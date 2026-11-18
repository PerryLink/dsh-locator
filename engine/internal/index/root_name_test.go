package index

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func searchTotal(t *testing.T, ix *Index, query string) int {
	t.Helper()
	q, err := ParseQuery(query)
	if err != nil {
		t.Fatalf("ParseQuery(%q): %v", query, err)
	}
	q.Limit = 100
	res, err := ix.Search(q)
	if err != nil {
		t.Fatalf("Search(%q): %v", query, err)
	}
	return res.Total
}

// TestRootRecordMatchesOwnNameNotAncestorPath pins the searchable name of a
// root record. A root has no parent record, so the index stores its whole
// absolute path in the name arena (pathLocked rebuilds the path from it). The
// name a bare query matches must still be the record's own last path
// component, exactly like Hit.Name. Matching the stored text made every
// ancestor directory searchable through the root: on macOS the temporary
// directory is /var/folders/..., "folders" contains "old", and the term "old"
// matched every index root (the darwin refresh_test failure reported old=2 for
// a deleted file).
func TestRootRecordMatchesOwnNameNotAncestorPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), "var-folders", "T", "workspace")
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	ix := New()
	ix.AddRoot(root)
	ix.AddPath(root, FileInfo{Mode: fs.ModeDir | 0o755})
	ix.AddPath(filepath.Join(root, "docs"), FileInfo{Mode: fs.ModeDir | 0o755})
	ix.AddPath(filepath.Join(root, "docs", "report.pdf"), FileInfo{Size: 1, Mode: 0o644})

	check := func(ix *Index, stage string) {
		t.Helper()
		if got := searchTotal(t, ix, "old"); got != 0 {
			t.Errorf("%s: ancestor directory of the root leaked into name matching: old=%d", stage, got)
		}
		if got := searchTotal(t, ix, "var-folders"); got != 0 {
			t.Errorf("%s: ancestor directory of the root leaked into name matching: var-folders=%d", stage, got)
		}
		if got := searchTotal(t, ix, "workspace"); got != 1 {
			t.Errorf("%s: root is not searchable by its own name: workspace=%d", stage, got)
		}
		if got := searchTotal(t, ix, "path:var-folders"); got != 3 {
			t.Errorf("%s: path: filter no longer sees the root path: got=%d, want root+docs+report", stage, got)
		}
		if got := searchTotal(t, ix, "report"); got != 1 {
			t.Errorf("%s: child entry lost: report=%d", stage, got)
		}
	}
	check(ix, "fresh")

	// The derived pinyin and folded-name tables are rebuilt from the stored
	// names on load and after compaction; the same rule must hold there.
	snap := filepath.Join(t.TempDir(), "root-name.snap")
	if err := ix.Save(snap); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(snap)
	if err != nil {
		t.Fatal(err)
	}
	check(loaded, "after load")
}

// TestRootRecordPinyinUsesOwnName: the pinyin and initials keys of a root must
// come from its own name too. Deriving them from the stored absolute path made
// a Han ancestor directory (for example /tmp/国家/报告) match its pinyin.
func TestRootRecordPinyinUsesOwnName(t *testing.T) {
	root := filepath.Join(t.TempDir(), "国家", "报告")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	ix := New()
	ix.AddRoot(root)
	ix.AddPath(root, FileInfo{Mode: fs.ModeDir | 0o755})

	check := func(ix *Index, stage string) {
		t.Helper()
		if got := searchTotal(t, ix, "guojia"); got != 0 {
			t.Errorf("%s: ancestor pinyin leaked into the root keys: guojia=%d", stage, got)
		}
		if got := searchTotal(t, ix, "gj"); got != 0 {
			t.Errorf("%s: ancestor initials leaked into the root keys: gj=%d", stage, got)
		}
		if got := searchTotal(t, ix, "baogao"); got != 1 {
			t.Errorf("%s: root pinyin missing: baogao=%d", stage, got)
		}
		if got := searchTotal(t, ix, "bg"); got != 1 {
			t.Errorf("%s: root initials missing: bg=%d", stage, got)
		}
	}
	check(ix, "fresh")

	snap := filepath.Join(t.TempDir(), "root-pinyin.snap")
	if err := ix.Save(snap); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(snap)
	if err != nil {
		t.Fatal(err)
	}
	check(loaded, "after load")
}
