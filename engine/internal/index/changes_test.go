package index

import (
	"io/fs"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// TestGenerationOnlyMovesOnRealChanges pins the snapshot-saving contract: a
// repeat watcher event with the same size/mtime/flags must not make the index
// look dirty, because a dirty generation triggers a full snapshot rewrite.
func TestGenerationOnlyMovesOnRealChanges(t *testing.T) {
	ix := New()
	root := filepath.Clean("/gen-root")
	ix.AddRoot(root)
	file := filepath.Join(root, "a.txt")

	g0 := ix.Generation()
	ix.AddPath(file, FileInfo{Size: 1, Mtime: 100, Mode: 0o644})
	if g := ix.Generation(); g == g0 {
		t.Fatalf("adding a new path did not advance the generation (%d)", g)
	}
	g1 := ix.Generation()

	// Same event again: create + close-write replays are common, and they must
	// be a no-op for the generation.
	ix.AddPath(file, FileInfo{Size: 1, Mtime: 100, Mode: 0o644})
	if g := ix.Generation(); g != g1 {
		t.Fatalf("unchanged re-add advanced generation %d -> %d", g1, g)
	}

	ix.AddPath(file, FileInfo{Size: 2, Mtime: 100, Mode: 0o644})
	if g := ix.Generation(); g == g1 {
		t.Fatal("size change did not advance the generation")
	}
	g2 := ix.Generation()

	ix.AddPath(file, FileInfo{Size: 2, Mtime: 101, Mode: 0o644})
	if g := ix.Generation(); g == g2 {
		t.Fatal("mtime change did not advance the generation")
	}

	if ix.RemovePath(filepath.Join(root, "missing.txt")) {
		t.Fatal("removing a missing path reported success")
	}
	g3 := ix.Generation()
	if !ix.RemovePath(file) {
		t.Fatal("removing an existing path failed")
	}
	if g := ix.Generation(); g == g3 {
		t.Fatal("removal did not advance the generation")
	}
}

func TestGenerationTracksFRNChanges(t *testing.T) {
	ix := New()
	root := filepath.Clean("/frn-root")
	ix.AddRoot(root)
	file := filepath.Join(root, "b.txt")
	ix.AddPathFRN(file, FileInfo{Size: 1, Mode: 0o644}, 0x42)
	g := ix.Generation()
	ix.AddPathFRN(file, FileInfo{Size: 1, Mode: 0o644}, 0x42)
	if now := ix.Generation(); now != g {
		t.Fatalf("same FRN re-add advanced generation %d -> %d", g, now)
	}
	ix.AddPathFRN(file, FileInfo{Size: 1, Mode: 0o644}, 0x43)
	if now := ix.Generation(); now == g {
		t.Fatal("FRN change did not advance the generation")
	}
}

// TestPathSortOrder builds the sort=path ordering from parent chains instead of
// materialised path strings. With unambiguous names the order must equal the
// full-path lexicographic order, including ancestors before descendants.
func TestPathSortOrder(t *testing.T) {
	ix := New()
	root := filepath.Clean("/data")
	ix.AddRoot(root)
	dir := FileInfo{Mode: fs.ModeDir | 0o755, Mtime: 1}
	file := FileInfo{Mode: 0o644, Mtime: 1}
	ix.AddBatch([]AddItem{
		{Path: filepath.Join(root, "docs"), Info: dir},
		{Path: filepath.Join(root, "docs", "report.pdf"), Info: file},
		{Path: filepath.Join(root, "docs", "notes.txt"), Info: file},
		{Path: filepath.Join(root, "src"), Info: dir},
		{Path: filepath.Join(root, "src", "main.go"), Info: file},
		{Path: filepath.Join(root, "src", "util.go"), Info: file},
		{Path: filepath.Join(root, "archive.zip"), Info: file},
	})

	q, err := ParseQuery("")
	if err != nil {
		t.Fatal(err)
	}
	q.SetSort("path", false)
	res, err := ix.Search(q)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		root,
		filepath.Join(root, "archive.zip"),
		filepath.Join(root, "docs"),
		filepath.Join(root, "docs", "notes.txt"),
		filepath.Join(root, "docs", "report.pdf"),
		filepath.Join(root, "src"),
		filepath.Join(root, "src", "main.go"),
		filepath.Join(root, "src", "util.go"),
	}
	if len(res.Hits) != len(want) {
		t.Fatalf("hits = %d, want %d: %+v", len(res.Hits), len(want), res.Hits)
	}
	for i, path := range want {
		if res.Hits[i].Path != path {
			t.Fatalf("hit %d = %q, want %q (order: %+v)", i, res.Hits[i].Path, path, res.Hits)
		}
	}

	q.SetSort("path", true)
	res, err = ix.Search(q)
	if err != nil {
		t.Fatal(err)
	}
	for i := range want {
		if got := res.Hits[i].Path; got != want[len(want)-1-i] {
			t.Fatalf("descending hit %d = %q, want %q", i, got, want[len(want)-1-i])
		}
	}

	// A page limit must not change the ordering of the returned slice.
	q.SetSort("path", false)
	q.Limit = 3
	res, err = ix.Search(q)
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != len(want) || len(res.Hits) != 3 {
		t.Fatalf("paged search = total %d hits %d", res.Total, len(res.Hits))
	}
	for i := 0; i < 3; i++ {
		if res.Hits[i].Path != want[i] {
			t.Fatalf("paged hit %d = %q, want %q", i, res.Hits[i].Path, want[i])
		}
	}
}

func TestDumpPageFromFiltersMtime(t *testing.T) {
	ix := New()
	root := filepath.Clean("/dump-root")
	ix.AddRoot(root)
	ms := int64(time.Millisecond)
	ix.AddBatch([]AddItem{
		{Path: filepath.Join(root, "old.txt"), Info: FileInfo{Size: 1, Mtime: 1000 * ms}},
		{Path: filepath.Join(root, "edge.txt"), Info: FileInfo{Size: 1, Mtime: 2000 * ms}},
		{Path: filepath.Join(root, "new.txt"), Info: FileInfo{Size: 1, Mtime: 3000 * ms}},
	})

	entries, next, done := ix.DumpPageFrom(0, 100, 2000)
	if !done || next != 4 {
		t.Fatalf("dump cursor = %d done=%v", next, done)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name)
	}
	if len(names) != 2 || names[0] != "edge.txt" || names[1] != "new.txt" {
		t.Fatalf("mtimeFrom dump = %v, want [edge.txt new.txt]", names)
	}

	entries, _, done = ix.DumpPageFrom(0, 100, 0)
	if !done || len(entries) != 4 {
		t.Fatalf("unfiltered dump returned %d entries done=%v, want 4", len(entries), done)
	}
}

// BenchmarkPathSort measures a path-sorted paged search over a large index. The
// old implementation built a path string for every match before sorting; this
// one compares parent chains, so allocations stay proportional to the match id
// list and the returned page.
func BenchmarkPathSort(b *testing.B) {
	ix := New()
	root := filepath.Clean("/bench")
	ix.AddRoot(root)
	dir := FileInfo{Mode: fs.ModeDir | 0o755, Mtime: 1}
	file := FileInfo{Mode: 0o644, Mtime: 1}
	const dirs = 2000
	const perDir = 100
	items := make([]AddItem, 0, dirs*(perDir+1))
	for d := 0; d < dirs; d++ {
		dirPath := filepath.Join(root, "dir-"+strconv.Itoa(d))
		items = append(items, AddItem{Path: dirPath, Info: dir})
		for f := 0; f < perDir; f++ {
			items = append(items, AddItem{Path: filepath.Join(dirPath, "file-"+strconv.Itoa(f)+".txt"), Info: file})
		}
	}
	ix.AddBatch(items)
	q, err := ParseQuery("")
	if err != nil {
		b.Fatal(err)
	}
	q.SetSort("path", false)
	q.Limit = 100
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := ix.Search(q); err != nil {
			b.Fatal(err)
		}
	}
}
