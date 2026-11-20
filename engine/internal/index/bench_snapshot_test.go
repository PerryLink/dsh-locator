package index

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func benchSnapshotPath(b *testing.B) string {
	b.Helper()
	src := os.Getenv("DSH_BENCH_SNAPSHOT")
	if src == "" {
		b.Skip("DSH_BENCH_SNAPSHOT not set")
	}
	dst := filepath.Join(b.TempDir(), "index.snapshot")
	data, err := os.ReadFile(src)
	if err != nil {
		b.Fatal(err)
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		b.Fatal(err)
	}
	return dst
}

func BenchmarkSnapshotLoad(b *testing.B) {
	path := benchSnapshotPath(b)
	b.ResetTimer()
	var heap uint64
	for i := 0; i < b.N; i++ {
		ix, err := Load(path)
		if err != nil {
			b.Fatal(err)
		}
		if i == 0 {
			runtime.GC()
			var ms runtime.MemStats
			runtime.ReadMemStats(&ms)
			heap = ms.HeapAlloc
		}
		if ix.Len() == 0 {
			b.Fatal("empty index")
		}
	}
	b.StopTimer()
	b.ReportMetric(float64(heap)/1e6, "heap-MB")
}

func BenchmarkSnapshotSave(b *testing.B) {
	path := benchSnapshotPath(b)
	ix, err := Load(path)
	if err != nil {
		b.Fatal(err)
	}
	out := filepath.Join(b.TempDir(), "out.snapshot")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := ix.Save(out); err != nil {
			b.Fatal(err)
		}
	}
	b.StopTimer()
	if st, err := os.Stat(out); err == nil {
		b.ReportMetric(float64(st.Size())/1e6, "file-MB")
	}
}

func BenchmarkCompactTombstones(b *testing.B) {
	path := benchSnapshotPath(b)
	ix, err := Load(path)
	if err != nil {
		b.Fatal(err)
	}
	st := ix.Stats()
	if st.Deleted == 0 {
		b.Skip("snapshot has no tombstones")
	}
	b.ReportMetric(float64(st.Deleted), "deleted")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ix.Compact()
	}
}

func BenchmarkStatsCached(b *testing.B) {
	path := benchSnapshotPath(b)
	ix, err := Load(path)
	if err != nil {
		b.Fatal(err)
	}
	_ = ix.Stats() // warm the memoised result
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if ix.Stats().Entries == 0 {
			b.Fatal("empty index")
		}
	}
}

func TestPersistBenchReport(t *testing.T) {
	src := os.Getenv("DSH_BENCH_SNAPSHOT")
	if src == "" {
		t.Skip("DSH_BENCH_SNAPSHOT not set")
	}
	dir := t.TempDir()
	dst := filepath.Join(dir, "index.snapshot")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		t.Fatal(err)
	}
	runtime.GC()
	start := time.Now()
	ix, err := Load(dst)
	loadTook := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	st := ix.Stats()
	t.Logf("LOAD took=%s heap=%.1fMB rss=%.1fMB entries=%d records=%d deleted=%d",
		loadTook, float64(ms.HeapAlloc)/1e6, float64(readRSSBytes())/1e6, st.Entries, st.Records, st.Deleted)
	start = time.Now()
	savePath := filepath.Join(dir, "out.snapshot")
	if err := ix.Save(savePath); err != nil {
		t.Fatal(err)
	}
	saveTook := time.Since(start)
	fi, _ := os.Stat(savePath)
	t.Logf("SAVE took=%s bytes=%d", saveTook, fi.Size())
	start = time.Now()
	ix.Compact()
	compactTook := time.Since(start)
	st = ix.Stats()
	runtime.GC()
	runtime.ReadMemStats(&ms)
	t.Logf("COMPACT took=%s deleted=%d heap=%.1fMB rss=%.1fMB",
		compactTook, st.Deleted, float64(ms.HeapAlloc)/1e6, float64(readRSSBytes())/1e6)
}

// TestSaveLockStall measures how long a writer (the watcher path) waits for the
// index lock while a snapshot is being written.
func TestSaveLockStall(t *testing.T) {
	src := os.Getenv("DSH_BENCH_SNAPSHOT")
	if src == "" {
		t.Skip("DSH_BENCH_SNAPSHOT not set")
	}
	dir := t.TempDir()
	dst := filepath.Join(dir, "index.snapshot")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		t.Fatal(err)
	}
	ix, err := Load(dst)
	if err != nil {
		t.Fatal(err)
	}
	// Warm up the append path: the first mutation after Load grows the exact
	// capacity arenas and would dominate a lock-stall measurement.
	ix.AddPath(filepath.Join("/bench-root", "warmup.txt"), FileInfo{Size: 1, Mode: 0o644})
	out := filepath.Join(dir, "out.snapshot")
	saveDone := make(chan error, 1)
	saveStart := time.Now()
	go func() { saveDone <- ix.Save(out) }()
	time.Sleep(2 * time.Millisecond)
	path := filepath.Join("/bench-root", fmt.Sprintf("writer-%d.txt", time.Now().UnixNano()))
	waitStart := time.Now()
	ix.AddPath(path, FileInfo{Size: 1, Mode: 0o644})
	stall := time.Since(waitStart)
	if err := <-saveDone; err != nil {
		t.Fatal(err)
	}
	t.Logf("WRITER-STALL wait=%s save=%s", stall, time.Since(saveStart))
}

func readRSSBytes() int64 {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				n, _ := strconv.ParseInt(fields[1], 10, 64)
				return n * 1024
			}
		}
	}
	return 0
}
