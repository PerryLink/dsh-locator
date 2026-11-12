//go:build windows

package watch

import (
	"path/filepath"
	"testing"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

// TestWindowsWatcherPairsRootsAndReportsDegraded covers two Windows-specific
// hazards: root paths and directory handles used to live in separate slices, so
// one failed CreateFile shifted every later root onto the wrong handle; and a
// watcher that only opened some roots must report degraded coverage so the
// daemon also runs the periodic rebuild.
func TestWindowsWatcherPairsRootsAndReportsDegraded(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	ix := index.New()
	ix.AddRoot(root)

	var degradedCalls int
	w, err := New(ix, Options{
		Roots: []string{root, missing},
		OnDegraded: func(h Health) {
			degradedCalls++
			if !h.Degraded || h.Watching >= h.Roots {
				t.Errorf("degraded callback health = %+v", h)
			}
		},
	})
	if err != nil {
		t.Fatalf("partial watcher creation failed: %v", err)
	}
	defer func() { _ = w.Close() }()

	ww := w.(*watcher)
	ww.mu.Lock()
	pairs := append([]watchedRoot(nil), ww.watched...)
	ww.mu.Unlock()
	if len(pairs) != 1 {
		t.Fatalf("watched roots = %d, want 1", len(pairs))
	}
	if pairs[0].root != root {
		t.Fatalf("handle paired with %q, want %q", pairs[0].root, root)
	}
	health := ww.Health()
	if health.Roots != 2 || health.Watching != 1 || !health.Degraded {
		t.Fatalf("health = %+v, want 1 of 2 roots degraded", health)
	}
	if degradedCalls == 0 {
		t.Fatal("OnDegraded was not called for the unopened root")
	}

	// With no usable root at all the watcher must fail so the server switches
	// to the refresh fallback instead of claiming the index is live.
	if _, err := New(ix, Options{Roots: []string{missing}}); err == nil {
		t.Fatal("watcher was created without any usable root")
	}
}

// TestWindowsWatcherHealthCleanRoot checks the healthy path: one open root is
// fully covered and not degraded.
func TestWindowsWatcherHealthCleanRoot(t *testing.T) {
	root := t.TempDir()
	ix := index.New()
	ix.AddRoot(root)
	w, err := New(ix, Options{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	health := w.(*watcher).Health()
	if health.Roots != 1 || health.Watching != 1 || health.Degraded {
		t.Fatalf("health = %+v, want clean single root", health)
	}
}
