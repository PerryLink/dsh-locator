package usn

import (
	"io/fs"
	"testing"
)

func TestBuildItemsScopesRootsAndExcludes(t *testing.T) {
	records := []Record{
		{FRN: 5, ParentFRN: 5, Name: ".", Attributes: AttributeDirectory},
		{FRN: 100, ParentFRN: 5, Name: "Users", Attributes: AttributeDirectory},
		{FRN: 101, ParentFRN: 100, Name: "me", Attributes: AttributeDirectory},
		{FRN: 102, ParentFRN: 101, Name: "report.pdf"},
		{FRN: 103, ParentFRN: 101, Name: "node_modules", Attributes: AttributeDirectory},
		{FRN: 104, ParentFRN: 103, Name: "pkg.js"},
		{FRN: 200, ParentFRN: 5, Name: "Windows", Attributes: AttributeDirectory},
		{FRN: 201, ParentFRN: 200, Name: "notepad.exe"},
		{FRN: 300, ParentFRN: 999, Name: "orphan.txt"},
	}
	items, stats := BuildItems(records, BuildOptions{
		VolumeRoot: `C:\`,
		Roots:      []string{`C:\Users\me`},
		Excludes:   []string{"node_modules"},
	})
	if stats.Entries != 2 || stats.Files != 1 || stats.Dirs != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	paths := map[string]fs.FileMode{}
	for _, item := range items {
		paths[item.Path] = item.Info.Mode
	}
	if _, ok := paths[`C:\Users\me\report.pdf`]; !ok {
		t.Fatalf("report.pdf missing: %+v", paths)
	}
	if _, ok := paths[`C:\Users\me`]; !ok {
		t.Fatalf("root dir missing: %+v", paths)
	}
	if _, ok := paths[`C:\Users\me\node_modules\pkg.js`]; ok {
		t.Fatal("excluded subtree leaked into items")
	}
	if _, ok := paths[`C:\Windows\notepad.exe`]; ok {
		t.Fatal("out-of-root file leaked into items")
	}
	if _, ok := paths[`C:\orphan.txt`]; ok {
		t.Fatal("orphan leaked into items")
	}
	if !paths[`C:\Users\me`].IsDir() {
		t.Fatal("directory mode not set")
	}
}

func TestBuildItemsReparsePoint(t *testing.T) {
	records := []Record{
		{FRN: 5, ParentFRN: 5, Name: ".", Attributes: AttributeDirectory},
		{FRN: 10, ParentFRN: 5, Name: "link", Attributes: AttributeDirectory | AttributeReparsePoint},
	}
	items, _ := BuildItems(records, BuildOptions{VolumeRoot: `D:\`, Roots: []string{`D:\`}})
	if len(items) != 1 {
		t.Fatalf("items = %+v", items)
	}
	if items[0].Info.Mode&fs.ModeSymlink == 0 {
		t.Fatal("reparse point must be marked as a symlink")
	}
}
