package usn

import (
	"sort"
	"strings"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

// Journal reason bits used by the applier.
const (
	ReasonDataOverwrite = 0x00000001
	ReasonDataExtend    = 0x00000002
	ReasonDataTruncation = 0x00000004
	ReasonCreate        = 0x00000100
	ReasonDelete        = 0x00000200
	ReasonRenameOld     = 0x00001000
	ReasonRenameNew     = 0x00002000
	ReasonBasicInfo     = 0x00008000
)

// ChangePaths maps a file reference number to its current absolute path. The
// map is updated as renames and creates are applied, so records later in the
// same batch resolve against the new tree.
type ChangePaths map[uint64]string

// PathsFromRecords rebuilds every record's path once. It is the FRN map a
// journal watcher needs; BuildItems uses the same tree but discards the map.
func PathsFromRecords(records []Record, volumeRoot string) ChangePaths {
	tree := NewTree(records)
	paths := make(ChangePaths, len(tree.Nodes)+1)
	paths[RootFileReferenceNumber] = volumeRoot
	for frn := range tree.Nodes {
		if path, ok := tree.Path(frn, volumeRoot); ok {
			paths[frn] = path
		}
	}
	return paths
}

// ChangeStats counts one applied journal batch.
type ChangeStats struct {
	Added   int
	Updated int
	Removed int
	Skipped int
}

// ApplyChanges applies journal records to the index in USN order.
//
// Records must be sorted by USN (the journal returns them that way). Creates
// and renames add entries with unknown size and modification time; data
// modifications leave the known metadata alone, because the journal does not
// carry the new size or mtime. The caller can stat the paths it wants to
// refresh. Deletes and rename-old records remove the previous path, including
// a whole subtree for directories.
func ApplyChanges(records []Record, paths ChangePaths, ix *index.Index, excludes, roots []string) ChangeStats {
	if !sort.SliceIsSorted(records, func(i, j int) bool { return records[i].USN < records[j].USN }) {
		sort.Slice(records, func(i, j int) bool { return records[i].USN < records[j].USN })
	}
	var stats ChangeStats
	for _, record := range records {
		if record.Name == "" || record.FRN == 0 {
			continue
		}
		parent := paths[record.ParentFRN]
		if parent == "" {
			stats.Skipped++
			continue
		}
		path := joinPath(parent, record.Name)
		isDir := record.Attributes&AttributeDirectory != 0

		switch {
		case record.Reason&(ReasonDelete|ReasonRenameOld) != 0:
			old := path
			if known := paths[record.FRN]; known != "" {
				old = known
			}
			if isDir {
				ix.RemoveSubtree(old)
			} else {
				ix.RemovePath(old)
			}
			delete(paths, record.FRN)
			stats.Removed++

		case record.Reason&(ReasonCreate|ReasonRenameNew) != 0:
			if len(roots) > 0 && !withinAny(path, roots) {
				stats.Skipped++
				continue
			}
			if excludedPath(path, excludes) {
				stats.Skipped++
				continue
			}
			if _, exists := ix.Lookup(path); exists {
				ix.AddPathFRN(path, index.FileInfo{Mode: modeFor(record.Attributes)}, record.FRN)
				stats.Updated++
			} else {
				ix.AddPathFRN(path, index.FileInfo{Mode: modeFor(record.Attributes)}, record.FRN)
				stats.Added++
			}
			paths[record.FRN] = path

		default:
			// A data or basic-info change: the entry exists, but the journal
			// does not carry the new size or mtime. Leave it for a stat pass.
			stats.Updated++
		}
	}
	return stats
}

func joinPath(parent, name string) string {
	separator := `\`
	if strings.Contains(parent, "/") {
		separator = "/"
	}
	if strings.HasSuffix(parent, separator) {
		return parent + name
	}
	return parent + separator + name
}
