//go:build linux

package watch

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

// benchWatchIndex builds an index that already holds dirs directories, the way
// the daemon loads a snapshot before starting the watcher.
func benchWatchIndex(b *testing.B, dirs int) (*index.Index, string) {
	b.Helper()
	root := b.TempDir()
	ix := index.New()
	ix.AddRoot(root)
	batch := make([]index.AddItem, 0, dirs)
	for i := 0; i < dirs; i++ {
		dir := filepath.Join(root, fmt.Sprintf("area%03d", i/100), fmt.Sprintf("dir%04d", i%100))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			b.Fatal(err)
		}
		batch = append(batch, index.AddItem{Path: dir, Info: index.FileInfo{Mode: os.ModeDir | 0o755}})
	}
	ix.AddBatch(batch)
	return ix, root
}

func BenchmarkWatcherInit(b *testing.B) {
	ix, root := benchWatchIndex(b, 4000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		w, err := New(ix, Options{Roots: []string{root}})
		if err != nil {
			b.Fatal(err)
		}
		_ = w.Close()
	}
}
