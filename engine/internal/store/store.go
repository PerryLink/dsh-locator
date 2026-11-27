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
	"github.com/PerryLink/dsh-locator/engine/internal/statefs"
)

// SnapshotName and MetaName are the two files in a state directory.
const (
	SnapshotName = "index.snapshot"
	MetaName     = "meta.json"
)

// IndexStats are the full totals of the index a meta file describes. They are
// computed from the live index at save time, so a meta that survived a restart
// (or was rebuilt from a snapshot) always describes the whole index, unlike
// Stats which only describes the most recent scan/refresh.
type IndexStats struct {
	Entries int64 `json:"entries"`
	Files   int64 `json:"files"`
	Dirs    int64 `json:"dirs"`
	Roots   int   `json:"roots"`
}

// RefreshInfo describes the scan/refresh whose statistics are in Meta.Stats.
// Keeping the mode and timestamp next to the numbers removes the historical
// ambiguity where "stats" looked like full index totals after a restart.
type RefreshInfo struct {
	At    time.Time  `json:"at"`
	Mode  string     `json:"mode"`
	Stats scan.Stats `json:"stats"`
}

// Meta describes how a snapshot was built.
type Meta struct {
	Version  string    `json:"version"`
	Roots    []string  `json:"roots"`
	Excludes []string  `json:"excludes"`
	BuiltAt  time.Time `json:"builtAt"`
	Platform string    `json:"platform"`
	// Stats is the statistics of the last scan/refresh (historical field name;
	// see LastRefresh for the mode and timestamp and IndexStats for the totals).
	Stats scan.Stats `json:"stats"`
	// IndexStats are the totals of the whole index this meta describes. Older
	// engines did not write it; LoadWithInfo derives it from the snapshot.
	IndexStats *IndexStats `json:"indexStats,omitempty"`
	// LastRefresh describes the scan/refresh that produced Stats.
	LastRefresh *RefreshInfo `json:"lastRefresh,omitempty"`
	// Incomplete marks a snapshot written while the initial scan was still
	// running; the next start must scan again.
	Incomplete bool `json:"incomplete,omitempty"`
	// Rebuilt reports that meta.json was missing or corrupt and LoadWithInfo
	// reconstructed this value from the snapshot instead of rescanning.
	// It is never serialized.
	Rebuilt bool `json:"-"`
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
//
// A missing or corrupt meta.json no longer fails the load: the snapshot itself
// is authoritative for the entries, roots and build time, so the metadata is
// reconstructed from it (Meta.Rebuilt is set) instead of forcing a full rescan.
// A missing or corrupt snapshot is still an error.
func LoadWithInfo(dir string) (*index.Index, Meta, index.SnapshotInfo, error) {
	snap, metaPath := Paths(dir)
	ix, info, err := index.LoadWithInfo(snap)
	if err != nil {
		return nil, Meta{}, info, err
	}
	if m, err := readMeta(metaPath); err == nil {
		return ix, m, info, nil
	}
	return ix, MetaFromSnapshot(ix, info), info, nil
}

// readMeta parses one meta.json, returning an error when it is missing,
// unreadable or not valid JSON.
func readMeta(path string) (Meta, error) {
	var m Meta
	b, err := os.ReadFile(path)
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, err
	}
	return m, nil
}

// MetaFromSnapshot reconstructs the metadata of a loaded snapshot. It is used
// when meta.json is missing/corrupt: every value either comes from the snapshot
// header or is derived from the loaded index, so no filesystem rescan happens.
// The caller should persist the rebuilt meta on its next save.
func MetaFromSnapshot(ix *index.Index, info index.SnapshotInfo) Meta {
	st := ix.Stats()
	built := time.Time{}
	if info.Built > 0 {
		built = time.Unix(0, info.Built)
	}
	m := Meta{
		Roots:      ix.Roots(),
		BuiltAt:    built,
		Platform:   runtime.GOOS + "/" + runtime.GOARCH,
		IndexStats: indexStatsOf(ix),
		Rebuilt:    true,
	}
	m.Stats = scan.Stats{Entries: int64(st.Entries), Files: int64(st.Files), Dirs: int64(st.Dirs), Roots: st.Roots}
	m.LastRefresh = &RefreshInfo{At: built, Mode: "snapshot", Stats: m.Stats}
	m.Incomplete = false
	return m
}

// indexStatsOf snapshots the full totals of ix.
func indexStatsOf(ix *index.Index) *IndexStats {
	st := ix.Stats()
	return &IndexStats{Entries: int64(st.Entries), Files: int64(st.Files), Dirs: int64(st.Dirs), Roots: st.Roots}
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
	builtAtGiven := !m.BuiltAt.IsZero()
	if m.Platform == "" {
		m.Platform = runtime.GOOS + "/" + runtime.GOARCH
	}
	if m.BuiltAt.IsZero() {
		m.BuiltAt = time.Now()
	}
	m.Roots = ix.Roots()
	if err := statefs.MkdirAll(dir); err != nil {
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
	// The totals come from the index that is being written, so even a meta kept
	// from an earlier run describes the whole index rather than one scan.
	m.IndexStats = indexStatsOf(ix)
	if m.LastRefresh == nil {
		// Legacy callers only fill Stats/BuiltAt; record that provenance once.
		// A caller-supplied BuiltAt means a scan/refresh produced Stats; the
		// zero-timestamp case is a plain snapshot save.
		mode := "scan"
		if !builtAtGiven {
			mode = "snapshot"
		}
		m.LastRefresh = &RefreshInfo{At: m.BuiltAt, Mode: mode, Stats: m.Stats}
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return res, err
	}
	b = append(b, '\n')
	tmp := metaPath + ".tmp"
	if err := statefs.WriteFile(tmp, b); err != nil {
		return res, err
	}
	if err := os.Rename(tmp, metaPath); err != nil {
		return res, err
	}
	res.Took = time.Since(start)
	return res, nil
}
