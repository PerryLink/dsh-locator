//go:build linux

package watch

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
)

// buildWatcherTree creates dirs directories under root, each with one file, and
// returns an index built from the tree the way the daemon loads a snapshot.
func buildWatcherTree(t *testing.T, root string, dirs int) *index.Index {
	t.Helper()
	for i := 0; i < dirs; i++ {
		dir := filepath.Join(root, "dir"+string(rune('a'+i)))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "seed.txt"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ix := index.New()
	if _, err := scan.Run(context.Background(), ix, scan.Options{Roots: []string{root}, Workers: 2}); err != nil {
		t.Fatal(err)
	}
	return ix
}

// TestLinuxWatcherIndexDrivenInit: watches are installed from the index records,
// no filesystem walk, and a change in a deep directory still arrives.
func TestLinuxWatcherIndexDrivenInit(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, "seed.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	ix := index.New()
	if _, err := scan.Run(context.Background(), ix, scan.Options{Roots: []string{root}, Workers: 2}); err != nil {
		t.Fatal(err)
	}
	var indexedDirs int
	after := int32(0)
	for {
		page, next, done := ix.DirPage(after, 100)
		indexedDirs += len(page)
		if done {
			break
		}
		after = next
	}
	w, err := New(ix, Options{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	h := HealthOf(w)
	if h.Dirs != indexedDirs {
		t.Fatalf("watched dirs = %d, indexed dirs = %d (watcher did not use the index)", h.Dirs, indexedDirs)
	}
	if h.Limited {
		t.Fatalf("unexpected limited health: %+v", h)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = w.Run(ctx)
	}()
	defer func() {
		cancel()
		_ = w.Close()
		<-done
	}()
	added := filepath.Join(deep, "added.txt")
	if err := os.WriteFile(added, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		res, _ := ix.Search(index.Query{Text: "added", Limit: 5})
		return res.Total == 1
	})
}

// TestLinuxWatcherMaxDirsQuota: exceeding the directory budget is an
// intermediate state (limited, degraded, coverage says why), not a watcher
// failure. Watched directories still deliver events.
func TestLinuxWatcherMaxDirsQuota(t *testing.T) {
	root := t.TempDir()
	ix := buildWatcherTree(t, root, 5)
	w, err := New(ix, Options{Roots: []string{root}, MaxDirs: 3})
	if err != nil {
		t.Fatalf("a truncated watcher must still start: %v", err)
	}
	defer func() { _ = w.Close() }()
	h := HealthOf(w)
	if !h.Limited || !h.Degraded {
		t.Fatalf("health = %+v, want limited and degraded", h)
	}
	if h.Limit != 3 {
		t.Fatalf("limit = %d, want 3", h.Limit)
	}
	if h.Dirs != 3 {
		t.Fatalf("watched dirs = %d, want exactly the budget", h.Dirs)
	}
	if len(h.Coverage) != 1 || h.Coverage[0].Watched || !h.Coverage[0].Limited {
		t.Fatalf("coverage = %+v, want one limited unwatched root", h.Coverage)
	}
	if !strings.Contains(h.Coverage[0].Reason, "budget") {
		t.Fatalf("coverage reason = %q", h.Coverage[0].Reason)
	}

	// The root itself is watched (it is the first index directory), so a file
	// created there must be indexed; an unwatched directory must not deliver.
	watched := make(map[string]bool)
	for dir := range w.(*watcher).dirWD {
		watched[dir] = true
	}
	var missingDir string
	for i := 0; i < 5; i++ {
		dir := filepath.Join(root, "dir"+string(rune('a'+i)))
		if !watched[dir] {
			missingDir = dir
			break
		}
	}
	if missingDir == "" {
		t.Fatal("expected at least one unwatched directory below the budget")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = w.Run(ctx)
	}()
	defer func() {
		cancel()
		_ = w.Close()
		<-done
	}()
	if err := os.WriteFile(filepath.Join(root, "root-added.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		res, _ := ix.Search(index.Query{Text: "root-added", Limit: 5})
		return res.Total == 1
	})
	if err := os.WriteFile(filepath.Join(missingDir, "unwatched.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	res, _ := ix.Search(index.Query{Text: "unwatched.txt", Limit: 5})
	if res.Total != 0 {
		t.Fatalf("unwatched directory delivered events: %+v", res.Hits)
	}
}

// TestLinuxWatcherCacheExcludes: indexed cache trees are not watched unless the
// include-caches option is set.
func TestLinuxWatcherCacheExcludes(t *testing.T) {
	root := t.TempDir()
	cache := filepath.Join(root, ".cargo", "registry")
	if err := os.MkdirAll(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	ix := index.New()
	ix.AddRoot(root)
	ix.AddBatch([]index.AddItem{
		{Path: filepath.Join(root, ".cargo"), Info: index.FileInfo{Mode: os.ModeDir | 0o755}},
		{Path: cache, Info: index.FileInfo{Mode: os.ModeDir | 0o755}},
	})
	w, err := New(ix, Options{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	for dir := range w.(*watcher).dirWD {
		if strings.Contains(dir, ".cargo") {
			t.Fatalf("cache directory was watched: %s", dir)
		}
	}
	_ = w.Close()

	all, err := New(ix, Options{Roots: []string{root}, IncludeCaches: true})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = all.Close() }()
	found := false
	for dir := range all.(*watcher).dirWD {
		if strings.Contains(dir, ".cargo") {
			found = true
		}
	}
	if !found {
		t.Fatal("includeCaches did not watch the cache tree")
	}
}
