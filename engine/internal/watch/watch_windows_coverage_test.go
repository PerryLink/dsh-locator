//go:build windows

package watch

import (
	"path/filepath"
	"testing"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

func windowsCoverageFor(h Health, root string) (RootCoverage, bool) {
	for _, c := range h.Coverage {
		if filepath.Clean(c.Path) == filepath.Clean(root) {
			return c, true
		}
	}
	return RootCoverage{}, false
}

func TestWindowsCoverageReportsEveryRoot(t *testing.T) {
	first := t.TempDir()
	second := t.TempDir()
	ix := index.New()
	ix.AddRoot(first)
	ix.AddRoot(second)
	w, err := New(ix, Options{Roots: []string{first, second}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	h := HealthOf(w)
	if len(h.Coverage) != 2 || h.Watching != 2 || h.Degraded {
		t.Fatalf("health = %+v, want two watched roots", h)
	}
	for _, root := range []string{first, second} {
		c, ok := windowsCoverageFor(h, root)
		if !ok || !c.Watched {
			t.Fatalf("coverage for %s = %+v ok=%v", root, c, ok)
		}
	}
}

func TestWindowsCoverageMarksFailedRootUnwatched(t *testing.T) {
	good := t.TempDir()
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	ix := index.New()
	ix.AddRoot(good)
	w, err := New(ix, Options{Roots: []string{good, missing}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	h := HealthOf(w)
	if !h.Degraded || h.Watching != 1 {
		t.Fatalf("health = %+v, want one of two roots watched", h)
	}
	goodCov, ok := windowsCoverageFor(h, good)
	if !ok || !goodCov.Watched {
		t.Fatalf("healthy root coverage = %+v ok=%v", goodCov, ok)
	}
	missingCov, ok := windowsCoverageFor(h, missing)
	if !ok || missingCov.Watched {
		t.Fatalf("missing root coverage = %+v ok=%v", missingCov, ok)
	}
	if missingCov.Reason == "" {
		t.Fatalf("unwatched root has no reason: %+v", missingCov)
	}
}
