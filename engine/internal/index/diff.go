package index

import (
	"io/fs"
	"path/filepath"
)

// DiffStats counts what a subtree diff applied.
type DiffStats struct {
	Added   int `json:"added"`
	Removed int `json:"removed"`
}

// diffChunk bounds how many records one lock acquisition processes, so a
// periodic refresh of a large root does not stall queries for the whole diff.
const diffChunk = 8192

// DiffSubtree reconciles one root with a freshly scanned index of that root.
//
// The daemon used to RemoveSubtree(root) and then re-append every entry on each
// periodic refresh. On 9p roots that cost a long write-lock stall, one
// tombstone per entry (100k tombstones per day at a 30 minute cadence) and the
// eventual compaction they trigger. DiffSubtree instead removes only vanished
// paths and upserts the rest in place; an unchanged tree writes nothing and,
// crucially, does not move the index generation.
func (ix *Index) DiffSubtree(root string, fresh *Index) DiffStats {
	var st DiffStats
	if fresh == nil {
		return st
	}
	root = cleanPath(root)
	ix.mu.RLock()
	rootID := ix.table.get(root, ix)
	var ids []int32
	if rootID >= 0 {
		ids = ix.subtreeIDsLocked(rootID)
	}
	ix.mu.RUnlock()

	// Phase 1: drop live entries below root that the fresh scan no longer saw.
	for start := 0; start < len(ids); start += diffChunk {
		end := start + diffChunk
		if end > len(ids) {
			end = len(ids)
		}
		ix.mu.Lock()
		fresh.mu.RLock()
		for _, id := range ids[start:end] {
			if int(id) >= len(ix.recs) || ix.recs[id].Deleted() {
				continue
			}
			path := ix.pathLocked(id)
			if fresh.table.get(path, fresh) >= 0 {
				continue
			}
			if ix.table.remove(path, ix) >= 0 {
				ix.recs[id].Flags |= FlagDeleted
				ix.nDelet++
				st.Removed++
				if ix.journalActiveLocked() {
					ix.journalDeleteLocked(path)
				}
			}
		}
		fresh.mu.RUnlock()
		ix.mu.Unlock()
	}

	// Phase 2: upsert every fresh record. Record ids are parent-first (the
	// scanner flushes a directory batch before queueing its children), so a
	// missing parent is already present when its children are appended.
	fresh.mu.RLock()
	n := len(fresh.recs)
	fresh.mu.RUnlock()
	for start := 0; start < n; start += diffChunk {
		end := start + diffChunk
		if end > n {
			end = n
		}
		ix.mu.Lock()
		fresh.mu.RLock()
		for i := start; i < end; i++ {
			fr := &fresh.recs[i]
			if fr.Deleted() {
				continue
			}
			path := fresh.pathLocked(int32(i))
			_, created := ix.addOrUpdateLocked(path, FileInfo{
				Size:  fr.Size,
				Mtime: fr.Mtime,
				Mode:  modeFromFlags(fr.Flags),
			}, fr.FRN)
			if created {
				st.Added++
			}
		}
		fresh.mu.RUnlock()
		ix.mu.Unlock()
	}
	return st
}

// subtreeIDsLocked returns the live record ids at or below rootID. Membership is
// tested through the parent chain, never by materialising paths, so the call is
// cheap even for a multi-million record index. Records whose parent chain was
// never stitched (a USN snapshot can store an orphan with its absolute path as
// the name) are matched by path prefix on their top-most record.
func (ix *Index) subtreeIDsLocked(rootID int32) []int32 {
	n := len(ix.recs)
	if rootID < 0 || int(rootID) >= n {
		return nil
	}
	rootPath := ix.pathLocked(rootID)
	prefix := rootPath
	if !pathEndsWithSep(prefix) {
		prefix += string(filepath.Separator)
	}
	// 0 = unknown, 1 = below root, 2 = outside.
	memo := make([]uint8, n)
	memo[rootID] = 1
	ids := make([]int32, 0, 64)
	ids = append(ids, rootID)
	stack := make([]int32, 0, 32)
	for i := 0; i < n; i++ {
		if memo[i] != 0 {
			continue
		}
		r := &ix.recs[i]
		if r.Deleted() {
			continue
		}
		stack = stack[:0]
		cur := int32(i)
		verdict := uint8(2)
		for depth := 0; ; depth++ {
			if depth > n || int(cur) < 0 || int(cur) >= n {
				break
			}
			if memo[cur] != 0 {
				verdict = memo[cur]
				break
			}
			stack = append(stack, cur)
			parent := ix.recs[cur].Parent
			if parent < 0 {
				// Top of a chain: root records (and unstitched orphans) carry
				// their full absolute path in the name arena.
				top := ix.nameLocked(cur)
				if pathUnderOrEqual(top, rootPath, prefix) {
					verdict = 1
				}
				break
			}
			cur = parent
		}
		for _, id := range stack {
			memo[id] = verdict
			if verdict == 1 {
				ids = append(ids, id)
			}
		}
	}
	return ids
}

// pathUnderOrEqual reports whether the absolute path p is root or below it.
func pathUnderOrEqual(p, root, rootPrefix string) bool {
	if pathsEqual(p, root) {
		return true
	}
	if pathsHavePrefix(p, rootPrefix) {
		return true
	}
	// A volume root keeps a trailing separator in stored names.
	last := len(root) - 1
	return last > 0 && isPathSepByte(root[last]) && pathsHavePrefix(p, root)
}

// pathsHavePrefix is strings.HasPrefix with the platform path case rules.
func pathsHavePrefix(s, prefix string) bool {
	if len(s) < len(prefix) {
		return false
	}
	if !caseInsensitiveFS {
		return s[:len(prefix)] == prefix
	}
	for i := 0; i < len(prefix); i++ {
		if foldByte(s[i]) != foldByte(prefix[i]) {
			return false
		}
	}
	return true
}

// pathEndsWithSep reports whether p already ends with a path separator.
func pathEndsWithSep(p string) bool {
	return len(p) > 0 && isPathSepByte(p[len(p)-1])
}

// modeFromFlags rebuilds the fs.FileMode flagsFor would have produced, so a
// diff can re-add a record without knowing the original mode bits.
func modeFromFlags(f Flags) fs.FileMode {
	var m fs.FileMode = 0o644
	if f&FlagDir != 0 {
		m = fs.ModeDir | 0o755
	}
	if f&FlagSymlink != 0 {
		m = fs.ModeSymlink | 0o777
	}
	if f&FlagReadonly != 0 {
		m &^= 0o222
	}
	return m
}

// DirPage returns up to limit live directory paths after record id after, the
// way DumpPage streams entries. The watcher uses it to install watches from the
// in-memory index instead of walking the filesystem a second time at startup.
func (ix *Index) DirPage(after int32, limit int) (dirs []string, next int32, done bool) {
	if limit <= 0 {
		limit = 1000
	}
	if after < 0 {
		after = 0
	}
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	dirs = make([]string, 0, limit)
	i := int(after)
	for ; i < len(ix.recs) && len(dirs) < limit; i++ {
		r := &ix.recs[i]
		if r.Deleted() || !r.IsDir() {
			continue
		}
		dirs = append(dirs, ix.pathLocked(int32(i)))
	}
	return dirs, int32(i), i >= len(ix.recs)
}
