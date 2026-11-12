package index

import (
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Query is a parsed search request.
type Query struct {
	// Text is the original query text (or the regular expression with Regex).
	Text string
	// Terms are bare name terms; all must match.
	Terms []Term
	// PathTerms must all occur in the full path.
	PathTerms []string
	// Exts and NotExts filter by extension (lower case, no dot).
	Exts    []string
	NotExts []string
	// MinSize and MaxSize bound the file size in bytes; -1 means unset.
	MinSize int64
	MaxSize int64
	// MinMtime and MaxMtime bound the modification time (Unix nanoseconds).
	MinMtime int64
	MaxMtime int64
	// DirsOnly and FilesOnly restrict the entry kind.
	DirsOnly  bool
	FilesOnly bool
	// Regex treats Text as one regular expression.
	Regex bool
	// Case makes matching case-sensitive.
	Case bool
	// WholeWord requires word boundaries around each term.
	WholeWord bool
	// Sort is name, path, size, mtime or ext.
	Sort string
	// Desc reverses the sort order.
	Desc bool
	// Offset and Limit page the sorted matches. Limit <= 0 means 100.
	Offset int
	Limit  int
}

// Term is one bare query term.
type Term struct {
	Value    string
	Neg      bool
	Wildcard bool
}

const (
	defaultLimit = 100
	maxLimit     = 5000
)

// ParseQuery parses an Everything-flavored query string.
//
// Bare words are ANDed substrings of the file name. `!word` negates. Known
// filters are ext:, path:, size:, dm:, folder:, file:, case: and wholeword:.
// Double quotes keep spaces inside one term.
func ParseQuery(text string) (Query, error) {
	q := Query{
		Text:    strings.TrimSpace(text),
		MinSize: -1, MaxSize: -1, MinMtime: -1, MaxMtime: -1,
		Limit: defaultLimit,
	}
	for _, tok := range tokenize(q.Text) {
		if tok == "" {
			continue
		}
		neg := false
		if strings.HasPrefix(tok, "!") && len(tok) > 1 {
			neg = true
			tok = tok[1:]
		}
		key, val, hasKey := splitFilter(tok)
		if hasKey {
			switch key {
			case "ext":
				exts, not, err := parseExt(val)
				if err != nil {
					return q, err
				}
				q.Exts = append(q.Exts, exts...)
				q.NotExts = append(q.NotExts, not...)
				continue
			case "path", "in":
				if val == "" {
					return q, errors.New("path: needs a directory fragment")
				}
				if neg {
					return q, errors.New("path: cannot be negated")
				}
				q.PathTerms = append(q.PathTerms, strings.ToLower(val))
				continue
			case "size":
				lo, hi, err := parseSizeRange(val)
				if err != nil {
					return q, err
				}
				if lo >= 0 {
					q.MinSize = lo
				}
				if hi >= 0 {
					q.MaxSize = hi
				}
				continue
			case "dm", "date", "modified":
				lo, hi, err := parseDateRange(val, time.Now())
				if err != nil {
					return q, err
				}
				if lo >= 0 {
					q.MinMtime = lo
				}
				if hi >= 0 {
					q.MaxMtime = hi
				}
				continue
			case "folder", "dir":
				q.DirsOnly = truthy(val)
				continue
			case "file":
				q.FilesOnly = truthy(val)
				continue
			case "case":
				q.Case = truthy(val)
				continue
			case "wholeword", "ww":
				q.WholeWord = truthy(val)
				continue
			}
		}
		v := strings.Trim(tok, `"`)
		if v == "" {
			continue
		}
		q.Terms = append(q.Terms, Term{
			Value:    v,
			Neg:      neg,
			Wildcard: strings.ContainsAny(v, "*?"),
		})
	}
	if q.DirsOnly && q.FilesOnly {
		return q, errors.New("folder: and file: contradict each other")
	}
	return q, nil
}

// SetSort applies a sort key and optional direction.
func (q *Query) SetSort(key string, desc bool) {
	switch key {
	case "name", "path", "size", "mtime", "ext":
		q.Sort = key
		q.Desc = desc
	}
}

func tokenize(s string) []string {
	var out []string
	var b strings.Builder
	quoted := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			quoted = !quoted
			b.WriteByte(c)
		case (c == ' ' || c == '\t') && !quoted:
			if b.Len() > 0 {
				out = append(out, b.String())
				b.Reset()
			}
		default:
			b.WriteByte(c)
		}
	}
	if b.Len() > 0 {
		out = append(out, b.String())
	}
	return out
}

func splitFilter(tok string) (key, val string, ok bool) {
	i := strings.IndexByte(tok, ':')
	if i <= 0 {
		return "", "", false
	}
	k := strings.ToLower(tok[:i])
	switch k {
	case "ext", "path", "in", "size", "dm", "date", "modified", "folder", "dir", "file", "case", "wholeword", "ww":
		return k, tok[i+1:], true
	}
	return "", "", false
}

func parseExt(v string) (include, exclude []string, err error) {
	for _, part := range strings.Split(v, ",") {
		p := strings.TrimSpace(part)
		p = strings.TrimPrefix(p, ".")
		if p == "" {
			continue
		}
		if strings.HasPrefix(p, "!") {
			exclude = append(exclude, strings.ToLower(strings.TrimPrefix(p, "!")))
		} else {
			include = append(include, strings.ToLower(p))
		}
	}
	if len(include) == 0 && len(exclude) == 0 {
		return nil, nil, errors.New("ext: needs at least one extension")
	}
	return include, exclude, nil
}

func parseSizeRange(v string) (lo, hi int64, err error) {
	lo, hi = -1, -1
	v = strings.TrimSpace(strings.ToLower(v))
	switch {
	case strings.HasPrefix(v, ">="):
		n, e := parseBytes(v[2:])
		return n, -1, e
	case strings.HasPrefix(v, "<="):
		n, e := parseBytes(v[2:])
		return -1, n, e
	case strings.HasPrefix(v, ">"):
		n, e := parseBytes(v[1:])
		if e != nil {
			return -1, -1, e
		}
		return n + 1, -1, nil
	case strings.HasPrefix(v, "<"):
		n, e := parseBytes(v[1:])
		if e != nil {
			return -1, -1, e
		}
		if n == 0 {
			return -1, -1, errors.New("size:<0 matches nothing")
		}
		return -1, n - 1, nil
	case strings.HasPrefix(v, "="):
		n, e := parseBytes(v[1:])
		return n, n, e
	case strings.Contains(v, ".."):
		parts := strings.SplitN(v, "..", 2)
		a, e := parseBytes(strings.TrimSpace(parts[0]))
		if e != nil {
			return -1, -1, e
		}
		b, e := parseBytes(strings.TrimSpace(parts[1]))
		if e != nil {
			return -1, -1, e
		}
		return a, b, nil
	default:
		n, e := parseBytes(v)
		return n, n, e
	}
}

func parseBytes(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, errors.New("empty size")
	}
	mult := int64(1)
	lower := strings.ToLower(s)
	for _, u := range []struct {
		suffix string
		mult   int64
	}{
		{"tb", 1 << 40}, {"gb", 1 << 30}, {"mb", 1 << 20}, {"kb", 1 << 10},
		{"t", 1 << 40}, {"g", 1 << 30}, {"m", 1 << 20}, {"k", 1 << 10}, {"b", 1},
	} {
		if strings.HasSuffix(lower, u.suffix) {
			mult = u.mult
			lower = strings.TrimSpace(strings.TrimSuffix(lower, u.suffix))
			break
		}
	}
	n, err := strconv.ParseFloat(lower, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid size %q", s)
	}
	return int64(n * float64(mult)), nil
}

func parseDateRange(v string, now time.Time) (lo, hi int64, err error) {
	v = strings.TrimSpace(strings.ToLower(v))
	loc := now.Location()
	day := func(t time.Time) time.Time {
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
	}
	startOf := func(t time.Time) (int64, int64) {
		return day(t).UnixNano(), day(t).AddDate(0, 0, 1).UnixNano()
	}
	mk := func(a, b time.Time) (int64, int64) { return a.UnixNano(), b.UnixNano() }

	switch v {
	case "today":
		a, b := startOf(now)
		return a, b, nil
	case "yesterday":
		a, b := startOf(now.AddDate(0, 0, -1))
		return a, b, nil
	case "thisweek", "week":
		wd := (int(now.Weekday()) + 6) % 7 // Monday = 0
		a := day(now.AddDate(0, 0, -wd))
		x, y := mk(a, a.AddDate(0, 0, 7))
		return x, y, nil
	case "thismonth", "month":
		a := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, loc)
		x, y := mk(a, a.AddDate(0, 1, 0))
		return x, y, nil
	case "thisyear", "year":
		a := time.Date(now.Year(), 1, 1, 0, 0, 0, 0, loc)
		x, y := mk(a, a.AddDate(1, 0, 0))
		return x, y, nil
	}

	for _, op := range []string{">=", "<=", ">", "<"} {
		if strings.HasPrefix(v, op) {
			a, b, err := parseDateAtom(strings.TrimSpace(v[len(op):]), now)
			if err != nil {
				return -1, -1, err
			}
			switch op {
			case ">":
				return b, -1, nil
			case ">=":
				return a, -1, nil
			case "<":
				return -1, a, nil
			default:
				return -1, b, nil
			}
		}
	}
	if strings.Contains(v, "..") {
		parts := strings.SplitN(v, "..", 2)
		a, _, err := parseDateAtom(strings.TrimSpace(parts[0]), now)
		if err != nil {
			return -1, -1, err
		}
		_, b, err := parseDateAtom(strings.TrimSpace(parts[1]), now)
		if err != nil {
			return -1, -1, err
		}
		if b <= a {
			b = a + int64(24*time.Hour)
		}
		return a, b, nil
	}
	a, b, err := parseDateAtom(v, now)
	if err != nil {
		return -1, -1, err
	}
	return a, b, nil
}

func parseDateAtom(v string, now time.Time) (start, end int64, err error) {
	loc := now.Location()
	layouts := []struct {
		layout string
		span   func(time.Time) time.Time
	}{
		{"2006-01-02", func(t time.Time) time.Time { return t.AddDate(0, 0, 1) }},
		{"2006-01", func(t time.Time) time.Time { return t.AddDate(0, 1, 0) }},
		{"2006", func(t time.Time) time.Time { return t.AddDate(1, 0, 0) }},
	}
	for _, l := range layouts {
		if t, e := time.ParseInLocation(l.layout, v, loc); e == nil {
			return t.UnixNano(), l.span(t).UnixNano(), nil
		}
	}
	return -1, -1, fmt.Errorf("invalid date %q", v)
}

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return true
}

// Search runs the query against the index.
func (ix *Index) Search(q Query) (Result, error) {
	start := time.Now()
	if !q.Regex && len(q.Terms) == 0 && len(q.PathTerms) == 0 && len(q.Exts) == 0 &&
		len(q.NotExts) == 0 && q.MinSize <= 0 && q.MaxSize <= 0 &&
		q.MinMtime <= 0 && q.MaxMtime <= 0 && !q.DirsOnly && !q.FilesOnly &&
		strings.TrimSpace(q.Text) != "" {
		parsed, err := ParseQuery(q.Text)
		if err != nil {
			return Result{}, err
		}
		parsed.Sort, parsed.Desc = q.Sort, q.Desc
		parsed.Offset, parsed.Limit = q.Offset, q.Limit
		q = parsed
	}
	limit := q.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	m, err := newMatcher(&q)
	if err != nil {
		return Result{}, err
	}

	ix.mu.RLock()
	defer ix.mu.RUnlock()

	ids := ix.collectMatches(m)
	total := len(ids)
	// Sorting by path compares the parent chains directly (see comparePath), so
	// no path is materialised for hits outside the returned page. A full-map
	// prebuild used to cost a path string per match, which for a million-entry
	// index is hundreds of megabytes and a multi-second stall.
	less := func(a, b int32) bool { return ix.lessHit(a, b, q) }

	k := q.Offset + limit
	if k > total {
		k = total
	}
	if k > 0 {
		if total > k*4 {
			selectTopK(ids, k, less)
			ids = ids[:k]
		}
		sort.Slice(ids, func(i, j int) bool { return less(ids[i], ids[j]) })
	}
	var page []int32
	if q.Offset < len(ids) {
		end := q.Offset + limit
		if end > len(ids) {
			end = len(ids)
		}
		page = ids[q.Offset:end]
	}
	hits := make([]Hit, 0, len(page))
	for _, id := range page {
		r := &ix.recs[id]
		path := ix.pathLocked(id)
		hits = append(hits, Hit{
			Path:  path,
			Name:  filepath.Base(path),
			Size:  r.Size,
			Mtime: r.Mtime / int64(time.Millisecond),
			Ext:   ix.extOfID(r.Ext),
			Dir:   r.IsDir(),
		})
	}
	return Result{
		Total:     total,
		Returned:  len(hits),
		Offset:    q.Offset,
		Truncated: q.Offset+len(hits) < total,
		TookNanos: time.Since(start).Nanoseconds(),
		Hits:      hits,
	}, nil
}

// collectMatches scans every live record. Large indexes are split across
// goroutines because the scan is pure read work; the index read lock is held by
// the caller.
func (ix *Index) collectMatches(m *matcher) []int32 {
	n := len(ix.recs)
	workers := runtime.GOMAXPROCS(0)
	if workers < 2 || n < 100_000 {
		ids := make([]int32, 0, 1024)
		for i := 0; i < n; i++ {
			if ix.recs[i].Deleted() {
				continue
			}
			if m.matches(ix, int32(i)) {
				ids = append(ids, int32(i))
			}
		}
		return ids
	}
	if workers > 16 {
		workers = 16
	}
	parts := make([][]int32, workers)
	chunk := (n + workers - 1) / workers
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		start := w * chunk
		end := start + chunk
		if end > n {
			end = n
		}
		if start >= end {
			continue
		}
		wg.Add(1)
		go func(slot, lo, hi int) {
			defer wg.Done()
			local := make([]int32, 0, 256)
			for i := lo; i < hi; i++ {
				if ix.recs[i].Deleted() {
					continue
				}
				if m.matches(ix, int32(i)) {
					local = append(local, int32(i))
				}
			}
			parts[slot] = local
		}(w, start, end)
	}
	wg.Wait()
	total := 0
	for _, part := range parts {
		total += len(part)
	}
	ids := make([]int32, 0, total)
	for _, part := range parts {
		ids = append(ids, part...)
	}
	return ids
}

func (ix *Index) lessHit(a, b int32, q Query) bool {
	cmp := ix.compareHits(a, b, q)
	if cmp == 0 {
		// Record ids are append-ordered, so the tie-break keeps the order
		// deterministic and stable without sort.SliceStable's extra memory.
		return a < b
	}
	if q.Desc {
		return cmp > 0
	}
	return cmp < 0
}

func (ix *Index) compareHits(a, b int32, q Query) int {
	ra, rb := &ix.recs[a], &ix.recs[b]
	switch q.Sort {
	case "size":
		return cmpInt64(ra.Size, rb.Size)
	case "mtime":
		return cmpInt64(ra.Mtime, rb.Mtime)
	case "ext":
		if c := compareStrings(ix.extOfID(ra.Ext), ix.extOfID(rb.Ext), q.Case); c != 0 {
			return c
		}
		return 0
	case "path":
		return ix.comparePath(a, b, q.Case)
	default:
		if q.Case {
			return strings.Compare(ix.nameLocked(a), ix.nameLocked(b))
		}
		return compareFold(ix.nameLocked(a), ix.nameLocked(b))
	}
}

// pathChainDepth bounds the parent-chain stack used by comparePath. Real trees
// are shallower; a deeper entry falls back to comparing materialised paths.
const pathChainDepth = 64

// comparePath orders two records by path without allocating: it walks both
// parent chains and compares the name of each component from the root down.
// Components are compared the way path strings are, except that a name which
// prefixes another one sorts first regardless of the separator byte (the
// difference only shows for names containing characters below '/', such as
// "a!" vs "a/x"). Ancestors sort before their descendants, and the result is a
// total order, so sorting stays deterministic.
func (ix *Index) comparePath(a, b int32, caseSens bool) int {
	var ca, cb [pathChainDepth]int32
	na := ix.fillPathChain(a, ca[:])
	nb := ix.fillPathChain(b, cb[:])
	if na < 0 || nb < 0 {
		// Pathological depth (or a corrupt parent link): compare the strings.
		return compareStrings(ix.pathLocked(a), ix.pathLocked(b), caseSens)
	}
	n := na
	if nb < n {
		n = nb
	}
	for i := 0; i < n; i++ {
		if c := compareStrings(ix.nameLocked(ca[i]), ix.nameLocked(cb[i]), caseSens); c != 0 {
			return c
		}
	}
	switch {
	case na < nb:
		return -1
	case na > nb:
		return 1
	}
	return 0
}

// fillPathChain writes the root..leaf record ids of id into dst and returns the
// chain length, or -1 when the chain does not fit in dst.
func (ix *Index) fillPathChain(id int32, dst []int32) int {
	n := 0
	for cur := id; cur >= 0; cur = ix.recs[cur].Parent {
		if n >= len(dst) || n >= len(ix.recs) {
			return -1
		}
		dst[n] = cur
		n++
	}
	for i, j := 0, n-1; i < j; i, j = i+1, j-1 {
		dst[i], dst[j] = dst[j], dst[i]
	}
	return n
}

func compareStrings(a, b string, caseSens bool) int {
	if caseSens {
		return strings.Compare(a, b)
	}
	return compareFold(a, b)
}

func compareFold(a, b string) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		ca, cb := foldByte(a[i]), foldByte(b[i])
		if ca < cb {
			return -1
		}
		if ca > cb {
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	}
	return 0
}

func cmpInt64(a, b int64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// selectTopK keeps the k smallest elements of ids in ids[:k] using a bounded
// max-heap, which avoids sorting hundreds of thousands of matches for a
// 100-row page.
func selectTopK(ids []int32, k int, less func(a, b int32) bool) {
	h := ids[:k]
	for i := k/2 - 1; i >= 0; i-- {
		siftDown(h, i, less)
	}
	for _, id := range ids[k:] {
		if less(id, h[0]) {
			h[0] = id
			siftDown(h, 0, less)
		}
	}
}

func siftDown(h []int32, i int, less func(a, b int32) bool) {
	for {
		largest := i
		l, r := 2*i+1, 2*i+2
		if l < len(h) && less(h[largest], h[l]) {
			largest = l
		}
		if r < len(h) && less(h[largest], h[r]) {
			largest = r
		}
		if largest == i {
			return
		}
		h[i], h[largest] = h[largest], h[i]
		i = largest
	}
}
