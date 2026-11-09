//go:build linux

package watch

import (
	"context"
	"os"
	"path/filepath"
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
