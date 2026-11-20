package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
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
	s.lastDirtyAt = time.Now().Add(-61 * time.Second)
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

// TestSaveDebounceMeasuresLatestChange pins the autosave fix: the debounce must
// restart on every change, not on the first change of the dirty window, while
// SaveMaxInterval still bounds how long continuous change can defer the write.
func TestSaveDebounceMeasuresLatestChange(t *testing.T) {
	s := New(Options{SaveDebounce: 100 * time.Millisecond, SaveMaxInterval: time.Hour})
	s.observeGeneration(1)
	time.Sleep(70 * time.Millisecond)
	// A second change restarts the quiet window: 70ms since the latest change is
	// below the 100ms debounce even though the window itself is older.
	s.observeGeneration(2)
	time.Sleep(70 * time.Millisecond)
	if s.saveDue() {
		t.Fatal("debounce fired before the index was quiet for SaveDebounce")
	}
	time.Sleep(50 * time.Millisecond)
	if !s.saveDue() {
		t.Fatal("debounce never fired after the index went quiet")
	}

	// A repeated markDirty (meta-only change) also moves the quiet window.
	s2 := New(Options{SaveDebounce: 100 * time.Millisecond, SaveMaxInterval: time.Hour})
	s2.markDirty()
	time.Sleep(70 * time.Millisecond)
	s2.markDirty()
	time.Sleep(70 * time.Millisecond)
	if s2.saveDue() {
		t.Fatal("repeated markDirty did not restart the debounce window")
	}

	// The max interval caps continuous change: a dirty index whose last write is
	// older than SaveMaxInterval must be saved even if it changed just now.
	s3 := New(Options{SaveDebounce: 30 * time.Second, SaveMaxInterval: time.Minute})
	s3.observeGeneration(7)
	s3.saveMu.Lock()
	s3.lastSaveAt = time.Now().Add(-2 * time.Minute)
	s3.saveMu.Unlock()
	if !s3.saveDue() {
		t.Fatal("SaveMaxInterval did not cap continuous change")
	}
}

// TestSaveIncrementalJournalEndToEnd: after the first full save, steady-state
// autosaves append a small journal and leave the base snapshot untouched, while
// a reload still sees the newest entries.
func TestSaveIncrementalJournalEndToEnd(t *testing.T) {
	root := t.TempDir()
	state := t.TempDir()
	s := New(Options{StateDir: state, Roots: []string{root}, Version: "test"})
	ix := index.New()
	ix.AddRoot(root)
	ix.AddPath(filepath.Join(root, "a.txt"), index.FileInfo{Size: 1, Mtime: 1, Mode: 0o644})
	s.mu.Lock()
	s.ix = ix
	s.meta = store.Meta{Roots: []string{root}}
	s.mu.Unlock()
	if !s.save(true) {
		t.Fatal("first save did not write a snapshot")
	}
	snap, _ := store.Paths(state)
	baseBefore, err := os.ReadFile(snap)
	if err != nil {
		t.Fatal(err)
	}
	baseMtime := mustStatModTime(t, snap)
	info, err := index.ReadSnapshotInfo(snap)
	if err != nil {
		t.Fatal(err)
	}
	if info.Version != 2 || !info.SupportsJournal() {
		t.Fatalf("first save base info = %+v", info)
	}

	ix.AddPath(filepath.Join(root, "b.txt"), index.FileInfo{Size: 2, Mtime: 2, Mode: 0o644})
	if !s.save(false) {
		t.Fatal("journal save was skipped")
	}
	baseAfter, err := os.ReadFile(snap)
	if err != nil {
		t.Fatal(err)
	}
	if string(baseAfter) != string(baseBefore) {
		t.Fatal("incremental save rewrote the base snapshot")
	}
	if now := mustStatModTime(t, snap); !now.Equal(baseMtime) {
		t.Fatalf("incremental save touched the base snapshot (mtime %s -> %s)", baseMtime, now)
	}
	journal := filepath.Join(state, index.JournalName)
	jinfo, err := os.Stat(journal)
	if err != nil {
		t.Fatalf("journal file missing: %v", err)
	}
	if jinfo.Size() >= int64(len(baseBefore)) {
		t.Fatalf("journal is %d bytes, base is %d bytes", jinfo.Size(), len(baseBefore))
	}
	loaded, _, err := store.Load(state)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	res, err := loaded.Search(mustParseQuery(t, "b.txt"))
	if err != nil || res.Total != 1 {
		t.Fatalf("journaled entry after reload: total=%d err=%v", res.Total, err)
	}

	// A second incremental save keeps accumulating into the same journal.
	ix.AddPath(filepath.Join(root, "c.txt"), index.FileInfo{Size: 3, Mtime: 3, Mode: 0o644})
	if !s.save(false) {
		t.Fatal("second journal save was skipped")
	}
	loaded, _, err = store.Load(state)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		res, err := loaded.Search(mustParseQuery(t, name))
		if err != nil || res.Total != 1 {
			t.Fatalf("%s lost after second journal save: total=%d err=%v", name, res.Total, err)
		}
	}

	// The status payload reports the persistence counters.
	status := s.statusPayload()
	if got := status["saveCount"].(int64); got < 3 {
		t.Fatalf("status saveCount = %d, want >= 3", got)
	}
	if status["saveBytes"].(int64) <= 0 || status["saveMs"].(int64) < 0 {
		t.Fatalf("status save bytes/ms = %v/%v", status["saveBytes"], status["saveMs"])
	}
	if got := status["snapshotFormat"].(uint32); got != 2 {
		t.Fatalf("status snapshotFormat = %d, want 2", got)
	}
	if status["lastSaveAt"].(int64) <= 0 {
		t.Fatalf("status lastSaveAt = %v", status["lastSaveAt"])
	}
	if status["journalEntries"].(int64) == 0 || status["journalBytes"].(int64) <= 0 {
		t.Fatalf("status journal = %v entries, %v bytes", status["journalEntries"], status["journalBytes"])
	}
	if status["saveLastFull"] != false {
		t.Fatalf("status saveLastFull = %v, want false for a journal save", status["saveLastFull"])
	}
}

func mustParseQuery(t *testing.T, text string) index.Query {
	t.Helper()
	q, err := index.ParseQuery(text)
	if err != nil {
		t.Fatal(err)
	}
	q.Limit = 10
	return q
}

// TestSaveCompactsAtFivePercent: tombstones past the 5% threshold are dropped
// on the save path (copy-on-write Compact), so the persisted base is compact.
func TestSaveCompactsAtFivePercent(t *testing.T) {
	root := t.TempDir()
	state := t.TempDir()
	ix := index.New()
	ix.AddRoot(root)
	items := make([]index.AddItem, 0, 30000)
	for i := 0; i < 30000; i++ {
		items = append(items, index.AddItem{
			Path: filepath.Join(root, "f"+strconv.Itoa(i)+".txt"),
			Info: index.FileInfo{Size: int64(i), Mode: 0o644},
		})
	}
	ix.AddBatch(items)
	for i := 0; i < 11000; i++ {
		if !ix.RemovePath(filepath.Join(root, "f"+strconv.Itoa(i)+".txt")) {
			t.Fatalf("remove f%d failed", i)
		}
	}
	if st := ix.Stats(); st.Deleted != 11000 {
		t.Fatalf("deleted before save = %d, want 11000", st.Deleted)
	}
	s := New(Options{StateDir: state, Roots: []string{root}, Version: "test"})
	s.mu.Lock()
	s.ix = ix
	s.meta = store.Meta{Roots: []string{root}}
	s.mu.Unlock()
	if !s.save(true) {
		t.Fatal("save failed")
	}
	if got := s.compactCount; got != 1 {
		t.Fatalf("compactCount = %d, want 1", got)
	}
	loaded, _, err := store.Load(state)
	if err != nil {
		t.Fatal(err)
	}
	if got := loaded.Stats().Deleted; got != 0 {
		t.Fatalf("persisted snapshot still has %d tombstones", got)
	}
	if got := loaded.Stats().Entries; got != 19001 {
		t.Fatalf("persisted entries = %d, want 19001", got)
	}
	// Compact forces a full base write, which merges (and clears) the journal.
	if _, err := os.Stat(filepath.Join(state, index.JournalName)); err == nil {
		t.Fatal("journal survived the compaction save")
	}
	status := s.statusPayload()
	if status["compactCount"].(int64) != 1 || status["compactMs"].(int64) < 0 {
		t.Fatalf("status compact counters = %v/%v", status["compactCount"], status["compactMs"])
	}
	if status["compactAt"].(int64) <= 0 {
		t.Fatalf("status compactAt = %v", status["compactAt"])
	}
}

// TestBootstrapReplaysJournalAndStaysClean: a restart must load base+journal,
// keep the replayed prefix pending for the next incremental save, and treat the
// on-disk state as current (no rewrite on a clean shutdown).
func TestBootstrapReplaysJournalAndStaysClean(t *testing.T) {
	root := t.TempDir()
	state := t.TempDir()
	ix := index.New()
	ix.AddRoot(root)
	ix.AddPath(filepath.Join(root, "a.txt"), index.FileInfo{Size: 1, Mtime: 1, Mode: 0o644})
	meta := store.Meta{Version: "test", Roots: []string{root}, Platform: "linux/amd64"}
	if _, err := store.SaveWith(state, ix, meta, store.SaveOptions{Full: true}); err != nil {
		t.Fatal(err)
	}
	ix.SetJournalEnabled(true)
	ix.AddPath(filepath.Join(root, "b.txt"), index.FileInfo{Size: 2, Mtime: 2, Mode: 0o644})
	res, err := store.SaveWith(state, ix, meta, store.SaveOptions{})
	if err != nil || res.Full || res.JournalEntries == 0 {
		t.Fatalf("journal save = %+v, %v", res, err)
	}

	s := New(Options{StateDir: state, Roots: []string{root}, Version: "test"})
	s.opt.Log = io.Discard
	if err := s.bootstrap(context.Background()); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if s.needsFullSave {
		t.Fatal("a v2 base plus journal was treated as needing a full save")
	}
	if !s.current().JournalEnabled() {
		t.Fatal("journal recording was not enabled after load")
	}
	if got := s.current().Stats().Entries; got != 3 {
		t.Fatalf("loaded entries = %d, want 3 (root + journaled file + first file)", got)
	}
	snap, _ := store.Paths(state)
	baseMtime := mustStatModTime(t, snap)
	journal := filepath.Join(state, index.JournalName)
	journalBefore, err := os.ReadFile(journal)
	if err != nil {
		t.Fatalf("journal missing after bootstrap: %v", err)
	}
	if s.save(false) {
		t.Fatal("clean bootstrap rewrote the snapshot")
	}
	if now := mustStatModTime(t, snap); !now.Equal(baseMtime) {
		t.Fatal("clean bootstrap touched the base snapshot")
	}
	journalAfter, err := os.ReadFile(journal)
	if err != nil || string(journalAfter) != string(journalBefore) {
		t.Fatal("clean bootstrap rewrote the journal")
	}

	// A new mutation is appended to the journal and a restarted server sees it.
	s.current().AddPath(filepath.Join(root, "c.txt"), index.FileInfo{Size: 3, Mtime: 3, Mode: 0o644})
	if !s.save(false) {
		t.Fatal("journal save after bootstrap was skipped")
	}
	s2 := New(Options{StateDir: state, Roots: []string{root}, Version: "test"})
	s2.opt.Log = io.Discard
	if err := s2.bootstrap(context.Background()); err != nil {
		t.Fatal(err)
	}
	searchRes, err := s2.current().Search(mustParseQuery(t, "c.txt"))
	if err != nil || searchRes.Total != 1 {
		t.Fatalf("journaled entry after restart: total=%d err=%v", searchRes.Total, err)
	}
}

// TestStatusDoesNotBlockBehindSave: status polls once a second and must not
// queue behind a multi-hundred-millisecond snapshot write. It reads the save
// metrics through their own lock, so holding saveMu must not delay it.
func TestStatusDoesNotBlockBehindSave(t *testing.T) {
	s := New(Options{Version: "test", Roots: []string{"/x"}})
	ix := index.New()
	ix.AddRoot("/x")
	s.mu.Lock()
	s.ix = ix
	s.mu.Unlock()
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	done := make(chan struct{})
	go func() {
		_ = s.statusPayload()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("statusPayload blocked behind saveMu")
	}
}
