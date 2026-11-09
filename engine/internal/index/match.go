package index

import (
	"regexp"
	"strings"
)

type matcher struct {
	q         *Query
	re        *regexp.Regexp
	terms     []string
	rawTerms  []string
	pathTerms []string
	exts      map[string]bool
	notExts   map[string]bool
	wholeWord bool
	caseSens  bool
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
		m.rawTerms = append(m.rawTerms, t.Value)
		if q.Case {
			m.terms = append(m.terms, t.Value)
		} else {
			m.terms = append(m.terms, strings.ToLower(t.Value))
		}
	}
	return m, nil
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
		for i, term := range m.rawTerms {
			neg := m.q.Terms[i].Neg
			ok := m.matchTerm(name, term, m.terms[i])
			if neg {
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
		lower := path
		if !m.caseSens {
			lower = strings.ToLower(path)
		}
		for _, pt := range m.pathTerms {
			if !strings.Contains(lower, pt) {
				return false
			}
		}
	}
	return true
}

func (m *matcher) matchTerm(name, raw, lower string) bool {
	if strings.ContainsAny(raw, "*?") {
		return globMatch(name, raw, m.caseSens)
	}
	if m.wholeWord {
		return containsWord(name, lower, m.caseSens)
	}
	if m.caseSens {
		return strings.Contains(name, raw)
	}
	return containsFold(name, lower)
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
