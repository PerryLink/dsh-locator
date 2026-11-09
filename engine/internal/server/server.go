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
	// SaveInterval is the autosave cadence; zero uses 30s.
	SaveInterval time.Duration
	// RefreshInterval rebuilds the index periodically when no native watcher
	// is available. Zero disables the fallback.
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
	meta     store.Meta
	stats    index.Stats
	scanning bool

	writeMu sync.Mutex
	out     io.Writer
	started time.Time

	rebuildMu sync.Mutex

	usnMu     sync.Mutex
	usnCancel context.CancelFunc
	usnActive bool
}

// New creates a server; call Run to serve.
func New(opt Options) *Server {
	if opt.SaveInterval <= 0 {
		opt.SaveInterval = 30 * time.Second
	}
	if opt.Log == nil {
		opt.Log = os.Stderr
	}
	return &Server{opt: opt, started: time.Now()}
}

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
		s.logf("loaded %d entries from %s", ix.Stats().Entries, s.opt.StateDir)
		if s.opt.USN && s.opt.Watch && s.resumeUSN(ctx) {
			s.logf("resumed the USN change journal")
			return nil
		}
		if s.opt.Watch {
			if !s.startWatcher() {
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
	go s.initialScan(ctx, ix)
	return nil
}

func (s *Server) initialScan(ctx context.Context, ix *index.Index) {
	defer func() {
		s.mu.Lock()
		s.scanning = false
		s.mu.Unlock()
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
		if !s.startWatcher() {
			s.startRefreshFallback(ctx)
		}
	}
	s.event("scan", map[string]any{"phase": "done", "entries": ix.Stats().Entries})
}

func (s *Server) scanInto(ctx context.Context, ix *index.Index, roots []string) error {
	s.event("scan", map[string]any{"phase": "start", "roots": roots})
	st, err := scan.Run(ctx, ix, scan.Options{
		Roots:    roots,
		Excludes: s.opt.Excludes,
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
	if !st.USN {
		s.clearUSNStates()
	}
	s.logf("scanned %d entries in %s", st.Entries, st.Took.Round(time.Millisecond))
	s.event("scan", map[string]any{"phase": "done", "entries": st.Entries, "tookMs": st.Took.Milliseconds()})
	return nil
}

func (s *Server) startWatcher() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.watcher != nil {
		return true
	}
	w, err := watch.New(s.ix, watch.Options{
		Roots:    s.opt.Roots,
		Excludes: s.opt.Excludes,
		OnError: func(err error) {
			s.logf("watch: %v", err)
			s.event("warning", map[string]string{"message": err.Error()})
		},
	})
	if err != nil {
		s.logf("watch disabled: %v", err)
		s.event("warning", map[string]string{"message": "filesystem watching unavailable: " + err.Error()})
		return false
	}
	s.watcher = w
	go func() {
		if err := w.Run(context.Background()); err != nil {
			s.logf("watch stopped: %v", err)
		}
	}()
	s.logf("watching %d root(s)", len(s.opt.Roots))
	return true
}

func (s *Server) stopWatcher() {
	s.mu.Lock()
	w := s.watcher
	s.watcher = nil
	s.mu.Unlock()
	if w != nil {
		_ = w.Close()
	}
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
			After int32 `json:"after"`
			Limit int   `json:"limit"`
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
		entries, next, done := s.current().DumpPage(p.After, p.Limit)
		return map[string]any{"entries": entries, "next": next, "done": done}, nil
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
			s.startWatcher()
			return
		}
		s.mu.Lock()
		s.ix = ix
		s.mu.Unlock()
		s.opt.Roots = roots
		if len(p.Excludes) > 0 {
			s.opt.Excludes = p.Excludes
		}
		s.mu.RLock()
		usnActive := s.usnActive
		s.mu.RUnlock()
		if s.opt.Watch && !usnActive {
			s.startWatcher()
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
		if s.opt.Watch {
			s.startWatcher()
		}
		return
	}
	s.mu.Lock()
	s.ix = ix
	s.mu.Unlock()
	s.opt.Roots = roots
	if len(excludes) > 0 {
		s.opt.Excludes = excludes
	}
	s.mu.RLock()
	usnActive := s.usnActive
	s.mu.RUnlock()
	if s.opt.Watch && !usnActive {
		s.startWatcher()
	}
	s.emitStats()
	s.event("rebuilt", s.statusPayload())
}

func (s *Server) startRefreshFallback(ctx context.Context) {
	if s.opt.RefreshInterval <= 0 {
		s.logf("no native watcher and no refresh interval; the index only changes on rebuild")
		return
	}
	s.logf("no native watcher; refreshing every %s", s.opt.RefreshInterval)
	go func() {
		t := time.NewTicker(s.opt.RefreshInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if !s.rebuildMu.TryLock() {
					continue
				}
				roots := append([]string(nil), s.opt.Roots...)
				go func() {
					defer s.rebuildMu.Unlock()
					s.rebuildWith(ctx, roots, nil)
				}()
			}
		}
	}()
}

func (s *Server) statusPayload() map[string]any {
	ix := s.current()
	st := ix.Stats()
	s.mu.RLock()
	meta := s.meta
	watching := s.watcher != nil
	s.mu.RUnlock()
	return map[string]any{
		"version":   s.opt.Version,
		"platform":  meta.Platform,
		"roots":     ix.Roots(),
		"entries":   st.Entries,
		"files":     st.Files,
		"dirs":      st.Dirs,
		"nameBytes": st.NameBytes,
		"deleted":   st.Deleted,
		"watching":  watching,
		"scanning":  s.isScanning(),
		"usn":       meta.Stats.USN,
		"uptimeSec": int(time.Since(s.started).Seconds()),
		"stateDir":  s.opt.StateDir,
	}
}

func (s *Server) emitStats() {
	s.event("stats", s.statusPayload())
}

func (s *Server) autosave(ctx context.Context) {
	t := time.NewTicker(s.opt.SaveInterval)
	defer t.Stop()
	var last uint64
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if s.isScanning() {
				continue
			}
			g := s.current().Generation()
			if g == last {
				continue
			}
			last = g
			s.save()
		}
	}
}

func (s *Server) save() {
	ix := s.current()
	s.mu.RLock()
	incomplete := s.scanning || s.meta.Incomplete
	s.mu.RUnlock()
	if ix.Stats().Deleted > 10000 && ix.Stats().Deleted*5 > ix.Stats().Entries {
		ix.Compact()
	}
	s.mu.RLock()
	meta := s.meta
	s.mu.RUnlock()
	meta.Version = s.opt.Version
	meta.Excludes = s.opt.Excludes
	meta.Incomplete = incomplete
	if err := store.Save(s.opt.StateDir, ix, meta); err != nil {
		s.logf("save failed: %v", err)
		return
	}
}

func (s *Server) shutdown() {
	s.stopUSN()
	s.stopWatcher()
	s.save()
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
