package index

import (
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func testIndex(t *testing.T) *Index {
	t.Helper()
	ix := New()
	root := filepath.Clean("/data")
	ix.AddRoot(root)
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC).UnixNano()
	add := func(p string, size int64, dir bool) {
		mode := fs.FileMode(0o644)
		if dir {
			mode = fs.ModeDir | 0o755
		}
		ix.AddPath(filepath.Join(root, p), FileInfo{Size: size, Mtime: base, Mode: mode})
	}
	add("docs", 0, true)
	add("docs/report.pdf", 2048, false)
	add("docs/notes.txt", 12, false)
	add("src", 0, true)
	add("src/main.go", 900, false)
	add("src/util.go", 120, false)
	add("src/REPORT.MD", 40, false)
	add("archive.zip", 5<<20, false)
	add("tmp", 0, true)
	add("tmp/cache.bin", 1<<20, false)
	return ix
}

func TestPathAndSearch(t *testing.T) {
	ix := testIndex(t)
	res, err := ix.Search(Query{Text: "report", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 2 {
		t.Fatalf("total = %d, want 2: %+v", res.Total, res.Hits)
	}
	for _, h := range res.Hits {
		if h.Name != "report.pdf" && h.Name != "REPORT.MD" {
			t.Fatalf("unexpected hit %+v", h)
		}
	}
	if p := ix.Path(ix.roots[0]); p != filepath.Clean("/data") {
		t.Fatalf("root path = %q", p)
	}
}

func TestFilters(t *testing.T) {
	ix := testIndex(t)
	cases := []struct {
		q    string
		want int
	}{
		{"ext:go", 2},
		{"ext:go size:>500", 1},
		{"folder:", 4},
		{"file:", 7},
		{"!report", 9},
		{"path:src", 4},
		{"*.go", 2},
		{"REPORT", 2},
		{"report case:1", 1},
		{"size:>1mb", 1},
	}
	for _, c := range cases {
		q, err := ParseQuery(c.q)
		if err != nil {
			t.Fatalf("%q: %v", c.q, err)
		}
		res, err := ix.Search(q)
		if err != nil {
			t.Fatalf("%q: %v", c.q, err)
		}
		if res.Total != c.want {
			t.Errorf("%q: total = %d, want %d (%+v)", c.q, res.Total, c.want, res.Hits)
		}
	}
}

func TestSortAndPage(t *testing.T) {
	ix := testIndex(t)
	q, _ := ParseQuery("")
	q.SetSort("size", true)
	q.Limit = 3
	res, err := ix.Search(q)
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 11 {
		t.Fatalf("total = %d, want 11", res.Total)
	}
	if len(res.Hits) != 3 || res.Hits[0].Name != "archive.zip" {
		t.Fatalf("unexpected page: %+v", res.Hits)
	}
	q.Offset = 3
	res, _ = ix.Search(q)
	if len(res.Hits) != 3 || res.Hits[0].Name != "main.go" {
		t.Fatalf("unexpected offset page: %+v", res.Hits)
	}
}

func TestDateFilter(t *testing.T) {
	ix := testIndex(t)
	q, err := ParseQuery("dm:2026-01-02")
	if err != nil {
		t.Fatal(err)
	}
	res, _ := ix.Search(q)
	if res.Total != 10 {
		t.Fatalf("date total = %d, want 10", res.Total)
	}
	q, _ = ParseQuery("dm:2026-01-03")
	res, _ = ix.Search(q)
	if res.Total != 0 {
		t.Fatalf("next-day total = %d, want 0", res.Total)
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	ix := testIndex(t)
	path := filepath.Join(t.TempDir(), "index.snap")
	if err := ix.Save(path); err != nil {
		t.Fatal(err)
	}
	back, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	res, err := back.Search(Query{Text: "go", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 2 {
		t.Fatalf("reloaded total = %d, want 2", res.Total)
	}
	if got := back.Roots(); len(got) != 1 || got[0] != filepath.Clean("/data") {
		t.Fatalf("roots = %v", got)
	}
	// The path table must still resolve existing entries after a load.
	if _, added := back.AddPath(filepath.Join("/data", "src", "main.go"), FileInfo{Size: 901, Mode: 0o644}); added {
		t.Fatal("existing path was re-added as new")
	}
	if got := back.Len(); got != 11 {
		t.Fatalf("len = %d, want 11", got)
	}
}

func TestCompact(t *testing.T) {
	ix := testIndex(t)
	if !ix.RemovePath("/data/archive.zip") {
		t.Fatal("remove failed")
	}
	if ix.Len() != 10 {
		t.Fatalf("len = %d, want 10", ix.Len())
	}
	ix.Compact()
	if ix.Len() != 10 || ix.Stats().Deleted != 0 {
		t.Fatalf("compact left %+v", ix.Stats())
	}
	res, _ := ix.Search(Query{Text: "archive", Limit: 5})
	if res.Total != 0 {
		t.Fatalf("deleted entry still searchable: %+v", res.Hits)
	}
	res, _ = ix.Search(Query{Text: "main.go", Limit: 5})
	if res.Total != 1 {
		t.Fatalf("main.go lost after compact: %+v", res.Hits)
	}
}

func TestMain(m *testing.M) {
	os.Exit(m.Run())
}

func TestTableSurvivesChurn(t *testing.T) {
	ix := New()
	ix.AddRoot("/churn")
	for i := 0; i < 20000; i++ {
		path := filepath.Join("/churn", "f"+strconv.Itoa(i)+".txt")
		ix.AddPath(path, FileInfo{Size: 1, Mode: 0o644})
		if i%2 == 0 {
			ix.RemovePath(path)
		}
	}
	if got := ix.Len(); got != 10001 {
		t.Fatalf("len = %d, want 10001", got)
	}
	if _, added := ix.AddPath(filepath.Join("/churn", "f19999.txt"), FileInfo{Size: 2, Mode: 0o644}); added {
		t.Fatal("existing path re-added as new")
	}
	res, err := ix.Search(Query{Text: "f19999", Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 1 {
		t.Fatalf("lookup after churn: %+v", res.Hits)
	}
}
