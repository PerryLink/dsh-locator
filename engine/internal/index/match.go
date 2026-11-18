package index

import (
	"regexp"
	"strings"
)

// matcher is the immutable per-query plan: normalized terms plus the filters.
type matcher struct {
	q         *Query
	re        *regexp.Regexp
	terms     []matchTerm
	pathTerms []string
	exts      map[string]bool
	notExts   map[string]bool
	wholeWord bool
	caseSens  bool
}

// matchTerm is one bare query term in its normalized search form.
type matchTerm struct {
	// raw keeps the query's case (after NFKC width folding); case-sensitive
	// and glob matching use it.
	raw string
	// lower is NFKC + lower case, compared against names and pinyin keys when
	// the query is case-insensitive.
	lower string
	neg   bool
	// wildcard terms use glob matching only.
	wildcard bool
	// han is true when the term contains a Han character.
	han bool
	// parts splits a mixed Han+Latin term. Pure Han or pure Latin terms leave
	// it nil and take the faster single-form path.
	parts []termPart
}

// termPart is one Han or non-Han run of a mixed term.
type termPart struct {
	text string
	han  bool
}

func newMatcher(q *Query) (*matcher, error) {
	m := &matcher{
		q:         q,
		pathTerms: q.PathTerms,
		wholeWord: q.WholeWord,
		caseSens:  q.Case,
	}
	if len(q.Exts) > 0 {
		m.exts = make(map[string]bool, len(q.Exts))
		for _, e := range q.Exts {
			m.exts[e] = true
		}
	}
	if len(q.NotExts) > 0 {
		m.notExts = make(map[string]bool, len(q.NotExts))
		for _, e := range q.NotExts {
			m.notExts[e] = true
		}
	}
	if q.Regex {
		pat := q.Text
		if !q.Case {
			pat = "(?i)" + pat
		}
		re, err := regexp.Compile(pat)
		if err != nil {
			return nil, err
		}
		m.re = re
		return m, nil
	}
	for _, t := range q.Terms {
		m.terms = append(m.terms, newMatchTerm(t, q.Case))
	}
	return m, nil
}

// newMatchTerm normalizes one term up front so the scan compares bytes instead
// of re-normalizing the query for every record.
func newMatchTerm(t Term, caseSens bool) matchTerm {
	mt := matchTerm{neg: t.Neg}
	mt.raw = normalizeText(t.Value, false)
	mt.lower = normalizeText(t.Value, true)
	mt.wildcard = strings.ContainsAny(mt.raw, "*?")
	mt.han = containsHan(mt.raw)
	if mt.han && !mt.wildcard && mixedHan(mt.searchForm(caseSens)) {
		mt.parts = splitHanRuns(mt.searchForm(caseSens))
	}
	return mt
}

// searchForm is the term form the matcher compares against.
func (t *matchTerm) searchForm(caseSens bool) string {
	if caseSens {
		return t.raw
	}
	return t.lower
}

// mixedHan reports whether s contains both Han and non-Han runes.
func mixedHan(s string) bool {
	seenHan, seenNonHan := false, false
	for _, r := range s {
		if isHan(r) {
			seenHan = true
		} else {
			seenNonHan = true
		}
		if seenHan && seenNonHan {
			return true
		}
	}
	return false
}

func (m *matcher) matches(ix *Index, id int32) bool {
	r := &ix.recs[id]
	name := ix.nameLocked(id)
	ext := ix.extOfID(r.Ext)
	if m.exts != nil && !m.exts[ext] {
		return false
	}
	if m.notExts != nil && m.notExts[ext] {
		return false
	}
	if m.q.DirsOnly && !r.IsDir() {
		return false
	}
	if m.q.FilesOnly && r.IsDir() {
		return false
	}
	if m.q.MinSize > 0 && r.Size < m.q.MinSize {
		return false
	}
	if m.q.MaxSize > 0 && r.Size > m.q.MaxSize {
		return false
	}
	if m.q.MinMtime > 0 && (r.Mtime == 0 || r.Mtime < m.q.MinMtime) {
		return false
	}
	if m.q.MaxMtime > 0 && (r.Mtime == 0 || r.Mtime >= m.q.MaxMtime) {
		return false
	}
	if m.re != nil {
		if !m.re.MatchString(name) {
			return false
		}
	} else {
		for i := range m.terms {
			ok := m.termMatches(ix, id, name, &m.terms[i])
			if m.terms[i].neg {
				if ok {
					return false
				}
				continue
			}
			if !ok {
				return false
			}
		}
	}
	if len(m.pathTerms) > 0 {
		path := ix.pathLocked(id)
		normalized := normalizeText(path, !m.caseSens)
		for _, pt := range m.pathTerms {
			if !strings.Contains(normalized, pt) {
				return false
			}
		}
	}
	return true
}

// termMatches resolves one term against a record. Literal matching comes first;
// the pinyin fallback only runs when the literal bytes did not match.
func (m *matcher) termMatches(ix *Index, id int32, name string, t *matchTerm) bool {
	hay := name
	stored := false
	if !m.caseSens {
		if folded, ok := ix.foldedName(id); ok {
			hay, stored = folded, true
		}
	}
	if t.wildcard {
		if m.caseSens {
			return globMatch(name, t.raw, true)
		}
		return globMatch(hay, t.lower, false)
	}
	if m.wholeWord {
		if m.caseSens {
			return containsWord(name, t.raw, true)
		}
		return containsWord(hay, t.lower, false)
	}
	needle := t.searchForm(m.caseSens)
	if t.han {
		if len(t.parts) == 0 {
			// A pure Han term matches the name literally. Pinyin must not
			// translate the query itself: "国家" is not "guojia".
			return m.literalMatches(name, hay, stored, needle)
		}
		return m.mixedMatches(ix, id, name, hay, stored, t)
	}
	// Pure non-Han term: literal match first, then the name's pinyin keys.
	if m.literalMatches(name, hay, stored, needle) {
		return true
	}
	if m.caseSens {
		return false
	}
	if full, initials, ok := ix.pinyinOf(id); ok {
		return pinyinContains(full, initials, t.lower)
	}
	return false
}

// mixedMatches handles a term that mixes Han and Latin characters, such as
// "guo家" or "国家gjy". Each run must match on its own: Han runs literally,
// Latin runs literally or through the pinyin keys, so neither side breaks the
// other.
func (m *matcher) mixedMatches(ix *Index, id int32, name, hay string, stored bool, t *matchTerm) bool {
	var full, initials string
	hasPinyin := false
	for i := range t.parts {
		p := &t.parts[i]
		if m.literalMatches(name, hay, stored, p.text) {
			continue
		}
		if p.han || m.caseSens {
			return false
		}
		if !hasPinyin {
			full, initials, hasPinyin = ix.pinyinOf(id)
		}
		if !hasPinyin || !pinyinContains(full, initials, p.text) {
			return false
		}
	}
	return true
}

// literalMatches compares a normalized needle with the record name. stored
// means hay already is the NFKC + lower-case form of the name.
func (m *matcher) literalMatches(name, hay string, stored bool, needle string) bool {
	if m.caseSens {
		return strings.Contains(name, needle)
	}
	if stored {
		return strings.Contains(hay, needle)
	}
	return containsFold(name, needle)
}

// containsWord reports whether needle occurs with non-word bytes on both
// sides.
func containsWord(hay, needle string, caseSens bool) bool {
	if needle == "" {
		return true
	}
	start := 0
	for {
		i := indexOfFold(hay[start:], needle, caseSens)
		if i < 0 {
			return false
		}
		abs := start + i
		leftOK := abs == 0 || !isWordByte(hay[abs-1])
		end := abs + len(needle)
		rightOK := end == len(hay) || !isWordByte(hay[end])
		if leftOK && rightOK {
			return true
		}
		start = abs + 1
		if start >= len(hay) {
			return false
		}
	}
}

func indexOfFold(hay, needle string, caseSens bool) int {
	if caseSens {
		return strings.Index(hay, needle)
	}
	if len(needle) == 0 {
		return 0
	}
	first := needle[0]
	for i := 0; i+len(needle) <= len(hay); i++ {
		if foldByte(hay[i]) != first {
			continue
		}
		ok := true
		for j := 1; j < len(needle); j++ {
			if foldByte(hay[i+j]) != needle[j] {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}

func containsFold(hay, needle string) bool {
	return indexOfFold(hay, needle, false) >= 0
}

func foldByte(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 'a' - 'A'
	}
	return c
}

func isWordByte(c byte) bool {
	return c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// globMatch matches a name against a glob with * and ?, case-insensitively
// unless caseSens is set.
func globMatch(name, pattern string, caseSens bool) bool {
	// Iterative backtracking: linear on ordinary patterns.
	pi, ni := 0, 0
	star, mark := -1, 0
	for ni < len(name) {
		if pi < len(pattern) {
			switch pattern[pi] {
			case '*':
				star = pi
				mark = ni
				pi++
				continue
			case '?':
				pi++
				ni++
				continue
			default:
				if equalByte(name[ni], pattern[pi], caseSens) {
					pi++
					ni++
					continue
				}
			}
		}
		if star >= 0 {
			pi = star + 1
			mark++
			ni = mark
			continue
		}
		return false
	}
	for pi < len(pattern) && pattern[pi] == '*' {
		pi++
	}
	return pi == len(pattern)
}

func equalByte(a, b byte, caseSens bool) bool {
	if caseSens {
		return a == b
	}
	return foldByte(a) == foldByte(b)
}
