package index

import (
	"io/fs"
	"path/filepath"
	"sync"
	"testing"
)

// TestCompactOrphanParentKeepsAbsolutePath: compaction drops tombstones, and a
// live child of a deleted directory must keep its absolute path (its parent
// record is gone, so the path has to move into the child's stored name).
func TestCompactOrphanParentKeepsAbsolutePath(t *testing.T) {
	root := filepath.Clean("/orphan")
	dir := filepath.Join(root, "dir")
	child := filepath.Join(dir, "child.txt")
	ix := New()
	ix.AddRoot(root)
	ix.AddPath(dir, FileInfo{Mode: fs.ModeDir | 0o755})
	ix.AddPath(child, FileInfo{Size: 7, Mtime: 7, Mode: 0o644})
	if !ix.RemovePath(dir) {
		t.Fatal("removing the directory failed")
	}
	ix.Compact()
	id, ok := ix.Lookup(child)
	if !ok {
		t.Fatal("child disappeared after compact")
	}
	if got := ix.Path(id); got != child {
		t.Fatalf("child path after compact = %q, want %q", got, child)
	}
	hit := findHit(t, ix, "child.txt")
	if hit == nil || hit.Path != child {
		t.Fatalf("child search hit after compact = %+v", hit)
	}
	if got := ix.Stats().Deleted; got != 0 {
		t.Fatalf("deleted = %d after compact", got)
	}
}

// TestCompactAbortsOnConcurrentMutation covers the copy-on-write commit guard:
// a mutation between the lock-free build and the swap aborts the attempt and
// leaves the index untouched (the caller retries later).
func TestCompactAbortsOnConcurrentMutation(t *testing.T) {
	ix := testIndex(t)
	for _, p := range []string{"/data/archive.zip", "/data/tmp/cache.bin", "/data/docs/notes.txt"} {
		if !ix.RemovePath(p) {
			t.Fatalf("remove %s failed", p)
		}
	}
	before := ix.Stats()
	calls := 0
	compactPhaseHook = func() {
		calls++
		ix.AddPath(filepath.Join("/data", "concurrent.txt"), FileInfo{Size: 1, Mode: 0o644})
	}
	defer func() { compactPhaseHook = nil }()
	if ix.tryCompactOnce() {
		t.Fatal("compaction committed although the generation moved")
	}
	if calls != 1 {
		t.Fatalf("hook ran %d times, want 1", calls)
	}
	// The hook's own addition is the only change that may be visible: the
	// aborted compaction must not have dropped the tombstones or renumbered.
	mid := ix.Stats()
	if mid.Deleted != before.Deleted || mid.Records != before.Records+1 || mid.Entries != before.Entries+1 {
		t.Fatalf("aborted compaction changed the index: %+v -> %+v", before, mid)
	}
	if hit := findHit(t, ix, "concurrent.txt"); hit == nil {
		t.Fatal("concurrent mutation was lost by the aborted compaction")
	}
	// A later, uncontended compaction still completes.
	compactPhaseHook = nil
	ix.Compact()
	if got := ix.Stats().Deleted; got != 0 {
		t.Fatalf("retry left %d tombstones", got)
	}
	if hit := findHit(t, ix, "main.go"); hit == nil {
		t.Fatal("live entry lost by compact")
	}
}

// TestCompactRebuildsNamesWhenMostlyDead: once most of the name arena is dead
// bytes, compaction rewrites it and every path still resolves.
func TestCompactRebuildsNamesWhenMostlyDead(t *testing.T) {
	root := filepath.Clean("/names")
	ix := New()
	ix.AddRoot(root)
	var keep []string
	for i := 0; i < 200; i++ {
		p := filepath.Join(root, "long-file-name-that-wastes-arena-space-"+string(rune('a'+i%26))+".txt")
		if i%2 == 0 {
			p = filepath.Join(root, "keep-"+string(rune('a'+i%26))+"-"+string(rune('a'+i/26%26))+".txt")
			keep = append(keep, p)
		}
		ix.AddPath(p, FileInfo{Size: int64(i), Mode: 0o644})
	}
	for i := 0; i < 200; i++ {
		p := filepath.Join(root, "long-file-name-that-wastes-arena-space-"+string(rune('a'+i%26))+".txt")
		if i%2 == 1 {
			ix.RemovePath(p)
		}
	}
	before := len(ix.names)
	ix.Compact()
	if len(ix.names) >= before {
		t.Fatalf("name arena was not compacted: %d -> %d", before, len(ix.names))
	}
	for _, p := range keep {
		if _, ok := ix.Lookup(p); !ok {
			t.Fatalf("live path %s lost after name compaction", p)
		}
	}
}

// TestStatsCacheTracksGeneration: status calls Stats twice a second; the
// memoised result must stay exact as mutations move the generation.
func TestStatsCacheTracksGeneration(t *testing.T) {
	ix := testIndex(t)
	first := ix.Stats()
	second := ix.Stats()
	if first != second {
		t.Fatalf("cached Stats changed between calls: %+v vs %+v", first, second)
	}
	path := filepath.Join("/data", "cached.txt")
	ix.AddPath(path, FileInfo{Size: 3, Mode: 0o644})
	third := ix.Stats()
	if third.Files != first.Files+1 || third.Entries != first.Entries+1 {
		t.Fatalf("Stats did not notice an added file: %+v -> %+v", first, third)
	}
	if third.Generation == first.Generation {
		t.Fatal("generation did not move with the mutation")
	}
	if !ix.RemovePath(path) {
		t.Fatal("remove failed")
	}
	fourth := ix.Stats()
	if fourth.Deleted != first.Deleted+1 {
		t.Fatalf("Stats did not notice a tombstone: %+v", fourth)
	}
	if fifth := ix.Stats(); fifth != fourth {
		t.Fatal("Stats cache not stable after mutation")
	}
}

// TestStatsConcurrentAccess exercises the cache under the race detector.
func TestStatsConcurrentAccess(t *testing.T) {
	ix := testIndex(t)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				_ = ix.Stats()
			}
		}()
	}
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				p := filepath.Join("/data", "concurrent-"+string(rune('a'+n))+"-"+string(rune('a'+j%26))+".txt")
				ix.AddPath(p, FileInfo{Size: int64(j), Mode: 0o644})
				ix.RemovePath(p)
			}
		}(i)
	}
	wg.Wait()
}
