package scan

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

// benchTree creates a directory tree with dirs dirs and filesPerDir files each.
// Every directory also contains excluded subtrees (node_modules, .git) so the
// per-entry exclusion cost is representative of a real profile.
func benchTree(b *testing.B, dirs, filesPerDir int) string {
	b.Helper()
	root := b.TempDir()
	for i := 0; i < dirs; i++ {
		dir := filepath.Join(root, fmt.Sprintf("area%03d", i/50), fmt.Sprintf("dir%04d", i%50))
		if err := os.MkdirAll(filepath.Join(dir, "node_modules", "pkg"), 0o755); err != nil {
			b.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(dir, ".git", "objects"), 0o755); err != nil {
			b.Fatal(err)
		}
		for j := 0; j < filesPerDir; j++ {
			name := filepath.Join(dir, fmt.Sprintf("file%03d.go", j))
			if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
				b.Fatal(err)
			}
		}
	}
	return root
}

func BenchmarkScanTree(b *testing.B) {
	root := benchTree(b, 400, 25)
	excludes := []string{"node_modules", ".git", ".cache", "dist", "build", "target", "vendor", "coverage", ".next", "__pycache__", ".venv"}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ix := index.New()
		if _, err := Run(context.Background(), ix, Options{Roots: []string{root}, Excludes: excludes, Workers: 8}); err != nil {
			b.Fatal(err)
		}
	}
}
