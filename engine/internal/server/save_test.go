package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/store"
	"github.com/PerryLink/dsh-locator/engine/internal/watch"
)

// runEngineOnce starts a server, waits for the initial scan, then shuts it down
// through the protocol. It is used to test what shutdown does (and does not)
// write to the state directory.
func runEngineOnce(t *testing.T, state, root string, wantEntries float64) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	srv := New(Options{StateDir: state, Roots: []string{root}, Version: "test"})
	done := make(chan error, 1)
	go func() { done <- srv.Run(ctx, inR, outW) }()
	scanner := bufio.NewScanner(outR)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	waitForEvent(t, scanner, "ready")
	waitForEntries(t, scanner, inW, wantEntries)
	waitForScanDone(t, scanner, inW)
	writeLine(t, inW, map[string]any{"id": 1, "method": "shutdown"})
	_ = waitForID(t, scanner, 1)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("server run: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("server did not stop")
	}
}

// TestShutdownDoesNotRewriteCleanSnapshot: a start that only loads an existing
// snapshot and then shuts down must leave the 100+ MB file untouched instead of
// rewriting it just because the process is exiting.
func TestShutdownDoesNotRewriteCleanSnapshot(t *testing.T) {
	root := t.TempDir()
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	runEngineOnce(t, state, root, 2) // root dir + a.txt

	snap, metaPath := store.Paths(state)
	snapBefore, err := os.ReadFile(snap)
	if err != nil {
		t.Fatalf("first run did not write a snapshot: %v", err)
	}
	metaBefore, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("first run did not write meta: %v", err)
	}
	snapInfo, err := os.Stat(snap)
	if err != nil {
		t.Fatal(err)
	}
	snapMtime := snapInfo.ModTime()
	time.Sleep(20 * time.Millisecond)

	runEngineOnce(t, state, root, 2)

	if now := mustStatModTime(t, snap); !now.Equal(snapMtime) {
		t.Fatalf("clean shutdown rewrote the snapshot (mtime %s -> %s)", snapMtime, now)
	}
	snapAfter, err := os.ReadFile(snap)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapAfter) != len(snapBefore) {
		t.Fatalf("snapshot size changed on clean shutdown: %d -> %d", len(snapBefore), len(snapAfter))
	}
	metaAfter, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(metaAfter) != string(metaBefore) {
		t.Fatalf("meta.json changed on clean shutdown:\n%s\n---\n%s", metaBefore, metaAfter)
	}
}

// waitForScanDone polls status until the asynchronous initial scan has finished,
// so shutdown saves a complete snapshot.
func waitForScanDone(t *testing.T, scanner *bufio.Scanner, in io.Writer) {
	t.Helper()
	id := 900
	for attempt := 0; attempt < 200; attempt++ {
		requestID := id
		id++
		writeLine(t, in, map[string]any{"id": requestID, "method": "status"})
		status := waitForID(t, scanner, float64(requestID))
		if status["scanning"] != true {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("initial scan never finished")
}

func mustStatModTime(t *testing.T, path string) time.Time {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.ModTime()
}

// TestDumpSinceGenerationSkipsUnchangedIndex covers the lightweight content
// refresh path: when the caller's generation equals the engine's, dump answers
// without walking the index.
func TestDumpSinceGenerationSkipsUnchangedIndex(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(Options{StateDir: t.TempDir(), Roots: []string{root}, Version: "test"})
	ix := index.New()
	ix.AddRoot(root)
	ix.AddPath(filepath.Join(root, "a.txt"), index.FileInfo{Size: 1, Mode: 0o644})
	s.mu.Lock()
	s.ix = ix
	s.mu.Unlock()
	gen := ix.Generation()

	raw, err := json.Marshal(map[string]any{"since": gen})
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.dispatch(context.Background(), request{Method: "dump", Params: raw})
	if err != nil {
		t.Fatal(err)
	}
	m := res.(map[string]any)
	if m["unchanged"] != true {
		t.Fatalf("since=current generation did not report unchanged: %v", m)
	}
	if entries := m["entries"].([]index.DumpEntry); len(entries) != 0 {
		t.Fatalf("unchanged dump returned %d entries", len(entries))
	}
	if got := m["generation"].(uint64); got != gen {
		t.Fatalf("dump generation = %d, want %d", got, gen)
	}

	res, err = s.dispatch(context.Background(), request{Method: "dump", Params: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	m = res.(map[string]any)
	entries := m["entries"].([]index.DumpEntry)
	if len(entries) != 2 {
		t.Fatalf("full dump returned %d entries, want 2", len(entries))
	}
	if m["done"] != true {
		t.Fatalf("full dump of a tiny index should be done: %v", m["done"])
	}
}

// TestRefreshFallbackHonoursZeroInterval: --refresh 0 must disable the periodic
// rebuild fallback entirely.
func TestRefreshFallbackHonoursZeroInterval(t *testing.T) {
	s := New(Options{Watch: true, RefreshInterval: 0})
	s.startRefreshFallback(context.Background())
	if s.refreshActive() {
		t.Fatal("refresh interval 0 started the fallback loop")
	}
	s.startRefreshFallback(context.Background())
	if s.refreshActive() {
		t.Fatal("disabled fallback started on retry")
	}

	s.opt.RefreshInterval = time.Hour
	s.startRefreshFallback(context.Background())
	if !s.refreshActive() {
		t.Fatal("positive refresh interval did not start the fallback loop")
	}
	s.stopRefreshFallback()
	if s.refreshActive() {
		t.Fatal("stopRefreshFallback left the loop active")
	}
}

// TestSaveOnlyWhenDirty: repeated saves with no changes must be no-ops, while a
// dirty generation writes exactly once.
func TestSaveOnlyWhenDirty(t *testing.T) {
	state := t.TempDir()
	s := New(Options{StateDir: state, Version: "test", SaveDebounce: time.Millisecond})
	ix := index.New()
	root := filepath.Join(state, "root")
	ix.AddRoot(root)
	s.mu.Lock()
	s.ix = ix
	s.meta = store.Meta{Version: "test", Roots: []string{root}}
	s.mu.Unlock()
	// Pretend a snapshot was just loaded, so the first save is a no-op.
	s.saveMu.Lock()
	s.saveOK = true
	s.savedGen = ix.Generation()
	s.observedGen = s.savedGen
	s.saveMu.Unlock()

	if s.save(false) {
		t.Fatal("save wrote a snapshot although nothing changed")
	}
	s.markDirty()
	if !s.save(false) {
		t.Fatal("save skipped a dirty index")
	}
	snap, _ := store.Paths(state)
	if _, err := os.Stat(snap); err != nil {
		t.Fatalf("dirty save did not write a snapshot: %v", err)
	}
	if s.save(false) {
		t.Fatal("second save rewrote an unchanged snapshot")
	}
	if !s.save(true) {
		t.Fatal("forced save did not write")
	}
}

// TestSaveDebounceAndMaxInterval checks the two timing knobs: quiet writes wait
// for the debounce, and continuous changes are capped by the max interval.
func TestSaveDebounceAndMaxInterval(t *testing.T) {
	s := New(Options{SaveDebounce: 60 * time.Second, SaveMaxInterval: 5 * time.Minute})
	s.observeGeneration(7)
	if s.saveDue() {
		t.Fatal("save is due immediately after a change")
	}
	s.saveMu.Lock()
	s.dirtySince = time.Now().Add(-61 * time.Second)
	s.saveMu.Unlock()
	if !s.saveDue() {
		t.Fatal("save is not due after the debounce interval")
	}

	s2 := New(Options{SaveDebounce: 60 * time.Second, SaveMaxInterval: 5 * time.Minute})
	s2.observeGeneration(9)
	s2.saveMu.Lock()
	s2.lastSaveAt = time.Now().Add(-6 * time.Minute)
	s2.saveMu.Unlock()
	if !s2.saveDue() {
		t.Fatal("save is not due after the max interval")
	}
}

// TestStatusReportsGenerationAndWatchHealth: status is how the host learns the
// engine generation for a zero-cost refresh check and whether watching is
// degraded.
func TestStatusReportsGenerationAndWatchHealth(t *testing.T) {
	s := New(Options{Version: "test", Roots: []string{"/x"}})
	ix := index.New()
	ix.AddRoot("/x")
	s.mu.Lock()
	s.ix = ix
	s.watch = watch.Health{Roots: 2, Watching: 1, Degraded: true, Reason: "root 2 failed"}
	s.mu.Unlock()

	status := s.statusPayload()
	if got := status["generation"].(uint64); got != ix.Generation() {
		t.Fatalf("status generation = %d, want %d", got, ix.Generation())
	}
	if status["watchDegraded"] != true {
		t.Fatalf("status watchDegraded = %v", status["watchDegraded"])
	}
	if status["watchReason"] != "root 2 failed" {
		t.Fatalf("status watchReason = %v", status["watchReason"])
	}
	if status["refreshFallback"] != false {
		t.Fatalf("status refreshFallback = %v", status["refreshFallback"])
	}
}

// TestRefreshFallbackRebuildsIndex exercises the fallback loop end to end: it
// must scan with a context that its own cancellation does not kill (the loop
// used to cancel the very context handed to the rebuild), and a healthy native
// watcher must then turn the loop off again.
func TestRefreshFallbackRebuildsIndex(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "seed.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(Options{
		StateDir:        t.TempDir(),
		Roots:           []string{root},
		Watch:           true,
		RefreshInterval: 20 * time.Millisecond,
		Version:         "test",
	})
	s.out = io.Discard
	s.ix = index.New()
	s.meta = store.Meta{Roots: []string{root}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.startRefreshFallback(ctx)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if s.current().Stats().Entries >= 2 {
			break // root + seed.txt were indexed by the periodic rebuild
		}
		if time.Now().After(deadline) {
			t.Fatalf("refresh fallback never rebuilt the index (entries=%d)", s.current().Stats().Entries)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The watcher started by the rebuild now covers the root completely, so the
	// fallback must switch off instead of rebuilding forever.
	for {
		if !s.refreshActive() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("refresh fallback kept running next to a healthy watcher")
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.stopWatcher()
	s.stopRefreshFallback()
}
