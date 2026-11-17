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
)

func TestLinuxWatcherSeesCreateAndDelete(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "seed.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	ix := index.New()
	ix.AddRoot(root)
	ix.AddPath(filepath.Join(root, "seed.txt"), index.FileInfo{Mode: 0o644})

	w, err := New(ix, Options{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
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

	added := filepath.Join(root, "added.txt")
	if err := os.WriteFile(added, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		res, _ := ix.Search(index.Query{Text: "added", Limit: 5})
		return res.Total == 1
	})

	if err := os.Remove(added); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		res, _ := ix.Search(index.Query{Text: "added", Limit: 5})
		return res.Total == 0
	})
}

func waitFor(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not reached within 3s")
}

func TestLinuxWatcherDirectoryLifecycle(t *testing.T) {
	root := t.TempDir()
	ix := index.New()
	ix.AddRoot(root)

	w, err := New(ix, Options{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
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

	// A pre-populated directory renamed into the tree: no events exist for the
	// files inside, so the watcher must index the subtree it just adopted.
	outside := filepath.Join(filepath.Dir(root), "locator-incoming-"+filepath.Base(root))
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(outside)
	if err := os.WriteFile(filepath.Join(outside, "inside.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(root, "moved")
	if err := os.Rename(outside, moved); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		res, _ := ix.Search(index.Query{Text: "inside.txt", Limit: 5})
		return res.Total == 1
	})

	renamed := filepath.Join(root, "moved2")
	if err := os.Rename(moved, renamed); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		res, _ := ix.Search(index.Query{Text: "inside.txt", Limit: 5})
		return res.Total == 1 && strings.HasPrefix(res.Hits[0].Path, renamed)
	})

	if err := os.RemoveAll(renamed); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		res, _ := ix.Search(index.Query{Text: "inside.txt", Limit: 5})
		return res.Total == 0
	})
}

// TestLinuxWatcherReportsDegradedCoverage: a root that cannot be watched (here a
// missing path, the same code path as an exhausted inotify watch limit) must be
// reported as degraded coverage instead of being silently ignored, so the daemon
// enables the periodic rebuild.
func TestLinuxWatcherReportsDegradedCoverage(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	ix := index.New()
	ix.AddRoot(root)

	var degradedCalls int
	w, err := New(ix, Options{
		Roots: []string{root, missing},
		OnDegraded: func(h Health) {
			degradedCalls++
			if !h.Degraded {
				t.Errorf("degraded callback health = %+v", h)
			}
		},
	})
	if err != nil {
		t.Fatalf("partial watcher creation failed: %v", err)
	}
	defer func() { _ = w.Close() }()

	health := w.(*watcher).Health()
	if health.Roots != 2 || health.Watching != 1 || !health.Degraded {
		t.Fatalf("health = %+v, want 1 of 2 roots degraded", health)
	}
	if health.Dirs == 0 {
		t.Fatal("healthy root has no inotify watches")
	}
	if health.Reason == "" {
		t.Fatal("degraded health has no reason")
	}
	if degradedCalls == 0 {
		t.Fatal("OnDegraded was not called")
	}

	if _, err := New(ix, Options{Roots: []string{missing}}); err == nil {
		t.Fatal("watcher was created without any watchable root")
	}
}

// TestLinuxWatcherSkipsRemoteRoots: a root on a filesystem that cannot deliver
// inotify events must not be walked directory-by-directory. The watcher reports
// degraded coverage (so the daemon runs the periodic rebuild) and must not fail
// startup just because every root was skipped.
func TestLinuxWatcherSkipsRemoteRoots(t *testing.T) {
	root := t.TempDir()
	ix := index.New()
	ix.AddRoot(root)

	old := classifyRoot
	classifyRoot = func(string) (string, bool) {
		return "test remote fs does not deliver inotify events", true
	}
	defer func() { classifyRoot = old }()

	w, err := New(ix, Options{Roots: []string{root}})
	if err != nil {
		t.Fatalf("a skipped root must not fail the watcher: %v", err)
	}
	defer func() { _ = w.Close() }()
	h := HealthOf(w)
	if !h.Degraded {
		t.Fatalf("expected degraded health, got %+v", h)
	}
	if h.Watching != 0 {
		t.Fatalf("expected 0 watched roots, got %d", h.Watching)
	}
	if !strings.Contains(h.Reason, "test remote fs") {
		t.Fatalf("reason must explain the skip, got %q", h.Reason)
	}
}

// TestLinuxWatcherKeepsLocalRootsWhenOneIsRemote: only the remote root is
// skipped; local roots keep their native watches while the health report stays
// honest about incomplete coverage.
func TestLinuxWatcherKeepsLocalRootsWhenOneIsRemote(t *testing.T) {
	local := t.TempDir()
	remote := t.TempDir()
	ix := index.New()
	ix.AddRoot(local)

	old := classifyRoot
	classifyRoot = func(root string) (string, bool) {
		if root == remote {
			return "test remote fs does not deliver inotify events", true
		}
		return "", false
	}
	defer func() { classifyRoot = old }()

	w, err := New(ix, Options{Roots: []string{local, remote}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	h := HealthOf(w)
	if h.Watching != 1 {
		t.Fatalf("expected 1 watched root, got %d (%+v)", h.Watching, h)
	}
	if !h.Degraded {
		t.Fatalf("expected degraded health for partial coverage, got %+v", h)
	}
}
