package index

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestSnapshotAndJournalAreCreatedPrivate pins the 0700/0600 promise for the
// two name-index files the engine writes itself.
func TestSnapshotAndJournalAreCreatedPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no POSIX mode bits")
	}
	dir := filepath.Join(t.TempDir(), "nested", "state")
	snap := filepath.Join(dir, "index.snapshot")
	ix := New()
	ix.AddRoot(filepath.Clean("/store-root"))
	ix.AddPath(filepath.Join("/store-root", "a.txt"), FileInfo{Size: 1, Mtime: 10})
	info, err := ix.SaveBase(snap, SnapshotOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertPerm(t, dir, 0o700)
	assertPerm(t, snap, 0o600)

	journal := filepath.Join(dir, JournalName)
	ix.SetJournalEnabled(true)
	ix.AddPath(filepath.Join("/store-root", "b.txt"), FileInfo{Size: 2, Mtime: 20})
	if _, _, err := ix.WriteJournalTo(journal, info.BaseID, 0); err != nil {
		t.Fatal(err)
	}
	assertPerm(t, journal, 0o600)
}

// assertPerm fails unless path has exactly want for its permission bits.
func assertPerm(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %04o, want %04o", path, got, want)
	}
}
