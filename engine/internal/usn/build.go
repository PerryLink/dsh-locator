package usn

import (
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

// BuildOptions scopes one volume's records to the configured roots.
type BuildOptions struct {
	// VolumeRoot is the volume's DOS root, such as `C:\`.
	VolumeRoot string
	// Roots are the indexed directories on that volume.
	Roots []string
	// Excludes are base-name globs skipped by the portable scanner too.
	Excludes []string
}

// BuildStats counts what one build produced.
type BuildStats struct {
	Entries int64
	Files   int64
	Dirs    int64
	Skipped int64
}

// BuildItems turns MFT records into index items below the configured roots.
//
// USN records carry names, parents and attributes but no size or modification
// time; items therefore have Size 0 and Mtime 0. The daemon fills those in for
// the rows it returns, and a full metadata pass can follow. Records outside
// every root, excluded entries and records whose parent chain is missing are
// dropped.
func BuildItems(records []Record, opt BuildOptions) ([]index.AddItem, BuildStats) {
	tree := NewTree(records)
	items := make([]index.AddItem, 0, len(tree.Nodes))
	var stats BuildStats
	for frn, node := range tree.Nodes {
		if frn == RootFileReferenceNumber {
			continue
		}
		path, ok := tree.Path(frn, opt.VolumeRoot)
		if !ok || path == opt.VolumeRoot {
			continue
		}
		if !withinAny(path, opt.Roots) {
			continue
		}
		isDir := node.Attributes&AttributeDirectory != 0
		if excludedPath(path, opt.Excludes) {
			stats.Skipped++
			continue
		}
		items = append(items, index.AddItem{
			Path: path,
			Info: index.FileInfo{
				Size:  0,
				Mtime: 0,
				Mode:  modeFor(node.Attributes),
			},
		})
		stats.Entries++
		if isDir {
			stats.Dirs++
		} else {
			stats.Files++
		}
	}
	return items, stats
}

func modeFor(attributes uint32) fs.FileMode {
	mode := fs.FileMode(0o644)
	switch {
	case attributes&AttributeReparsePoint != 0:
		mode = fs.ModeSymlink | 0o777
	case attributes&AttributeDirectory != 0:
		mode = fs.ModeDir | 0o755
	}
	if attributes&0x1 != 0 { // FILE_ATTRIBUTE_READONLY
		mode &^= 0o222
	}
	return mode
}

func withinAny(path string, roots []string) bool {
	for _, root := range roots {
		if Within(path, root) {
			return true
		}
	}
	return false
}

// excludedPath rejects a path when any of its segments matches an exclude
// glob, so a skipped directory also removes its descendants.
func excludedPath(path string, patterns []string) bool {
	trimmed := strings.TrimPrefix(path, filepath.VolumeName(path))
	for _, segment := range strings.FieldsFunc(trimmed, func(r rune) bool { return r == '\\' || r == '/' }) {
		if segment == "" {
			continue
		}
		for _, pattern := range patterns {
			pattern = strings.TrimSpace(pattern)
			if pattern == "" || strings.ContainsAny(pattern, `/\`) {
				continue
			}
			if ok, _ := filepath.Match(pattern, segment); ok {
				return true
			}
		}
	}
	return false
}
