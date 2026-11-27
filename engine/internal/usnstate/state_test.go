package usnstate

import (
	"os"
	"runtime"
	"testing"

	"github.com/PerryLink/dsh-locator/engine/internal/scan"
)

func TestSaveCreatesPrivateFiles(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no POSIX mode bits")
	}
	dir := t.TempDir()
	if err := Save(dir, scan.USNState{Volume: "C:", NextUSN: 42}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("state dir mode = %04o", info.Mode().Perm())
	}
	file, err := os.Stat(Path(dir))
	if err != nil {
		t.Fatal(err)
	}
	if file.Mode().Perm() != 0o600 {
		t.Fatalf("usn-state.json mode = %04o", file.Mode().Perm())
	}
	loaded := Load(dir)
	if len(loaded) != 1 || loaded[0].NextUSN != 42 {
		t.Fatalf("loaded = %+v", loaded)
	}
}
