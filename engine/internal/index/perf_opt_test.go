package index

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

func mustWriteFileB(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// buildIndexWith adds root, every ancestor directory of files, then the files.
// Sizes come from the map value; mtime is fixed so diffs are comparable.
func buildIndexWith(t *testing.T, root string, files map[string]int64) *Index {
	t.Helper()
	ix := New()
	ix.AddRoot(root)
	dirs := make(map[string]struct{})
	for p := range files {
		for d := filepath.Dir(p); len(d) > len(root); d = filepath.Dir(d) {
			dirs[d] = struct{}{}
		}
	}
	dlist := make([]string, 0, len(dirs))
	for d := range dirs {
		dlist = append(dlist, d)
	}
	sort.Slice(dlist, func(i, j int) bool { return len(dlist[i]) < len(dlist[j]) })
	for _, d := range dlist {
		ix.AddPath(d, FileInfo{Mode: os.ModeDir | 0o755})
	}
	for p, size := range files {
		ix.AddPath(p, FileInfo{Size: size, Mtime: 1, Mode: 0o644})
	}
	return ix
}

func searchHits(t *testing.T, ix *Index, text string) []Hit {
	t.Helper()
	q, err := ParseQuery(text)
	if err != nil {
		t.Fatal(err)
	}
	q.Limit = 100
	res, err := ix.Search(q)
	if err != nil {
		t.Fatal(err)
	}
	return res.Hits
}

// TestDiffSubtreeAppliesChanges: the periodic refresh must converge a root
// without removing and re-adding the whole subtree (no tombstone wave).
func TestDiffSubtreeAppliesChanges(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "difftest")
	keep := filepath.Join(root, "keep.txt")
	old := filepath.Join(root, "dir", "old.txt")
	newFile := filepath.Join(root, "new.txt")
	live := buildIndexWith(t, root, map[string]int64{keep: 1, old: 1, filepath.Join(root, "dir"): 0})
	_ = filepath.Join(root, "dir")
	genBefore := live.Generation()

	noChange := buildIndexWith(t, root, map[string]int64{keep: 1, old: 1, filepath.Join(root, "dir"): 0})
	d := live.DiffSubtree(root, noChange)
	if d.Added != 0 || d.Removed != 0 {
		t.Fatalf("unchanged diff = %+v, want zero", d)
	}
	if live.Generation() != genBefore {
		t.Fatalf("unchanged diff moved the generation %d -> %d", genBefore, live.Generation())
	}

	fresh := buildIndexWith(t, root, map[string]int64{keep: 6, newFile: 1, filepath.Join(root, "dir"): 0})
	d = live.DiffSubtree(root, fresh)
	if d.Added != 1 || d.Removed != 1 {
		t.Fatalf("diff = %+v, want 1 added and 1 removed", d)
	}
	if got := live.Stats().Deleted; got != 1 {
		t.Fatalf("tombstones = %d, want 1 (the old RemoveSubtree path created one per entry)", got)
	}
	if hits := searchHits(t, live, "new.txt"); len(hits) != 1 {
		t.Fatalf("added file not indexed: %+v", hits)
	}
	if hits := searchHits(t, live, "old.txt"); len(hits) != 0 {
		t.Fatalf("removed file survived: %+v", hits)
	}
	hits := searchHits(t, live, "keep.txt")
	if len(hits) != 1 || hits[0].Size != 6 {
		t.Fatalf("updated metadata not applied: %+v", hits)
	}
}

// TestDiffSubtreeKeepsOtherRoots pins the incremental-refresh promise: a diff
// of one root never touches another root.
func TestDiffSubtreeKeepsOtherRoots(t *testing.T) {
	healthy := filepath.Join(string(filepath.Separator), "healthy")
	degraded := filepath.Join(string(filepath.Separator), "degraded")
	live := buildIndexWith(t, healthy, map[string]int64{filepath.Join(healthy, "keep.txt"): 1})
	second := buildIndexWith(t, degraded, map[string]int64{filepath.Join(degraded, "gone.txt"): 1})
	for _, root := range second.Roots() {
		live.AddRoot(root)
	}
	var items []AddItem
	for i := range second.recs {
		items = append(items, AddItem{Path: second.Path(int32(i)), Info: FileInfo{Size: second.recs[i].Size, Mtime: second.recs[i].Mtime, Mode: modeFromFlags(second.recs[i].Flags)}})
	}
	live.AddBatch(items)
	fresh := buildIndexWith(t, degraded, map[string]int64{})
	d := live.DiffSubtree(degraded, fresh)
	if d.Removed != 1 {
		t.Fatalf("removed = %d, want 1", d.Removed)
	}
	if hits := searchHits(t, live, "keep.txt"); len(hits) != 1 {
		t.Fatal("healthy root entry disappeared")
	}
}

// TestAddBatchAtAndDirPage: the scanner batch path and the watcher directory
// enumeration must agree with the index paths.
func TestAddBatchAtAndDirPage(t *testing.T) {
	root := t.TempDir()
	ix := New()
	ix.AddRoot(root)
	rootID, ok := ix.Lookup(root)
	if !ok {
		t.Fatal("root record missing")
	}
	dirs := []AddItem{
		{Path: filepath.Join(root, "a"), Info: FileInfo{Mode: os.ModeDir | 0o755}},
		{Path: filepath.Join(root, "a", "b"), Info: FileInfo{Mode: os.ModeDir | 0o755}},
		{Path: filepath.Join(root, "f.txt"), Info: FileInfo{Mode: 0o644, Size: 3, Mtime: 7}},
	}
	// A batch carries direct children only: "a" and "f.txt" belong to root,
	// "b" belongs to "a". The nested dir is added after its parent exists.
	ix.AddBatchAt(rootID, []AddItem{dirs[0], dirs[2]})
	aID, ok := ix.Lookup(filepath.Join(root, "a"))
	if !ok {
		t.Fatal("child dir not indexed by AddBatchAt")
	}
	ix.AddBatchAt(aID, dirs[1:])
	for _, item := range dirs {
		id, ok := ix.Lookup(item.Path)
		if !ok {
			t.Fatalf("%s was not indexed", item.Path)
		}
		if got := ix.Path(id); got != item.Path {
			t.Fatalf("path = %q, want %q", got, item.Path)
		}
	}
	var got []string
	after := int32(0)
	for {
		page, next, done := ix.DirPage(after, 1)
		got = append(got, page...)
		if done {
			break
		}
		after = next
	}
	sort.Strings(got)
	want := []string{root, filepath.Join(root, "a"), filepath.Join(root, "a", "b")}
	sort.Strings(want)
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("DirPage = %v, want %v", got, want)
	}
}

// TestLookupPathCompare: path lookups must resolve deep and missing paths
// correctly while comparing parent chains without materialising the path.
func TestLookupPathCompare(t *testing.T) {
	root := t.TempDir()
	ix := New()
	ix.AddRoot(root)
	deep := filepath.Join(root, "a", "b", "c", "d", "e", "f", "g")
	ix.AddBatch([]AddItem{
		{Path: filepath.Join(root, "a"), Info: FileInfo{Mode: os.ModeDir | 0o755}},
		{Path: filepath.Join(root, "a", "b"), Info: FileInfo{Mode: os.ModeDir | 0o755}},
		{Path: deep, Info: FileInfo{Mode: 0o644}},
	})
	if id, ok := ix.Lookup(deep); !ok || ix.Path(id) != deep {
		t.Fatalf("deep lookup failed: id=%d ok=%v", id, ok)
	}
	if _, ok := ix.Lookup(filepath.Join(root, "a", "b", "c")); ok {
		t.Fatal("lookup reported a missing directory")
	}
	if _, ok := ix.Lookup(deep + ".bak"); ok {
		t.Fatal("lookup matched a different path")
	}
}

// TestLookupRootIsSeparator: a "/" root stores its own path as the record name;
// child lookups must still compare correctly without materialising paths.
func TestLookupRootIsSeparator(t *testing.T) {
	ix := New()
	ix.AddRoot(string(filepath.Separator))
	child := string(filepath.Separator) + "some-child"
	ix.AddPath(child, FileInfo{Mode: os.ModeDir | 0o755})
	id, ok := ix.Lookup(child)
	if !ok {
		t.Fatalf("child of the filesystem root was not found")
	}
	if got := ix.Path(id); got != child {
		t.Fatalf("path = %q, want %q", got, child)
	}
	if _, ok := ix.Lookup(child + "-other"); ok {
		t.Fatal("lookup matched a different path")
	}
}

// TestQueryGlobFastPathEquivalence: the single-star fast paths must agree with
// the reference glob matcher for every name/pattern pair.
func TestQueryGlobFastPathEquivalence(t *testing.T) {
	names := []string{"report.pdf", "x.go", ".go", "go", "my.go.bak", "REPORT.PDF", "a-b.txt", "abc", "a*b", "a?b", "docs/main.go"}
	patterns := []string{"*.go", "*.pdf", "report*", "*report*", "*", "**", "a*b", "a?b", "*.GO", "x*", "*x", "*.*"}
	ix := New()
	root := filepath.Join(string(filepath.Separator), "globtest")
	ix.AddRoot(root)
	batch := make([]AddItem, 0, len(names))
	for _, name := range names {
		batch = append(batch, AddItem{Path: filepath.Join(root, name), Info: FileInfo{Mode: 0o644}})
	}
	ix.AddBatch(batch)
	for _, pattern := range patterns {
		for _, caseSens := range []bool{false, true} {
			q := Query{Terms: []Term{{Value: pattern}}, Limit: 100, MinSize: -1, MaxSize: -1, MinMtime: -1, MaxMtime: -1, Case: caseSens}
			res, err := ix.Search(q)
			if err != nil {
				t.Fatal(err)
			}
			want := 0
			ix.mu.RLock()
			for i := range ix.recs {
				if ix.recs[i].Deleted() {
					continue
				}
				hay, pat := ix.matchNameLocked(int32(i)), pattern
				if !caseSens {
					hay, pat = strings.ToLower(hay), strings.ToLower(pat)
				}
				if globMatch(hay, pat, caseSens) {
					want++
				}
			}
			ix.mu.RUnlock()
			if res.Total != want {
				t.Fatalf("pattern %q case=%v: total %d, want %d", pattern, caseSens, res.Total, want)
			}
		}
	}
}

// TestQueryRegexLiteralPlanEquivalence: the regex literal shortcut must never
// change match results, including anchored and case-folded patterns.
func TestQueryRegexLiteralPlanEquivalence(t *testing.T) {
	names := []string{"report.pdf", "my-report.pdf", "REPORT.PDF", "notes.txt", "a1b2", "report-42.pdf", "x"}
	patterns := []string{`report`, `^report`, `report$`, `^report$`, `report-`, `^rep.*pdf$`, `\d+`, `^$`, `a|b`, `x?y`, `(?i)^REPORT`, `[0-9]{2}`}
	ix := New()
	root := filepath.Join(string(filepath.Separator), "regextest")
	ix.AddRoot(root)
	batch := make([]AddItem, 0, len(names))
	for i, name := range names {
		batch = append(batch, AddItem{Path: filepath.Join(root, fmt.Sprintf("%d-%s", i, name)), Info: FileInfo{Mode: 0o644}})
	}
	ix.AddBatch(batch)
	for _, pattern := range patterns {
		for _, caseSens := range []bool{false, true} {
			pat := pattern
			if !caseSens {
				pat = "(?i)" + pat
			}
			re := regexp.MustCompile(pat)
			q := Query{Text: pattern, Regex: true, Limit: 100, MinSize: -1, MaxSize: -1, MinMtime: -1, MaxMtime: -1, Case: caseSens}
			res, err := ix.Search(q)
			if err != nil {
				t.Fatalf("pattern %q: %v", pattern, err)
			}
			want := 0
			for i, name := range names {
				if re.MatchString(fmt.Sprintf("%d-%s", i, name)) {
					want++
				}
			}
			if res.Total != want {
				t.Fatalf("pattern %q case=%v: total %d, want %d", pattern, caseSens, res.Total, want)
			}
		}
	}
}

// TestExtBitmapMatchesReference checks the bitmap filter against the map filter
// it replaced for every record of a mixed-extension index.
func TestExtBitmapMatchesReference(t *testing.T) {
	ix := New()
	root := filepath.Join(string(filepath.Separator), "exttest")
	ix.AddRoot(root)
	exts := []string{"go", "json", "pdf", "txt", ""}
	items := make([]AddItem, 0, 40)
	for i := 0; i < 40; i++ {
		ext := exts[i%len(exts)]
		name := fmt.Sprintf("f%02d", i)
		if ext != "" {
			name += "." + ext
		}
		items = append(items, AddItem{Path: filepath.Join(root, name), Info: FileInfo{Mode: 0o644}})
	}
	ix.AddBatch(items)
	queries := []Query{
		{Exts: []string{"json"}, Limit: 100, MinSize: -1, MaxSize: -1, MinMtime: -1, MaxMtime: -1},
		{Exts: []string{"json", "pdf"}, Limit: 100, MinSize: -1, MaxSize: -1, MinMtime: -1, MaxMtime: -1},
		{NotExts: []string{"json"}, Limit: 100, MinSize: -1, MaxSize: -1, MinMtime: -1, MaxMtime: -1},
		{Exts: []string{"json"}, NotExts: []string{"pdf"}, Limit: 100, MinSize: -1, MaxSize: -1, MinMtime: -1, MaxMtime: -1},
		{Exts: []string{"nope"}, Limit: 100, MinSize: -1, MaxSize: -1, MinMtime: -1, MaxMtime: -1},
	}
	for _, q := range queries {
		m, err := newMatcher(&q)
		if err != nil {
			t.Fatal(err)
		}
		ix.mu.RLock()
		m.prepareExts(ix)
		for i := range ix.recs {
			ext := ix.extOfID(ix.recs[i].Ext)
			want := true
			if q.Exts != nil {
				found := false
				for _, e := range q.Exts {
					if e == ext {
						found = true
						break
					}
				}
				want = found
			}
			if want && q.NotExts != nil {
				for _, e := range q.NotExts {
					if e == ext {
						want = false
						break
					}
				}
			}
			if got := m.matches(ix, int32(i)); got != want {
				t.Fatalf("query %+v record %d ext=%q: matches=%v want=%v", q, i, ext, got, want)
			}
		}
		ix.mu.RUnlock()
	}
}

// TestSearchStreamingTopK: when the page is small and matches are wide, Search
// keeps a bounded heap per worker; the page and total must equal the reference
// full-scan result.
func TestSearchStreamingTopK(t *testing.T) {
	ix := New()
	root := filepath.Join(string(filepath.Separator), "topk")
	ix.AddRoot(root)
	const n = 120000
	batch := make([]AddItem, 0, n)
	for i := 0; i < n; i++ {
		name := fmt.Sprintf("report-%06d.txt", i)
		if i%7 == 0 {
			name = fmt.Sprintf("notes-%06d.txt", i)
		}
		batch = append(batch, AddItem{Path: filepath.Join(root, name), Info: FileInfo{Size: int64(i), Mtime: int64(i), Mode: 0o644}})
	}
	ix.AddBatch(batch)
	q, err := ParseQuery("report")
	if err != nil {
		t.Fatal(err)
	}
	q.Limit, q.Offset = 25, 10
	res, err := ix.Search(q)
	if err != nil {
		t.Fatal(err)
	}
	if want := n - (n+6)/7; res.Total != want {
		t.Fatalf("total = %d, want %d", res.Total, want)
	}
	if len(res.Hits) != 25 {
		t.Fatalf("hits = %d, want 25", len(res.Hits))
	}
	// Reference: full scan, sort, then page.
	ix.mu.RLock()
	m, err := newMatcher(&q)
	if err != nil {
		t.Fatal(err)
	}
	ids := ix.collectMatches(m)
	less := func(a, b int32) bool { return ix.lessHit(a, b, q) }
	sort.Slice(ids, func(i, j int) bool { return less(ids[i], ids[j]) })
	want := make([]string, 0, len(res.Hits))
	for _, id := range ids[q.Offset : q.Offset+len(res.Hits)] {
		want = append(want, ix.pathLocked(id))
	}
	ix.mu.RUnlock()
	for i := range want {
		if res.Hits[i].Path != want[i] {
			t.Fatalf("hit %d = %q, want %q", i, res.Hits[i].Path, want[i])
		}
	}
}

// TestPinyinBitmapFallback: the pinyin bitmap must keep transliteration working
// (including after Compact rebuilds the derived tables) and must not leak into
// ASCII-only queries.
func TestPinyinBitmapFallback(t *testing.T) {
	ix := New()
	root := filepath.Join(string(filepath.Separator), "pytest")
	ix.AddRoot(root)
	ix.AddBatch([]AddItem{
		{Path: filepath.Join(root, "国家公园报告.pdf"), Info: FileInfo{Mode: 0o644}},
		{Path: filepath.Join(root, "plain-report.txt"), Info: FileInfo{Mode: 0o644}},
	})
	if hits := searchHits(t, ix, "guojia"); len(hits) != 1 || !strings.Contains(hits[0].Name, "国家") {
		t.Fatalf("full pinyin search = %+v", hits)
	}
	if hits := searchHits(t, ix, "gjgy"); len(hits) != 1 {
		t.Fatalf("initials subsequence search = %+v", hits)
	}
	if hits := searchHits(t, ix, "report"); len(hits) != 1 || hits[0].Name != "plain-report.txt" {
		t.Fatalf("ascii search = %+v", hits)
	}
	// Delete the Han entry, force a compaction and verify the rebuilt bitmap.
	ix.RemovePath(filepath.Join(root, "国家公园报告.pdf"))
	ix.Compact()
	if hits := searchHits(t, ix, "guojia"); len(hits) != 0 {
		t.Fatalf("stale pinyin keys after compact = %+v", hits)
	}
}
