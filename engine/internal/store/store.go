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
}

// Paths returns the snapshot and meta file names inside dir.
func Paths(dir string) (snapshot, meta string) {
	return filepath.Join(dir, SnapshotName), filepath.Join(dir, MetaName)
}

// DefaultDir is the per-user state directory.
func DefaultDir() string {
	if dir, err := os.UserCacheDir(); err == nil && dir != "" {
		return filepath.Join(dir, "dsh-locator")
	}
	return filepath.Join(os.TempDir(), "dsh-locator")
}

// Load opens the snapshot and its meta. A missing or corrupt pair is an error.
func Load(dir string) (*index.Index, Meta, error) {
	snap, metaPath := Paths(dir)
	ix, err := index.Load(snap)
	if err != nil {
		return nil, Meta{}, err
	}
	var m Meta
	b, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, Meta{}, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, Meta{}, err
	}
	return ix, m, nil
}

// Save writes the snapshot then meta.json atomically.
func Save(dir string, ix *index.Index, m Meta) error {
	if m.Platform == "" {
		m.Platform = runtime.GOOS + "/" + runtime.GOARCH
	}
	if m.BuiltAt.IsZero() {
		m.BuiltAt = time.Now()
	}
	m.Roots = ix.Roots()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	snap, metaPath := Paths(dir)
	if err := ix.Save(snap); err != nil {
		return err
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp := metaPath + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, metaPath)
}
