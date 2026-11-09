package usn

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

// localPath lets these tests exercise Windows journal semantics on any host:
// the index joins records with the host separator, so the seeded paths and the
// path map are converted together.
func localPath(path string) string {
	if filepath.Separator == '/' {
		return strings.ReplaceAll(path, `\`, `/`)
	}
	return path
}

func testRecords() []Record {
	return []Record{
		{FRN: 5, ParentFRN: 5, Name: ".", Attributes: AttributeDirectory},
		{FRN: 100, ParentFRN: 5, Name: "Users", Attributes: AttributeDirectory},
		{FRN: 101, ParentFRN: 100, Name: "me", Attributes: AttributeDirectory},
		{FRN: 102, ParentFRN: 101, Name: "old.txt"},
	}
}

func seed(t *testing.T, records []Record, root string) (*index.Index, ChangePaths) {
	t.Helper()
	raw := PathsFromRecords(records, root)
	paths := make(ChangePaths, len(raw))
	ix := index.New()
	tree := NewTree(records)
	for frn, node := range tree.Nodes {
		path, ok := raw[frn]
		if !ok {
			continue
		}
		localized := localPath(path)
		paths[frn] = localized
		if frn != RootFileReferenceNumber {
			ix.AddPath(localized, index.FileInfo{Mode: modeFor(node.Attributes)})
		}
	}
	return ix, paths
}

func TestPathsFromRecords(t *testing.T) {
	paths := PathsFromRecords(testRecords(), `C:\`)
	if paths[102] != `C:\Users\me\old.txt` {
		t.Fatalf("path map = %+v", paths)
	}
	if paths[RootFileReferenceNumber] != `C:\` {
		t.Fatalf("root missing: %+v", paths)
	}
}

func TestApplyChangesCreateDeleteRename(t *testing.T) {
	records := testRecords()
	ix, paths := seed(t, records, `C:\`)

	create := []Record{{FRN: 200, ParentFRN: 101, Name: "new.txt", USN: 10, Reason: ReasonCreate}}
	stats := ApplyChanges(create, paths, ix, nil, nil)
	if stats.Added != 1 {
		t.Fatalf("create stats = %+v", stats)
	}
	if _, ok := ix.Lookup(localPath(`C:\Users\me\new.txt`)); !ok {
		t.Fatal("created file missing")
	}

	rename := []Record{
		{FRN: 200, ParentFRN: 101, Name: "new.txt", USN: 20, Reason: ReasonRenameOld},
		{FRN: 200, ParentFRN: 101, Name: "renamed.txt", USN: 21, Reason: ReasonRenameNew},
	}
	stats = ApplyChanges(rename, paths, ix, nil, nil)
	if stats.Removed != 1 || stats.Added != 1 {
		t.Fatalf("rename stats = %+v", stats)
	}
	if _, ok := ix.Lookup(localPath(`C:\Users\me\new.txt`)); ok {
		t.Fatal("old name survived rename")
	}
	if _, ok := ix.Lookup(localPath(`C:\Users\me\renamed.txt`)); !ok {
		t.Fatal("new name missing after rename")
	}

	ApplyChanges([]Record{{FRN: 200, ParentFRN: 101, Name: "renamed.txt", USN: 30, Reason: ReasonDelete}}, paths, ix, nil, nil)
	if _, ok := ix.Lookup(localPath(`C:\Users\me\renamed.txt`)); ok {
		t.Fatal("deleted file still indexed")
	}
}

func TestApplyChangesNewDirectoryAndChild(t *testing.T) {
	ix, paths := seed(t, testRecords(), `C:\`)
	batch := []Record{
		{FRN: 300, ParentFRN: 101, Name: "docs", USN: 10, Reason: ReasonCreate, Attributes: AttributeDirectory},
		{FRN: 301, ParentFRN: 300, Name: "a.txt", USN: 11, Reason: ReasonCreate},
	}
	stats := ApplyChanges(batch, paths, ix, nil, nil)
	if stats.Added != 2 {
		t.Fatalf("stats = %+v", stats)
	}
	if _, ok := ix.Lookup(localPath(`C:\Users\me\docs\a.txt`)); !ok {
		t.Fatal("child of a just-created directory not resolved")
	}
	if !ix.IsDir(localPath(`C:\Users\me\docs`)) {
		t.Fatal("new directory not marked as a directory")
	}
}

func TestApplyChangesDeleteDirectoryRemovesSubtree(t *testing.T) {
	records := append(testRecords(),
		Record{FRN: 300, ParentFRN: 101, Name: "docs", Attributes: AttributeDirectory},
		Record{FRN: 301, ParentFRN: 300, Name: "a.txt"},
	)
	ix, paths := seed(t, records, `C:\`)

	ApplyChanges([]Record{{FRN: 300, ParentFRN: 101, Name: "docs", Attributes: AttributeDirectory, USN: 50, Reason: ReasonDelete}}, paths, ix, nil, nil)
	if _, ok := ix.Lookup(localPath(`C:\Users\me\docs\a.txt`)); ok {
		t.Fatal("subtree child survived directory delete")
	}
}

func TestApplyChangesSkipsExcludedAndUnknownParents(t *testing.T) {
	ix, paths := seed(t, testRecords(), `C:\`)
	batch := []Record{
		{FRN: 400, ParentFRN: 101, Name: "node_modules", USN: 1, Reason: ReasonCreate, Attributes: AttributeDirectory},
		{FRN: 401, ParentFRN: 400, Name: "x.js", USN: 2, Reason: ReasonCreate},
		{FRN: 402, ParentFRN: 999, Name: "orphan.txt", USN: 3, Reason: ReasonCreate},
	}
	stats := ApplyChanges(batch, paths, ix, []string{"node_modules"}, nil)
	if stats.Added != 0 || stats.Skipped == 0 {
		t.Fatalf("stats = %+v", stats)
	}
}
