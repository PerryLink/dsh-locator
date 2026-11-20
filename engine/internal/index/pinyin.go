package index

import (
	"encoding/binary"
	"strings"
	"unicode/utf8"

	"github.com/mozillazg/go-pinyin"
)

// pinyinTable holds the full-pinyin and first-letter keys of names that
// contain Han characters. Keys live in one byte arena addressed by record id:
// ASCII-only entries cost four bytes (a zero offset) and only Chinese names pay
// for their key bytes. Record ids match Index.recs, so Compact rebuilds it.
type pinyinTable struct {
	offs  []uint32 // 0 = no pinyin; otherwise offset+1 into arena
	arena []byte
	// has is one bit per record id. The dominant whole-disk case has a few
	// thousand Han names among millions of ASCII ones; testing a 190 KB bitmap
	// keeps the per-record fallback from streaming the 4-byte-per-record offset
	// table through the cache on every query.
	has []uint64
}

const pinyinHeader = 4 // uint16 full-pinyin length + uint16 initials length

// reset drops every key; used before Compact rebuilds the table.
func (t *pinyinTable) reset() {
	t.offs = nil
	t.arena = nil
	t.has = nil
}

// grow ensures the table has one offset (and one bitmap bit) per record.
func (t *pinyinTable) grow(n int) {
	for len(t.offs) < n {
		t.offs = append(t.offs, 0)
	}
	words := (n + 63) >> 6
	for len(t.has) < words {
		t.has = append(t.has, 0)
	}
}

// hasKey reports whether the record has pinyin keys. It is the cheap first
// question in the query fallback; get() reads the arena only on a hit.
func (t *pinyinTable) hasKey(id int32) bool {
	if int(id) < 0 {
		return false
	}
	word := int(id) >> 6
	if word >= len(t.has) {
		return false
	}
	return t.has[word]&(1<<uint(id&63)) != 0
}

func (t *pinyinTable) empty() bool { return len(t.arena) == 0 }

// set stores both keys for record id. Callers must have called grow first.
func (t *pinyinTable) set(id int32, full, initials string) {
	if int(id) < 0 {
		return
	}
	if int(id) >= len(t.offs) {
		t.grow(int(id) + 1)
	}
	start := len(t.arena)
	t.arena = append(t.arena, 0, 0, 0, 0)
	binary.LittleEndian.PutUint16(t.arena[start:start+2], uint16(len(full)))
	binary.LittleEndian.PutUint16(t.arena[start+2:start+4], uint16(len(initials)))
	t.arena = append(t.arena, full...)
	t.arena = append(t.arena, initials...)
	t.offs[id] = uint32(start + 1)
	word := int(id) >> 6
	if word >= len(t.has) {
		t.grow(int(id) + 1)
	}
	t.has[word] |= 1 << uint(id&63)
}

// get returns the record's pinyin keys as zero-copy strings. The caller holds
// the index read lock, so the arena cannot move while they are in use.
func (t *pinyinTable) get(id int32) (full, initials string, ok bool) {
	if int(id) < 0 || int(id) >= len(t.offs) {
		return "", "", false
	}
	off := t.offs[id]
	if off == 0 {
		return "", "", false
	}
	start := int(off - 1)
	if start+pinyinHeader > len(t.arena) {
		return "", "", false
	}
	fullLen := int(binary.LittleEndian.Uint16(t.arena[start : start+2]))
	initialsLen := int(binary.LittleEndian.Uint16(t.arena[start+2 : start+4]))
	pos := start + pinyinHeader
	if pos+fullLen+initialsLen > len(t.arena) {
		return "", "", false
	}
	full = unsafeString(t.arena[pos : pos+fullLen])
	initials = unsafeString(t.arena[pos+fullLen : pos+fullLen+initialsLen])
	return full, initials, true
}

// pinyinToneBase folds the tone-marked vowels in go-pinyin's dictionary values
// to the tone-less ASCII letters its Normal style produces ("nǚ" -> "nv").
var pinyinToneBase = map[rune]byte{
	'ā': 'a', 'á': 'a', 'ǎ': 'a', 'à': 'a',
	'ē': 'e', 'é': 'e', 'ě': 'e', 'è': 'e',
	'ō': 'o', 'ó': 'o', 'ǒ': 'o', 'ò': 'o',
	'ī': 'i', 'í': 'i', 'ǐ': 'i', 'ì': 'i',
	'ū': 'u', 'ú': 'u', 'ǔ': 'u', 'ù': 'u',
	'ü': 'v', 'ǘ': 'v', 'ǚ': 'v', 'ǜ': 'v',
	'ń': 'n', 'ň': 'n', 'ǹ': 'n', 'ḿ': 'm',
}

// appendPinyinSyllable appends the tone-less pinyin of one character to full
// (all letters) and initials (its first letter). It reads go-pinyin's exported
// dictionary directly instead of calling LazyPinyin: LazyPinyin allocates a
// slice, a result slice and a seen map for every character, which doubled the
// peak RSS of a 1.5M-entry index load (about 200 MiB -> 400 MiB). The pinned
// dictionary is the same lookup LazyPinyin performs internally.
func appendPinyinSyllable(full, initials *strings.Builder, r rune) bool {
	value, ok := pinyin.PinyinDict[int(r)]
	if !ok || value == "" {
		return false
	}
	// go-pinyin lists readings comma-separated and LazyPinyin keeps the first.
	if i := strings.IndexByte(value, ','); i >= 0 {
		value = value[:i]
	}
	first := byte(0)
	for _, c := range value {
		var b byte
		if c < utf8.RuneSelf {
			b = byte(c)
		} else {
			mapped, found := pinyinToneBase[c]
			if !found {
				// Not a tone mark this release knows; skip the rune rather
				// than emit a broken key. The fidelity test pins the dictionary.
				continue
			}
			b = mapped
		}
		if first == 0 {
			first = b
		}
		full.WriteByte(b)
	}
	if first == 0 {
		return false
	}
	initials.WriteByte(first)
	return true
}

// pinyinKeys transliterates a name: full joins every syllable ("guojia") and
// initials keeps the first letter of each syllable ("gj"). Non-Han characters
// are skipped, so "报告2026.pdf" yields "baogao"/"bg". ok is false for names
// without Han characters (the common case on a whole-disk index).
func pinyinKeys(name string) (full, initials string, ok bool) {
	if !containsHan(name) {
		return "", "", false
	}
	var fullB, initB strings.Builder
	fullB.Grow(len(name) * 2)
	initB.Grow(len(name))
	for _, r := range name {
		appendPinyinSyllable(&fullB, &initB, r)
	}
	if fullB.Len() == 0 {
		return "", "", false
	}
	return fullB.String(), initB.String(), true
}

// pinyinContains matches a case-folded Latin query against a name's pinyin keys:
// any substring of the full pinyin ("guojia", "gongyuan"), any substring of
// the initials ("gjgy"), or a subsequence of the initials ("gjy").
func pinyinContains(full, initials, query string) bool {
	if query == "" {
		return false
	}
	if strings.Contains(full, query) || strings.Contains(initials, query) {
		return true
	}
	// Initial-letter abbreviations are usually typed as a subsequence: users
	// write "gjy" for 国家公园 (initials "gjgy"). Restrict the loose match to
	// pure Latin-letter queries so digits and punctuation cannot over-match.
	if !isLatinLetters(query) {
		return false
	}
	return isSubsequence(initials, query)
}

func isLatinLetters(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 'a' || s[i] > 'z' {
			return false
		}
	}
	return s != ""
}

func isSubsequence(hay, needle string) bool {
	if needle == "" {
		return true
	}
	j := 0
	for i := 0; i < len(hay) && j < len(needle); i++ {
		if hay[i] == needle[j] {
			j++
		}
	}
	return j == len(needle)
}
