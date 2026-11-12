// Package server speaks the line-delimited JSON protocol used by the DSH
// plugin: one request object per line, one response object per line, plus
// unsolicited event objects.
package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
	"github.com/PerryLink/dsh-locator/engine/internal/store"
	"github.com/PerryLink/dsh-locator/engine/internal/watch"
)

// Options configures a Server.
type Options struct {
	// StateDir holds the snapshot; it is created on demand.
	StateDir string
	// Roots are indexed when no usable snapshot exists, or on rebuild.
	Roots []string
	// Excludes are scan/watch exclusion globs.
	Excludes []string
	// Watch enables the platform change watcher.
	Watch bool
	// SaveInterval is deprecated. When SaveDebounce is zero it is used as the
	// debounce value; it used to be a fixed autosave cadence, which rewrote the
	// whole snapshot on a timer even when nothing had changed.
	SaveInterval time.Duration
	// SaveDebounce writes the snapshot once the index has been quiet for this
	// long. Zero uses 60s.
	SaveDebounce time.Duration
	// SaveMaxInterval forces a snapshot write once unsaved changes are older
	// than this, even while changes keep arriving. Zero uses 5 minutes.
	SaveMaxInterval time.Duration
	// RefreshInterval rebuilds the index periodically when no native watcher is
	// available, or while the watcher only covers part of the roots. Zero
	// disables the fallback.
	RefreshInterval time.Duration
	// ScanWorkers is the directory reader concurrency; zero uses GOMAXPROCS.
	ScanWorkers int
	// USN tries the NTFS USN/MFT enumeration before the portable walk.
	USN bool
	// Version is reported by status.
	Version string
	// Log receives diagnostics; nil means stderr.
	Log io.Writer
}

// Server owns one index and its watcher.
type Server struct {
	opt Options

	mu       sync.RWMutex
	ix       *index.Index
	watcher  watch.Watcher
	watch    watch.Health
	meta     store.Meta
	stats    index.Stats
	scanning bool

	// refreshCancel stops the periodic rebuild fallback; nil means it is not
	// running. refreshSeq identifies the current loop. Guarded by mu.
	refreshCancel context.CancelFunc
	refreshSeq    uint64

	// saveMu serialises snapshot writes and the dirty bookkeeping they update.
	saveMu sync.Mutex
	// dirty marks state that must be persisted even when the index generation
	// happens to match (meta updates, a replaced index, a failed first save).
	dirty bool
	// dirtySince is when the current dirty window started.
	dirtySince time.Time
	// observedGen is the last generation the autosave loop saw.
	observedGen uint64
	// savedGen and savedIncomplete describe what is currently on disk.
	savedGen        uint64
	savedIncomplete bool
	// saveOK is true once this process loaded or wrote a snapshot.
	saveOK     bool
	lastSaveAt time.Time

	writeMu sync.Mutex
	out     io.Writer
	started time.Time
	// runCtx is the server lifetime context; the watcher outlives any shorter
	// fallback-rebuild context.
	runCtx context.Context

	rebuildMu sync.Mutex

	usnMu     sync.Mutex
	usnCancel context.CancelFunc
	usnActive bool
}

// New creates a server; call Run to serve.
func New(opt Options) *Server {
	if opt.SaveDebounce <= 0 {
		opt.SaveDebounce = opt.SaveInterval
	}
	if opt.SaveDebounce <= 0 {
		opt.SaveDebounce = defaultSaveDebounce
	}
	if opt.SaveMaxInterval <= 0 {
		opt.SaveMaxInterval = defaultSaveMaxInterval
	}
	if opt.SaveMaxInterval < opt.SaveDebounce {
		opt.SaveMaxInterval = opt.SaveDebounce
	}
	if opt.Log == nil {
		opt.Log = os.Stderr
	}
	now := time.Now()
	return &Server{opt: opt, started: now, lastSaveAt: now}
}

const (
	defaultSaveDebounce    = 60 * time.Second
	defaultSaveMaxInterval = 5 * time.Minute
)

func (s *Server) logf(format string, args ...any) {
	fmt.Fprintf(s.opt.Log, "locator: "+format+"\n", args...)
}

// write sends one JSON value as a line.
func (s *Server) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err = s.out.Write(append(b, '\n'))
	return err
}

func (s *Server) event(name string, payload any) {
	_ = s.write(map[string]any{"event": name, "params": payload})
}

type request struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type response struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Result any             `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Run loads or builds the index, then serves requests from in until EOF.
func (s *Server) Run(ctx context.Context, in io.Reader, out io.Writer) error {
	s.out = out
	s.runCtx = ctx
	if err := s.bootstrap(ctx); err != nil {
		s.event("error", map[string]string{"message": err.Error()})
		return err
	}
	s.event("ready", s.statusPayload())

	go s.autosave(ctx)

	dec := json.NewDecoder(bufio.NewReaderSize(in, 1<<20))
	for {
		var req request
		if err := dec.Decode(&req); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			s.logf("bad request: %v", err)
			_ = s.write(response{Error: &rpcError{Code: "bad-request", Message: err.Error()}})
			continue
		}
		if req.Method == "shutdown" {
			_ = s.write(response{ID: req.ID, Result: map[string]any{"ok": true}})
			break
		}
		res, err := s.dispatch(ctx, req)
		if err != nil {
			_ = s.write(response{ID: req.ID, Error: &rpcError{Code: codeOf(err), Message: err.Error()}})
			continue
		}
		_ = s.write(response{ID: req.ID, Result: res})
	}
	s.shutdown()
	return nil
}

type bootstrapError struct{ err error }

func (e bootstrapError) Error() string { return e.err.Error() }
func (e bootstrapError) Unwrap() error { return e.err }

// bootstrap loads a usable snapshot or starts the initial scan in the
// background. Either way requests are served immediately: a search during the
// first scan sees the entries indexed so far and carries `indexing: true`.
func (s *Server) bootstrap(ctx context.Context) error {
	ix, meta, err := store.Load(s.opt.StateDir)
	if err == nil && sameRoots(ix.Roots(), s.opt.Roots) && !meta.Incomplete {
		s.mu.Lock()
		s.ix = ix
		s.meta = meta
		s.stats = ix.Stats()
		s.mu.Unlock()
		// The snapshot on disk already reflects this state, so a quiet shutdown
		// writes nothing.
		s.saveMu.Lock()
		s.savedGen = ix.Generation()
		s.observedGen = s.savedGen
		s.savedIncomplete = meta.Incomplete
		s.saveOK = true
		s.dirty = false
		s.saveMu.Unlock()
		s.logf("loaded %d entries from %s", ix.Stats().Entries, s.opt.StateDir)
		if s.opt.USN && s.opt.Watch && s.resumeUSN(ctx) {
			s.logf("resumed the USN change journal")
			return nil
		}
		if s.opt.Watch {
			if !s.startWatcher(ctx) {
				s.startRefreshFallback(ctx)
			}
		}
		return nil
	}

	ix = index.New()
	s.mu.Lock()
	s.ix = ix
	s.scanning = true
	s.meta = store.Meta{Version: s.opt.Version, Roots: append([]string(nil), s.opt.Roots...), Incomplete: true}
	s.mu.Unlock()
	s.saveMu.Lock()
	s.saveOK = false
	s.savedGen = 0
	s.observedGen = 0
	s.savedIncomplete = true
	s.dirty = true
	s.dirtySince = time.Now()
	s.saveMu.Unlock()
	go s.initialScan(ctx, ix)
	return nil
}

func (s *Server) initialScan(ctx context.Context, ix *index.Index) {
	defer func() {
		s.mu.Lock()
		s.scanning = false
		s.mu.Unlock()
		s.markDirty()
		s.emitStats()
	}()
	if err := s.scanInto(ctx, ix, s.opt.Roots); err != nil {
		s.logf("initial scan failed: %v", err)
		s.event("error", map[string]string{"message": "initial scan failed: " + err.Error()})
		return
	}
	s.mu.Lock()
	s.meta.Incomplete = false
	usnActive := s.usnActive
	s.mu.Unlock()
	if s.opt.Watch && !usnActive {
		if !s.startWatcher(ctx) {
			s.startRefreshFallback(ctx)
		}
	}
	s.event("scan", map[string]any{"phase": "done", "entries": ix.Stats().Entries})
}

func (s *Server) scanInto(ctx context.Context, ix *index.Index, roots []string) error {
	s.event("scan", map[string]any{"phase": "start", "roots": roots})
	st, err := scan.Run(ctx, ix, scan.Options{
		Roots:      roots,
		Excludes:   s.opt.Excludes,
		Workers:    s.opt.ScanWorkers,
		WindowsUSN: s.opt.USN,
		Warn: func(err error) {
			s.logf("usn: %v (using directory walk)", err)
			s.event("warning", map[string]string{"message": "USN unavailable: " + err.Error()})
		},
		Progress: func(p scan.Progress) {
			s.event("scan", map[string]any{"phase": "progress", "entries": p.Entries, "current": p.Current})
		},
		ProgressEvery: time.Second,
		OnUSNState:    s.saveUSNState,
	})
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.usnActive = st.USN
	s.meta = store.Meta{
		Version:  s.opt.Version,
		Roots:    ix.Roots(),
		Excludes: s.opt.Excludes,
		BuiltAt:  time.Now(),
		Stats:    st,
	}
	s.mu.Unlock()
	s.markDirty()
	if !st.USN {
		s.clearUSNStates()
	}
	s.logf("scanned %d entries in %s", st.Entries, st.Took.Round(time.Millisecond))
	s.event("scan", map[string]any{"phase": "done", "entries": st.Entries, "tookMs": st.Took.Milliseconds()})
	return nil
}

// startWatcher starts the native watcher for the current index. It returns
// false when the backend is unavailable (the caller then enables the refresh
// fallback). A backend that can only watch part of the requested roots returns
// a watcher plus a degraded health report; the server keeps it and also enables
// the periodic rebuild so unwatched subtrees still converge.
func (s *Server) startWatcher(ctx context.Context) bool {
	s.mu.RLock()
	ix := s.ix
	already := s.watcher != nil
	roots := s.opt.Roots
	excludes := s.opt.Excludes
	s.mu.RUnlock()
	if already || ix == nil {
		return already
	}
	onDegraded := func(h watch.Health) {
		s.mu.Lock()
		s.watch = h
		s.mu.Unlock()
		if h.Reason != "" {
			s.logf("watch degraded: %s", h.Reason)
			s.event("warning", map[string]string{"message": "filesystem watching degraded: " + h.Reason})
		}
		s.startRefreshFallback(ctx)
	}
	w, err := watch.New(ix, watch.Options{
		Roots:    roots,
		Excludes: excludes,
		OnError: func(err error) {
			s.logf("watch: %v", err)
			s.event("warning", map[string]string{"message": err.Error()})
		},
		OnDegraded: onDegraded,
	})
	if err != nil {
		s.logf("watch disabled: %v", err)
		s.event("warning", map[string]string{"message": "filesystem watching unavailable: " + err.Error()})
		return false
	}
	health := watch.HealthOf(w)
	s.mu.Lock()
	if s.watcher != nil {
		// Another path won the race; keep the installed watcher.
		s.mu.Unlock()
		_ = w.Close()
		return true
	}
	s.watcher = w
	s.watch = health
	runCtx := s.runCtx
	s.mu.Unlock()
	if runCtx == nil {
		runCtx = ctx
	}
	go func() {
		runErr := w.Run(runCtx)
		s.mu.Lock()
		current := s.watcher == w
		if current {
			s.watcher = nil
			s.watch = watch.Health{}
		}
		s.mu.Unlock()
		if !current || runCtx.Err() != nil {
			return // stopped on purpose (shutdown or rebuild)
		}
		msg := "filesystem watcher stopped"
		if runErr != nil {
			msg += ": " + runErr.Error()
		}
		s.logf("%s; falling back to periodic refresh", msg)
		s.event("warning", map[string]string{"message": msg})
		s.startRefreshFallback(ctx)
	}()
	if health.Degraded {
		s.logf("watching %d of %d root(s); %s", health.Watching, health.Roots, health.Reason)
	} else {
		s.logf("watching %d root(s)", health.Watching)
	}
	if health.Degraded || health.Watching < health.Roots {
		s.startRefreshFallback(ctx)
	} else {
		// A complete native watcher is live; the periodic rebuild would only
		// duplicate work. (stopWatcher no longer cancels the fallback, so a
		// fallback rebuild can scan with its own context and stop here.)
		s.stopRefreshFallback()
	}
	return true
}

func (s *Server) stopWatcher() {
	s.mu.Lock()
	w := s.watcher
	s.watcher = nil
	s.watch = watch.Health{}
	s.mu.Unlock()
	if w != nil {
		_ = w.Close()
	}
}

// refreshActive reports whether the periodic rebuild fallback is running.
func (s *Server) refreshActive() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.refreshCancel != nil
}

func (s *Server) isScanning() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.scanning
}

func (s *Server) current() *index.Index {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ix
}

func (s *Server) dispatch(ctx context.Context, req request) (any, error) {
	switch req.Method {
	case "ping":
		return map[string]any{"ok": true, "version": s.opt.Version}, nil
	case "status":
		return s.statusPayload(), nil
	case "search":
		var p SearchParams
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, err
		}
		return s.search(p)
	case "rebuild":
		var p RebuildParams
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, err
		}
		return s.rebuild(ctx, p)
	case "roots":
		return map[string]any{"roots": s.current().Roots()}, nil
	case "dump":
		var p struct {
			After     int32  `json:"after"`
			Limit     int    `json:"limit"`
			Since     uint64 `json:"since"`
			MtimeFrom int64  `json:"mtimeFrom"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, err
		}
		if p.Limit <= 0 {
			p.Limit = 5000
		}
		if p.Limit > 10000 {
			p.Limit = 10000
		}
		ix := s.current()
		gen := ix.Generation()
		// A caller that has already seen this generation can skip the walk
		// entirely; this is the cheap "nothing changed" refresh path.
		if p.Since != 0 && p.Since == gen {
			return map[string]any{
				"entries":    []index.DumpEntry{},
				"next":       0,
				"done":       true,
				"unchanged":  true,
				"generation": gen,
			}, nil
		}
		entries, next, done := ix.DumpPageFrom(p.After, p.Limit, p.MtimeFrom)
		return map[string]any{
			"entries":    entries,
			"next":       next,
			"done":       done,
			"generation": gen,
		}, nil
	default:
		return nil, fmt.Errorf("unknown method %q", req.Method)
	}
}

// SearchParams is the `search` method payload.
type SearchParams struct {
	Query     string `json:"query"`
	Limit     int    `json:"limit"`
	Offset    int    `json:"offset"`
	Sort      string `json:"sort"`
	Desc      bool   `json:"desc"`
	Regex     bool   `json:"regex"`
	Case      bool   `json:"case"`
	WholeWord bool   `json:"wholeWord"`
	FilesOnly bool   `json:"filesOnly"`
	DirsOnly  bool   `json:"dirsOnly"`
}

func (s *Server) search(p SearchParams) (index.Result, error) {
	var q index.Query
	var err error
	if p.Regex {
		q = index.Query{Text: p.Query, Regex: true, MinSize: -1, MaxSize: -1, MinMtime: -1, MaxMtime: -1}
	} else {
		q, err = index.ParseQuery(p.Query)
		if err != nil {
			return index.Result{}, err
		}
	}
	q.Limit, q.Offset = p.Limit, p.Offset
	q.SetSort(p.Sort, p.Desc)
	q.Case = q.Case || p.Case
	q.WholeWord = q.WholeWord || p.WholeWord
	q.FilesOnly = q.FilesOnly || p.FilesOnly
	q.DirsOnly = q.DirsOnly || p.DirsOnly
	result, err := s.current().Search(q)
	if err != nil {
		return result, err
	}
	s.mu.RLock()
	result.Indexing = s.scanning
	s.mu.RUnlock()
	fillMissingMetadata(result.Hits)
	return result, nil
}

// RebuildParams is the `rebuild` method payload.
type RebuildParams struct {
	Roots    []string `json:"roots"`
	Excludes []string `json:"excludes"`
}

func (s *Server) rebuild(ctx context.Context, p RebuildParams) (any, error) {
	if !s.rebuildMu.TryLock() {
		return nil, errors.New("a rebuild is already running")
	}
	roots := p.Roots
	if len(roots) == 0 {
		roots = s.opt.Roots
	}
	if len(roots) == 0 {
		s.rebuildMu.Unlock()
		return nil, errors.New("no roots to index")
	}
	go func() {
		defer s.rebuildMu.Unlock()
		s.stopWatcher()
		ix := index.New()
		if err := s.scanInto(ctx, ix, roots); err != nil {
			s.logf("rebuild failed: %v", err)
			s.event("error", map[string]string{"message": "rebuild failed: " + err.Error()})
			if !s.startWatcher(ctx) {
				s.startRefreshFallback(ctx)
			}
			return
		}
		s.adoptIndex(ix)
		s.mu.Lock()
		s.opt.Roots = roots
		if len(p.Excludes) > 0 {
			s.opt.Excludes = p.Excludes
		}
		s.mu.Unlock()
		s.mu.RLock()
		usnActive := s.usnActive
		s.mu.RUnlock()
		if s.opt.Watch && !usnActive {
			if !s.startWatcher(ctx) {
				s.startRefreshFallback(ctx)
			}
		}
		s.emitStats()
		s.event("rebuilt", s.statusPayload())
	}()
	return map[string]any{"started": true}, nil
}

// rebuildWith replaces the index with a fresh scan. It is called with rebuildMu
// held, from an explicit rebuild or the refresh fallback.
func (s *Server) rebuildWith(ctx context.Context, roots, excludes []string) {
	s.stopWatcher()
	ix := index.New()
	if err := s.scanInto(ctx, ix, roots); err != nil {
		s.logf("rebuild failed: %v", err)
		s.event("error", map[string]string{"message": "rebuild failed: " + err.Error()})
		if s.opt.Watch && !s.startWatcher(ctx) {
			s.startRefreshFallback(ctx)
		}
		return
	}
	s.adoptIndex(ix)
	s.mu.Lock()
	s.opt.Roots = roots
	if len(excludes) > 0 {
		s.opt.Excludes = excludes
	}
	s.mu.Unlock()
	s.mu.RLock()
	usnActive := s.usnActive
	s.mu.RUnlock()
	if s.opt.Watch && !usnActive {
		if !s.startWatcher(ctx) {
			s.startRefreshFallback(ctx)
		}
	}
	s.emitStats()
	s.event("rebuilt", s.statusPayload())
}

// startRefreshFallback starts the single periodic rebuild loop used when no
// native watcher is available or it only covers part of the roots. It is a
// no-op when the fallback is already running or was disabled (--refresh 0).
func (s *Server) startRefreshFallback(ctx context.Context) {
	if !s.opt.Watch || s.opt.RefreshInterval <= 0 {
		s.logf("periodic refresh fallback is disabled; the index only changes on rebuild")
		return
	}
	s.mu.Lock()
	if s.refreshCancel != nil {
		s.mu.Unlock()
		return
	}
	rctx, cancel := context.WithCancel(ctx)
	s.refreshCancel = cancel
	s.refreshSeq++
	seq := s.refreshSeq
	s.mu.Unlock()
	s.logf("no complete native watcher; refreshing every %s", s.opt.RefreshInterval)
	go func() {
		defer func() {
			s.mu.Lock()
			if s.refreshSeq == seq {
				s.refreshCancel = nil
			}
			s.mu.Unlock()
		}()
		t := time.NewTicker(s.opt.RefreshInterval)
		defer t.Stop()
		for {
			select {
			case <-rctx.Done():
				return
			case <-t.C:
				if !s.rebuildMu.TryLock() {
					continue
				}
				s.mu.RLock()
				roots := append([]string(nil), s.opt.Roots...)
				excludes := append([]string(nil), s.opt.Excludes...)
				s.mu.RUnlock()
				go func() {
					defer s.rebuildMu.Unlock()
					s.rebuildWith(rctx, roots, excludes)
				}()
			}
		}
	}()
}

func (s *Server) stopRefreshFallback() {
	s.mu.Lock()
	cancel := s.refreshCancel
	s.refreshCancel = nil
	s.refreshSeq++
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Server) statusPayload() map[string]any {
	ix := s.current()
	st := ix.Stats()
	s.mu.RLock()
	meta := s.meta
	watching := s.watcher != nil
	health := s.watch
	usnActive := s.usnActive
	refresh := s.refreshCancel != nil
	scanning := s.scanning
	s.mu.RUnlock()
	return map[string]any{
		"version":         s.opt.Version,
		"platform":        meta.Platform,
		"roots":           ix.Roots(),
		"entries":         st.Entries,
		"files":           st.Files,
		"dirs":            st.Dirs,
		"nameBytes":       st.NameBytes,
		"deleted":         st.Deleted,
		"generation":      st.Generation,
		"builtAt":         st.BuiltAt,
		"watching":        watching || usnActive,
		"watchDegraded":   health.Degraded,
		"watchReason":     health.Reason,
		"watchRoots":      health.Watching,
		"refreshFallback": refresh,
		"usnActive":       usnActive,
		"scanning":        scanning,
		"usn":             meta.Stats.USN,
		"uptimeSec":       int(time.Since(s.started).Seconds()),
		"stateDir":        s.opt.StateDir,
	}
}

func (s *Server) emitStats() {
	s.event("stats", s.statusPayload())
}

// markDirty records state that must be persisted even when the generation has
// not moved (meta updates, a replaced index, an unsaved first snapshot).
func (s *Server) markDirty() {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	if !s.dirty {
		s.dirty = true
		s.dirtySince = time.Now()
	}
}

// adoptIndex installs a freshly built index and marks its state for saving.
func (s *Server) adoptIndex(ix *index.Index) {
	s.mu.Lock()
	s.ix = ix
	s.mu.Unlock()
	s.saveMu.Lock()
	s.dirty = true
	s.dirtySince = time.Now()
	s.observedGen = ix.Generation()
	s.saveMu.Unlock()
}

// observeGeneration folds the index generation into the dirty state. Only real
// mutations move the generation, so a quiet index never becomes dirty and the
// snapshot is not rewritten on a timer.
func (s *Server) observeGeneration(gen uint64) {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	if gen == s.observedGen {
		return
	}
	s.observedGen = gen
	if !s.dirty {
		s.dirty = true
		s.dirtySince = time.Now()
	}
}

// saveDue reports whether pending changes may be written now. Writes happen
// after the index went quiet for SaveDebounce, or at the latest SaveMaxInterval
// after the previous write so continuous change cannot starve the snapshot.
func (s *Server) saveDue() bool {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	if !s.dirty {
		return false
	}
	return time.Since(s.dirtySince) >= s.opt.SaveDebounce ||
		time.Since(s.lastSaveAt) >= s.opt.SaveMaxInterval
}

func (s *Server) autosave(ctx context.Context) {
	// Poll the generation cheaply (a read lock, no allocation) and only write
	// when a real change has settled.
	tick := s.opt.SaveDebounce / 4
	if tick < 500*time.Millisecond {
		tick = 500 * time.Millisecond
	}
	if tick > 5*time.Second {
		tick = 5 * time.Second
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if s.isScanning() {
				continue
			}
			s.observeGeneration(s.current().Generation())
			if !s.saveDue() {
				continue
			}
			s.save(false)
		}
	}
}

// save persists the index and meta when there is anything new to persist. It
// returns whether a snapshot was written.
func (s *Server) save(force bool) bool {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	ix := s.current()
	s.mu.RLock()
	incomplete := s.scanning || s.meta.Incomplete
	s.mu.RUnlock()
	gen := ix.Generation()
	if !force && !s.dirty && gen == s.savedGen && incomplete == s.savedIncomplete && s.saveOK {
		return false
	}
	// Compact right before the write when tombstones dominate; it renumbers
	// records, so the saved generation must be read afterwards.
	if st := ix.Stats(); st.Deleted > 10000 && st.Deleted*5 > st.Entries {
		ix.Compact()
	}
	gen = ix.Generation()
	s.mu.RLock()
	meta := s.meta
	s.mu.RUnlock()
	meta.Version = s.opt.Version
	meta.Excludes = s.opt.Excludes
	meta.Incomplete = incomplete
	if err := store.Save(s.opt.StateDir, ix, meta); err != nil {
		s.logf("save failed: %v", err)
		return false
	}
	s.savedGen = gen
	s.observedGen = gen
	s.savedIncomplete = incomplete
	s.saveOK = true
	s.dirty = false
	s.lastSaveAt = time.Now()
	return true
}

func (s *Server) shutdown() {
	s.stopUSN()
	s.stopWatcher()
	s.stopRefreshFallback()
	// Write only if something is actually unsaved; a quiet shutdown leaves the
	// existing snapshot untouched.
	s.save(false)
}

func (s *Server) stopUSN() {
	s.usnMu.Lock()
	cancel := s.usnCancel
	s.usnCancel = nil
	s.usnMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// fillMissingMetadata stats at most one page of USN-built rows that still have
// no size or mtime. The index itself is not rewritten; this only makes the
// returned page truthful until the next metadata pass.
func fillMissingMetadata(hits []index.Hit) {
	for i := range hits {
		hit := &hits[i]
		if hit.Dir || hit.Mtime != 0 {
			continue
		}
		info, err := os.Stat(hit.Path)
		if err != nil {
			continue
		}
		hit.Size = info.Size()
		hit.Mtime = info.ModTime().UnixMilli()
	}
}

func sameRoots(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for _, x := range a {
		found := false
		for _, y := range b {
			if x == y {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func codeOf(err error) string {
	return "error"
}
