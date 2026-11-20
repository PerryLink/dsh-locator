package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/store"
	"github.com/PerryLink/dsh-locator/engine/internal/watch"
)

// refreshServer builds a two-root server whose health says the first root is
// watched and the second must be rescanned by the periodic refresh.
func refreshServer(t *testing.T, healthy, degraded string) (*Server, *index.Index) {
	t.Helper()
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
	s.watch = watch.Health{
		Roots:    2,
		Watching: 1,
		Degraded: true,
		Coverage: []watch.RootCoverage{
			{Path: filepath.Clean(healthy), Watched: true},
			{Path: filepath.Clean(degraded), Watched: false, Reason: "9p"},
		},
	}
	s.mu.Unlock()
	return s, ix
}

// TestPeriodicRefreshNoChangePersistsNothing: the P1-6 acceptance rule. A
// refresh that finds the same tree must not move the generation, mark the
// snapshot dirty or report a change.
func TestPeriodicRefreshNoChangePersistsNothing(t *testing.T) {
	healthy := t.TempDir()
	degraded := t.TempDir()
	s, ix := refreshServer(t, healthy, degraded)
	genBefore := ix.Generation()
	changed := s.periodicRefresh(context.Background())
	if changed {
		t.Fatal("no-change refresh reported a change")
	}
	if ix.Generation() != genBefore {
		t.Fatalf("no-change refresh moved the generation %d -> %d", genBefore, ix.Generation())
	}
	s.saveMu.Lock()
	dirty := s.dirty
	s.saveMu.Unlock()
	if dirty {
		t.Fatal("no-change refresh marked the snapshot dirty")
	}
	s.mu.RLock()
	report := s.lastRefresh
	s.mu.RUnlock()
	if report == nil || report.Mode != "incremental" || report.Changed {
		t.Fatalf("report = %+v, want an unchanged incremental refresh", report)
	}
	if report.Added != 0 || report.Removed != 0 {
		t.Fatalf("report counters = +%d/-%d, want zero", report.Added, report.Removed)
	}

	// A real change must show up in both the index and the diff counters.
	mustWrite(t, filepath.Join(degraded, "added.txt"))
	if err := os.Remove(filepath.Join(degraded, "old.txt")); err != nil {
		t.Fatal(err)
	}
	changed = s.periodicRefresh(context.Background())
	if !changed {
		t.Fatal("changed refresh reported no change")
	}
	if countFor(t, ix, "added") != 1 || countFor(t, ix, "old") != 0 {
		t.Fatal("diff refresh did not converge the degraded root")
	}
	s.mu.RLock()
	report = s.lastRefresh
	s.mu.RUnlock()
	if report.Added != 1 || report.Removed != 1 || !report.Changed {
		t.Fatalf("report = %+v, want +1/-1 changed", report)
	}
	s.saveMu.Lock()
	dirty = s.dirty
	s.saveMu.Unlock()
	if !dirty {
		t.Fatal("changed refresh did not mark the snapshot dirty")
	}
}

// TestDiffRefreshDoesNotAccumulateTombstones: the pre-0.20 reflection did a
// RemoveSubtree + re-append, so every periodic refresh left one tombstone per
// entry and eventually forced a compaction. The diff path must leave the record
// count and tombstone count untouched when nothing changed.
func TestDiffRefreshDoesNotAccumulateTombstones(t *testing.T) {
	healthy := t.TempDir()
	degraded := t.TempDir()
	for i := 0; i < 25; i++ {
		mustWrite(t, filepath.Join(degraded, fmt.Sprintf("file%02d.txt", i)))
	}
	s, ix := refreshServer(t, healthy, degraded)
	recordsBefore := ix.Stats().Records
	deletedBefore := ix.Stats().Deleted
	for i := 0; i < 5; i++ {
		if changed := s.periodicRefresh(context.Background()); changed {
			t.Fatalf("refresh %d reported a change for an untouched tree", i)
		}
	}
	st := ix.Stats()
	if st.Deleted != deletedBefore {
		t.Fatalf("tombstones grew from %d to %d over five idle refreshes", deletedBefore, st.Deleted)
	}
	if st.Records != recordsBefore {
		t.Fatalf("records grew from %d to %d over five idle refreshes", recordsBefore, st.Records)
	}
	s.mu.RLock()
	builtAt := s.meta.BuiltAt
	s.mu.RUnlock()
	if !builtAt.IsZero() {
		t.Fatalf("idle refreshes rewrote meta.BuiltAt to %v", builtAt)
	}
}

// TestNextRefreshDelayBackoff pins the exponential backoff with jitter.
func TestNextRefreshDelayBackoff(t *testing.T) {
	s := New(Options{RefreshInterval: time.Second})
	check := func(got time.Duration, min, max time.Duration) {
		t.Helper()
		if got < min || got > max {
			t.Fatalf("delay = %v, want %v..%v", got, min, max)
		}
	}
	check(s.nextRefreshDelay(false, 0), 1700*time.Millisecond, 2300*time.Millisecond)
	check(s.nextRefreshDelay(false, 0), 3500*time.Millisecond, 4600*time.Millisecond)
	// Capped at 8x the base interval.
	check(s.nextRefreshDelay(false, 0), 7000*time.Millisecond, 9100*time.Millisecond)
	check(s.nextRefreshDelay(false, 0), 7000*time.Millisecond, 9100*time.Millisecond)
	check(s.nextRefreshDelay(true, 0), 870*time.Millisecond, 1130*time.Millisecond)
	// A long refresh spaces the next one even when it changed the index.
	check(s.nextRefreshDelay(true, 10*time.Second), 17*time.Second, 23*time.Second)
	if s.setRefreshSchedule(time.Second) {
		t.Fatal("setRefreshSchedule succeeded without an active loop")
	}
	s.mu.Lock()
	s.refreshCancel = func() {}
	s.ix = index.New()
	s.mu.Unlock()
	if !s.setRefreshSchedule(time.Second) {
		t.Fatal("setRefreshSchedule failed with an active loop")
	}
	status := s.statusPayload()
	if got := status["refreshNextInMs"].(int64); got <= 0 || got > 1100 {
		t.Fatalf("refreshNextInMs = %d", got)
	}
}

// TestStatusObservability: P1-10 fields must be present with the documented
// types, and query latency history must advance.
func TestStatusObservability(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "report.txt"))
	ix := index.New()
	if _, err := scanForTest(t, ix, []string{root}); err != nil {
		t.Fatal(err)
	}
	s := New(Options{StateDir: t.TempDir(), Roots: []string{root}, Version: "test"})
	s.out = io.Discard
	s.opt.Log = io.Discard
	s.mu.Lock()
	s.ix = ix
	s.mu.Unlock()
	status := s.statusPayload()
	for _, key := range []string{"rssBytes", "hwmBytes", "heapBytes", "snapshotBytes", "watchDirs", "watchLimit", "queryCount", "lastQueryMs", "refreshBackoffMs"} {
		if _, ok := status[key]; !ok {
			t.Fatalf("status missing %q", key)
		}
	}
	if _, ok := status["watchLimited"].(bool); !ok {
		t.Fatalf("watchLimited = %v", status["watchLimited"])
	}
	if _, ok := status["watchInitializing"].(bool); !ok {
		t.Fatalf("watchInitializing = %v", status["watchInitializing"])
	}
	if got := status["builtAt"].(int64); got != ix.Stats().BuiltAt/int64(time.Millisecond) {
		t.Fatalf("builtAt = %d, want unix ms", got)
	}
	if got := status["recentQueryMs"].([]int64); len(got) != 0 {
		t.Fatalf("recentQueryMs = %v before any query", got)
	}
	if _, err := s.dispatch(context.Background(), request{Method: "search", Params: json.RawMessage(`{"query":"report","limit":5}`)}); err != nil {
		t.Fatal(err)
	}
	status = s.statusPayload()
	if got := status["queryCount"].(int64); got != 1 {
		t.Fatalf("queryCount = %d, want 1", got)
	}
	if got := status["recentQueryMs"].([]int64); len(got) != 1 {
		t.Fatalf("recentQueryMs = %v, want one sample", got)
	}
	if status["lastQueryMs"].(int64) < 0 {
		t.Fatalf("lastQueryMs = %v", status["lastQueryMs"])
	}
}

// TestReadyDoesNotWaitForWatcher: bootstrap must emit ready and answer status
// while the native watcher is still being installed, then converge to watching.
func TestReadyDoesNotWaitForWatcher(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 20; i++ {
		dir := filepath.Join(root, "dir"+string(rune('a'+i)))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	state := t.TempDir()
	ix := index.New()
	if _, err := scanForTest(t, ix, []string{root}); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(state, ix, store.Meta{Roots: []string{root}, Platform: "linux/amd64"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	srv := New(Options{StateDir: state, Roots: []string{root}, Watch: true, RefreshInterval: time.Hour, Version: "test"})
	done := make(chan error, 1)
	go func() { done <- srv.Run(ctx, inR, outW) }()
	scanner := bufio.NewScanner(outR)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	ready := waitForEvent(t, scanner, "ready")
	if ready["watching"] == true {
		// The watcher may legitimately win the race on a tiny tree; either way
		// ready must already have been emitted at this point.
		t.Logf("ready arrived with the watcher already installed")
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		writeLine(t, inW, map[string]any{"id": 1, "method": "status"})
		status := waitForID(t, scanner, 1)
		if status["watching"] == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("watcher never became live after ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	writeLine(t, inW, map[string]any{"id": 2, "method": "shutdown"})
	_ = waitForID(t, scanner, 2)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop")
	}
}

// TestWatchLimitStartsRefreshFallback: a snapshot loaded under a tiny watch
// budget must report watchLimited and turn on the periodic refresh instead of
// failing the watcher.
func TestWatchLimitStartsRefreshFallback(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("watchMaxDirs budgets the per-directory inotify watcher; other platforms use a single recursive handle")
	}
	root := t.TempDir()
	for i := 0; i < 6; i++ {
		dir := filepath.Join(root, "dir"+string(rune('a'+i)))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	state := t.TempDir()
	ix := index.New()
	if _, err := scanForTest(t, ix, []string{root}); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(state, ix, store.Meta{Roots: []string{root}, Platform: "linux/amd64"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	srv := New(Options{StateDir: state, Roots: []string{root}, Watch: true, WatchMaxDirs: 2, RefreshInterval: time.Hour, Version: "test"})
	done := make(chan error, 1)
	go func() { done <- srv.Run(ctx, inR, outW) }()
	scanner := bufio.NewScanner(outR)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	waitForEvent(t, scanner, "ready")
	deadline := time.Now().Add(10 * time.Second)
	for {
		writeLine(t, inW, map[string]any{"id": 1, "method": "status"})
		status := waitForID(t, scanner, 1)
		if status["watchLimited"] == true && status["refreshFallback"] == true {
			if got := status["watchLimit"].(float64); got != 2 {
				t.Fatalf("watchLimit = %v, want 2", got)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("watch-limited engine never started the refresh fallback: %v", status)
		}
		time.Sleep(10 * time.Millisecond)
	}
	writeLine(t, inW, map[string]any{"id": 2, "method": "shutdown"})
	_ = waitForID(t, scanner, 2)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop")
	}
	_ = index.New
}
