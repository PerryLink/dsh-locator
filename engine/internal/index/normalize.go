package index

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// normalizeText returns the search form of s. NFKC folds full-width ASCII and
// CJK compatibility characters (for example "ＲＥＰＯＲＴ" and the Kangxi
// radical "⾦"); foldCase additionally lower-cases the result so Latin queries
// stay case-insensitive. Chinese characters already in unified form are
// unchanged and NFKC.String returns the input without allocating, which keeps
// the per-name work during a whole-disk scan cheap.
func normalizeText(s string, foldCase bool) string {
	if s == "" {
		return s
	}
	if isASCII(s) {
		if foldCase {
			return strings.ToLower(s)
		}
		return s
	}
	n := norm.NFKC.String(s)
	if foldCase {
		n = strings.ToLower(n)
	}
	return n
}

// foldedName returns name's case-folded NFKC form when it differs from the raw
// bytes in a way the byte-wise matcher cannot handle: full-width characters,
// compatibility ideographs and non-ASCII case. Pure ASCII names return false;
// the matcher already folds ASCII case without materialising a copy.
func foldedName(name string) (string, bool) {
	if !hasNonASCII(name) {
		return "", false
	}
	n := normalizeText(name, true)
	if n == name {
		return "", false
	}
	return n, true
}

func hasNonASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return true
		}
	}
	return false
}

func isASCII(s string) bool { return !hasNonASCII(s) }

// containsHan reports whether s has a Han character that go-pinyin can
// transliterate. The ASCII fast path keeps startup scanning cheap: a whole-disk
// index is mostly ASCII names.
func containsHan(s string) bool {
	if !hasNonASCII(s) {
		return false
	}
	for _, r := range s {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

// isHan reports whether r is a Han character.
func isHan(r rune) bool { return unicode.Is(unicode.Han, r) }

// splitHanRuns splits a normalized mixed Han+Latin term into runs. Each run is
// matched independently: a Han run must occur literally in the name, a Latin
// run may also match the name's pinyin keys. Terms without Han, or with Han
// only, never reach this function.
func splitHanRuns(s string) []termPart {
	parts := make([]termPart, 0, 4)
	start := 0
	inHan := false
	for i, r := range s {
		han := isHan(r)
		if i == 0 {
			inHan = han
			continue
		}
		if han == inHan {
			continue
		}
		parts = append(parts, termPart{text: s[start:i], han: inHan})
		start = i
		inHan = han
	}
	parts = append(parts, termPart{text: s[start:], han: inHan})
	return parts
}
