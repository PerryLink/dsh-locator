package scan

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

func TestRunIndexesTreeAndSkipsExcludes(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "docs", "report.pdf"))
	mustWrite(t, filepath.Join(dir, "src", "main.go"))
	mustWrite(t, filepath.Join(dir, "node_modules", "pkg", "index.js"))
	mustWrite(t, filepath.Join(dir, ".git", "config"))

	ix := index.New()
	st, err := Run(context.Background(), ix, Options{
		Roots:    []string{dir},
		Excludes: []string{"node_modules", ".git"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if st.Files != 2 {
		t.Fatalf("files = %d, want 2 (excludes must prune subtrees)", st.Files)
	}
	if st.Dirs < 2 {
		t.Fatalf("dirs = %d, want at least 2", st.Dirs)
	}
	res, err := ix.Search(index.Query{Text: "report", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 1 || res.Hits[0].Path != filepath.Join(dir, "docs", "report.pdf") {
		t.Fatalf("unexpected search: %+v", res)
	}
	if got := ix.Len(); got != int(st.Entries) {
		t.Fatalf("index len = %d, stats entries = %d", got, st.Entries)
	}
}

func TestRunRejectsMissingRoot(t *testing.T) {
	ix := index.New()
	if _, err := Run(context.Background(), ix, Options{Roots: []string{filepath.Join(t.TempDir(), "nope")}}); err == nil {
		t.Fatal("expected ErrNoRoots")
	}
}

func mustWrite(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}
