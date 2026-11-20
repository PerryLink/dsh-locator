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
	"runtime/debug"
	"sync"
	"sync/atomic"
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
	// IncludeCaches keeps toolchain/package cache trees in the index and the
	// watcher. The default false mirrors the scanner default.
	IncludeCaches bool
	// WatchMaxDirs caps watched directories across all roots. Zero uses the
	// watcher default (120000); the unwatched remainder relies on the periodic
	// incremental refresh.
	WatchMaxDirs int
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
	// UnwatchedRefreshInterval is the cadence the fallback uses for roots
	// without a native watcher (9p/DrvFs, NFS, SMB and similar). Zero follows
	// RefreshInterval; the effective value is the smaller of the two, so it can
	// only make watcher-less roots fresher, never slower. Ignored when
	// RefreshInterval is zero (the fallback is disabled) or Watch is false.
	UnwatchedRefreshInterval time.Duration
	// DisableIncrementalRefresh makes every periodic refresh rescan all roots
	// instead of reusing the entries of roots that have a healthy live watcher.
	// The default (false) rescans only degraded or unwatched roots and falls
	// back to a full rebuild when coverage cannot be attributed per root.
	DisableIncrementalRefresh bool
	// SnapshotCompression selects how the base snapshot payload is stored:
	// CompressionNone (default) or CompressionZstd. Incremental journal saves
	// are unaffected by it.
	SnapshotCompression index.Compression
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
	// watchInit is true while the native watcher is constructed in the
	// background; watchGen invalidates an in-flight start after a deliberate
	// stop, so a rebuild cannot race a stale initialisation.
	watchInit bool
	watchGen  uint64

	// refreshCancel stops the periodic rebuild fallback; nil means it is not
	// running. refreshSeq identifies the current loop. Guarded by mu.
	refreshCancel context.CancelFunc
	refreshSeq    uint64
	// lastRefresh describes the most recent periodic refresh decision and is
	// reported by status so the host can show what was (not) rescanned.
	// Guarded by mu.
	lastRefresh *refreshReport
	// refreshIdle counts consecutive refreshes that changed nothing;
	// refreshDelay/refreshNextAt describe the exponential backoff the fallback
	// loop applies next. Guarded by mu.
	refreshIdle   int
	refreshDelay  time.Duration
	refreshNextAt time.Time
	// refreshRounds counts fallback refresh rounds that ran (each produced one
	// refresh report); a round the pressure gate declined is counted by
	// refreshSkippedByPressure instead. Guarded by mu.
	refreshRounds            int64
	refreshSkippedByPressure int64
	// pressureProbe samples the host load signals the fallback gate consults.
	// nil uses samplePressure. It is installed before the fallback loop starts
	// (tests replace it to force a verdict) and never mutated afterwards, so it
	// needs no lock.
	pressureProbe func() pressureInput

	// queryCount and recentQueryMs back the status observability fields.
	queryCount    atomic.Int64
	queryMu       sync.Mutex
	recentQueryMs [queryRingSize]int64
	recentQueryN  int

	// metrics caches process memory and snapshot size readings for a short TTL.
	metricsMu sync.Mutex
	metricsAt time.Time
	metrics   statusMetrics

	// saveMu serialises snapshot writes and the dirty bookkeeping they update.
	saveMu sync.Mutex
	// saveStatsMu guards the metric fields below. They are written by save (which
	// holds saveMu for the whole write), so status must read them through their
	// own lock instead of waiting behind a multi-hundred-millisecond snapshot
	// write.
	saveStatsMu sync.Mutex
	// dirty marks state that must be persisted even when the index generation
	// happens to match (meta updates, a replaced index, a failed first save).
	dirty bool
	// lastDirtyAt is when the index last changed. The debounce only writes once
	// the index has been quiet this long since the *latest* change (the old
	// field was set only once per dirty window, so continuous change rewrote the
	// whole snapshot every 60-128s instead of once per SaveMaxInterval).
	lastDirtyAt time.Time
	// observedGen is the last generation the autosave loop saw.
	observedGen uint64
	// savedGen and savedIncomplete describe what is currently on disk.
	savedGen        uint64
	savedIncomplete bool
	// saveOK is true once this process loaded or wrote a snapshot.
	saveOK     bool
	lastSaveAt time.Time
	// needsFullSave is set when the in-memory index cannot be expressed as an
	// append to the base on disk (fresh scan, rebuilt index, v1 migration).
	needsFullSave bool

	// Save/compact accounting reported by status (P1/P2 observability).
	saveCount      int64
	saveBytes      int64
	saveMs         int64
	saveLastFull   bool
	snapshotFormat uint32
	journalEntries int64
	journalBytes   int64
	compactCount   int64
	compactMs      int64
	compactAt      time.Time

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
	return &Server{opt: opt, started: now, lastSaveAt: now, lastDirtyAt: now}
}

const (
	defaultSaveDebounce    = 60 * time.Second
	defaultSaveMaxInterval = 5 * time.Minute

	// minCompactDeleted keeps a tiny index from rewriting itself over a handful
	// of tombstones; above ~20k live entries the 5% ratio governs.
	minCompactDeleted = 1024
	// compactDeletedRatio triggers compaction when Deleted*20 > Entries, i.e.
	// 5% tombstones. The previous 20% ratio (Deleted*5 > Entries) never fired on
	// the live index (6.7% tombstones), so the snapshot grew forever.
	compactDeletedRatio = 20
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
	ix, meta, info, err := store.LoadWithInfo(s.opt.StateDir)
	if err == nil && sameRoots(ix.Roots(), s.opt.Roots) && !meta.Incomplete {
		s.mu.Lock()
		s.ix = ix
		s.meta = meta
		s.stats = ix.Stats()
		s.mu.Unlock()
		// The snapshot on disk already reflects this state, so a quiet shutdown
		// writes nothing. A v1 base has no journal yet, so the first save
		// migrates it to the v2 format; a v2 base plus its journal is current.
		now := time.Now()
		s.saveMu.Lock()
		s.savedGen = ix.Generation()
		s.observedGen = s.savedGen
		s.savedIncomplete = meta.Incomplete
		s.saveOK = true
		s.dirty = false
		s.lastSaveAt = now
		s.lastDirtyAt = now
		s.needsFullSave = !info.SupportsJournal()
		s.saveMu.Unlock()
		s.saveStatsMu.Lock()
		s.snapshotFormat = info.Version
		s.journalEntries = int64(info.JournalEntries)
		s.journalBytes = info.JournalBytes
		s.saveStatsMu.Unlock()
		ix.SetJournalEnabled(true)
		if info.JournalReplayed {
			s.logf("replayed %d journal entries (%d bytes) from %s", info.JournalEntries, info.JournalBytes, s.opt.StateDir)
		}
		if info.JournalIgnored {
			s.logf("ignored an unusable snapshot journal in %s", s.opt.StateDir)
		}
		if info.JournalTruncated {
			s.logf("snapshot journal had a torn tail; replayed the %d valid entries", info.JournalEntries)
		}
		s.logf("loaded %d entries from %s", ix.Stats().Entries, s.opt.StateDir)
		if s.opt.USN && s.opt.Watch && s.resumeUSN(ctx) {
			s.logf("resumed the USN change journal")
			return nil
		}
		if s.opt.Watch {
			// P1-5: ready must not wait for the watcher. The index already holds
			// every directory record, so installing watches can happen while the
			// daemon serves its first requests.
			s.startWatcherAsync(ctx)
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
	s.lastDirtyAt = time.Now()
	s.needsFullSave = true
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
	if _, err := s.scanRoots(ctx, ix, s.opt.Roots, s.opt.USN); err != nil {
		s.logf("initial scan failed: %v", err)
		s.event("error", map[string]string{"message": "initial scan failed: " + err.Error()})
		return
	}
	s.mu.Lock()
	s.meta.Incomplete = false
	usnActive := s.usnActive
	s.mu.Unlock()
	if s.opt.Watch && !usnActive {
		s.startWatcherAsync(ctx)
	}
	s.event("scan", map[string]any{"phase": "done", "entries": ix.Stats().Entries})
}

// scanRoots scans roots into ix and folds the result into the server metadata.
// It returns the scan statistics so a periodic incremental refresh can report
// how much it actually did. useUSN is false for partial rescans: a volume MFT
// enumeration would cover more than the refreshed roots and starts its own
// change watcher, which a partial refresh must not do next to the live watcher.
func (s *Server) scanRoots(ctx context.Context, ix *index.Index, roots []string, useUSN bool) (scan.Stats, error) {
	s.event("scan", map[string]any{"phase": "start", "roots": roots})
	st, err := scan.Run(ctx, ix, scan.Options{
		Roots:         roots,
		Excludes:      s.opt.Excludes,
		IncludeCaches: s.opt.IncludeCaches,
		Workers:       s.opt.ScanWorkers,
		WindowsUSN:    useUSN,
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
		return st, err
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
	return st, nil
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
		Roots:         roots,
		Excludes:      excludes,
		IncludeCaches: s.opt.IncludeCaches,
		MaxDirs:       s.opt.WatchMaxDirs,
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
	s.watchGen++
	s.mu.Unlock()
	if w != nil {
		_ = w.Close()
	}
}

// startWatcherAsync installs the native watcher in the background so the ready
// event and the first search do not wait for the watch syscalls. When the
// watcher is up it emits a stats event, and a degraded/limited result turns on
// the periodic refresh fallback exactly like the synchronous path.
func (s *Server) startWatcherAsync(ctx context.Context) {
	if !s.opt.Watch {
		return
	}
	s.mu.Lock()
	if s.watchInit || s.watcher != nil {
		s.mu.Unlock()
		return
	}
	s.watchInit = true
	gen := s.watchGen
	s.mu.Unlock()
	go func() {
		started := s.startWatcher(ctx)
		s.mu.Lock()
		stale := s.watchGen != gen
		s.watchInit = false
		s.mu.Unlock()
		if stale {
			// A rebuild stopped the watcher while this initialisation was in
			// flight; do not leave a second watcher behind.
			s.stopWatcher()
		}
		if !started {
			s.startRefreshFallback(ctx)
		}
		// The startup walk was the biggest transient heap spike; give the pages
		// back now that the watch map is built (P0-2/P1-5).
		debug.FreeOSMemory()
		s.emitStats()
	}()
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

// watcherHealth returns the latest watcher coverage report.
func (s *Server) watcherHealth() watch.Health {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.watch
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
	s.recordQuery(time.Duration(result.TookNanos))
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
		if _, err := s.scanRoots(ctx, ix, roots, s.opt.USN); err != nil {
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
// held, from an explicit rebuild or the refresh fallback, and returns the scan
// statistics (zero on failure) so the refresh report can show what it did.
func (s *Server) rebuildWith(ctx context.Context, roots, excludes []string) scan.Stats {
	s.stopWatcher()
	ix := index.New()
	st, err := s.scanRoots(ctx, ix, roots, s.opt.USN)
	if err != nil {
		s.logf("rebuild failed: %v", err)
		s.event("error", map[string]string{"message": "rebuild failed: " + err.Error()})
		if s.opt.Watch && !s.startWatcher(ctx) {
			s.startRefreshFallback(ctx)
		}
		return st
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
	return st
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
	unwatched := s.unwatchedRefreshInterval()
	if s.opt.DisableIncrementalRefresh {
		s.logf("no complete native watcher; rebuilding the whole index every %s (incremental refresh disabled)", s.opt.RefreshInterval)
	} else if unwatched > 0 && unwatched < s.opt.RefreshInterval {
		s.logf("no complete native watcher; refreshing unwatched roots every %s (base %s; only unwatched/degraded roots are rescanned)", unwatched, s.opt.RefreshInterval)
	} else {
		s.logf("no complete native watcher; refreshing every %s (only unwatched/degraded roots are rescanned)", s.opt.RefreshInterval)
	}
	go func() {
		defer func() {
			s.mu.Lock()
			if s.refreshSeq == seq {
				s.refreshCancel = nil
			}
			s.mu.Unlock()
		}()
		// Timer instead of ticker: a refresh that found nothing doubles the
		// wait (with jitter) so a slow 9p root is not rescanned every base
		// interval just to learn that nothing changed. A changed refresh
		// resets the delay. Rounds that refresh watcher-less roots use the
		// faster unwatched cadence with a 2x idle cap instead.
		delay := s.fallbackCadence(s.watcherHealth())
		if delay <= 0 {
			delay = s.opt.RefreshInterval
		}
		s.setRefreshSchedule(delay)
		t := time.NewTimer(delay)
		defer t.Stop()
		for {
			select {
			case <-rctx.Done():
				return
			case <-t.C:
			}
			if rctx.Err() != nil {
				return
			}
			// Pressure gate: do not pile a slow 9p rescan on top of an already
			// saturated host. A declined round is recorded and retried soon so
			// freshness recovers as soon as the load does.
			if reasons := s.pressureVerdict(); len(reasons) > 0 {
				s.recordPressureSkip(reasons)
				retry := pressureRetryInterval(s.fallbackCadence(s.watcherHealth()))
				if !s.setRefreshSchedule(retry) {
					return
				}
				t.Reset(retry)
				continue
			}
			if !s.rebuildMu.TryLock() {
				// A rebuild is already running; retry sooner than the base
				// interval so the fallback does not skip a whole period.
				retry := s.opt.RefreshInterval / 4
				if retry < time.Second {
					retry = time.Second
				}
				if !s.setRefreshSchedule(retry) {
					return
				}
				t.Reset(retry)
				continue
			}
			refreshStart := time.Now()
			outcome := s.periodicRefresh(rctx)
			took := time.Since(refreshStart)
			s.rebuildMu.Unlock()
			if rctx.Err() != nil {
				return
			}
			if outcome.Scanned {
				// A full or partial rescan spikes the high-water mark by well over
				// a hundred MB on a 9p root even though the steady state is tens of
				// MB; hand the pages back instead of keeping them resident.
				freeOSMemory()
			}
			cadence := cadenceBase
			if outcome.Unwatched {
				cadence = cadenceUnwatched
			}
			next := s.nextRefreshDelayFor(cadence, outcome.Changed, took)
			if !s.setRefreshSchedule(next) {
				return
			}
			t.Reset(next)
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
	now := time.Now()
	ix := s.current()
	st := ix.Stats()
	s.mu.RLock()
	meta := s.meta
	watching := s.watcher != nil
	health := s.watch
	usnActive := s.usnActive
	refresh := s.refreshCancel != nil
	scanning := s.scanning
	lastRefresh := s.lastRefresh
	incremental := !s.opt.DisableIncrementalRefresh
	watchInit := s.watchInit
	refreshIdle := s.refreshIdle
	refreshDelay := s.refreshDelay
	refreshNextAt := s.refreshNextAt
	refreshRounds := s.refreshRounds
	pressureSkips := s.refreshSkippedByPressure
	s.mu.RUnlock()
	metrics := s.statusMetrics()
	queryCount, lastQueryMs, recentQueryMs := s.queryStats()
	snapStats := s.snapshotStats()
	refreshMode := ""
	refreshReason := ""
	refreshScanned := []string{}
	refreshSkipped := []string{}
	var refreshEntries int64
	var refreshTookMs int64
	var refreshAt int64
	var refreshAdded int64
	var refreshRemoved int64
	var refreshChanged bool
	if lastRefresh != nil {
		refreshMode = lastRefresh.Mode
		refreshReason = lastRefresh.Reason
		refreshScanned = append(refreshScanned, lastRefresh.Scanned...)
		refreshSkipped = append(refreshSkipped, lastRefresh.Skipped...)
		refreshEntries = lastRefresh.Entries
		refreshTookMs = lastRefresh.Took.Milliseconds()
		refreshAt = lastRefresh.At.UnixMilli()
		refreshAdded = lastRefresh.Added
		refreshRemoved = lastRefresh.Removed
		refreshChanged = lastRefresh.Changed
	}
	return map[string]any{
		"version":             s.opt.Version,
		"platform":            meta.Platform,
		"roots":               ix.Roots(),
		"entries":             st.Entries,
		"files":               st.Files,
		"dirs":                st.Dirs,
		"nameBytes":           st.NameBytes,
		"deleted":             st.Deleted,
		"generation":          st.Generation,
		"builtAt":             st.BuiltAt / int64(time.Millisecond),
		"watching":            watching || usnActive,
		"watchInitializing":   watchInit,
		"watchDegraded":       health.Degraded,
		"watchReason":         health.Reason,
		"watchRoots":          health.Watching,
		"watchDirs":           health.Dirs,
		"watchLimit":          health.Limit,
		"watchLimited":        health.Limited,
		"watchUnwatchedRoots": unwatchedRoots(health),
		"refreshFallback":     refresh,
		"incrementalRefresh":  incremental,
		"refreshMode":         refreshMode,
		"refreshReason":       refreshReason,
		"refreshScannedRoots": refreshScanned,
		"refreshSkippedRoots": refreshSkipped,
		"refreshEntries":      refreshEntries,
		"refreshTookMs":       refreshTookMs,
		"refreshAt":           refreshAt,
		"refreshAdded":        refreshAdded,
		"refreshRemoved":      refreshRemoved,
		"refreshChanged":      refreshChanged,
		"usnActive":           usnActive,
		"scanning":            scanning,
		"usn":                 meta.Stats.USN,
		"uptimeSec":           int(time.Since(s.started).Seconds()),
		"stateDir":            s.opt.StateDir,
		// Observability (P1-10): process memory, snapshot footprint and query
		// latency history. Additive fields; consumers may ignore them.
		"rssBytes":         metrics.rss,
		"hwmBytes":         metrics.hwm,
		"heapBytes":        metrics.heap,
		"numGC":            metrics.numGC,
		"snapshotBytes":    metrics.snapshotBytes,
		"queryCount":       queryCount,
		"lastQueryMs":      lastQueryMs,
		"recentQueryMs":    recentQueryMs,
		"refreshIdle":      refreshIdle,
		"refreshBackoffMs": refreshDelay.Milliseconds(),
		"refreshNextInMs":  refreshNextIn(now, refreshNextAt),
		// Fallback-refresh observability (0.20.2): the cadence used for roots
		// without a native watcher, when the next round is due, and how many
		// rounds ran or were declined because the host was under pressure.
		"unwatchedRefreshMs":       s.unwatchedRefreshInterval().Milliseconds(),
		"nextRefreshAt":            unixMilliOrZero(refreshNextAt),
		"refreshRounds":            refreshRounds,
		"refreshSkippedByPressure": pressureSkips,
		// Persistence observability (P1/P2): what the snapshot mechanism did.
		// Additive fields; consumers that predate them simply ignore them.
		"snapshotFormat": snapStats.format,
		"saveCount":      snapStats.count,
		"saveBytes":      snapStats.bytes,
		"saveMs":         snapStats.ms,
		"saveLastFull":   snapStats.lastFull,
		"lastSaveAt":     unixMilliOrZero(snapStats.lastSaveAt),
		"journalEntries": snapStats.journalEntries,
		"journalBytes":   snapStats.journalBytes,
		"compactCount":   snapStats.compactCount,
		"compactMs":      snapStats.compactMs,
		"compactAt":      unixMilliOrZero(snapStats.compactAt),
	}
}

// unixMilliOrZero formats an optional timestamp for status JSON.
func unixMilliOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// refreshNextIn reports how long until the next fallback refresh, in ms.
func refreshNextIn(now, next time.Time) int64 {
	if next.IsZero() || next.Before(now) {
		return 0
	}
	return next.Sub(now).Milliseconds()
}

func (s *Server) emitStats() {
	s.event("stats", s.statusPayload())
}

// markDirty records state that must be persisted even when the generation has
// not moved (meta updates, a replaced index, an unsaved first snapshot).
func (s *Server) markDirty() {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	s.dirty = true
	s.lastDirtyAt = time.Now()
}

// adoptIndex installs a freshly built index and marks its state for saving. The
// base on disk describes the previous index, so the next save must be full.
func (s *Server) adoptIndex(ix *index.Index) {
	s.mu.Lock()
	s.ix = ix
	s.mu.Unlock()
	s.saveMu.Lock()
	s.dirty = true
	s.lastDirtyAt = time.Now()
	s.needsFullSave = true
	s.observedGen = ix.Generation()
	s.saveMu.Unlock()
}

// observeGeneration folds the index generation into the dirty state. Only real
// mutations move the generation, so a quiet index never becomes dirty and the
// snapshot is not rewritten on a timer. lastDirtyAt moves on every observed
// change: the debounce measures quiet time since the latest change, not since
// the start of the dirty window.
func (s *Server) observeGeneration(gen uint64) {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	if gen == s.observedGen {
		return
	}
	s.observedGen = gen
	s.dirty = true
	s.lastDirtyAt = time.Now()
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
	return time.Since(s.lastDirtyAt) >= s.opt.SaveDebounce ||
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
//
// Steady-state saves append the incremental journal (a few dozen kilobytes)
// instead of rewriting the whole arena. A full base rewrite still happens after
// a scan/rebuild, on a v1 migration, when the journal overflowed, or right
// after a compaction.
func (s *Server) save(force bool) bool {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	ix := s.current()
	s.mu.RLock()
	incomplete := s.scanning || s.meta.Incomplete
	meta := s.meta
	s.mu.RUnlock()
	gen := ix.Generation()
	if !force && !s.dirty && gen == s.savedGen && incomplete == s.savedIncomplete && s.saveOK {
		return false
	}
	// Compact right before the write when tombstones reach 5%: the old 20%
	// threshold never fired on a live index, so the snapshot only ever grew.
	// Compact is copy-on-write (see Index.Compact) and runs on the debounce
	// path, not while a scan is applying a diff.
	compacted := false
	if !s.isScanning() {
		st := ix.Stats()
		if st.Deleted >= minCompactDeleted && st.Deleted*compactDeletedRatio > st.Entries {
			compactStart := time.Now()
			before := ix.Generation()
			ix.Compact()
			if ix.Generation() != before {
				compacted = true
				s.saveStatsMu.Lock()
				s.compactCount++
				s.compactMs = time.Since(compactStart).Milliseconds()
				s.compactAt = time.Now()
				s.saveStatsMu.Unlock()
			}
		}
	}
	// Recording is enabled before the base is encoded: a mutation that races
	// the write is then recorded in the journal (and appended after the base)
	// instead of being lost between the two.
	if !ix.JournalEnabled() {
		ix.SetJournalEnabled(true)
	}
	marker := ix.JournalMarker()
	// The persisted generation is the pre-save one. A mutation that happens
	// during the save moves the live generation again, so the next autosave
	// tick persists it; being conservative here is always safe.
	gen = ix.Generation()
	meta.Version = s.opt.Version
	meta.Excludes = s.opt.Excludes
	meta.Incomplete = incomplete
	full := s.needsFullSave || compacted
	start := time.Now()
	res, err := store.SaveWith(s.opt.StateDir, ix, meta, store.SaveOptions{
		Full:            full,
		Compression:     s.opt.SnapshotCompression,
		JournalAfterSeq: marker,
	})
	took := time.Since(start)
	if err != nil {
		s.logf("save failed: %v", err)
		return false
	}
	if res.Full {
		// Entries at or below the marker went into the new base; whatever was
		// recorded while it was written stays for the next journal append.
		ix.JournalResetAfter(marker)
		s.needsFullSave = false
	}
	entries, jbytes, _ := ix.JournalStats()
	s.savedGen = gen
	s.observedGen = gen
	s.savedIncomplete = incomplete
	s.saveOK = true
	s.dirty = false
	s.lastSaveAt = time.Now()
	s.saveStatsMu.Lock()
	s.saveCount++
	s.saveBytes += res.SnapshotBytes + res.JournalBytes
	s.saveMs = took.Milliseconds()
	s.saveLastFull = res.Full
	s.snapshotFormat = res.Format
	s.journalEntries = int64(entries)
	s.journalBytes = jbytes
	s.saveStatsMu.Unlock()
	return true
}

// saveStats is the status view of the save/compact accounting.
type saveStats struct {
	count          int64
	bytes          int64
	ms             int64
	lastFull       bool
	format         uint32
	lastSaveAt     time.Time
	journalEntries int64
	journalBytes   int64
	compactCount   int64
	compactMs      int64
	compactAt      time.Time
}

func (s *Server) snapshotStats() saveStats {
	s.saveStatsMu.Lock()
	defer s.saveStatsMu.Unlock()
	return saveStats{
		count:          s.saveCount,
		bytes:          s.saveBytes,
		ms:             s.saveMs,
		lastFull:       s.saveLastFull,
		format:         s.snapshotFormat,
		lastSaveAt:     s.lastSaveAt,
		journalEntries: s.journalEntries,
		journalBytes:   s.journalBytes,
		compactCount:   s.compactCount,
		compactMs:      s.compactMs,
		compactAt:      s.compactAt,
	}
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
