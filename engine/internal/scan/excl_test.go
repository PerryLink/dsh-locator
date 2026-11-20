package scan

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

// TestIsCachePath pins the P0-1 default cache-exclude rules.
func TestIsCachePath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"/home/u/go/pkg/mod/github.com/x", true},
		{"/home/u/.cargo/registry/src", true},
		{"/home/u/.cargo-b20/registry/src", true},
		{"/home/u/.rustup/toolchains/stable", true},
		{"/home/u/.local/lib/python3.12/site-packages/x", true},
		{"/home/u/.local/share/pnpm/store/v3", true},
		{"/home/u/proj/site-packages/x.py", true},
		{"/home/u/proj/dist-packages/y.py", true},
		{"/home/u/.CARGO/registry", true},
		{"/home/u/.npm/_cacache/content", true},
		{"/home/u/.pnpm/store", true},
		{"/home/u/.bun/install/cache", true},
		{"/home/u/.nvm/versions/node/v24", true},
		{"/home/u/.gradle/caches", true},
		{"/home/u/.local/go/src", true},
		{"/home/u/toolchain/go1.27.3/src", true},
		{"/home/u/project/.npmrc-data/x", false},
		{"/home/u/go/pkg/other", false},
		{"/home/u/go/pkg", false},
		{"/home/u/.dsh/sessions", false},
		{"/home/u/project/.local/share/data", false},
		{"/home/u/project/node_modules/x", false},
	}
	for _, tc := range tests {
		if got := IsCachePath(tc.path); got != tc.want {
			t.Fatalf("IsCachePath(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}

// TestScanSkipsCachesByDefault is the P0-1 acceptance test: cache trees are
// pruned by default and restored with IncludeCaches.
func TestScanSkipsCachesByDefault(t *testing.T) {
	root := t.TempDir()
	write := func(rel string) {
		t.Helper()
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("docs/report.pdf")
	write("go/pkg/mod/github.com/pkg/errors/errors.go")
	write(".cargo-b20/registry/src/lib.rs")
	write(".rustup/toolchains/stable/bin/rustc")
	write(".local/lib/python3.12/thing.py")
	write(".local/share/pnpm/store/pkg.tgz")
	write("site-packages/numpy/__init__.py")
	write("dist-packages/old.py")
	write(".npm/_cacache/content/a")
	write(".bun/install/cache/b")
	write(".nvm/versions/node/v24/c")
	write(".local/go/src/d")
	write("toolchain/go1.27.3/src/e")

	ix := index.New()
	st, err := Run(context.Background(), ix, Options{Roots: []string{root}, Workers: 2})
	if err != nil {
		t.Fatal(err)
	}
	if st.Files != 1 {
		t.Fatalf("files = %d, want only docs/report.pdf (st=%+v)", st.Files, st)
	}
	if st.Skipped == 0 {
		t.Fatal("cache trees were not counted as skipped")
	}
	if _, ok := ix.Lookup(filepath.Join(root, "go", "pkg", "mod")); ok {
		t.Fatal("cache directory was indexed")
	}

	all := index.New()
	st, err = Run(context.Background(), all, Options{Roots: []string{root}, Workers: 2, IncludeCaches: true})
	if err != nil {
		t.Fatal(err)
	}
	if st.Files != 13 {
		t.Fatalf("files with IncludeCaches = %d, want 13", st.Files)
	}
}

// TestExcluderMatchesOldReference compares the precompiled matcher with the
// pre-0.20 per-entry implementation on a mixed pattern set.
func TestExcluderMatchesOldReference(t *testing.T) {
	patterns := []string{"node_modules", "*.tmp", "build/**", "sub/*.log", "[a]bc", " .cache "}
	e := NewExcluder(patterns, true)
	paths := []string{
		"/home/u/proj/node_modules/x.js",
		"/home/u/proj/notes.tmp",
		"/home/u/proj/build/x.o",
		"/home/u/proj/sub/a.log",
		"/home/u/proj/abc.txt",
		"/home/u/proj/.cache/x",
		"/home/u/proj/keep.go",
	}
	for _, path := range paths {
		name := filepath.Base(path)
		isDir := strings.HasSuffix(path, "/")
		want := referenceExcluded(path, name, isDir, patterns)
		if got := e.Skip(path, name, isDir); got != want {
			t.Fatalf("Skip(%q) = %v, want %v", path, got, want)
		}
	}
}

// TestExcluderSkipAnySegment: change streams report absolute paths, so a path
// is excluded when any segment matches the base-name rules or it is a cache.
func TestExcluderSkipAnySegment(t *testing.T) {
	e := NewExcluder([]string{"node_modules", "*.tmp"}, false)
	if !e.SkipAnySegment("/a/node_modules/b/c.js") {
		t.Fatal("path through node_modules not excluded")
	}
	if !e.SkipAnySegment("/a/b/x.tmp") {
		t.Fatal("tmp file not excluded")
	}
	if !e.SkipAnySegment("/home/u/.cargo/registry/x") {
		t.Fatal("cache segment not excluded by default")
	}
	if e.SkipAnySegment("/a/b/keep.go") {
		t.Fatal("ordinary path wrongly excluded")
	}
	all := NewExcluder([]string{"node_modules"}, true)
	if all.SkipAnySegment("/home/u/.cargo/registry/x") {
		t.Fatal("includeCaches excluder still skipped a cache tree")
	}
}

// referenceExcluded is the pre-0.20 scan rule, kept as the equivalence oracle.
func referenceExcluded(path, name string, isDir bool, patterns []string) bool {
	for _, p := range patterns {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if strings.ContainsAny(p, "/\\") {
			if ok, _ := filepath.Match(p, path); ok {
				return true
			}
			if isDir && strings.HasSuffix(p, "/**") {
				base := strings.TrimSuffix(strings.TrimSuffix(p, "/**"), "/")
				if ok, _ := filepath.Match(base, name); ok {
					return true
				}
			}
			continue
		}
		if ok, _ := filepath.Match(p, name); ok {
			return true
		}
	}
	return false
}
