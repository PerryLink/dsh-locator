package server

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
	"github.com/PerryLink/dsh-locator/engine/internal/watch"
)

// TestPlanRefresh covers the core P1-4 rule: when the watcher reports healthy
// coverage for some roots and degraded coverage for others, a periodic refresh
// must rescan only the degraded roots and reuse the healthy ones.
func TestPlanRefresh(t *testing.T) {
	home := filepath.Clean("/home/user")
	remote := filepath.Clean("/mnt/c")
	roots := []string{home, remote}
	partial := watch.Health{
		Roots:    2,
		Watching: 1,
		Degraded: true,
		Reason:   "9p/DrvFs does not deliver inotify events",
		Coverage: []watch.RootCoverage{
			{Path: home, Watched: true},
			{Path: remote, Watched: false, Reason: "9p/DrvFs does not deliver inotify events"},
		},
	}
	tests := []struct {
		name        string
		roots       []string
		health      watch.Health
		indexed     []string
		incremental bool
		wantMode    refreshMode
		wantRescan  []string
		wantSkipped []string
	}{
		{
			name:        "partial coverage rescans only the unwatched root",
			roots:       roots,
			health:      partial,
			indexed:     roots,
			incremental: true,
			wantMode:    refreshIncremental,
			wantRescan:  []string{remote},
			wantSkipped: []string{home},
		},
		{
			name:  "complete healthy coverage skips the rescan",
			roots: []string{home},
			health: watch.Health{Roots: 1, Watching: 1, Coverage: []watch.RootCoverage{
				{Path: home, Watched: true},
			}},
			indexed:     []string{home},
			incremental: true,
			wantMode:    refreshSkip,
		},
		{
			name:  "degraded without an identifiable root falls back to full",
			roots: []string{home},
			health: watch.Health{Roots: 1, Watching: 1, Degraded: true, Coverage: []watch.RootCoverage{
				{Path: home, Watched: true},
			}},
			indexed:     []string{home},
			incremental: true,
			wantMode:    refreshFull,
		},
		{
			name:        "no per-root coverage falls back to full",
			roots:       roots,
			health:      watch.Health{Roots: 2, Watching: 1, Degraded: true, Reason: "partial"},
			indexed:     roots,
			incremental: true,
			wantMode:    refreshFull,
		},
		{
			name:  "coverage does not name every configured root",
			roots: roots,
			health: watch.Health{Roots: 2, Watching: 1, Degraded: true, Coverage: []watch.RootCoverage{
				{Path: home, Watched: true},
			}},
			indexed:     roots,
			incremental: true,
			wantMode:    refreshFull,
		},
		{
			name:  "every root unwatched means there is nothing to reuse",
			roots: []string{home, remote},
			health: watch.Health{Roots: 2, Watching: 0, Degraded: true, Coverage: []watch.RootCoverage{
				{Path: home, Watched: false, Reason: "watch limit"},
				{Path: remote, Watched: false, Reason: "9p"},
			}},
			indexed:     roots,
			incremental: true,
			wantMode:    refreshFull,
		},
		{
			name:        "disabled optimisation always rebuilds everything",
			roots:       roots,
			health:      partial,
			indexed:     roots,
			incremental: false,
			wantMode:    refreshFull,
		},
		{
			name:        "configured roots changed since the index was built",
			roots:       roots,
			health:      partial,
			indexed:     []string{home},
			incremental: true,
			wantMode:    refreshFull,
		},
		{
			name:        "no roots configured",
			roots:       nil,
			health:      partial,
			indexed:     nil,
			incremental: true,
			wantMode:    refreshSkip,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			plan := planRefresh(tc.roots, tc.health, tc.indexed, tc.incremental)
			if plan.Mode != tc.wantMode {
				t.Fatalf("mode = %v, want %v (%s)", plan.Mode, tc.wantMode, plan.Reason)
			}
			if !sameRootSet(plan.Rescan, tc.wantRescan) {
				t.Fatalf("rescan = %v, want %v", plan.Rescan, tc.wantRescan)
			}
			if !sameRootSet(plan.Skipped, tc.wantSkipped) {
				t.Fatalf("skipped = %v, want %v", plan.Skipped, tc.wantSkipped)
			}
			if plan.Reason == "" {
				t.Fatal("plan has no human-readable reason")
			}
		})
	}
}

func TestSameRootSet(t *testing.T) {
	a := []string{filepath.Clean("/a"), filepath.Clean("/b")}
	b := []string{filepath.Clean("/b"), filepath.Clean("/a")}
	if !sameRootSet(a, b) {
		t.Fatal("same roots in a different order compare unequal")
	}
	if sameRootSet(a, []string{filepath.Clean("/a")}) {
		t.Fatal("different root counts compare equal")
	}
	if sameRootSet(a, []string{filepath.Clean("/a"), filepath.Clean("/c")}) {
		t.Fatal("different roots compare equal")
	}
}

// TestRescanRootsReusesHealthyRoot scans two roots, changes files in both, and
// rescans only the degraded one: the untouched root must keep its entries
// (including a file the watcher would have added), while the degraded root
// converges to disk.
func TestRescanRootsReusesHealthyRoot(t *testing.T) {
	healthy := t.TempDir()
	degraded := t.TempDir()
	mustWrite(t, filepath.Join(healthy, "keep.txt"))
	mustWrite(t, filepath.Join(degraded, "old.txt"))

	ix := index.New()
	if _, err := scanForTest(t, ix, []string{healthy, degraded}); err != nil {
		t.Fatal(err)
	}
	s := New(Options{StateDir: t.TempDir(), Roots: []string{healthy, degraded}, Version: "test"})
	s.out = io.Discard
	s.opt.Log = io.Discard
	s.mu.Lock()
	s.ix = ix
	s.mu.Unlock()

	// The watcher would have indexed healthy/new.txt already; this test leaves
	// it out of the index to prove rescanRoots never touches the healthy root.
	mustWrite(t, filepath.Join(healthy, "new.txt"))
	mustWrite(t, filepath.Join(degraded, "added.txt"))
	if err := os.Remove(filepath.Join(degraded, "old.txt")); err != nil {
		t.Fatal(err)
	}

	st, err := s.rescanRoots(context.Background(), ix, []string{degraded})
	if err != nil {
		t.Fatalf("rescanRoots: %v", err)
	}
	if st.Entries == 0 {
		t.Fatal("rescan did not scan the degraded root")
	}
	if got := countFor(t, ix, "keep"); got != 1 {
		t.Fatalf("healthy root entries were lost: keep=%d", got)
	}
	if got := countFor(t, ix, "new"); got != 0 {
		t.Fatalf("rescan touched the healthy root: new=%d", got)
	}
	if got := countFor(t, ix, "added"); got != 1 {
		t.Fatalf("degraded root did not converge: added=%d", got)
	}
	if got := countFor(t, ix, "old"); got != 0 {
		t.Fatalf("deleted file survived the rescan: old=%d", got)
	}
	if !sameRootSet(ix.Roots(), []string{healthy, degraded}) {
		t.Fatalf("roots = %v", ix.Roots())
	}
}

// TestStatusReportsIncrementalRefresh: status must expose the feature flag, the
// per-root coverage gap and the last refresh decision so health/diagnostics can
// show that a rebuild skipped healthy roots.
func TestStatusReportsIncrementalRefresh(t *testing.T) {
	s := New(Options{Version: "test", Roots: []string{"/a", "/b"}})
	ix := index.New()
	ix.AddRoot("/a")
	ix.AddRoot("/b")
	home := filepath.Clean("/a")
	remote := filepath.Clean("/b")
	plan := refreshPlan{
		Mode:    refreshIncremental,
		Rescan:  []string{remote},
		Skipped: []string{home},
		Reason:  "rescanning unwatched roots only",
	}
	s.mu.Lock()
	s.ix = ix
	s.watch = watch.Health{
		Roots:    2,
		Watching: 1,
		Degraded: true,
		Coverage: []watch.RootCoverage{
			{Path: home, Watched: true},
			{Path: remote, Watched: false, Reason: "9p"},
		},
	}
	s.mu.Unlock()
	s.recordRefresh("incremental", plan, 123, 4*time.Millisecond)

	status := s.statusPayload()
	if status["incrementalRefresh"] != true {
		t.Fatalf("incrementalRefresh = %v", status["incrementalRefresh"])
	}
	if status["refreshMode"] != "incremental" {
		t.Fatalf("refreshMode = %v", status["refreshMode"])
	}
	if status["refreshReason"] != plan.Reason {
		t.Fatalf("refreshReason = %v", status["refreshReason"])
	}
	if got := status["refreshScannedRoots"].([]string); len(got) != 1 || got[0] != remote {
		t.Fatalf("refreshScannedRoots = %v", got)
	}
	if got := status["refreshSkippedRoots"].([]string); len(got) != 1 || got[0] != home {
		t.Fatalf("refreshSkippedRoots = %v", got)
	}
	if got := status["refreshEntries"].(int64); got != 123 {
		t.Fatalf("refreshEntries = %v", got)
	}
	if got := status["refreshTookMs"].(int64); got != 4 {
		t.Fatalf("refreshTookMs = %v", got)
	}
	if got := status["watchUnwatchedRoots"].([]string); len(got) != 1 || got[0] != remote {
		t.Fatalf("watchUnwatchedRoots = %v", got)
	}

	disabled := New(Options{Version: "test", Roots: []string{"/a"}, DisableIncrementalRefresh: true})
	disabledIx := index.New()
	disabledIx.AddRoot("/a")
	disabled.mu.Lock()
	disabled.ix = disabledIx
	disabled.mu.Unlock()
	if disabled.statusPayload()["incrementalRefresh"] != false {
		t.Fatal("incrementalRefresh does not reflect --no-incremental-refresh")
	}
}

// TestPeriodicRefreshFallsBackToFull: when the incremental scan of a degraded
// root fails (for example the mount vanished while the watcher kept running),
// the refresh must not leave the index half-updated; it rebuilds everything.
func TestPeriodicRefreshFallsBackToFull(t *testing.T) {
	good := t.TempDir()
	bad := t.TempDir()
	mustWrite(t, filepath.Join(good, "keep.txt"))
	mustWrite(t, filepath.Join(bad, "gone.txt"))
	ix := index.New()
	if _, err := scanForTest(t, ix, []string{good, bad}); err != nil {
		t.Fatal(err)
	}
	s := New(Options{StateDir: t.TempDir(), Roots: []string{good, bad}, Version: "test"})
	s.out = io.Discard
	s.opt.Log = io.Discard
	s.mu.Lock()
	s.ix = ix
	s.watch = watch.Health{
		Roots:    2,
		Watching: 1,
		Degraded: true,
		Coverage: []watch.RootCoverage{
			{Path: good, Watched: true},
			{Path: bad, Watched: false, Reason: "mount vanished"},
		},
	}
	s.mu.Unlock()

	if err := os.RemoveAll(bad); err != nil {
		t.Fatal(err)
	}
	s.periodicRefresh(context.Background())

	s.mu.RLock()
	report := s.lastRefresh
	s.mu.RUnlock()
	if report == nil {
		t.Fatal("refresh did not record a report")
	}
	if report.Mode != "full" {
		t.Fatalf("refresh mode = %q, want full after the incremental scan failed", report.Mode)
	}
	if !strings.Contains(report.Reason, "incremental scan failed") {
		t.Fatalf("refresh reason = %q", report.Reason)
	}
	if countFor(t, s.current(), "keep") != 1 {
		t.Fatal("fallback rebuild lost the healthy root entries")
	}
	if countFor(t, s.current(), "gone") != 0 {
		t.Fatal("fallback rebuild kept entries from the vanished root")
	}
}

func TestRescanRootsErrorsOnUnreadableRoot(t *testing.T) {
	ix := index.New()
	s := New(Options{StateDir: t.TempDir(), Version: "test"})
	s.out = io.Discard
	s.opt.Log = io.Discard
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	if _, err := s.rescanRoots(context.Background(), ix, []string{missing}); err == nil {
		t.Fatal("rescanRoots accepted a missing root")
	}
}

func scanForTest(t *testing.T, ix *index.Index, roots []string) (scan.Stats, error) {
	t.Helper()
	return scan.Run(context.Background(), ix, scan.Options{Roots: roots, Workers: 2})
}

func mustWrite(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func countFor(t *testing.T, ix *index.Index, query string) int {
	t.Helper()
	q, err := index.ParseQuery(query)
	if err != nil {
		t.Fatal(err)
	}
	q.Limit = 10
	res, err := ix.Search(q)
	if err != nil {
		t.Fatal(err)
	}
	return res.Total
}
