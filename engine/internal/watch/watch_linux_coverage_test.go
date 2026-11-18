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

// coverageFor returns the coverage entry of one root.
func coverageFor(h Health, root string) (RootCoverage, bool) {
	for _, c := range h.Coverage {
		if filepath.Clean(c.Path) == filepath.Clean(root) {
			return c, true
		}
	}
	return RootCoverage{}, false
}

// TestLinuxCoverageAttributesSkippedRoots: the daemon must be able to tell
// which root is unwatched so the periodic refresh can rescan only that one.
func TestLinuxCoverageAttributesSkippedRoots(t *testing.T) {
	local := t.TempDir()
	remote := t.TempDir()
	ix := index.New()
	ix.AddRoot(local)
	ix.AddRoot(remote)

	old := classifyRoot
	classifyRoot = func(root string) (string, bool) {
		if filepath.Clean(root) == filepath.Clean(remote) {
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
	if len(h.Coverage) != 2 {
		t.Fatalf("coverage = %+v, want one entry per root", h.Coverage)
	}
	localCov, ok := coverageFor(h, local)
	if !ok || !localCov.Watched {
		t.Fatalf("local root coverage = %+v ok=%v, want watched", localCov, ok)
	}
	remoteCov, ok := coverageFor(h, remote)
	if !ok || remoteCov.Watched {
		t.Fatalf("remote root coverage = %+v ok=%v, want unwatched", remoteCov, ok)
	}
	if !strings.Contains(remoteCov.Reason, "test remote fs") {
		t.Fatalf("remote root reason = %q", remoteCov.Reason)
	}
}

// TestLinuxCoverageKeepsDegradedFSRootUnwatched: a FUSE/stacked root is still
// walked (it may deliver events) but stays in the rescan set because its
// notifications are not trustworthy.
func TestLinuxCoverageKeepsDegradedFSRootUnwatched(t *testing.T) {
	root := t.TempDir()
	ix := index.New()
	ix.AddRoot(root)
	old := classifyRoot
	classifyRoot = func(string) (string, bool) {
		return "test FUSE may drop events", false
	}
	defer func() { classifyRoot = old }()
	w, err := New(ix, Options{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	h := HealthOf(w)
	if len(h.Coverage) != 1 {
		t.Fatalf("coverage = %+v", h.Coverage)
	}
	if h.Coverage[0].Watched {
		t.Fatalf("degraded filesystem root must not be reported as fully watched: %+v", h.Coverage[0])
	}
	if !h.Degraded {
		t.Fatalf("health not degraded: %+v", h)
	}
}

// TestLinuxCoverageDropsRootWhenWatchIsRemoved: deleting a watched root
// removes its watch; coverage must then report the root as unwatched so the
// periodic refresh rescans it instead of reusing stale entries.
func TestLinuxCoverageDropsRootWhenWatchIsRemoved(t *testing.T) {
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

	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		h := HealthOf(w)
		cov, ok := coverageFor(h, root)
		if ok && !cov.Watched {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("root coverage did not turn unwatched after the root was removed: %+v", h)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
