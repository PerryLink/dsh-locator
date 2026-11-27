package store

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

// TestStateDirIsCreatedPrivate pins the 0700/0600 promise of the README:
// inside a state directory every engine-created object is owner-only.
func TestStateDirIsCreatedPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no POSIX mode bits; the engine relies on ACL inheritance there")
	}
	dir := filepath.Join(t.TempDir(), "nested", "state")
	// Simulate a state directory and a leftover temporary file from an older
	// (<=0.22) engine, then prove a save tightens both.
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "meta.json.tmp"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	ix := testIndex(t)
	if err := Save(dir, ix, Meta{Version: "test"}); err != nil {
		t.Fatal(err)
	}
	assertMode(t, dir, 0o700)
	snap, metaPath := Paths(dir)
	assertMode(t, snap, 0o600)
	assertMode(t, metaPath, 0o600)

	// The incremental journal follows the same rule.
	ix.SetJournalEnabled(true)
	ix.AddPath(filepath.Join("/store-root", "c.txt"), index.FileInfo{Size: 3, Mtime: 30})
	if _, err := SaveWith(dir, ix, Meta{Version: "test"}, SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	journal := JournalPath(dir)
	if _, err := os.Stat(journal); err != nil {
		t.Fatalf("journal was not written: %v", err)
	}
	assertMode(t, journal, 0o600)

	// The USN cursor and the write lock are state files too.
	lock, holder, err := AcquireLock(dir, "test")
	if err != nil || lock == nil || holder != nil {
		t.Fatalf("AcquireLock = %v, %v, %v", lock, holder, err)
	}
	assertMode(t, LockPath(dir), 0o600)
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
}

// assertMode fails unless path has exactly want, including the owner bits.
func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %04o, want %04o", path, got, want)
	}
}
