package server

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

func newServerWithIndex(t *testing.T, ix *index.Index, roots []string) *Server {
	t.Helper()
	s := New(Options{StateDir: t.TempDir(), Roots: roots, Version: "test"})
	s.out = io.Discard
	s.opt.Log = io.Discard
	s.mu.Lock()
	s.ix = ix
	s.mu.Unlock()
	return s
}

// TestRescanRootsDarwinTempPathShape reproduces the darwin CI failure on
// Linux. t.TempDir() on macOS returns a path under /var/folders/, and the
// "folders" component contains the substring "old". The regression test that
// proves a deleted file stops being indexed counts bare "old" hits; while a
// root record stored its absolute path as its searchable name, both roots
// matched that term and the count was 2 even though the file was gone. Shaping
// the roots the same way here keeps the darwin-only failure reproducible on
// Linux.
func TestRescanRootsDarwinTempPathShape(t *testing.T) {
	base := filepath.Join(t.TempDir(), "var-folders", "T")
	healthy := filepath.Join(base, "healthy")
	degraded := filepath.Join(base, "degraded")
	for _, dir := range []string{healthy, degraded} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite(t, filepath.Join(healthy, "keep.txt"))
	mustWrite(t, filepath.Join(degraded, "old.txt"))

	ix := index.New()
	if _, err := scanForTest(t, ix, []string{healthy, degraded}); err != nil {
		t.Fatal(err)
	}
	s := newServerWithIndex(t, ix, []string{healthy, degraded})
	if got := countFor(t, ix, "old"); got != 1 {
		t.Fatalf("before the rescan old.txt should be the only \"old\" hit: old=%d", got)
	}

	// The watcher would have indexed healthy/new.txt already; leaving it out
	// proves a partial refresh never touches the healthy root.
	mustWrite(t, filepath.Join(healthy, "new.txt"))
	mustWrite(t, filepath.Join(degraded, "added.txt"))
	if err := os.Remove(filepath.Join(degraded, "old.txt")); err != nil {
		t.Fatal(err)
	}
	st, err := s.rescanRoots(context.Background(), ix, []string{degraded})
	if err != nil {
		t.Fatalf("rescanRoots: %v", err)
	}
	if st.Entries == 0 {
		t.Fatal("rescan did not scan the degraded root")
	}
	if got := countFor(t, ix, "old"); got != 0 {
		t.Fatalf("deleted file survived the rescan (roots matched the ancestor path): old=%d", got)
	}
	if got := countFor(t, ix, "keep"); got != 1 {
		t.Fatalf("healthy root entries were lost: keep=%d", got)
	}
	if got := countFor(t, ix, "new"); got != 0 {
		t.Fatalf("rescan touched the healthy root: new=%d", got)
	}
	if got := countFor(t, ix, "added"); got != 1 {
		t.Fatalf("degraded root did not converge: added=%d", got)
	}
	if !sameRootSet(ix.Roots(), []string{healthy, degraded}) {
		t.Fatalf("roots = %v", ix.Roots())
	}
}

// TestRescanRootsThroughSymlinks pins the path-form contract for roots that
// are reached through a symlink (the macOS /var -> /private/var shape): the
// scan stores entries under the configured spelling, and RemoveSubtree must
// match that same spelling so a partial rescan converges instead of leaving
// stale entries behind or duplicating the tree.
func TestRescanRootsThroughSymlinks(t *testing.T) {
	t.Run("root is a symlink", func(t *testing.T) {
		base := t.TempDir()
		realRoot := filepath.Join(base, "real-root")
		linkRoot := filepath.Join(base, "link-root")
		if err := os.Mkdir(realRoot, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(realRoot, linkRoot); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		rescanThroughLink(t, linkRoot, realRoot)
	})
	t.Run("ancestor is a symlink", func(t *testing.T) {
		base := t.TempDir()
		realParent := filepath.Join(base, "private-var")
		linkParent := filepath.Join(base, "var")
		realRoot := filepath.Join(realParent, "root")
		if err := os.MkdirAll(realRoot, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(realParent, linkParent); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		rescanThroughLink(t, filepath.Join(linkParent, "root"), realRoot)
	})
}

func rescanThroughLink(t *testing.T, configuredRoot, realRoot string) {
	t.Helper()
	mustWrite(t, filepath.Join(realRoot, "keep.txt"))
	mustWrite(t, filepath.Join(realRoot, "old.txt"))

	ix := index.New()
	if _, err := scanForTest(t, ix, []string{configuredRoot}); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !ix.HasRoot(configuredRoot) {
		t.Fatalf("root was not indexed under the configured spelling: roots=%v", ix.Roots())
	}
	if ix.HasRoot(realRoot) {
		t.Fatalf("root was indexed under the resolved spelling: roots=%v", ix.Roots())
	}
	if _, ok := ix.Lookup(filepath.Join(configuredRoot, "old.txt")); !ok {
		t.Fatalf("entries are not stored under the configured spelling: roots=%v", ix.Roots())
	}

	s := newServerWithIndex(t, ix, []string{configuredRoot})
	if err := os.Remove(filepath.Join(realRoot, "old.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.rescanRoots(context.Background(), ix, []string{configuredRoot}); err != nil {
		t.Fatalf("rescanRoots: %v", err)
	}
	if got := countFor(t, ix, "old"); got != 0 {
		t.Fatalf("deleted file survived the rescan through the symlink: old=%d", got)
	}
	if got := countFor(t, ix, "keep"); got != 1 {
		t.Fatalf("keep.txt = %d, want 1", got)
	}
	if got := ix.Len(); got != 2 {
		t.Fatalf("rescan left stale or duplicate records: entries=%d, want root+keep.txt", got)
	}
	if !sameRootSet(ix.Roots(), []string{configuredRoot}) {
		t.Fatalf("roots = %v, want the configured spelling %q", ix.Roots(), configuredRoot)
	}
}
