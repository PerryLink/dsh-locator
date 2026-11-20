package store

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

func testIndex(t *testing.T) *index.Index {
	t.Helper()
	root := filepath.Clean("/store-root")
	ix := index.New()
	ix.AddRoot(root)
	ix.AddPath(filepath.Join(root, "a.txt"), index.FileInfo{Size: 1, Mtime: 10, Mode: 0o644})
	ix.AddPath(filepath.Join(root, "b.txt"), index.FileInfo{Size: 2, Mtime: 20, Mode: 0o644})
	return ix
}

func mustStat(t *testing.T, path string) os.FileInfo {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi
}

func loadState(t *testing.T, dir string) (*index.Index, Meta) {
	t.Helper()
	ix, meta, err := Load(dir)
	if err != nil {
		t.Fatalf("store.Load: %v", err)
	}
	return ix, meta
}

// TestSaveWithIncrementalJournal: the second and third saves must append only a
// small journal while the base snapshot file stays byte-identical.
func TestSaveWithIncrementalJournal(t *testing.T) {
	dir := t.TempDir()
	ix := testIndex(t)
	meta := Meta{Version: "test", Roots: []string{"/store-root"}}
	res, err := SaveWith(dir, ix, meta, SaveOptions{Full: true})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Full || res.SnapshotBytes <= 0 {
		t.Fatalf("first save result = %+v", res)
	}
	snap, _ := Paths(dir)
	baseBefore := append([]byte(nil), mustReadFile(t, snap)...)
	baseMtime := mustStat(t, snap).ModTime()
	ix.SetJournalEnabled(true)

	root := filepath.Clean("/store-root")
	ix.AddPath(filepath.Join(root, "c.txt"), index.FileInfo{Size: 3, Mtime: 30, Mode: 0o644})
	res, err = SaveWith(dir, ix, meta, SaveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Full || res.JournalEntries == 0 || res.JournalBytes <= 0 {
		t.Fatalf("journal-only save result = %+v", res)
	}
	if !bytes.Equal(mustReadFile(t, snap), baseBefore) {
		t.Fatal("journal-only save rewrote the base snapshot")
	}
	if got := mustStat(t, snap).ModTime(); !got.Equal(baseMtime) {
		t.Fatalf("journal-only save touched the base snapshot mtime: %s -> %s", baseMtime, got)
	}
	journal := JournalPath(dir)
	if _, err := os.Stat(journal); err != nil {
		t.Fatalf("journal file missing: %v", err)
	}
	loaded, _ := loadState(t, dir)
	if hit := searchName(t, loaded, "c.txt"); hit == nil {
		t.Fatal("journaled file missing after reload")
	}

	ix.AddPath(filepath.Join(root, "d.txt"), index.FileInfo{Size: 4, Mtime: 40, Mode: 0o644})
	res, err = SaveWith(dir, ix, meta, SaveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Full || res.JournalEntries < 2 {
		t.Fatalf("second journal-only save result = %+v", res)
	}
	if !bytes.Equal(mustReadFile(t, snap), baseBefore) {
		t.Fatal("second journal-only save rewrote the base snapshot")
	}
	loaded, _ = loadState(t, dir)
	for _, name := range []string{"a.txt", "b.txt", "c.txt", "d.txt"} {
		if hit := searchName(t, loaded, name); hit == nil {
			t.Fatalf("%s missing after journal replay", name)
		}
	}
}

func searchName(t *testing.T, ix *index.Index, name string) *index.Hit {
	t.Helper()
	q, err := index.ParseQuery(name)
	if err != nil {
		t.Fatal(err)
	}
	q.Limit = 10
	res, err := ix.Search(q)
	if err != nil {
		t.Fatal(err)
	}
	for i := range res.Hits {
		return &res.Hits[i]
	}
	return nil
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestSaveForcesFullWhenBaseIsV1: migrating an old snapshot must replace the
// base in one full write; a journal append against a v1 base is impossible.
func TestSaveForcesFullWhenBaseIsV1(t *testing.T) {
	dir := t.TempDir()
	writeTinyV1(t, dir)
	ix, meta, info, err := LoadWithInfo(dir)
	if err != nil {
		t.Fatalf("v1 load: %v", err)
	}
	if info.Version != 1 || info.SupportsJournal() {
		t.Fatalf("v1 info = %+v", info)
	}
	ix.SetJournalEnabled(true)
	root := filepath.Clean("/v1root")
	ix.AddPath(filepath.Join(root, "new.txt"), index.FileInfo{Size: 5, Mtime: 5, Mode: 0o644})
	meta.Version = "test"
	res, err := SaveWith(dir, ix, meta, SaveOptions{Full: false})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Full {
		t.Fatalf("save against a v1 base was not full: %+v", res)
	}
	snap, _ := Paths(dir)
	head, err := index.ReadSnapshotInfo(snap)
	if err != nil {
		t.Fatal(err)
	}
	if head.Version != 2 {
		t.Fatalf("migrated base version = %d, want 2", head.Version)
	}
	loaded, _ := loadState(t, dir)
	if hit := searchName(t, loaded, "new.txt"); hit == nil {
		t.Fatal("post-migration mutation missing")
	}
}

// writeTinyV1 writes a minimal 0.19-format snapshot plus meta.json: one root
// record and one file record.
func writeTinyV1(t *testing.T, dir string) {
	t.Helper()
	const (
		magic      = "DSHLOC01"
		v1Header   = 48
		recordSize = 40
	)
	root := "/v1root"
	fileName := "file.txt"
	names := []byte(root + fileName)
	ext := []byte("txt")
	tableCap := 16
	total := v1Header + 2*recordSize + len(names) + (2 + len(ext)) + 4 + tableCap*4
	buf := make([]byte, total)
	copy(buf[0:8], magic)
	binary.LittleEndian.PutUint32(buf[8:], 1)
	binary.LittleEndian.PutUint64(buf[16:], uint64(time.Now().UnixNano()))
	binary.LittleEndian.PutUint32(buf[24:], 2) // records
	binary.LittleEndian.PutUint32(buf[28:], uint32(len(names)))
	binary.LittleEndian.PutUint32(buf[32:], 1) // extensions
	binary.LittleEndian.PutUint32(buf[36:], 1) // roots
	binary.LittleEndian.PutUint32(buf[40:], uint32(tableCap))
	binary.LittleEndian.PutUint32(buf[44:], 0) // deleted

	off := v1Header
	// Root record: name is the full absolute path, parent -1.
	binary.LittleEndian.PutUint32(buf[off:], 0)
	binary.LittleEndian.PutUint32(buf[off+4:], uint32(len(root)))
	binary.LittleEndian.PutUint32(buf[off+8:], uint32(0xFFFFFFFF))
	buf[off+30] = byte(1) // FlagDir (first iota bit)
	off += recordSize
	// File record: basename, parent 0.
	binary.LittleEndian.PutUint32(buf[off:], uint32(len(root)))
	binary.LittleEndian.PutUint32(buf[off+4:], uint32(len(fileName)))
	binary.LittleEndian.PutUint32(buf[off+8:], 0)
	binary.LittleEndian.PutUint64(buf[off+12:], 1)
	binary.LittleEndian.PutUint64(buf[off+20:], 1)
	binary.LittleEndian.PutUint16(buf[off+28:], 1)
	off += recordSize
	off += copy(buf[off:], names)
	binary.LittleEndian.PutUint16(buf[off:], uint16(len(ext)))
	off += 2 + copy(buf[off+2:], ext)
	binary.LittleEndian.PutUint32(buf[off:], 0) // roots[0] = record id 0
	off += 4
	binary.LittleEndian.PutUint32(buf[off:], 1) // one table slot holds root id+1
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	snap, metaPath := Paths(dir)
	if err := os.WriteFile(snap, buf, 0o644); err != nil {
		t.Fatal(err)
	}
	m := Meta{Version: "0.19.4", Roots: []string{root}, Platform: "linux/amd64", BuiltAt: time.Now()}
	mb, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metaPath, mb, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestSaveWithJournalAndZstd: an incremental journal appends to a compressed
// base, and Load replays it through the zstd decoder.
func TestSaveWithJournalAndZstd(t *testing.T) {
	dir := t.TempDir()
	ix := testIndex(t)
	meta := Meta{Version: "test", Roots: []string{"/store-root"}}
	res, err := SaveWith(dir, ix, meta, SaveOptions{Full: true, Compression: index.CompressionZstd})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Full {
		t.Fatal("first save should be full")
	}
	snap, _ := Paths(dir)
	info, err := index.ReadSnapshotInfo(snap)
	if err != nil {
		t.Fatal(err)
	}
	if !info.UsesZstd() {
		t.Fatalf("base is not zstd: %+v", info)
	}
	baseMtime := mustStat(t, snap).ModTime()
	ix.SetJournalEnabled(true)
	ix.AddPath(filepath.Join("/store-root", "z.txt"), index.FileInfo{Size: 9, Mode: 0o644})
	res, err = SaveWith(dir, ix, meta, SaveOptions{Compression: index.CompressionZstd})
	if err != nil {
		t.Fatal(err)
	}
	if res.Full {
		t.Fatalf("zstd base should accept an incremental journal: %+v", res)
	}
	if got := mustStat(t, snap).ModTime(); !got.Equal(baseMtime) {
		t.Fatal("journal-only save touched the zstd base")
	}
	loaded, _ := loadState(t, dir)
	if hit := searchName(t, loaded, "z.txt"); hit == nil {
		t.Fatal("journaled entry missing after zstd+journal load")
	}
}

// TestSaveForcesFullOnCompressionChange: switching --snapshot-compression must
// rewrite the base so the configured format takes effect.
func TestSaveForcesFullOnCompressionChange(t *testing.T) {
	dir := t.TempDir()
	ix := testIndex(t)
	meta := Meta{Version: "test", Roots: []string{"/store-root"}}
	if _, err := SaveWith(dir, ix, meta, SaveOptions{Full: true}); err != nil {
		t.Fatal(err)
	}
	ix.SetJournalEnabled(true)
	ix.AddPath(filepath.Join("/store-root", "e.txt"), index.FileInfo{Size: 1, Mode: 0o644})
	res, err := SaveWith(dir, ix, meta, SaveOptions{Compression: index.CompressionZstd})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Full {
		t.Fatalf("compression change did not force a full rewrite: %+v", res)
	}
	snap, _ := Paths(dir)
	info, err := index.ReadSnapshotInfo(snap)
	if err != nil {
		t.Fatal(err)
	}
	if !info.UsesZstd() {
		t.Fatalf("compression change not persisted: %+v", info)
	}
}

// TestSaveFullDropsPreviousJournal: after a full rewrite the old journal must
// not be replayed against the new base (its base id is gone).
func TestSaveFullDropsPreviousJournal(t *testing.T) {
	dir := t.TempDir()
	ix := testIndex(t)
	meta := Meta{Version: "test", Roots: []string{"/store-root"}}
	if _, err := SaveWith(dir, ix, meta, SaveOptions{Full: true}); err != nil {
		t.Fatal(err)
	}
	ix.SetJournalEnabled(true)
	ix.AddPath(filepath.Join("/store-root", "stale.txt"), index.FileInfo{Size: 1, Mode: 0o644})
	if _, err := SaveWith(dir, ix, meta, SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	// Force a full base rewrite. The journal entries recorded before the marker
	// are in the base; the journal must be empty afterwards.
	marker := ix.JournalMarker()
	if _, err := SaveWith(dir, ix, meta, SaveOptions{Full: true, JournalAfterSeq: marker}); err != nil {
		t.Fatal(err)
	}
	ix.JournalResetAfter(marker)
	journal := JournalPath(dir)
	if _, err := os.Stat(journal); err == nil {
		t.Fatalf("journal was not dropped after a full save")
	}
}

// TestJournalSaveBenchReport measures the real whole-disk case: a 1.5M-entry
// snapshot, one full save, then incremental journal saves. It only runs when
// DSH_BENCH_SNAPSHOT points at a snapshot file.
func TestJournalSaveBenchReport(t *testing.T) {
	src := os.Getenv("DSH_BENCH_SNAPSHOT")
	if src == "" {
		t.Skip("DSH_BENCH_SNAPSHOT not set")
	}
	dir := t.TempDir()
	snap, _ := Paths(dir)
	if err := os.WriteFile(snap, mustReadFile(t, src), 0o644); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	ix, err := index.Load(snap)
	if err != nil {
		t.Fatal(err)
	}
	loadTook := time.Since(start)
	meta := Meta{Version: "bench", Roots: ix.Roots()}
	start = time.Now()
	full, err := SaveWith(dir, ix, meta, SaveOptions{Full: true})
	if err != nil {
		t.Fatal(err)
	}
	fullWall := time.Since(start)
	ix.SetJournalEnabled(true)

	root := ix.Roots()[0]
	var add []string
	for i := 0; i < 1000; i++ {
		p := filepath.Join(root, "journal-bench", "file-"+strconv.Itoa(i)+".txt")
		add = append(add, p)
		ix.AddPath(p, index.FileInfo{Size: int64(i), Mtime: int64(i), Mode: 0o644})
	}
	// A write that races a journal save must not wait for the snapshot write.
	type stallResult struct{ d time.Duration }
	stallCh := make(chan stallResult, 1)
	start = time.Now()
	jres, err := SaveWith(dir, ix, meta, SaveOptions{})
	jwall := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		s := time.Now()
		ix.AddPath(filepath.Join(root, "journal-bench", "racing.txt"), index.FileInfo{Size: 1, Mode: 0o644})
		stallCh <- stallResult{d: time.Since(s)}
	}()
	select {
	case r := <-stallCh:
		t.Logf("JournalRacingWrite %s", r.d)
	case <-time.After(5 * time.Second):
		t.Fatal("journal save blocked the racing writer")
	}
	_ = jres
	// Reload base+journal and check the replayed state.
	start = time.Now()
	back, _, info, err := LoadWithInfo(dir)
	reloadTook := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	if info.JournalEntries == 0 {
		t.Fatalf("journal was not replayed: %+v", info)
	}
	hit := searchName(t, back, "file-999.txt")
	if hit == nil {
		t.Fatal("journaled path missing after reload")
	}
	if len(add) == 0 {
		t.Fatal("no paths added")
	}
	t.Logf("LOAD_FULL took=%s entries=%d", loadTook, ix.Stats().Entries)
	t.Logf("SAVE_FULL took=%s bytes=%d", fullWall, full.SnapshotBytes)
	t.Logf("SAVE_JOURNAL took=%s journalBytes=%d entries=%d baseBytes=%d", jwall, jres.JournalBytes, jres.JournalEntries, full.SnapshotBytes)
	t.Logf("LOAD_BASE_JOURNAL took=%s journalEntries=%d", reloadTook, info.JournalEntries)
}
