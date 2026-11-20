package index

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// buildJournalBase writes a small base snapshot and returns the index, the
// snapshot path and the root path used by the entries.
func buildJournalBase(t *testing.T) (*Index, string, string) {
	t.Helper()
	dir := t.TempDir()
	base := filepath.Join(dir, "index.snapshot")
	root := filepath.Clean("/journal-root")
	ix := New()
	ix.AddRoot(root)
	ix.AddPath(filepath.Join(root, "keep.txt"), FileInfo{Size: 1, Mtime: 10, Mode: 0o644})
	ix.AddPath(filepath.Join(root, "gone.txt"), FileInfo{Size: 2, Mtime: 20, Mode: 0o644})
	sub := filepath.Join(root, "sub")
	ix.AddPath(sub, FileInfo{Mode: os.ModeDir | 0o755})
	ix.AddPath(filepath.Join(sub, "nested.txt"), FileInfo{Size: 3, Mtime: 30, Mode: 0o644})
	if _, err := ix.SaveBase(base, SnapshotOptions{}); err != nil {
		t.Fatalf("save base: %v", err)
	}
	return ix, base, root
}

func baseIDOf(t *testing.T, base string) uint64 {
	t.Helper()
	info, err := ReadSnapshotInfo(base)
	if err != nil {
		t.Fatalf("read snapshot info: %v", err)
	}
	return info.BaseID
}

func pathInDir(base, name string) string {
	return filepath.Join(filepath.Dir(base), name)
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func findHit(t *testing.T, ix *Index, text string) *Hit {
	t.Helper()
	q, err := ParseQuery(text)
	if err != nil {
		t.Fatal(err)
	}
	q.Limit = 10
	res, err := ix.Search(q)
	if err != nil {
		t.Fatal(err)
	}
	for i := range res.Hits {
		return &res.Hits[i]
	}
	return nil
}

// TestJournalRoundTrip: mutations recorded after a base snapshot, written to the
// journal and replayed on load must reproduce the live state exactly.
func TestJournalRoundTrip(t *testing.T) {
	ix, base, root := buildJournalBase(t)
	baseID := baseIDOf(t, base)
	ix.SetJournalEnabled(true)

	newFile := filepath.Join(root, "new.txt")
	ix.AddPath(newFile, FileInfo{Size: 9, Mtime: 99, Mode: 0o644})
	ix.AddPath(filepath.Join(root, "keep.txt"), FileInfo{Size: 42, Mtime: 11, Mode: 0o644})
	if !ix.RemovePath(filepath.Join(root, "gone.txt")) {
		t.Fatal("removing gone.txt failed")
	}
	ix.RemoveSubtree(filepath.Join(root, "sub"))
	// 2 puts (new.txt, updated keep.txt) + 3 deletes (gone.txt, sub, nested.txt)
	entries, jbytes, overflow := ix.JournalStats()
	if entries != 5 || jbytes <= 0 || overflow {
		t.Fatalf("journal stats = %d entries, %d bytes, overflow %v", entries, jbytes, overflow)
	}
	journal := pathInDir(base, JournalName)
	written, n, err := ix.WriteJournalTo(journal, baseID, 0)
	if err != nil || n != entries || written <= 0 {
		t.Fatalf("WriteJournalTo = %d bytes, %d entries, %v", written, n, err)
	}

	back, info, err := LoadWithInfo(base)
	if err != nil {
		t.Fatalf("load base+journal: %v", err)
	}
	if !info.JournalReplayed || info.JournalEntries != entries {
		t.Fatalf("load info = %+v", info)
	}
	if got := back.Stats().Deleted; got != 3 { // gone.txt + sub + nested.txt
		t.Fatalf("deleted = %d, want 3", got)
	}
	if hit := findHit(t, back, "new.txt"); hit == nil || hit.Size != 9 || hit.Path != newFile {
		t.Fatalf("added file after replay = %+v", hit)
	}
	if hit := findHit(t, back, "keep.txt"); hit == nil || hit.Size != 42 || hit.Mtime != 11/int64(time.Millisecond) {
		t.Fatalf("updated file after replay = %+v", hit)
	}
	if hit := findHit(t, back, "gone.txt"); hit != nil {
		t.Fatalf("removed file survived replay: %+v", hit)
	}
	if hit := findHit(t, back, "nested.txt"); hit != nil {
		t.Fatalf("removed subtree survived replay: %+v", hit)
	}
	// The replayed prefix stays pending so the next incremental save rewrites it
	// instead of replacing the journal with only new changes.
	if got, _, _ := back.JournalStats(); got != entries {
		t.Fatalf("replayed journal kept %d entries, want %d", got, entries)
	}
	back.SetJournalEnabled(true)
	if _, n2, err := back.WriteJournalTo(journal, baseID, 0); err != nil || n2 != entries {
		t.Fatalf("rewriting replayed journal = %d entries, %v (want %d)", n2, err, entries)
	}
	again, _, err := LoadWithInfo(base)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.Stats().Deleted; got != 3 {
		t.Fatalf("second replay deleted = %d, want 3", got)
	}
}

// TestJournalSurvivesCompact: entries are path-addressed, so a compaction that
// renumbers record ids must not invalidate them.
func TestJournalSurvivesCompact(t *testing.T) {
	ix, base, root := buildJournalBase(t)
	baseID := baseIDOf(t, base)
	ix.SetJournalEnabled(true)
	ix.AddPath(filepath.Join(root, "after.txt"), FileInfo{Size: 5, Mtime: 50, Mode: 0o644})
	ix.RemovePath(filepath.Join(root, "keep.txt"))
	if !ix.RemovePath(filepath.Join(root, "gone.txt")) {
		t.Fatal("remove gone.txt failed")
	}
	ix.Compact()
	if got := ix.Stats().Deleted; got != 0 {
		t.Fatalf("compact left %d tombstones", got)
	}
	journal := pathInDir(base, JournalName)
	if _, n, err := ix.WriteJournalTo(journal, baseID, 0); err != nil || n != 3 {
		t.Fatalf("journal after compact = %d entries, %v", n, err)
	}
	back, err := Load(base)
	if err != nil {
		t.Fatal(err)
	}
	if hit := findHit(t, back, "after.txt"); hit == nil || hit.Size != 5 {
		t.Fatalf("added file lost after compact+replay: %+v", hit)
	}
	if hit := findHit(t, back, "keep.txt"); hit != nil {
		t.Fatalf("removed file survived compact+replay: %+v", hit)
	}
}

// TestJournalAddRootReplay: a root added at runtime is journaled as a root,
// not just as a record.
func TestJournalAddRootReplay(t *testing.T) {
	ix, base, _ := buildJournalBase(t)
	baseID := baseIDOf(t, base)
	ix.SetJournalEnabled(true)
	extra := filepath.Clean("/journal-extra")
	ix.AddRoot(extra)
	ix.AddPath(filepath.Join(extra, "extra.txt"), FileInfo{Size: 7, Mtime: 7, Mode: 0o644})
	journal := pathInDir(base, JournalName)
	if _, _, err := ix.WriteJournalTo(journal, baseID, 0); err != nil {
		t.Fatal(err)
	}
	back, err := Load(base)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range back.Roots() {
		if r == extra {
			found = true
		}
	}
	if !found {
		t.Fatalf("extra root missing after replay: %v", back.Roots())
	}
	if hit := findHit(t, back, "extra.txt"); hit == nil || hit.Path != filepath.Join(extra, "extra.txt") {
		t.Fatalf("file under added root = %+v", hit)
	}
}

// TestJournalTruncatedTailIgnored simulates kill -9 in the middle of an append:
// a truncated frame must be ignored while the valid prefix still applies.
func TestJournalTruncatedTailIgnored(t *testing.T) {
	ix, base, root := buildJournalBase(t)
	baseID := baseIDOf(t, base)
	ix.SetJournalEnabled(true)
	names := []string{"one.txt", "two.txt", "three.txt"}
	for _, n := range names {
		ix.AddPath(filepath.Join(root, n), FileInfo{Size: 1, Mtime: 1, Mode: 0o644})
	}
	journal := pathInDir(base, JournalName)
	if _, n, err := ix.WriteJournalTo(journal, baseID, 0); err != nil || n != 3 {
		t.Fatalf("write journal = %d, %v", n, err)
	}
	full := mustRead(t, journal)
	if len(full) <= journalHeaderSize+16 {
		t.Fatalf("journal too short to truncate usefully: %d", len(full))
	}
	cuts := []int{journalHeaderSize + 4, journalHeaderSize + 10, len(full) - 3, len(full) - 1}
	baseBytes := mustRead(t, base)
	for _, cut := range cuts {
		dir := t.TempDir()
		baseCopy := filepath.Join(dir, "index.snapshot")
		if err := os.WriteFile(baseCopy, baseBytes, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, JournalName), full[:cut], 0o644); err != nil {
			t.Fatal(err)
		}
		back, info, err := LoadWithInfo(baseCopy)
		if err != nil {
			t.Fatalf("cut %d: load failed: %v", cut, err)
		}
		if info.JournalEntries >= len(names) {
			t.Fatalf("cut %d: replayed %d entries, want fewer than %d", cut, info.JournalEntries, len(names))
		}
		if !info.JournalTruncated {
			t.Fatalf("cut %d: a truncated journal was not reported as torn", cut)
		}
		if got := back.Stats().Deleted; got != 0 {
			t.Fatalf("cut %d: unexpected tombstones %d", cut, got)
		}
	}
	// The untruncated journal replays everything.
	back, info, err := LoadWithInfo(base)
	if err != nil {
		t.Fatal(err)
	}
	if info.JournalEntries != 3 {
		t.Fatalf("full journal replayed %d entries, want 3", info.JournalEntries)
	}
	for _, n := range names {
		if hit := findHit(t, back, n); hit == nil {
			t.Fatalf("%s missing after full replay", n)
		}
	}
}

// TestJournalCorruptCRCStopsReplay: a torn byte in the middle never applies the
// damaged frame or anything after it.
func TestJournalCorruptCRCStopsReplay(t *testing.T) {
	ix, base, root := buildJournalBase(t)
	baseID := baseIDOf(t, base)
	ix.SetJournalEnabled(true)
	for _, n := range []string{"a.txt", "b.txt"} {
		ix.AddPath(filepath.Join(root, n), FileInfo{Size: 1, Mode: 0o644})
	}
	journal := pathInDir(base, JournalName)
	if _, _, err := ix.WriteJournalTo(journal, baseID, 0); err != nil {
		t.Fatal(err)
	}
	b := mustRead(t, journal)
	// Flip a byte in the last frame's payload (CRC covers it).
	b[len(b)-2] ^= 0xFF
	if err := os.WriteFile(journal, b, 0o644); err != nil {
		t.Fatal(err)
	}
	back, info, err := LoadWithInfo(base)
	if err != nil {
		t.Fatalf("load with corrupt tail: %v", err)
	}
	if info.JournalEntries != 1 {
		t.Fatalf("corrupt tail replayed %d entries, want the 1 valid prefix entry", info.JournalEntries)
	}
	if hit := findHit(t, back, "a.txt"); hit == nil {
		t.Fatal("valid prefix entry missing")
	}
	if hit := findHit(t, back, "b.txt"); hit != nil {
		t.Fatal("damaged frame was applied")
	}
}

// TestJournalBaseMismatchIgnored: a journal written against another base must
// be skipped, not replayed (replaying it could roll fields back).
func TestJournalBaseMismatchIgnored(t *testing.T) {
	ix, base, root := buildJournalBase(t)
	baseID := baseIDOf(t, base)
	ix.SetJournalEnabled(true)
	ix.AddPath(filepath.Join(root, "stale.txt"), FileInfo{Size: 1, Mode: 0o644})
	journal := pathInDir(base, JournalName)
	if _, _, err := ix.WriteJournalTo(journal, baseID+1, 0); err != nil {
		t.Fatal(err)
	}
	back, info, err := LoadWithInfo(base)
	if err != nil {
		t.Fatal(err)
	}
	if info.JournalReplayed || info.JournalEntries != 0 {
		t.Fatalf("mismatched journal was replayed: %+v", info)
	}
	if !info.JournalIgnored {
		t.Fatal("mismatched journal was not reported as ignored")
	}
	if hit := findHit(t, back, "stale.txt"); hit != nil {
		t.Fatal("stale journal entry leaked into the index")
	}
}

// TestJournalCorruptHeaderIgnored covers a garbage/partial journal header.
func TestJournalCorruptHeaderIgnored(t *testing.T) {
	_, base, _ := buildJournalBase(t)
	journal := pathInDir(base, JournalName)
	if err := os.WriteFile(journal, []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	back, info, err := LoadWithInfo(base)
	if err != nil {
		t.Fatalf("corrupt journal failed the load: %v", err)
	}
	if !info.JournalIgnored || info.JournalReplayed {
		t.Fatalf("load info = %+v", info)
	}
	if back.Len() == 0 {
		t.Fatal("base entries missing")
	}
}

// TestJournalOverflowFallsBack covers the bounded recorder: once either budget
// is crossed the entries are dropped and the next save must be a full base.
func TestJournalOverflowFallsBack(t *testing.T) {
	ix, base, root := buildJournalBase(t)
	_ = base
	ix.SetJournalEnabled(true)
	// Pretend the recorder is nearly full; one more entry trips the cap.
	ix.mu.Lock()
	ix.journal.bytes = maxJournalBytes - 1
	ix.mu.Unlock()
	ix.AddPath(filepath.Join(root, "overflow.txt"), FileInfo{Size: 1, Mode: 0o644})
	if !ix.JournalOverflowed() {
		t.Fatal("journal did not overflow past its byte budget")
	}
	if entries, bytes, overflow := ix.JournalStats(); entries != 0 || bytes != 0 || !overflow {
		t.Fatalf("overflow stats = %d entries, %d bytes, %v", entries, bytes, overflow)
	}
	ix.AddPath(filepath.Join(root, "after-overflow.txt"), FileInfo{Size: 1, Mode: 0o644})
	if entries, _, _ := ix.JournalStats(); entries != 0 {
		t.Fatalf("overflow still recorded %d entries", entries)
	}
	ix.JournalResetAfter(0)
	if ix.JournalOverflowed() {
		t.Fatal("reset did not clear the overflow flag")
	}
}

// TestJournalPlaybackIsIdempotent: loading the same base+journal twice yields
// identical state.
func TestJournalPlaybackIsIdempotent(t *testing.T) {
	ix, base, root := buildJournalBase(t)
	baseID := baseIDOf(t, base)
	ix.SetJournalEnabled(true)
	ix.AddPath(filepath.Join(root, "idem.txt"), FileInfo{Size: 3, Mtime: 4, Mode: 0o644})
	ix.RemovePath(filepath.Join(root, "gone.txt"))
	journal := pathInDir(base, JournalName)
	if _, _, err := ix.WriteJournalTo(journal, baseID, 0); err != nil {
		t.Fatal(err)
	}
	first, err := Load(base)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Load(base)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := second.Stats(), first.Stats(); got != want {
		t.Fatalf("replay not idempotent: %+v vs %+v", got, want)
	}
	if hit := findHit(t, second, "idem.txt"); hit == nil || hit.Size != 3 {
		t.Fatalf("idempotent replay lost the put: %+v", hit)
	}
}
