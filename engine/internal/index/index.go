package index

import (
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"
)

// Index is a set of indexed roots plus every file and directory below them.
// Records are append-only; deleting marks a tombstone and compaction rewrites
// the arenas.
type Index struct {
	mu     sync.RWMutex
	names  []byte
	recs   []Record
	exts   []string
	extIdx map[string]uint16
	roots  []int32
	table  *pathTable
	nDelet int
	built  int64
	gen    uint64
}

// New creates an empty index.
func New() *Index {
	return &Index{
		extIdx: make(map[string]uint16),
		table:  newPathTable(1024),
		built:  time.Now().UnixNano(),
	}
}

// Len returns the number of live entries.
func (ix *Index) Len() int {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return len(ix.recs) - ix.nDelet
}

// Roots returns the indexed root paths.
func (ix *Index) Roots() []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := make([]string, 0, len(ix.roots))
	for _, id := range ix.roots {
		out = append(out, ix.pathLocked(id))
	}
	return out
}

// HasRoot reports whether root is already indexed, comparing the way the
// platform compares paths.
func (ix *Index) HasRoot(root string) bool {
	root = cleanPath(root)
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	for _, id := range ix.roots {
		if pathsEqual(ix.pathLocked(id), root) {
			return true
		}
	}
	return false
}

// AddRoot indexes a root directory itself and returns its record id.
func (ix *Index) AddRoot(root string) int32 {
	root = cleanPath(root)
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if id := ix.table.get(root, ix); id >= 0 {
		for _, r := range ix.roots {
			if r == id {
				return id
			}
		}
		ix.roots = append(ix.roots, id)
		return id
	}
	id := ix.appendLocked(root, -1, FileInfo{Mode: fs.ModeDir})
	ix.roots = append(ix.roots, id)
	ix.gen++
	return id
}

// AddPath indexes one file or directory. info may be zero for directories.
// It returns the record id and whether a new record was created.
func (ix *Index) AddPath(full string, info FileInfo) (int32, bool) {
	full = cleanPath(full)
	ix.mu.Lock()
	defer ix.mu.Unlock()
	existed := ix.table.get(full, ix) >= 0
	id := ix.addLocked(full, info)
	return id, !existed
}

// appendLocked appends one record; the caller holds the write lock.
func (ix *Index) appendLocked(name string, parent int32, info FileInfo) int32 {
	off := uint32(len(ix.names))
	ix.names = append(ix.names, name...)
	rec := Record{
		NameOff: off,
		NameLen: uint32(len(name)),
		Parent:  parent,
		Size:    info.Size,
		Mtime:   info.Mtime,
		Flags:   flagsFor(info.Mode, 0),
	}
	if !info.Mode.IsDir() {
		rec.Ext = ix.extLocked(extOf(name))
	}
	id := int32(len(ix.recs))
	ix.recs = append(ix.recs, rec)
	// Insert after append: Path(id) must be resolvable during collision checks.
	ix.table.set(nameForKey(ix.pathLocked(id)), id, ix)
	return id
}

func (ix *Index) extLocked(ext string) uint16 {
	if ext == "" {
		return 0
	}
	if id, ok := ix.extIdx[ext]; ok {
		return id
	}
	id := uint16(len(ix.exts) + 1) // 0 = no extension
	ix.exts = append(ix.exts, ext)
	ix.extIdx[ext] = id
	return id
}

func (ix *Index) extOfID(id uint16) string {
	if id == 0 || int(id) > len(ix.exts) {
		return ""
	}
	return ix.exts[id-1]
}

// RemovePath deletes one entry by path. It returns whether the entry existed.
func (ix *Index) RemovePath(full string) bool {
	full = cleanPath(full)
	ix.mu.Lock()
	defer ix.mu.Unlock()
	id := ix.table.remove(full, ix)
	if id < 0 {
		return false
	}
	ix.recs[id].Flags |= FlagDeleted
	ix.nDelet++
	ix.gen++
	return true
}

// Name returns the record's own name.
func (ix *Index) Name(id int32) string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.nameLocked(id)
}

func (ix *Index) nameLocked(id int32) string {
	r := &ix.recs[id]
	return unsafeString(ix.names[r.NameOff : r.NameOff+r.NameLen])
}

// Path reconstructs the absolute path of a record.
func (ix *Index) Path(id int32) string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.pathLocked(id)
}

func (ix *Index) pathLocked(id int32) string {
	if id < 0 || int(id) >= len(ix.recs) {
		return ""
	}
	// A leaf can be at most a few hundred levels deep in practice; grow on
	// demand instead of allocating a fixed-depth assumption.
	var chain [32]int32
	n := 0
	for cur := id; cur >= 0 && n < len(chain); cur = ix.recs[cur].Parent {
		chain[n] = cur
		n++
	}
	if n == 0 {
		return ""
	}
	first := ix.nameLocked(chain[n-1])
	var b strings.Builder
	b.Grow(len(first) + 32*n)
	b.WriteString(first)
	for i := n - 2; i >= 0; i-- {
		name := ix.nameLocked(chain[i])
		if !strings.HasSuffix(b.String(), string(filepath.Separator)) {
			b.WriteByte(byte(filepath.Separator))
		}
		b.WriteString(name)
	}
	return b.String()
}

// Stats summarizes the index without touching disk.
func (ix *Index) Stats() Stats {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	s := Stats{
		Records:   len(ix.recs),
		Dirs:      0,
		Roots:     len(ix.roots),
		NameBytes: len(ix.names),
		Deleted:   ix.nDelet,
		BuiltAt:   ix.built,
		Generation: ix.gen,
	}
	for i := range ix.recs {
		if ix.recs[i].Deleted() {
			continue
		}
		if ix.recs[i].IsDir() {
			s.Dirs++
		} else {
			s.Files++
		}
	}
	s.Entries = s.Files + s.Dirs
	return s
}

// Compact rewrites the arenas, dropping tombstones and rebuilding the path
// table. It is O(entries) and is called when deletions accumulate.
func (ix *Index) Compact() {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if ix.nDelet == 0 {
		return
	}
	live := len(ix.recs) - ix.nDelet
	names := make([]byte, 0, len(ix.names))
	recs := make([]Record, 0, live)
	remap := make([]int32, len(ix.recs))
	for i := range remap {
		remap[i] = -1
	}
	for i := range ix.recs {
		old := &ix.recs[i]
		if old.Deleted() {
			continue
		}
		name := unsafeString(ix.names[old.NameOff : old.NameOff+old.NameLen])
		off := uint32(len(names))
		names = append(names, name...)
		rec := *old
		rec.NameOff = off
		if old.Parent >= 0 && int(old.Parent) < len(remap) {
			rec.Parent = remap[old.Parent]
		} else {
			rec.Parent = -1
		}
		remap[i] = int32(len(recs))
		recs = append(recs, rec)
	}
	ix.names = names
	ix.recs = recs
	ix.nDelet = 0
	ix.table = newPathTable(len(recs))
	for id := range ix.recs {
		ix.table.set(ix.pathLocked(int32(id)), int32(id), ix)
	}
	for i := range ix.roots {
		if int(ix.roots[i]) < len(remap) {
			ix.roots[i] = remap[ix.roots[i]]
		}
	}
	ix.gen++
}

func flagsFor(mode fs.FileMode, keep Flags) Flags {
	f := keep &^ (FlagDir | FlagSymlink | FlagReadonly)
	if mode.IsDir() {
		f |= FlagDir
	}
	if mode&fs.ModeSymlink != 0 {
		f |= FlagSymlink
	}
	if mode.Perm()&0o222 == 0 && !mode.IsDir() {
		f |= FlagReadonly
	}
	return f
}

func extOf(name string) string {
	i := strings.LastIndexByte(name, '.')
	if i <= 0 || i == len(name)-1 {
		return ""
	}
	ext := name[i+1:]
	if len(ext) > 16 {
		return ""
	}
	return strings.ToLower(ext)
}

// nameForKey returns the string used as the path-table key. Hashing already
// folds ASCII case on case-insensitive platforms; the key itself is the real
// path.
func nameForKey(path string) string { return path }

func unsafeString(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	return unsafe.String(unsafe.SliceData(b), len(b))
}

// Lookup returns the record id for an indexed path.
func (ix *Index) Lookup(path string) (int32, bool) {
	path = cleanPath(path)
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	id := ix.table.get(path, ix)
	return id, id >= 0
}

// IsDir reports whether an indexed path exists and is a directory.
func (ix *Index) IsDir(path string) bool {
	id, ok := ix.Lookup(path)
	if !ok {
		return false
	}
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.recs[id].IsDir()
}

// RemoveSubtree deletes a path and, for a directory, everything below it. It
// returns the number of removed entries.
func (ix *Index) RemoveSubtree(path string) int {
	path = cleanPath(path)
	ix.mu.Lock()
	defer ix.mu.Unlock()
	prefix := path + string(filepath.Separator)
	removed := 0
	for i := range ix.recs {
		if ix.recs[i].Deleted() {
			continue
		}
		p := ix.pathLocked(int32(i))
		if p == path || strings.HasPrefix(p, prefix) {
			if ix.table.remove(p, ix) >= 0 {
				ix.recs[i].Flags |= FlagDeleted
				ix.nDelet++
				removed++
			}
		}
	}
	if removed > 0 {
		ix.gen++
	}
	return removed
}

// Generation increments on every mutation; a saver compares it to decide
// whether the snapshot is stale.
func (ix *Index) Generation() uint64 {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.gen
}

// AddItem is one path and its metadata for AddBatch.
type AddItem struct {
	Path string
	Info FileInfo
}

// AddBatch indexes many entries under one lock. It is used by the parallel
// scanner; callers must add a directory before its children so parents resolve.
func (ix *Index) AddBatch(items []AddItem) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	for _, item := range items {
		ix.addLocked(item.Path, item.Info)
	}
}

func (ix *Index) addLocked(full string, info FileInfo) int32 {
	full = cleanPath(full)
	if id := ix.table.get(full, ix); id >= 0 {
		r := &ix.recs[id]
		r.Size = info.Size
		r.Mtime = info.Mtime
		r.Flags = flagsFor(info.Mode, r.Flags)
		ix.gen++
		return id
	}
	parent := int32(-1)
	if dir := filepath.Dir(full); dir != full {
		parent = ix.table.get(dir, ix)
	}
	name := filepath.Base(full)
	if parent < 0 {
		name = full
	}
	id := ix.appendLocked(name, parent, info)
	ix.gen++
	return id
}
