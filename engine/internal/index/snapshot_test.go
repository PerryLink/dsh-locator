package index

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadRejectsCorruptSnapshots(t *testing.T) {
	dir := t.TempDir()
	cases := map[string][]byte{
		"empty":       {},
		"bad-magic":   []byte("NOTLOC01"),
		"short":       []byte("DSHLOC01"),
		"bad-table":   append(make([]byte, 48), 0, 0, 0, 0),
	}
	for name, data := range cases {
		path := filepath.Join(dir, name+".snap")
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Fatalf("%s: Load accepted corrupt data", name)
		}
	}
}

func TestSaveLoadEmptyIndex(t *testing.T) {
	ix := New()
	path := filepath.Join(t.TempDir(), "empty.snap")
	if err := ix.Save(path); err != nil {
		t.Fatal(err)
	}
	back, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if back.Len() != 0 {
		t.Fatalf("len = %d", back.Len())
	}
	res, err := back.Search(Query{Text: "anything", Limit: 5})
	if err != nil || res.Total != 0 {
		t.Fatalf("unexpected search on empty index: %+v %v", res, err)
	}
}

func TestSnapshotRoundTripsFRN(t *testing.T) {
	ix := New()
	ix.AddRoot("/data")
	ix.AddBatch([]AddItem{
		{Path: "/data/a.txt", FRN: 0x000500000000002a, Info: FileInfo{Size: 3}},
		{Path: "/data/b.txt", Info: FileInfo{Size: 4}},
	})
	path := filepath.Join(t.TempDir(), "frn.snap")
	if err := ix.Save(path); err != nil {
		t.Fatal(err)
	}
	back, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	paths := back.FRNPaths()
	if got := paths[0x000500000000002a]; got != "/data/a.txt" {
		t.Fatalf("FRN path = %q", got)
	}
	if len(paths) != 1 {
		t.Fatalf("FRN map has %d entries, want 1", len(paths))
	}
}
