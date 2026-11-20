package server

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
)

// benchRefreshTree builds a root with dirs dirs and files files plus a loaded
// index, mirroring one periodic fallback refresh of an unwatched 9p root.
func benchRefreshTree(b *testing.B, dirs, files int) (*Server, *index.Index, string) {
	b.Helper()
	root := b.TempDir()
	for i := 0; i < dirs; i++ {
		dir := filepath.Join(root, fmt.Sprintf("area%03d", i/50), fmt.Sprintf("dir%04d", i%50))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			b.Fatal(err)
		}
		for j := 0; j < files/dirs; j++ {
			name := filepath.Join(dir, fmt.Sprintf("file%03d.txt", j))
			if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
				b.Fatal(err)
			}
		}
	}
	ix := index.New()
	if _, err := scan.Run(context.Background(), ix, scan.Options{Roots: []string{root}, Workers: 8}); err != nil {
		b.Fatal(err)
	}
	s := New(Options{StateDir: b.TempDir(), Roots: []string{root}, Version: "bench"})
	s.out = io.Discard
	s.opt.Log = io.Discard
	s.mu.Lock()
	s.ix = ix
	s.mu.Unlock()
	return s, ix, root
}

func BenchmarkPeriodicRefreshNoChange(b *testing.B) {
	s, ix, root := benchRefreshTree(b, 100, 10000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := s.rescanRoots(context.Background(), ix, []string{root}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPeriodicRefreshSmallChange(b *testing.B) {
	s, ix, root := benchRefreshTree(b, 100, 10000)
	changed := filepath.Join(root, "area000", "dir0000", "file000.txt")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := os.WriteFile(changed, []byte(fmt.Sprintf("y%d", i)), 0o644); err != nil {
			b.Fatal(err)
		}
		if _, err := s.rescanRoots(context.Background(), ix, []string{root}); err != nil {
			b.Fatal(err)
		}
	}
}
