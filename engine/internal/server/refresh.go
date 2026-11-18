package server

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
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
	Took    time.Duration
	At      time.Time
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
func (s *Server) periodicRefresh(ctx context.Context) {
	start := time.Now()
	s.mu.RLock()
	roots := append([]string(nil), s.opt.Roots...)
	excludes := append([]string(nil), s.opt.Excludes...)
	health := s.watch
	disable := s.opt.DisableIncrementalRefresh
	ix := s.ix
	s.mu.RUnlock()
	if ix == nil || ctx.Err() != nil {
		return
	}
	plan := planRefresh(roots, health, ix.Roots(), !disable)
	switch plan.Mode {
	case refreshSkip:
		s.logf("periodic refresh: %s", plan.Reason)
		s.recordRefresh("skipped", plan, 0, time.Since(start))
		return
	case refreshFull:
		s.logf("periodic refresh: full rebuild (%s)", plan.Reason)
		st := s.rebuildWith(ctx, roots, excludes)
		s.recordRefresh("full", plan, st.Entries, st.Took)
		return
	}
	s.logf("periodic refresh: rescanning %d of %d root(s); reusing healthy watched root(s): %s",
		len(plan.Rescan), len(roots), strings.Join(plan.Skipped, ", "))
	// A partial rescan briefly removes the degraded root's subtree. Flag the
	// scan so autosave does not persist that window and searches can report
	// indexing:true; the full-rebuild path builds a private index and adopts it
	// atomically instead.
	s.mu.Lock()
	s.scanning = true
	s.mu.Unlock()
	st, err := s.rescanRoots(ctx, ix, plan.Rescan)
	s.mu.Lock()
	s.scanning = false
	s.mu.Unlock()
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		s.logf("incremental refresh failed: %v; falling back to a full rebuild", err)
		full := plan
		full.Mode = refreshFull
		full.Reason = "incremental scan failed: " + err.Error()
		st = s.rebuildWith(ctx, roots, excludes)
		s.recordRefresh("full", full, st.Entries, st.Took)
		return
	}
	s.logf("periodic refresh: rescanned %d entries under %d root(s) in %s", st.Entries, len(plan.Rescan), st.Took.Round(time.Millisecond))
	s.recordRefresh("incremental", plan, st.Entries, st.Took)
	s.emitStats()
}

// rescanRoots drops the subtree of every root that needs refreshing and scans
// those roots back into the live index. Entries under healthy roots are left
// untouched (their watcher keeps them current), which is what makes a periodic
// refresh on a 9p+inotify profile seconds instead of a full rebuild.
func (s *Server) rescanRoots(ctx context.Context, ix *index.Index, roots []string) (scan.Stats, error) {
	for _, root := range roots {
		if ix.HasRoot(root) {
			ix.RemoveSubtree(root)
		}
	}
	// A partial refresh must not start a volume change watcher or enumerate a
	// whole MFT: the native watcher already covers the healthy roots and the
	// portable walk is scoped to exactly these roots.
	return s.scanRoots(ctx, ix, roots, false)
}

func (s *Server) recordRefresh(mode string, plan refreshPlan, entries int64, took time.Duration) {
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
