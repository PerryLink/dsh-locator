package index

import (
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/mozillazg/go-pinyin"
)

// cjkIndex is a small fixture that mixes Chinese, Latin and mixed names.
func cjkIndex(t *testing.T) *Index {
	t.Helper()
	ix := New()
	root := filepath.Clean("/data")
	ix.AddRoot(root)
	for _, name := range []string{
		"国家公园.txt",
		"会议记录.docx",
		"报告2026.pdf",
		"金融数据.csv",
		"report.pdf",
		"README.md",
		"ＲＥＰＯＲＴ２.txt",
		"hello.txt",
	} {
		ix.AddPath(filepath.Join(root, name), FileInfo{Size: 1, Mode: 0o644})
	}
	return ix
}

func hitNames(res Result) []string {
	names := make([]string, 0, len(res.Hits))
	for i := range res.Hits {
		names = append(names, res.Hits[i].Name)
	}
	sort.Strings(names)
	return names
}

func searchNames(t *testing.T, ix *Index, query string) []string {
	t.Helper()
	q, err := ParseQuery(query)
	if err != nil {
		t.Fatalf("ParseQuery(%q): %v", query, err)
	}
	q.Limit = 100
	res, err := ix.Search(q)
	if err != nil {
		t.Fatalf("Search(%q): %v", query, err)
	}
	return hitNames(res)
}

func wantNames(t *testing.T, query string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%q: got %v, want %v", query, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%q: got %v, want %v", query, got, want)
		}
	}
}

func TestPinyinFullName(t *testing.T) {
	ix := cjkIndex(t)
	cases := map[string][]string{
		"guojia":         {"国家公园.txt"},
		"gongyuan":       {"国家公园.txt"},
		"guojiagongyuan": {"国家公园.txt"},
		"huiyijilu":      {"会议记录.docx"},
		"baogao":         {"报告2026.pdf"},
		"jinrong":        {"金融数据.csv"},
	}
	for query, want := range cases {
		wantNames(t, query, searchNames(t, ix, query), want)
	}
}

func TestPinyinInitials(t *testing.T) {
	ix := cjkIndex(t)
	cases := map[string][]string{
		"gjgy": {"国家公园.txt"},
		"gjy":  {"国家公园.txt"}, // abbreviation: subsequence of "gjgy"
		"hyjl": {"会议记录.docx"},
		"jrsj": {"金融数据.csv"},
		"bg":   {"报告2026.pdf"},
	}
	for query, want := range cases {
		wantNames(t, query, searchNames(t, ix, query), want)
	}
}

func TestPinyinMixedQuery(t *testing.T) {
	ix := cjkIndex(t)
	// A mixed term must not translate the Han half and must not lose the
	// Latin half: each run matches independently.
	wantNames(t, "guo家", searchNames(t, ix, "guo家"), []string{"国家公园.txt"})
	wantNames(t, "国家gjy", searchNames(t, ix, "国家gjy"), []string{"国家公园.txt"})
	wantNames(t, "报告2026", searchNames(t, ix, "报告2026"), []string{"报告2026.pdf"})
	// Separate terms work exactly like before: one pinyin term plus one
	// literal term.
	wantNames(t, "guojia 公园", searchNames(t, ix, "guojia 公园"), []string{"国家公园.txt"})
}

func TestQueryNormalizationWidthCaseAndCJK(t *testing.T) {
	ix := cjkIndex(t)
	// Full-width Latin letters fold to ASCII, then to lower case.
	wantNames(t, "ＧＵＯＪＩＡ", searchNames(t, ix, "ＧＵＯＪＩＡ"), []string{"国家公园.txt"})
	wantNames(t, "ｇｊｙ", searchNames(t, ix, "ｇｊｙ"), []string{"国家公园.txt"})
	// ASCII case folding still works.
	wantNames(t, "GUOJIA", searchNames(t, ix, "GUOJIA"), []string{"国家公园.txt"})
	// A full-width file name matches an ASCII query through the normalized
	// name table (and the ASCII report.pdf still matches literally).
	wantNames(t, "report", searchNames(t, ix, "report"), []string{"report.pdf", "ＲＥＰＯＲＴ２.txt"})
	// Kangxi radical 金 is an NFKC compatibility form of 金.
	wantNames(t, "⾦融", searchNames(t, ix, "⾦融"), []string{"金融数据.csv"})
	// A full-width ideographic space separates terms just like ASCII space.
	wantNames(t, "国家　公园", searchNames(t, ix, "国家　公园"), []string{"国家公园.txt"})
	// Full-width filter keywords and negation are normalized before parsing.
	wantNames(t, "ｅｘｔ:ｐｄｆ", searchNames(t, ix, "ｅｘｔ:ｐｄｆ"), []string{"report.pdf", "报告2026.pdf"})
	// The fixture root itself ("data") is an indexed record and is not
	// filtered out by an unrelated negated term.
	wantNames(t, "！report", searchNames(t, ix, "！report"), []string{
		"README.md", "data", "hello.txt", "会议记录.docx", "国家公园.txt", "报告2026.pdf", "金融数据.csv",
	})
}

func TestPinyinDoesNotAffectNonChineseNames(t *testing.T) {
	ix := New()
	root := filepath.Clean("/data")
	ix.AddRoot(root)
	for _, name := range []string{"report.pdf", "guojia.txt", "hello.txt"} {
		ix.AddPath(filepath.Join(root, name), FileInfo{Size: 1, Mode: 0o644})
	}
	wantNames(t, "guojia", searchNames(t, ix, "guojia"), []string{"guojia.txt"})
	wantNames(t, "gjy", searchNames(t, ix, "gjy"), nil)
	wantNames(t, "zhongguo", searchNames(t, ix, "zhongguo"), nil)
	wantNames(t, "HELLO", searchNames(t, ix, "HELLO"), []string{"hello.txt"})
	// An index with no Han names skips the pinyin fallback entirely.
	if ix.HasPinyin() {
		t.Fatal("ASCII-only index reported pinyin entries")
	}
	if !cjkIndex(t).HasPinyin() {
		t.Fatal("Chinese fixture reported no pinyin entries")
	}
}

func TestPinyinNegationAndCaseSensitive(t *testing.T) {
	ix := cjkIndex(t)
	res, err := ix.Search(mustQuery(t, "!guojia"))
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 8 {
		t.Fatalf("negated pinyin total = %d, want 8 (%v)", res.Total, hitNames(res))
	}
	// case:1 turns the pinyin fallback off: 国家公园 has no literal "guojia".
	res, err = ix.Search(mustQuery(t, "guojia case:1"))
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 0 {
		t.Fatalf("case-sensitive pinyin total = %d, want 0 (%v)", res.Total, hitNames(res))
	}
}

func TestPinyinWildcardStaysLiteral(t *testing.T) {
	ix := cjkIndex(t)
	wantNames(t, "国家*", searchNames(t, ix, "国家*"), []string{"国家公园.txt"})
	// A wildcard must not be routed through the pinyin substring matcher.
	wantNames(t, "guo*", searchNames(t, ix, "guo*"), nil)
}

func TestPinyinSurvivesSnapshotRoundTrip(t *testing.T) {
	ix := cjkIndex(t)
	path := filepath.Join(t.TempDir(), "cjk.snap")
	if err := ix.Save(path); err != nil {
		t.Fatal(err)
	}
	back, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !back.HasPinyin() {
		t.Fatal("loaded index has no pinyin table")
	}
	wantNames(t, "guojia", searchNames(t, back, "guojia"), []string{"国家公园.txt"})
	wantNames(t, "gjy", searchNames(t, back, "gjy"), []string{"国家公园.txt"})
	wantNames(t, "⾦融", searchNames(t, back, "⾦融"), []string{"金融数据.csv"})
	// New records added after Load must maintain the derived tables.
	if _, added := back.AddPath(filepath.Join("/data", "新增报告.txt"), FileInfo{Size: 2, Mode: 0o644}); !added {
		t.Fatal("new Chinese path was not added")
	}
	wantNames(t, "xinzeng", searchNames(t, back, "xinzeng"), []string{"新增报告.txt"})
}

func TestPinyinAddBatchAndCompact(t *testing.T) {
	root := filepath.Clean("/batch")
	ix := New()
	ix.AddRoot(root)
	ix.AddBatch([]AddItem{
		{Path: filepath.Join(root, "国家公园.txt"), Info: FileInfo{Size: 1, Mode: 0o644}},
		{Path: filepath.Join(root, "会议记录.docx"), Info: FileInfo{Size: 1, Mode: 0o644}},
	})
	wantNames(t, "guojia", searchNames(t, ix, "guojia"), []string{"国家公园.txt"})
	if !ix.RemovePath(filepath.Join(root, "会议记录.docx")) {
		t.Fatal("remove failed")
	}
	ix.Compact()
	wantNames(t, "guojia", searchNames(t, ix, "guojia"), []string{"国家公园.txt"})
	wantNames(t, "hyjl", searchNames(t, ix, "hyjl"), nil)
	// The folded-name table is rebuilt by Compact too.
	if _, added := ix.AddPath(filepath.Join(root, "ＦＵＬＬ.txt"), FileInfo{Size: 1, Mode: 0o644}); !added {
		t.Fatal("full-width path was not added")
	}
	wantNames(t, "full", searchNames(t, ix, "full"), []string{"ＦＵＬＬ.txt"})
}

func TestPinyinKeysUnit(t *testing.T) {
	full, initials, ok := pinyinKeys("国家公园")
	if !ok || full != "guojiagongyuan" || initials != "gjgy" {
		t.Fatalf("pinyinKeys = %q %q %v", full, initials, ok)
	}
	full, initials, ok = pinyinKeys("报告2026.pdf")
	if !ok || full != "baogao" || initials != "bg" {
		t.Fatalf("pinyinKeys = %q %q %v", full, initials, ok)
	}
	if _, _, ok := pinyinKeys("report.pdf"); ok {
		t.Fatal("ASCII name reported pinyin")
	}
	if !pinyinContains("guojiagongyuan", "gjgy", "guojia") || !pinyinContains("guojiagongyuan", "gjgy", "gjy") {
		t.Fatal("pinyinContains missed full/abbreviation match")
	}
	if pinyinContains("guojiagongyuan", "gjgy", "zzz") {
		t.Fatal("pinyinContains accepted an unrelated query")
	}
}

// TestPinyinConversionMatchesGoPinyin pins the allocation-free dictionary
// conversion against go-pinyin's own LazyPinyin output for every character in
// its dictionary: the full key must equal the Normal-style syllable and the
// initials key must equal the FirstLetter-style syllable.
func TestPinyinConversionMatchesGoPinyin(t *testing.T) {
	fullArgs := pinyin.NewArgs()
	firstArgs := pinyin.NewArgs()
	firstArgs.Style = pinyin.FirstLetter
	for key, value := range pinyin.PinyinDict {
		r := rune(key)
		var fullB, initB strings.Builder
		if !appendPinyinSyllable(&fullB, &initB, r) {
			t.Fatalf("%U (%q): appendPinyinSyllable returned false", r, value)
		}
		gotFull, gotInit := fullB.String(), initB.String()
		wantFull := pinyin.LazyPinyin(string(r), fullArgs)
		if len(wantFull) != 1 || gotFull != wantFull[0] {
			t.Fatalf("%U (%q): full = %q, go-pinyin = %v", r, value, gotFull, wantFull)
		}
		wantInit := pinyin.LazyPinyin(string(r), firstArgs)
		if len(wantInit) != 1 || gotInit != wantInit[0] {
			t.Fatalf("%U (%q): initials = %q, go-pinyin = %v", r, value, gotInit, wantInit)
		}
	}
}

func TestNormalizeTextUnit(t *testing.T) {
	if got := normalizeText("ＲＥＰＯＲＴ", true); got != "report" {
		t.Fatalf("full-width normalization = %q", got)
	}
	if got := normalizeText("⾦融", false); got != "金融" {
		t.Fatalf("CJK compatibility normalization = %q", got)
	}
	if got := normalizeText("国家", false); got != "国家" {
		t.Fatalf("identity normalization = %q", got)
	}
	if _, ok := foldedName("report.pdf"); ok {
		t.Fatal("ASCII name has a folded entry")
	}
	if got, ok := foldedName("ＲＥＰＯＲＴ２.txt"); !ok || got != "report2.txt" {
		t.Fatalf("foldedName = %q %v", got, ok)
	}
}

// TestSnapshotFormatKeepsPinyinDerived pins the compatibility contract: the
// legacy v1 layout stays readable, and the pinyin/folded-name tables remain
// derived state that Load rebuilds rather than persisted data.
func TestSnapshotFormatKeepsPinyinDerived(t *testing.T) {
	if snapshotVersion != 1 {
		t.Fatalf("legacy snapshot version = %d, want 1", snapshotVersion)
	}
	if snapshotVersionCurrent != 2 {
		t.Fatalf("current snapshot version = %d, want 2", snapshotVersionCurrent)
	}
	// The round-trip tests (TestPinyinSurvivesSnapshotRoundTrip, the v1 and zstd
	// cases in snapshot_v2_test.go) prove the derived tables are rebuilt on
	// load rather than stored.
}

func mustQuery(t *testing.T, text string) Query {
	t.Helper()
	q, err := ParseQuery(text)
	if err != nil {
		t.Fatalf("ParseQuery(%q): %v", text, err)
	}
	q.Limit = 100
	return q
}
