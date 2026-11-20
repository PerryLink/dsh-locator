package index

import (
	"regexp/syntax"
	"strings"
)

// globKind is the precomputed shape of a wildcard term. It lets "*.go" and
// "prefix*" skip the general backtracking matcher entirely, which was a
// measurable share of query time for glob-heavy queries.
type globKind uint8

const (
	globGeneral globKind = iota
	globAll
	globLiteralPrefix
	globLiteralSuffix
	globLiteralContains
)

// planGlob classifies a wildcard pattern and returns the literal part it
// implies. Patterns with character classes, ? or several stars stay general.
func planGlob(pattern string) (globKind, string) {
	stars := 0
	starAt := -1
	for i := 0; i < len(pattern); i++ {
		switch pattern[i] {
		case '*':
			stars++
			starAt = i
		case '?':
			return globGeneral, ""
		}
	}
	switch {
	case stars == 0:
		return globGeneral, ""
	case stars == len(pattern):
		// Only stars: matches every name.
		return globAll, ""
	case stars == 1 && starAt == len(pattern)-1:
		return globLiteralPrefix, pattern[:len(pattern)-1]
	case stars == 1 && starAt == 0:
		return globLiteralSuffix, pattern[1:]
	case stars == 2 && pattern[0] == '*' && pattern[len(pattern)-1] == '*' && len(pattern) > 2:
		return globLiteralContains, pattern[1 : len(pattern)-1]
	}
	return globGeneral, ""
}

// hasPrefixFold is strings.HasPrefix for a folded haystack.
func hasPrefixFold(s, prefix string) bool {
	if len(s) < len(prefix) {
		return false
	}
	for i := 0; i < len(prefix); i++ {
		if foldByte(s[i]) != foldByte(prefix[i]) {
			return false
		}
	}
	return true
}

// hasSuffixFold is strings.HasSuffix for a folded haystack.
func hasSuffixFold(s, suffix string) bool {
	if len(s) < len(suffix) {
		return false
	}
	off := len(s) - len(suffix)
	for i := 0; i < len(suffix); i++ {
		if foldByte(s[off+i]) != foldByte(suffix[i]) {
			return false
		}
	}
	return true
}

// regexLitKind says where a regex-plan literal occurs in a match.
type regexLitKind uint8

const (
	reLiteralNone regexLitKind = iota
	reLiteralContains
	reLiteralPrefix
	reLiteralSuffix
	reLiteralExact
)

// regexPlan is the literal prefilter for a regexp query. A fully literal
// pattern (optionally anchored) can skip the regex engine entirely.
type regexPlan struct {
	kind      regexLitKind
	lit       string
	fold      bool
	skipRegex bool
}

// prefilter reports whether the literal can still be present. It is a necessary
// condition only unless skipRegex says it is sufficient.
func (p *regexPlan) prefilter(name string) bool {
	switch p.kind {
	case reLiteralNone:
		return true
	case reLiteralContains:
		if p.fold {
			return indexOfFold(name, p.lit, false) >= 0
		}
		return strings.Contains(name, p.lit)
	case reLiteralPrefix:
		if p.fold {
			return hasPrefixFold(name, p.lit)
		}
		return strings.HasPrefix(name, p.lit)
	case reLiteralSuffix:
		if p.fold {
			return hasSuffixFold(name, p.lit)
		}
		return strings.HasSuffix(name, p.lit)
	case reLiteralExact:
		if p.fold {
			return len(name) == len(p.lit) && hasPrefixFold(name, p.lit)
		}
		return name == p.lit
	}
	return true
}

// planRegex extracts a literal prefilter from a regular expression. It only
// analyses the parsed syntax tree; anything it cannot prove necessary is left
// to the regexp engine.
func planRegex(pat string) regexPlan {
	re, err := syntax.Parse(pat, syntax.Perl)
	if err != nil {
		return regexPlan{}
	}
	re = re.Simplify()
	if lit, fold, kind, ok := wholeLiteral(re); ok && len(lit) > 0 {
		if fold {
			lit = strings.ToLower(lit)
		}
		return regexPlan{kind: kind, lit: lit, fold: fold, skipRegex: true}
	}
	if lit, fold, anchored, ok := leadingLiteral(re); ok && len(lit) >= 2 {
		if fold {
			lit = strings.ToLower(lit)
		}
		kind := reLiteralContains
		if anchored {
			kind = reLiteralPrefix
		}
		return regexPlan{kind: kind, lit: lit, fold: fold}
	}
	return regexPlan{}
}

// wholeLiteral reports whether re is exactly one literal run, optionally
// wrapped in text anchors.
func wholeLiteral(re *syntax.Regexp) (lit string, fold bool, kind regexLitKind, ok bool) {
	re = unwrapCapture(re)
	if re.Op == syntax.OpLiteral {
		return string(re.Rune), re.Flags&syntax.FoldCase != 0, reLiteralContains, true
	}
	if re.Op != syntax.OpConcat {
		return "", false, reLiteralNone, false
	}
	begin, end := false, false
	var runes []rune
	for _, sub := range re.Sub {
		sub = unwrapCapture(sub)
		switch sub.Op {
		case syntax.OpEmptyMatch:
			continue
		case syntax.OpBeginLine, syntax.OpBeginText:
			if len(runes) > 0 {
				return "", false, reLiteralNone, false
			}
			begin = true
			continue
		case syntax.OpEndLine, syntax.OpEndText:
			end = true
			continue
		case syntax.OpLiteral:
			if len(runes) > 0 || end {
				return "", false, reLiteralNone, false
			}
			runes = append(runes, sub.Rune...)
			fold = fold || sub.Flags&syntax.FoldCase != 0
			continue
		}
		return "", false, reLiteralNone, false
	}
	if len(runes) == 0 {
		return "", false, reLiteralNone, false
	}
	lit = string(runes)
	switch {
	case begin && end:
		kind = reLiteralExact
	case begin:
		kind = reLiteralPrefix
	case end:
		kind = reLiteralSuffix
	default:
		kind = reLiteralContains
	}
	return lit, fold, kind, true
}

// leadingLiteral extracts a literal run that any match must contain at its
// start (when anchored) or somewhere. It stops at the first non-literal op.
func leadingLiteral(re *syntax.Regexp) (lit string, fold, anchored, ok bool) {
	re = unwrapCapture(re)
	if re.Op == syntax.OpLiteral {
		return string(re.Rune), re.Flags&syntax.FoldCase != 0, false, true
	}
	if re.Op != syntax.OpConcat {
		return "", false, false, false
	}
	var runes []rune
	for _, sub := range re.Sub {
		sub = unwrapCapture(sub)
		if len(runes) == 0 {
			switch sub.Op {
			case syntax.OpEmptyMatch:
				continue
			case syntax.OpBeginLine, syntax.OpBeginText:
				anchored = true
				continue
			case syntax.OpLiteral:
				runes = append(runes, sub.Rune...)
				fold = fold || sub.Flags&syntax.FoldCase != 0
				continue
			}
			return "", false, false, false
		}
		if sub.Op == syntax.OpLiteral {
			runes = append(runes, sub.Rune...)
			fold = fold || sub.Flags&syntax.FoldCase != 0
			continue
		}
		return string(runes), fold, anchored, true
	}
	return string(runes), fold, anchored, true
}

func unwrapCapture(re *syntax.Regexp) *syntax.Regexp {
	for re.Op == syntax.OpCapture && len(re.Sub) == 1 {
		re = re.Sub[0]
	}
	return re
}

// prepareExts resolves the extension filter names to index extension ids once
// per query and stores them as bitmaps. The caller holds the index read lock.
func (m *matcher) prepareExts(ix *Index) {
	if m.extPrepared {
		return
	}
	m.extPrepared = true
	words := (len(ix.exts) + 64) / 64
	if m.exts != nil {
		bits := make([]uint64, words)
		any := false
		for name := range m.exts {
			id, ok := ix.extIdx[name]
			if !ok {
				continue
			}
			bits[int(id)>>6] |= 1 << uint(id&63)
			any = true
		}
		if !any {
			m.extImpossible = true
			return
		}
		m.extInclude = bits
	}
	if m.notExts != nil {
		bits := make([]uint64, words)
		any := false
		for name := range m.notExts {
			id, ok := ix.extIdx[name]
			if !ok {
				continue
			}
			bits[int(id)>>6] |= 1 << uint(id&63)
			any = true
		}
		if any {
			m.extExclude = bits
		}
	}
}

// bitsTest reports whether the extension id is set in the bitmap.
func bitsTest(bits []uint64, id uint16) bool {
	word := int(id) >> 6
	if word >= len(bits) {
		return false
	}
	return bits[word]&(1<<uint(id&63)) != 0
}
