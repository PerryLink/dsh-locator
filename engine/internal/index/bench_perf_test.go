package index

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// benchIndex builds a synthetic whole-disk-like index: mostly ASCII developer
// file names, with a slice of Han-character names so the pinyin fallback is
// exercised.
func benchIndex(b *testing.B, files, chinese int) *Index {
	b.Helper()
	ix := New()
	root := filepath.Join(string(filepath.Separator)+"bench", "root")
	ix.AddRoot(root)
	dirs := make([]AddItem, 0, 2048)
	for i := 0; i < 2048; i++ {
		dirs = append(dirs, AddItem{Path: filepath.Join(root, fmt.Sprintf("area%02d", i/64), fmt.Sprintf("dir%04d", i)), Info: FileInfo{Mode: os.ModeDir | 0o755}})
	}
	ix.AddBatch(dirs)
	exts := []string{".go", ".js", ".ts", ".json", ".md", ".pdf", ".txt", ".yaml", ".png", ".bin"}
	batch := make([]AddItem, 0, files)
	for i := 0; i < files; i++ {
		dir := dirs[i%len(dirs)].Path
		name := fmt.Sprintf("report-%05d-%s%s", i, strings.Repeat("x", i%12), exts[i%len(exts)])
		if i%997 == 0 {
			name = fmt.Sprintf("notes-%05d%s", i, exts[i%len(exts)])
		}
		if i%3119 == 0 {
			name = fmt.Sprintf("func-%05d-handler%s", i, exts[i%len(exts)])
		}
		batch = append(batch, AddItem{Path: filepath.Join(dir, name), Info: FileInfo{Size: int64(i), Mtime: int64(i) * 1e9, Mode: 0o644}})
	}
	han := []string{"国家公园报告", "会议记录", "项目计划书", "年度总结", "招股说明书", "技术方案设计", "季度财务报告", "产品需求文档"}
	for i := 0; i < chinese; i++ {
		dir := dirs[i%len(dirs)].Path
		name := fmt.Sprintf("%s-%05d%s", han[i%len(han)], i, exts[i%len(exts)])
		batch = append(batch, AddItem{Path: filepath.Join(dir, name), Info: FileInfo{Size: int64(i), Mtime: int64(i) * 1e9, Mode: 0o644}})
	}
	ix.AddBatch(batch)
	return ix
}

func benchQuery(text string) Query {
	q, err := ParseQuery(text)
	if err != nil {
		panic(err)
	}
	q.Limit = 100
	return q
}

func runBenchSearch(b *testing.B, text string) {
	ix := benchIndex(b, 120000, 500)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := ix.Search(benchQuery(text)); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkSearchSubstring(b *testing.B)  { runBenchSearch(b, "report") }
func BenchmarkSearchNarrow(b *testing.B)     { runBenchSearch(b, "report-00042") }
func BenchmarkSearchGlobSuffix(b *testing.B) { runBenchSearch(b, "*.go") }
func BenchmarkSearchGlobPrefix(b *testing.B) { runBenchSearch(b, "report-0001*") }
func BenchmarkSearchExt(b *testing.B)        { runBenchSearch(b, "ext:json") }
func BenchmarkSearchExtExclude(b *testing.B) { runBenchSearch(b, "ext:!pdf") }
func BenchmarkSearchPinyin(b *testing.B)     { runBenchSearch(b, "guojia") }
func BenchmarkSearchWide(b *testing.B)       { runBenchSearch(b, "x") }

func BenchmarkSearchRegex(b *testing.B) {
	ix := benchIndex(b, 120000, 500)
	q := Query{Text: `report-[0-9]{5}-`, Regex: true, Limit: 100, MinSize: -1, MaxSize: -1, MinMtime: -1, MaxMtime: -1}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := ix.Search(q); err != nil {
			b.Fatal(err)
		}
	}
}
