// Package store owns the on-disk layout of a locator state directory.
package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
)

// SnapshotName and MetaName are the two files in a state directory.
const (
	SnapshotName = "index.snapshot"
	MetaName     = "meta.json"
)

// Meta describes how a snapshot was built.
type Meta struct {
	Version  string     `json:"version"`
	Roots    []string   `json:"roots"`
	Excludes []string   `json:"excludes"`
	BuiltAt  time.Time  `json:"builtAt"`
	Platform string     `json:"platform"`
	Stats    scan.Stats `json:"stats"`
	// Incomplete marks a snapshot written while the initial scan was still
	// running; the next start must scan again.
	Incomplete bool `json:"incomplete,omitempty"`
}

// Paths returns the snapshot and meta file names inside dir.
func Paths(dir string) (snapshot, meta string) {
	return filepath.Join(dir, SnapshotName), filepath.Join(dir, MetaName)
}

// JournalPath returns the incremental journal path inside dir.
func JournalPath(dir string) string {
	return filepath.Join(dir, index.JournalName)
}

// DefaultDir is the per-user state directory.
func DefaultDir() string {
	if dir, err := os.UserCacheDir(); err == nil && dir != "" {
		return filepath.Join(dir, "dsh-locator")
	}
	return filepath.Join(os.TempDir(), "dsh-locator")
}

// Load opens the snapshot (plus its journal) and its meta. A missing or corrupt
// pair is an error.
func Load(dir string) (*index.Index, Meta, error) {
	ix, m, _, err := LoadWithInfo(dir)
	return ix, m, err
}

// LoadWithInfo is Load plus the snapshot header/journal facts. The index loader
// replays index.journal transparently when the base is a v2 snapshot.
func LoadWithInfo(dir string) (*index.Index, Meta, index.SnapshotInfo, error) {
	snap, metaPath := Paths(dir)
	ix, info, err := index.LoadWithInfo(snap)
	if err != nil {
		return nil, Meta{}, info, err
	}
	var m Meta
	b, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, Meta{}, info, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, Meta{}, info, err
	}
	return ix, m, info, nil
}

// SaveOptions controls one snapshot save.
type SaveOptions struct {
	// Full forces a fresh base snapshot. Incremental saves append only the
	// journal, which is what keeps steady-state autosaves at a few kilobytes.
	Full bool
	// Compression selects the base payload encoding; a changed setting forces a
	// full rewrite so the configured format takes effect.
	Compression index.Compression
	// JournalAfterSeq keeps journal entries recorded after this marker when a
	// new base is written. Entries at or below it are already in the base; later
	// ones raced the encode and must survive in the journal.
	JournalAfterSeq uint64
}

// SaveResult reports what one SaveWith call did.
type SaveResult struct {
	Full           bool
	Format         uint32
	BaseID         uint64
	SnapshotBytes  int64
	JournalBytes   int64
	JournalEntries int
	Took           time.Duration
}

// Save writes a full snapshot (the historical behaviour) then meta.json.
func Save(dir string, ix *index.Index, m Meta) error {
	_, err := SaveWith(dir, ix, m, SaveOptions{Full: true})
	return err
}

// SaveWith writes a base snapshot or appends the incremental journal, then
// meta.json. A journal is only appended when the base on disk is a v2 snapshot
// for the same root set and compression; anything else forces a full rewrite.
func SaveWith(dir string, ix *index.Index, m Meta, opt SaveOptions) (SaveResult, error) {
	var res SaveResult
	start := time.Now()
	if m.Platform == "" {
		m.Platform = runtime.GOOS + "/" + runtime.GOARCH
	}
	if m.BuiltAt.IsZero() {
		m.BuiltAt = time.Now()
	}
	m.Roots = ix.Roots()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return res, err
	}
	snap, metaPath := Paths(dir)
	journalPath := JournalPath(dir)
	base, baseErr := index.ReadSnapshotInfo(snap)
	canAppend := !opt.Full && baseErr == nil && base.SupportsJournal() &&
		base.Compression() == opt.Compression && !ix.JournalOverflowed()
	if canAppend {
		jbytes, jentries, err := ix.WriteJournalTo(journalPath, base.BaseID, 0)
		if err != nil {
			return res, err
		}
		res = SaveResult{
			Format:         base.Version,
			BaseID:         base.BaseID,
			JournalBytes:   int64(jbytes),
			JournalEntries: jentries,
		}
	} else {
		info, err := ix.SaveBase(snap, index.SnapshotOptions{Compression: opt.Compression})
		if err != nil {
			return res, err
		}
		jbytes, jentries, err := ix.WriteJournalTo(journalPath, info.BaseID, opt.JournalAfterSeq)
		if err != nil {
			return res, err
		}
		res = SaveResult{
			Full:           true,
			Format:         info.Version,
			BaseID:         info.BaseID,
			SnapshotBytes:  info.FileBytes,
			JournalBytes:   int64(jbytes),
			JournalEntries: jentries,
		}
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return res, err
	}
	b = append(b, '\n')
	tmp := metaPath + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return res, err
	}
	if err := os.Rename(tmp, metaPath); err != nil {
		return res, err
	}
	res.Took = time.Since(start)
	return res, nil
}
