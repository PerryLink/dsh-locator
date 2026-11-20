package scan

import (
	"path/filepath"
	"strings"
)

// Excluder is a precompiled exclude matcher shared by the scanner, the native
// watcher and the USN applier. The old per-entry helper trimmed and re-parsed
// every glob for every directory entry (11 filepath.Match calls per entry in the
// reported profile); compiling once removes that from the hot loop.
type Excluder struct {
	literals  map[string]struct{}
	nameGlobs []simpleGlob
	nameRaw   []string
	pathGlobs []pathGlob
	cacheSkip bool
	empty     bool
}

// simpleGlob is a precompiled base-name glob that only uses * and ?.
type simpleGlob struct {
	pattern string
}

// pathGlob is a pattern containing a path separator, matched against the whole
// absolute path. recursiveBase holds the base-name rule of a "dir/**" pattern.
type pathGlob struct {
	raw           string
	recursiveBase string
}

// NewExcluder compiles patterns once. includeCaches keeps well-known toolchain
// and package-cache trees (Go module cache, Cargo, Rustup, .local/lib,
// site-packages, ...) indexed; by default they are skipped because they are
// usually the majority of a whole-disk entry count and almost never searched.
func NewExcluder(patterns []string, includeCaches bool) *Excluder {
	e := &Excluder{cacheSkip: !includeCaches}
	for _, raw := range patterns {
		p := strings.TrimSpace(raw)
		if p == "" {
			continue
		}
		if strings.ContainsAny(p, "/\\") {
			pg := pathGlob{raw: p}
			if strings.HasSuffix(p, "/**") {
				pg.recursiveBase = strings.TrimSuffix(strings.TrimSuffix(p, "/**"), "/")
			}
			e.pathGlobs = append(e.pathGlobs, pg)
			continue
		}
		if isSimpleGlob(p) {
			if !strings.ContainsAny(p, "*?") {
				if e.literals == nil {
					e.literals = make(map[string]struct{})
				}
				e.literals[p] = struct{}{}
				continue
			}
			e.nameGlobs = append(e.nameGlobs, simpleGlob{pattern: p})
			continue
		}
		e.nameRaw = append(e.nameRaw, p)
	}
	e.empty = !e.cacheSkip && e.literals == nil && len(e.nameGlobs) == 0 && len(e.nameRaw) == 0 && len(e.pathGlobs) == 0
	return e
}

// Empty reports whether the excluder can never match, so callers can skip the
// check entirely.
func (e *Excluder) Empty() bool { return e == nil || e.empty }

// Skip is the scanner rule: base-name literals/globs match the entry name,
// path globs match the whole path, and cache trees are pruned unless the user
// opted back in.
func (e *Excluder) Skip(path, name string, isDir bool) bool {
	if e == nil || e.empty {
		return false
	}
	if e.literals != nil {
		if _, ok := e.literals[name]; ok {
			return true
		}
	}
	for i := range e.nameGlobs {
		if matchSimpleGlob(name, e.nameGlobs[i].pattern, false) {
			return true
		}
	}
	for _, p := range e.nameRaw {
		if ok, _ := filepath.Match(p, name); ok {
			return true
		}
	}
	for i := range e.pathGlobs {
		pg := &e.pathGlobs[i]
		if ok, _ := filepath.Match(pg.raw, path); ok {
			return true
		}
		if isDir && pg.recursiveBase != "" {
			if matchSimpleGlob(name, pg.recursiveBase, false) {
				return true
			}
		}
	}
	if e.cacheSkip && IsCachePath(path) {
		return true
	}
	return false
}

// MatchName reports whether a single path segment matches the base-name rules
// only. It is the building block for change streams that report full paths.
func (e *Excluder) MatchName(name string) bool {
	if e == nil || e.empty {
		return false
	}
	if e.literals != nil {
		if _, ok := e.literals[name]; ok {
			return true
		}
	}
	for i := range e.nameGlobs {
		if matchSimpleGlob(name, e.nameGlobs[i].pattern, false) {
			return true
		}
	}
	for _, p := range e.nameRaw {
		if ok, _ := filepath.Match(p, name); ok {
			return true
		}
	}
	return false
}

// SkipAnySegment is the change-stream rule (Windows ReadDirectoryChangesW,
// FSEvents, USN journal): a path is excluded when any of its segments matches a
// base-name rule or when the path is inside a cache tree. Path globs are not
// evaluated here, matching the pre-0.20 behaviour of those backends.
func (e *Excluder) SkipAnySegment(path string) bool {
	if e == nil || e.empty {
		return false
	}
	if e.cacheSkip && IsCachePath(path) {
		return true
	}
	if e.literals == nil && len(e.nameGlobs) == 0 && len(e.nameRaw) == 0 {
		return false
	}
	start := 0
	for i := 0; i <= len(path); i++ {
		if i != len(path) && !isSep(path[i]) {
			continue
		}
		if i > start && e.MatchName(path[start:i]) {
			return true
		}
		start = i + 1
	}
	return false
}

// SkipPath is the scanner rule for a full path whose kind is already known.
func (e *Excluder) SkipPath(path string, isDir bool) bool {
	if e == nil || e.empty {
		return false
	}
	name := path
	if i := lastSep(path); i >= 0 {
		name = path[i+1:]
	}
	return e.Skip(path, name, isDir)
}

// isSimpleGlob reports whether a base-name pattern only uses * and ?, the
// shapes our iterative matcher handles. Character classes and escapes fall back
// to filepath.Match so behaviour is unchanged.
func isSimpleGlob(p string) bool {
	return !strings.ContainsAny(p, "[\\")
}

func isSep(c byte) bool {
	if c == '/' {
		return true
	}
	return c == '\\' && filepath.Separator == '\\'
}

func lastSep(p string) int {
	for i := len(p) - 1; i >= 0; i-- {
		if isSep(p[i]) {
			return i
		}
	}
	return -1
}

// matchSimpleGlob matches a name against a * / ? glob. It is the same iterative
// backtracking the index query planner uses, without filepath.Match error
// handling and allocation.
func matchSimpleGlob(name, pattern string, caseSens bool) bool {
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
				if equalByteFold(name[ni], pattern[pi], caseSens) {
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

func equalByteFold(a, b byte, caseSens bool) bool {
	if caseSens {
		return a == b
	}
	return foldByte(a) == foldByte(b)
}

func foldByte(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + ('a' - 'A')
	}
	return c
}

// cacheSegments are single path components that always mean a toolchain or
// package cache. .cargo uses prefix semantics because real trees are named
// .cargo, .cargo-b20, .cargo-home, and so on; exact equality missed them.
func cacheSegment(seg string) bool {
	if hasPrefixFoldASCII(seg, ".cargo") {
		return true
	}
	if equalFoldASCII(seg, ".rustup") ||
		equalFoldASCII(seg, "site-packages") ||
		equalFoldASCII(seg, "dist-packages") ||
		equalFoldASCII(seg, ".npm") ||
		equalFoldASCII(seg, ".pnpm") ||
		equalFoldASCII(seg, ".yarn") ||
		equalFoldASCII(seg, ".bun") ||
		equalFoldASCII(seg, ".nvm") ||
		equalFoldASCII(seg, ".gradle") ||
		equalFoldASCII(seg, ".m2") ||
		equalFoldASCII(seg, ".nuget") ||
		equalFoldASCII(seg, ".conda") ||
		equalFoldASCII(seg, ".pyenv") ||
		equalFoldASCII(seg, ".asdf") ||
		equalFoldASCII(seg, ".gem") ||
		equalFoldASCII(seg, ".pub-cache") ||
		equalFoldASCII(seg, ".ccache") ||
		equalFoldASCII(seg, "toolchain") {
		return true
	}
	return false
}

// IsCachePath reports whether path is inside a well-known toolchain or package
// cache that the default profile excludes: the Go module cache (go/pkg/mod),
// Cargo trees (.cargo*), Rustup, the user-local library tree (.local/lib), the
// pnpm store (.local/share/pnpm) and Python site/dist-packages. The DSH state
// directory is intentionally not cache-excluded.
func IsCachePath(path string) bool {
	prev, prev2 := "", ""
	start := 0
	for i := 0; i <= len(path); i++ {
		if i != len(path) && !isSep(path[i]) {
			continue
		}
		seg := path[start:i]
		start = i + 1
		if seg == "" {
			continue
		}
		if cacheSegment(seg) {
			return true
		}
		switch {
		case equalFoldASCII(seg, "mod") && equalFoldASCII(prev, "pkg") && equalFoldASCII(prev2, "go"):
			return true
		case equalFoldASCII(seg, "lib") && equalFoldASCII(prev, ".local"):
			return true
		case equalFoldASCII(seg, "pnpm") && equalFoldASCII(prev, "share") && equalFoldASCII(prev2, ".local"):
			return true
		case equalFoldASCII(seg, "go") && equalFoldASCII(prev, ".local"):
			return true
		}
		prev2 = prev
		prev = seg
	}
	return false
}

func equalFoldASCII(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		if foldByte(a[i]) != foldByte(b[i]) {
			return false
		}
	}
	return true
}

func hasPrefixFoldASCII(s, prefix string) bool {
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
