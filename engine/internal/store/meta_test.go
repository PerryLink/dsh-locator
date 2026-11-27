package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
)

// TestSaveRecordsIndexStatsAndRefresh pins the meta.json semantics: stats is
// the last scan, indexStats are the full totals of the stored index, and
// lastRefresh names the scan that produced the stats.
func TestSaveRecordsIndexStatsAndRefresh(t *testing.T) {
	dir := t.TempDir()
	ix := testIndex(t)
	stats := scan.Stats{Entries: 2, Files: 2, Roots: 1}
	meta := Meta{
		Version:     "test",
		Roots:       []string{"/store-root"},
		Stats:       stats,
		LastRefresh: &RefreshInfo{At: time.Now(), Mode: "refresh", Stats: stats},
	}
	if err := Save(dir, ix, meta); err != nil {
		t.Fatal(err)
	}
	_, metaPath := Paths(dir)
	b, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err := json.Unmarshal(b, &stored); err != nil {
		t.Fatal(err)
	}
	scanInfo, ok := stored["indexStats"].(map[string]any)
	if !ok {
		t.Fatalf("meta has no indexStats: %s", b)
	}
	if scanInfo["entries"].(float64) != 3 || scanInfo["files"].(float64) != 2 || scanInfo["dirs"].(float64) != 1 || scanInfo["roots"].(float64) != 1 {
		t.Fatalf("indexStats = %v", scanInfo)
	}
	refresh, ok := stored["lastRefresh"].(map[string]any)
	if !ok {
		t.Fatalf("meta has no lastRefresh: %s", b)
	}
	if refresh["mode"] != "refresh" {
		t.Fatalf("lastRefresh.mode = %v", refresh["mode"])
	}
	if stored["platform"] == nil || stored["platform"] == "" {
		t.Fatalf("meta has no platform: %s", b)
	}

	// A reload keeps the enriched fields intact.
	_, loaded, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.IndexStats == nil || loaded.IndexStats.Entries != 3 || loaded.IndexStats.Roots != 1 {
		t.Fatalf("loaded indexStats = %+v", loaded.IndexStats)
	}
	if loaded.LastRefresh == nil || loaded.LastRefresh.Mode != "refresh" {
		t.Fatalf("loaded lastRefresh = %+v", loaded.LastRefresh)
	}
	if loaded.Rebuilt {
		t.Fatal("a healthy load must not report Rebuilt")
	}
}

// TestLoadRebuildsMissingMeta: deleting meta.json must not force a rescan; the
// snapshot header and the loaded index are enough to reconstruct the metadata.
func TestLoadRebuildsMissingMeta(t *testing.T) {
	dir := t.TempDir()
	ix := testIndex(t)
	if err := Save(dir, ix, Meta{Version: "test", Roots: []string{"/store-root"}}); err != nil {
		t.Fatal(err)
	}
	_, metaPath := Paths(dir)
	if err := os.Remove(metaPath); err != nil {
		t.Fatal(err)
	}
	loaded, meta, info, err := LoadWithInfo(dir)
	if err != nil {
		t.Fatalf("LoadWithInfo without meta.json: %v", err)
	}
	if !meta.Rebuilt {
		t.Fatal("rebuilt meta was not flagged")
	}
	if len(meta.Roots) != 1 || meta.Roots[0] != filepath.Clean("/store-root") {
		t.Fatalf("rebuilt roots = %v", meta.Roots)
	}
	if meta.IndexStats == nil || meta.IndexStats.Entries != 3 {
		t.Fatalf("rebuilt indexStats = %+v", meta.IndexStats)
	}
	if meta.Platform == "" {
		t.Fatal("rebuilt meta has no platform")
	}
	if meta.Stats.Entries != 3 {
		t.Fatalf("rebuilt stats = %+v", meta.Stats)
	}
	if loaded.Stats().Entries != 3 {
		t.Fatalf("loaded entries = %d", loaded.Stats().Entries)
	}
	if info.Built == 0 {
		t.Fatal("snapshot header has no built timestamp")
	}
	if meta.Incomplete {
		t.Fatal("rebuilt meta must not mark the snapshot incomplete")
	}
}

// TestLoadRebuildsCorruptMeta does the same for a meta.json that is not JSON.
func TestLoadRebuildsCorruptMeta(t *testing.T) {
	dir := t.TempDir()
	if err := Save(dir, testIndex(t), Meta{Version: "test", Roots: []string{"/store-root"}}); err != nil {
		t.Fatal(err)
	}
	_, metaPath := Paths(dir)
	if err := os.WriteFile(metaPath, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, meta, _, err := LoadWithInfo(dir)
	if err != nil {
		t.Fatalf("LoadWithInfo with corrupt meta.json: %v", err)
	}
	if !meta.Rebuilt {
		t.Fatal("rebuilt meta was not flagged")
	}
}

// TestLoadStillFailsWithoutSnapshot keeps the fallback honest: only meta.json
// may be missing, a missing snapshot is still an error.
func TestLoadStillFailsWithoutSnapshot(t *testing.T) {
	dir := t.TempDir()
	snap, metaPath := Paths(dir)
	if err := os.WriteFile(metaPath, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := LoadWithInfo(dir); err == nil {
		t.Fatal("LoadWithInfo accepted a state dir without a snapshot")
	}
	if _, err := os.Stat(snap); !os.IsNotExist(err) {
		t.Fatalf("snapshot unexpectedly exists: %v", err)
	}
}

// TestMetaFromSnapshotRootsKeepSameRootsBootstrap: the reconstructed roots are
// the snapshot roots, so the server's same-roots bootstrap check keeps working.
func TestMetaFromSnapshotRootsKeepSameRootsBootstrap(t *testing.T) {
	ix := index.New()
	root := filepath.Clean("/store-root")
	ix.AddRoot(root)
	ix.AddPath(filepath.Join(root, "a.txt"), index.FileInfo{Size: 1, Mtime: 10})
	meta := MetaFromSnapshot(ix, index.SnapshotInfo{Version: 2, Built: 123})
	if len(meta.Roots) != 1 || meta.Roots[0] != root {
		t.Fatalf("rebuilt roots %v do not match the configured root %s", meta.Roots, root)
	}
}
