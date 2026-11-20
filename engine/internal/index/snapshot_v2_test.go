package index

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeV1Snapshot re-implements the 0.19 format byte-for-byte so the "old
// snapshots keep loading" promise is tested against a real v1 file rather than
// against the current encoder.
func writeV1Snapshot(t *testing.T, path string, ix *Index) {
	t.Helper()
	var extBytes int
	for _, e := range ix.exts {
		extBytes += 2 + len(e)
	}
	buf := make([]byte, headerSize+len(ix.recs)*recordSize+len(ix.names)+
		extBytes+len(ix.roots)*4+len(ix.table.slots)*4)
	copy(buf[0:8], snapshotMagic)
	binary.LittleEndian.PutUint32(buf[8:], snapshotVersion)
	binary.LittleEndian.PutUint32(buf[12:], 0)
	binary.LittleEndian.PutUint64(buf[16:], uint64(ix.built))
	binary.LittleEndian.PutUint32(buf[24:], uint32(len(ix.recs)))
	binary.LittleEndian.PutUint32(buf[28:], uint32(len(ix.names)))
	binary.LittleEndian.PutUint32(buf[32:], uint32(len(ix.exts)))
	binary.LittleEndian.PutUint32(buf[36:], uint32(len(ix.roots)))
	binary.LittleEndian.PutUint32(buf[40:], uint32(len(ix.table.slots)))
	binary.LittleEndian.PutUint32(buf[44:], uint32(ix.nDelet))
	off := headerSize
	for i := range ix.recs {
		r := &ix.recs[i]
		binary.LittleEndian.PutUint32(buf[off:], r.NameOff)
		binary.LittleEndian.PutUint32(buf[off+4:], r.NameLen)
		binary.LittleEndian.PutUint32(buf[off+8:], uint32(r.Parent))
		binary.LittleEndian.PutUint64(buf[off+12:], uint64(r.Size))
		binary.LittleEndian.PutUint64(buf[off+20:], uint64(r.Mtime))
		binary.LittleEndian.PutUint16(buf[off+28:], r.Ext)
		buf[off+30] = byte(r.Flags)
		binary.LittleEndian.PutUint64(buf[off+32:], r.FRN)
		off += recordSize
	}
	off += copy(buf[off:], ix.names)
	for _, e := range ix.exts {
		binary.LittleEndian.PutUint16(buf[off:], uint16(len(e)))
		off += 2 + copy(buf[off+2:], e)
	}
	for _, id := range ix.roots {
		binary.LittleEndian.PutUint32(buf[off:], uint32(id))
		off += 4
	}
	for _, v := range ix.table.slots {
		binary.LittleEndian.PutUint32(buf[off:], uint32(v))
		off += 4
	}
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestSnapshotNamesArenaExactlyAllocated pins the streaming-load memory fix:
// the name arena must be its own exactly-sized allocation, not a sub-slice of a
// whole-file read buffer (which used to pin ~81MB of dead heap).
func TestSnapshotNamesArenaExactlyAllocated(t *testing.T) {
	ix := testIndex(t)
	path := filepath.Join(t.TempDir(), "index.snapshot")
	if _, err := ix.SaveBase(path, SnapshotOptions{}); err != nil {
		t.Fatal(err)
	}
	back, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cap(back.names) != len(back.names) || len(back.names) == 0 {
		t.Fatalf("name arena cap=%d len=%d, want an exact allocation", cap(back.names), len(back.names))
	}
	if got, want := back.Stats().NameBytes, len(ix.names); got != want {
		t.Fatalf("name bytes = %d, want %d", got, want)
	}
	res, err := back.Search(Query{Text: "report", Limit: 10})
	if err != nil || res.Total != 2 {
		t.Fatalf("search after streaming load: total=%d err=%v", res.Total, err)
	}
}

// TestSnapshotV1StillLoadsAndMigrates: a snapshot written by the old release
// loads unchanged; the next base write upgrades it to v2.
func TestSnapshotV1StillLoadsAndMigrates(t *testing.T) {
	dir := t.TempDir()
	v1 := filepath.Join(dir, "index.snapshot")
	src := testIndex(t)
	writeV1Snapshot(t, v1, src)
	info, err := ReadSnapshotInfo(v1)
	if err != nil {
		t.Fatal(err)
	}
	if info.Version != snapshotVersion || info.BaseID != 0 || info.SupportsJournal() {
		t.Fatalf("v1 info = %+v", info)
	}
	back, err := Load(v1)
	if err != nil {
		t.Fatalf("v1 snapshot failed to load: %v", err)
	}
	if back.Len() != src.Len() {
		t.Fatalf("v1 entries = %d, want %d", back.Len(), src.Len())
	}
	res, err := back.Search(Query{Text: "main.go", Limit: 5})
	if err != nil || res.Total != 1 {
		t.Fatalf("v1 search total=%d err=%v", res.Total, err)
	}
	// Migration: writing a base again produces a journal-capable v2 snapshot.
	v2 := filepath.Join(dir, "migrated.snapshot")
	newInfo, err := back.SaveBase(v2, SnapshotOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if newInfo.Version != snapshotVersionCurrent || !newInfo.SupportsJournal() {
		t.Fatalf("migrated info = %+v", newInfo)
	}
	migrated, err := Load(v2)
	if err != nil {
		t.Fatal(err)
	}
	if migrated.Len() != back.Len() {
		t.Fatalf("migrated entries = %d, want %d", migrated.Len(), back.Len())
	}
}

// TestSnapshotZstdRoundTrip covers --snapshot-compression zstd.
func TestSnapshotZstdRoundTrip(t *testing.T) {
	ix := testIndex(t)
	// A few longer names make the compression benefit visible.
	dir := t.TempDir()
	for i := 0; i < 200; i++ {
		name := filepath.Join("/data", "docs", "generated-report-"+string(rune('a'+i%26))+"-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt")
		ix.AddPath(name, FileInfo{Size: int64(i), Mtime: int64(i) * 1e6, Mode: 0o644})
	}
	none := filepath.Join(dir, "none.snapshot")
	zst := filepath.Join(dir, "zst.snapshot")
	if _, err := ix.SaveBase(none, SnapshotOptions{}); err != nil {
		t.Fatal(err)
	}
	info, err := ix.SaveBase(zst, SnapshotOptions{Compression: CompressionZstd})
	if err != nil {
		t.Fatal(err)
	}
	if !info.UsesZstd() || info.Compression() != CompressionZstd {
		t.Fatalf("zstd info = %+v", info)
	}
	readInfo, err := ReadSnapshotInfo(zst)
	if err != nil {
		t.Fatal(err)
	}
	if !readInfo.UsesZstd() {
		t.Fatalf("ReadSnapshotInfo lost the compression flag: %+v", readInfo)
	}
	noneSize := mustStatSize(t, none)
	zstSize := mustStatSize(t, zst)
	if zstSize >= noneSize {
		t.Fatalf("zstd snapshot %d bytes is not smaller than none %d bytes", zstSize, noneSize)
	}
	back, err := Load(zst)
	if err != nil {
		t.Fatalf("load zstd snapshot: %v", err)
	}
	got, want := back.Stats(), ix.Stats()
	// Generation is per-process (it restarts at 0 after Load); compare the
	// persisted shape of the index instead.
	got.Generation, want.Generation = 0, 0
	if got != want {
		t.Fatalf("zstd round-trip stats = %+v, want %+v", got, want)
	}
	res, err := back.Search(Query{Text: "report", Limit: 10})
	if err != nil || res.Total == 0 {
		t.Fatalf("zstd search total=%d err=%v", res.Total, err)
	}
}

func mustStatSize(t *testing.T, path string) int64 {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Size()
}

// TestSnapshotV2TruncationRejected: every truncation of a v2 snapshot must fail
// cleanly instead of returning a partial index.
func TestSnapshotV2TruncationRejected(t *testing.T) {
	ix := testIndex(t)
	path := filepath.Join(t.TempDir(), "index.snapshot")
	if _, err := ix.SaveBase(path, SnapshotOptions{}); err != nil {
		t.Fatal(err)
	}
	good := mustRead(t, path)
	cuts := []int{0, 7, 40, headerSizeV2, headerSizeV2 + recordSize, headerSizeV2 + recordSize*3, len(good) - 1}
	for _, cut := range cuts {
		truncated := filepath.Join(t.TempDir(), "truncated.snapshot")
		if err := os.WriteFile(truncated, good[:cut], 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(truncated); err == nil {
			t.Fatalf("cut %d: Load accepted a truncated snapshot", cut)
		}
	}
}

// TestSnapshotV2CorruptCases: header and payload sanity checks reject data that
// would otherwise panic or allocate absurd amounts.
func TestSnapshotV2CorruptCases(t *testing.T) {
	ix := testIndex(t)
	path := filepath.Join(t.TempDir(), "index.snapshot")
	if _, err := ix.SaveBase(path, SnapshotOptions{}); err != nil {
		t.Fatal(err)
	}
	good := mustRead(t, path)
	cases := map[string]func([]byte) []byte{
		"bad-magic": func(b []byte) []byte { b[0] = 'X'; return b },
		"bad-version": func(b []byte) []byte {
			binary.LittleEndian.PutUint32(b[8:], 99)
			return b
		},
		"bad-table-cap": func(b []byte) []byte {
			binary.LittleEndian.PutUint32(b[56:], 12345)
			return b
		},
		"huge-payload": func(b []byte) []byte {
			binary.LittleEndian.PutUint64(b[24:], 1<<40)
			return b
		},
		"payload-short": func(b []byte) []byte {
			binary.LittleEndian.PutUint64(b[24:], 64)
			return b
		},
		"name-out-of-range": func(b []byte) []byte {
			binary.LittleEndian.PutUint32(b[headerSizeV2+4:], 1<<30)
			return b
		},
	}
	for name, mutate := range cases {
		corrupt := mutate(append([]byte(nil), good...))
		p := filepath.Join(t.TempDir(), name+".snapshot")
		if err := os.WriteFile(p, corrupt, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(p); err == nil {
			t.Fatalf("%s: Load accepted corrupt data", name)
		}
	}
}

// TestSnapshotInfoMatchesHeader: the store relies on ReadSnapshotInfo to decide
// between a journal append and a full rewrite.
func TestSnapshotInfoMatchesHeader(t *testing.T) {
	ix := testIndex(t)
	ix.RemovePath("/data/archive.zip")
	path := filepath.Join(t.TempDir(), "index.snapshot")
	saved, err := ix.SaveBase(path, SnapshotOptions{})
	if err != nil {
		t.Fatal(err)
	}
	info, err := ReadSnapshotInfo(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Version != snapshotVersionCurrent || info.BaseID != saved.BaseID {
		t.Fatalf("header info = %+v, want base id %d", info, saved.BaseID)
	}
	if info.Records != len(ix.recs) || info.NameBytes != len(ix.names) ||
		info.TableCap != len(ix.table.slots) || info.Deleted != ix.nDelet {
		t.Fatalf("header counts = %+v", info)
	}
	if !info.SupportsJournal() {
		t.Fatal("freshly written v2 base does not support a journal")
	}
	if info.FileBytes != mustStatSize(t, path) {
		t.Fatalf("FileBytes = %d, file = %d", info.FileBytes, mustStatSize(t, path))
	}
}

// TestSaveReleasesIndexLockBeforeWriting: the snapshot writer used to keep the
// index read lock for the whole file write, so the watcher's next mutation
// waited for the disk. The write phase must run lock-free.
func TestSaveReleasesIndexLockBeforeWriting(t *testing.T) {
	ix := New()
	root := filepath.Clean("/lock-root")
	ix.AddRoot(root)
	items := make([]AddItem, 0, 20000)
	for i := 0; i < 20000; i++ {
		items = append(items, AddItem{
			Path: filepath.Join(root, "dir", "f"+string(rune('a'+i%26))+"-"+time.Unix(0, int64(i)).Format("150405")+".txt"),
			Info: FileInfo{Size: int64(i), Mode: 0o644},
		})
	}
	ix.AddBatch(items)
	path := filepath.Join(t.TempDir(), "index.snapshot")

	orig := snapshotWriteFile
	started := make(chan struct{})
	release := make(chan struct{})
	snapshotWriteFile = func(tmp string, header, payload []byte, comp Compression) error {
		close(started)
		<-release
		return writeSnapshotFile(tmp, header, payload, comp)
	}
	defer func() { snapshotWriteFile = orig }()

	saveDone := make(chan error, 1)
	go func() { saveDone <- ix.Save(path) }()
	<-started // encode finished, the write phase is blocked
	writeDone := make(chan struct{})
	go func() {
		ix.AddPath(filepath.Join(root, "during-save.txt"), FileInfo{Size: 1, Mode: 0o644})
		close(writeDone)
	}()
	select {
	case <-writeDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Save held the index lock while writing the snapshot")
	}
	close(release)
	if err := <-saveDone; err != nil {
		t.Fatal(err)
	}
}

// TestSnapshotSaveIsAtomic: a failed write must leave the previous snapshot
// intact rather than a half-written file.
func TestSnapshotSaveIsAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "index.snapshot")
	ix := testIndex(t)
	if _, err := ix.SaveBase(path, SnapshotOptions{}); err != nil {
		t.Fatal(err)
	}
	before := mustRead(t, path)
	orig := snapshotWriteFile
	snapshotWriteFile = func(tmp string, header, payload []byte, comp Compression) error {
		if err := os.WriteFile(tmp, header[:10], 0o644); err != nil {
			return err
		}
		return bytes.ErrTooLarge
	}
	t.Cleanup(func() { snapshotWriteFile = orig })
	if _, err := ix.SaveBase(path, SnapshotOptions{}); err == nil {
		t.Fatal("failed snapshot write reported success")
	}
	snapshotWriteFile = orig
	if got := mustRead(t, path); !bytes.Equal(got, before) {
		t.Fatal("failed save corrupted the previous snapshot")
	}
	if _, err := Load(path); err != nil {
		t.Fatalf("previous snapshot no longer loads: %v", err)
	}
}
