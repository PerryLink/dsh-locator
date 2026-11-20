package server

import (
	"context"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
	"github.com/PerryLink/dsh-locator/engine/internal/store"
	"github.com/PerryLink/dsh-locator/engine/internal/watch"
)

// refreshMode is the decision for one periodic-refresh tick.
type refreshMode int

const (
	// refreshSkip means every root has a live watcher: nothing to rescan.
	refreshSkip refreshMode = iota
	// refreshIncremental means only the named roots are rescanned; the rest
	// keep their entries because their native watchers are healthy.
	refreshIncremental
	// refreshFull means the whole index is rebuilt from every root.
	refreshFull
)

// refreshPlan is the pure decision behind the periodic refresh fallback.
// Keeping it free of watcher and filesystem hooks makes the "rescan only the
// degraded roots" rule directly testable.
type refreshPlan struct {
	Mode    refreshMode
	Rescan  []string
	Skipped []string
	Reason  string
}

// refreshReport is the recorded outcome of the last periodic refresh.
type refreshReport struct {
	Mode    string
	Reason  string
	Scanned []string
	Skipped []string
	Entries int64
	// Added/Removed are the upsert-diff counters of an incremental refresh.
	Added   int64
	Removed int64
	// Changed is false when the refresh found the tree identical to the index;
	// such a refresh persists nothing (no generation move, no snapshot write).
	Changed bool
	Took    time.Duration
	At      time.Time
}

// refreshChanges carries the diff counters of one incremental refresh.
type refreshChanges struct {
	Added   int64
	Removed int64
	Changed bool
}

// planRefresh decides what a periodic refresh should rescan. incremental is
// false when the operator disabled the optimisation; then every tick rebuilds
// the whole index exactly like releases before 0.19.0 did.
func planRefresh(roots []string, health watch.Health, indexedRoots []string, incremental bool) refreshPlan {
	if len(roots) == 0 {
		return refreshPlan{Mode: refreshSkip, Reason: "no roots configured"}
	}
	if !incremental {
		return refreshPlan{Mode: refreshFull, Reason: "incremental refresh disabled"}
	}
	if !sameRootSet(roots, indexedRoots) {
		return refreshPlan{Mode: refreshFull, Reason: "configured roots changed"}
	}
	if health.Watching == 0 || len(health.Coverage) != len(roots) {
		return refreshPlan{Mode: refreshFull, Reason: "watcher did not report per-root coverage"}
	}
	covered := make(map[string]watch.RootCoverage, len(health.Coverage))
	for _, c := range health.Coverage {
		covered[filepath.Clean(c.Path)] = c
	}
	rescan := make([]string, 0, len(roots))
	skipped := make([]string, 0, len(roots))
	for _, root := range roots {
		c, ok := covered[filepath.Clean(root)]
		if !ok {
			return refreshPlan{Mode: refreshFull, Reason: "watcher coverage does not include " + root}
		}
		if c.Watched {
			skipped = append(skipped, root)
		} else {
			rescan = append(rescan, root)
		}
	}
	switch {
	case len(rescan) == 0:
		if health.Degraded {
			// The watcher says coverage is incomplete but every root claims a
			// live watch (for example a dropped notification stream). The
			// damaged root cannot be identified, so fall back to a full scan.
			return refreshPlan{Mode: refreshFull, Reason: "watcher is degraded but every root is still watched"}
		}
		return refreshPlan{Mode: refreshSkip, Reason: "all roots have a live watcher"}
	case len(rescan) == len(roots):
		return refreshPlan{Mode: refreshFull, Reason: "no healthy watched root to preserve"}
	default:
		return refreshPlan{
			Mode:    refreshIncremental,
			Rescan:  rescan,
			Skipped: skipped,
			Reason:  "rescanning unwatched roots only",
		}
	}
}

// sameRootSet reports whether two root lists name the same directories.
func sameRootSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	counts := make(map[string]int, len(a))
	for _, root := range a {
		counts[filepath.Clean(root)]++
	}
	for _, root := range b {
		counts[filepath.Clean(root)]--
	}
	for _, n := range counts {
		if n != 0 {
			return false
		}
	}
	return true
}

// periodicRefresh runs one tick of the fallback loop. It rescans only roots the
// watcher cannot cover and reuses the live index for healthy watched roots; any
// structural change or scan failure falls back to a full rebuild.
//
// The return value reports whether the refresh actually changed the index. A
// no-change tick leaves the generation alone, persists nothing, and lets the
// fallback loop back off instead of hammering a slow 9p root.
func (s *Server) periodicRefresh(ctx context.Context) bool {
	start := time.Now()
	s.mu.RLock()
	roots := append([]string(nil), s.opt.Roots...)
	excludes := append([]string(nil), s.opt.Excludes...)
	health := s.watch
	disable := s.opt.DisableIncrementalRefresh
	ix := s.ix
	s.mu.RUnlock()
	if ix == nil || ctx.Err() != nil {
		return false
	}
	plan := planRefresh(roots, health, ix.Roots(), !disable)
	switch plan.Mode {
	case refreshSkip:
		s.logf("periodic refresh: %s", plan.Reason)
		s.recordRefresh("skipped", plan, 0, time.Since(start))
		return false
	case refreshFull:
		s.logf("periodic refresh: full rebuild (%s)", plan.Reason)
		st := s.rebuildWith(ctx, roots, excludes)
		s.recordRefresh("full", plan, st.Entries, st.Took, refreshChanges{Changed: true})
		return true
	}
	s.logf("periodic refresh: rescanning %d of %d root(s); reusing healthy watched root(s): %s",
		len(plan.Rescan), len(roots), strings.Join(plan.Skipped, ", "))
	// Flag the scan so autosave does not persist a half-applied diff and
	// searches can report indexing:true. The diff itself applies in chunks, so
	// readers are never blocked for the whole rescan.
	s.mu.Lock()
	s.scanning = true
	s.mu.Unlock()
	genBefore := ix.Generation()
	st, diff, err := s.diffRescanRoots(ctx, ix, plan.Rescan)
	s.mu.Lock()
	s.scanning = false
	s.mu.Unlock()
	if err != nil {
		if ctx.Err() != nil {
			return false
		}
		s.logf("incremental refresh failed: %v; falling back to a full rebuild", err)
		full := plan
		full.Mode = refreshFull
		full.Reason = "incremental scan failed: " + err.Error()
		st = s.rebuildWith(ctx, roots, excludes)
		s.recordRefresh("full", full, st.Entries, st.Took, refreshChanges{Changed: true})
		return true
	}
	changed := ix.Generation() != genBefore
	if changed {
		// Rescanning changes the meta a snapshot must carry; an unchanged tick
		// deliberately leaves meta and dirty state alone.
		s.noteRescanMeta(ix, st)
		s.markDirty()
	}
	s.logf("periodic refresh: rescanned %d entries under %d root(s) in %s (added %d, removed %d, changed %v)",
		st.Entries, len(plan.Rescan), time.Since(start).Round(time.Millisecond), diff.Added, diff.Removed, changed)
	s.recordRefresh("incremental", plan, st.Entries, time.Since(start),
		refreshChanges{Added: int64(diff.Added), Removed: int64(diff.Removed), Changed: changed})
	s.emitStats()
	return changed
}

// rescanRoots reconciles every named root with a fresh scan of just that root.
//
// The pre-0.20 code removed the whole root subtree (a full-table sweep that
// stalled writes for ~0.6s on 9p) and re-appended every entry, creating one
// tombstone per entry and eventually a compaction. The upsert diff removes only
// vanished paths and updates the rest in place, so an unchanged root touches
// nothing.
func (s *Server) rescanRoots(ctx context.Context, ix *index.Index, roots []string) (scan.Stats, error) {
	st, _, err := s.diffRescanRoots(ctx, ix, roots)
	return st, err
}

// diffRescanRoots scans each root into a private index and applies the diff to
// the live one. Healthy watched roots are not in the list and stay untouched.
func (s *Server) diffRescanRoots(ctx context.Context, ix *index.Index, roots []string) (scan.Stats, index.DiffStats, error) {
	var total scan.Stats
	var diff index.DiffStats
	if len(roots) == 0 {
		return total, diff, nil
	}
	s.event("scan", map[string]any{"phase": "start", "roots": roots})
	for _, root := range roots {
		if ctx.Err() != nil {
			return total, diff, ctx.Err()
		}
		fresh := index.New()
		st, err := scan.Run(ctx, fresh, s.scanOptions([]string{root}))
		if err != nil {
			return total, diff, err
		}
		if !ix.HasRoot(root) {
			ix.AddRoot(root)
		}
		d := ix.DiffSubtree(root, fresh)
		diff.Added += d.Added
		diff.Removed += d.Removed
		total.Roots++
		total.Entries += st.Entries
		total.Files += st.Files
		total.Dirs += st.Dirs
		total.Skipped += st.Skipped
		total.Errors += st.Errors
		total.Took += st.Took
	}
	s.event("scan", map[string]any{"phase": "done", "entries": total.Entries, "tookMs": total.Took.Milliseconds()})
	return total, diff, nil
}

// scanOptions builds the scanner configuration a partial refresh uses. It never
// enables USN: a volume enumeration would cover more than the refreshed roots
// and start its own change watcher next to the live one.
func (s *Server) scanOptions(roots []string) scan.Options {
	return scan.Options{
		Roots:         roots,
		Excludes:      s.opt.Excludes,
		IncludeCaches: s.opt.IncludeCaches,
		Workers:       s.opt.ScanWorkers,
		Progress: func(p scan.Progress) {
			s.event("scan", map[string]any{"phase": "progress", "entries": p.Entries, "current": p.Current})
		},
		ProgressEvery: time.Second,
	}
}

// noteRescanMeta records the scan statistics of a changed incremental refresh
// without rebuilding the whole meta by hand.
func (s *Server) noteRescanMeta(ix *index.Index, st scan.Stats) {
	s.mu.Lock()
	s.meta.Version = s.opt.Version
	s.meta.Roots = ix.Roots()
	s.meta.Excludes = s.opt.Excludes
	s.meta.BuiltAt = time.Now()
	s.meta.Stats = st
	s.mu.Unlock()
}

func (s *Server) recordRefresh(mode string, plan refreshPlan, entries int64, took time.Duration, changes ...refreshChanges) {
	if took < 0 {
		took = 0
	}
	r := &refreshReport{
		Mode:    mode,
		Reason:  plan.Reason,
		Scanned: append([]string{}, plan.Rescan...),
		Skipped: append([]string{}, plan.Skipped...),
		Entries: entries,
		Took:    took,
		At:      time.Now(),
	}
	if len(changes) > 0 {
		r.Added = changes[0].Added
		r.Removed = changes[0].Removed
		r.Changed = changes[0].Changed
	}
	s.mu.Lock()
	s.lastRefresh = r
	s.mu.Unlock()
}

// unwatchedRoots lists the roots the watcher does not cover. It is empty when
// the backend does not report per-root coverage.
func unwatchedRoots(health watch.Health) []string {
	out := make([]string, 0, len(health.Coverage))
	for _, c := range health.Coverage {
		if !c.Watched {
			out = append(out, c.Path)
		}
	}
	return out
}

// Refresh backoff: an unchanged tick doubles the wait up to 8x the configured
// interval, and every delay gets jitter so profiles started together do not
// rescan in lock-step. A changed tick resets the delay to the configured value.
const refreshBackoffCap = 3

// nextRefreshDelay advances the backoff state and returns the next delay. An
// unchanged tick doubles the wait; a refresh that itself took a long time (a
// slow 9p rescan) also spaces the next one so heavy scans cannot run back to
// back.
func (s *Server) nextRefreshDelay(changed bool, took time.Duration) time.Duration {
	base := s.opt.RefreshInterval
	s.mu.Lock()
	if changed {
		s.refreshIdle = 0
	} else if s.refreshIdle < refreshBackoffCap {
		s.refreshIdle++
	}
	idle := s.refreshIdle
	s.mu.Unlock()
	delay := base << uint(idle)
	if took > base/2 && 2*took > delay {
		delay = 2 * took
	}
	// +/-12% jitter.
	jitter := 0.88 + 0.24*rand.Float64()
	return time.Duration(float64(delay) * jitter)
}

// setRefreshSchedule records the delay the fallback loop will wait next and
// reports whether the loop is still active.
func (s *Server) setRefreshSchedule(delay time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.refreshCancel == nil {
		return false
	}
	s.refreshDelay = delay
	s.refreshNextAt = time.Now().Add(delay)
	return true
}

// queryRingSize is the number of recent query latencies status keeps.
const queryRingSize = 16

// recordQuery appends one query latency to the status ring.
func (s *Server) recordQuery(d time.Duration) {
	ms := d.Milliseconds()
	s.queryCount.Add(1)
	s.queryMu.Lock()
	s.recentQueryMs[s.recentQueryN%queryRingSize] = ms
	s.recentQueryN++
	s.queryMu.Unlock()
}

// queryStats returns the query count and the recent latency history, oldest
// first.
func (s *Server) queryStats() (count int64, last int64, recent []int64) {
	count = s.queryCount.Load()
	s.queryMu.Lock()
	n := s.recentQueryN
	recent = make([]int64, 0, queryRingSize)
	start := 0
	if n > queryRingSize {
		start = n - queryRingSize
	}
	for i := start; i < n; i++ {
		recent = append(recent, s.recentQueryMs[i%queryRingSize])
	}
	s.queryMu.Unlock()
	if len(recent) > 0 {
		last = recent[len(recent)-1]
	}
	return count, last, recent
}

// statusMetrics is the engine-side resource snapshot status exposes.
type statusMetrics struct {
	rss           int64
	hwm           int64
	heap          int64
	snapshotBytes int64
	numGC         uint32
}

// metricsTTL bounds how often status pays for /proc and a snapshot stat.
const metricsTTL = time.Second

// statusMetrics samples process memory and the snapshot footprint, cached for a
// second so a polling panel does not re-read /proc on every request.
func (s *Server) statusMetrics() statusMetrics {
	s.metricsMu.Lock()
	defer s.metricsMu.Unlock()
	now := time.Now()
	if !s.metricsAt.IsZero() && now.Sub(s.metricsAt) < metricsTTL {
		return s.metrics
	}
	var m statusMetrics
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	m.heap = int64(ms.HeapAlloc)
	m.numGC = ms.NumGC
	m.rss, m.hwm = processRSS()
	if snap, _ := store.Paths(s.opt.StateDir); snap != "" {
		if info, err := os.Stat(snap); err == nil {
			m.snapshotBytes = info.Size()
		}
	}
	s.metrics = m
	s.metricsAt = now
	return m
}

// processRSS reads the resident set size and high-water mark from /proc. Both
// are zero on platforms without procfs.
func processRSS() (rss, hwm int64) {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		switch {
		case strings.HasPrefix(line, "VmRSS:"):
			rss = parseProcKB(line)
		case strings.HasPrefix(line, "VmHWM:"):
			hwm = parseProcKB(line)
		}
	}
	return rss, hwm
}

// parseProcKB turns a "VmRSS:  12345 kB" line into bytes.
func parseProcKB(line string) int64 {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0
	}
	n, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return n * 1024
}
