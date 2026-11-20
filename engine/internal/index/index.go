package index

import (
	"io/fs"
	"path/filepath"
	"runtime"
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

	// py indexes the pinyin forms of names containing Han characters. It is
	// derived state: the on-disk snapshot format is unchanged and the table is
	// rebuilt from records on Load and after Compact.
	py pinyinTable
	// folded holds the NFKC + lower-case form of names that do not match their
	// raw bytes (full-width forms, compatibility ideographs, non-ASCII case).
	folded   map[int32]string
	foldBits []uint64 // one bit per record id: folded[id] exists

	// deferDerived suppresses per-record derived-table maintenance while a
	// snapshot or journal is being replayed; buildDerivedLocked then runs once
	// for the whole arena.
	deferDerived bool

	// journal records mutations since the last full base snapshot (nil when
	// off/unsupported). Guarded by mu like every other arena field.
	journal *journalState

	// statsMu guards Stats' memoised result. Stats takes mu.RLock internally,
	// so it must never be called while the caller holds mu.
	statsMu    sync.Mutex
	statsCache Stats
	statsGen   uint64
	statsValid bool
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
		// The roots list is part of the snapshot even when the record itself
		// was already present.
		ix.gen++
		if ix.journalActiveLocked() {
			ix.journalAddRootLocked(root)
		}
		return id
	}
	id := ix.appendLocked(root, -1, FileInfo{Mode: fs.ModeDir}, 0)
	ix.roots = append(ix.roots, id)
	ix.gen++
	if ix.journalActiveLocked() {
		ix.journalAddRootLocked(root)
	}
	return id
}

// AddPath indexes one file or directory. info may be zero for directories.
// It returns the record id and whether a new record was created.
func (ix *Index) AddPath(full string, info FileInfo) (int32, bool) {
	return ix.AddPathFRN(full, info, 0)
}

// AddPathFRN is AddPath with an NTFS file reference number. A non-zero FRN
// lets a later USN journal batch resolve this path after a restart.
func (ix *Index) AddPathFRN(full string, info FileInfo, frn uint64) (int32, bool) {
	full = cleanPath(full)
	ix.mu.Lock()
	defer ix.mu.Unlock()
	existed := ix.table.get(full, ix) >= 0
	id := ix.addLockedFRN(full, info, frn)
	return id, !existed
}

// appendLocked appends one record; the caller holds the write lock.
func (ix *Index) appendLocked(name string, parent int32, info FileInfo, frn uint64) int32 {
	off := uint32(len(ix.names))
	ix.names = append(ix.names, name...)
	rec := Record{
		NameOff: off,
		NameLen: uint32(len(name)),
		Parent:  parent,
		Size:    info.Size,
		Mtime:   info.Mtime,
		Flags:   flagsFor(info.Mode, 0),
		FRN:     frn,
	}
	if !info.Mode.IsDir() {
		rec.Ext = ix.extLocked(extOf(name))
	}
	id := int32(len(ix.recs))
	ix.recs = append(ix.recs, rec)
	// Insert after append: Path(id) must be resolvable during collision checks.
	ix.table.set(nameForKey(ix.pathLocked(id)), id, ix)
	ix.addDerivedLocked(id, name)
	if ix.journalActiveLocked() {
		ix.journalPutLocked(ix.pathLocked(id), &ix.recs[id])
	}
	return id
}

// addDerivedLocked indexes the search-only forms of one newly appended record.
// The caller holds the write lock (or is Load building the index before it is
// published). The function is intentionally cheap for ASCII names: pinyin work
// only happens when the name contains a Han character.
func (ix *Index) addDerivedLocked(id int32, name string) {
	if ix.deferDerived {
		return
	}
	ix.py.grow(len(ix.recs))
	// Root records store their absolute path in the name arena (pathLocked
	// reconstructs the path from it); index the search forms of the record's own
	// name, never of the ancestor directories that are only part of the path.
	name = ix.searchNameLocked(id, name)
	if full, initials, ok := pinyinKeys(name); ok {
		ix.py.set(id, full, initials)
	}
	if folded, ok := foldedName(name); ok {
		if ix.folded == nil {
			ix.folded = make(map[int32]string)
		}
		bit := int(id) >> 6
		if bit >= len(ix.foldBits) {
			ix.foldBits = append(ix.foldBits, make([]uint64, bit+1-len(ix.foldBits))...)
		}
		ix.foldBits[bit] |= 1 << uint(id&63)
		ix.folded[id] = folded
	}
}

// buildDerivedLocked rebuilds every search-only structure from the record
// arena. It is used after Load and after Compact renumbered the records.
//
// The whole-disk case is overwhelmingly ASCII names, so this walks every name
// exactly once for the non-ASCII test and skips pinyin/NFKC for the rest. The
// pinyin offset and bitmap tables are preallocated instead of grown per record
// (the old addDerivedLocked path called py.grow for every entry as a no-op).
func (ix *Index) buildDerivedLocked() {
	ix.py.reset()
	ix.folded = nil
	ix.foldBits = nil
	n := len(ix.recs)
	ix.py.offs = make([]uint32, n)
	// Allocate the presence bitmap up front: go-pinyin work is rare, but a
	// lazily grown bitmap made the build append one word per record range.
	ix.py.has = make([]uint64, (n+63)>>6)
	for i := 0; i < n; i++ {
		r := &ix.recs[i]
		if r.Deleted() {
			continue
		}
		name := unsafeString(ix.names[r.NameOff : r.NameOff+r.NameLen])
		if r.Parent < 0 {
			// Root records store their absolute path in the arena; only the
			// last component is searchable (see searchNameLocked).
			name = filepath.Base(name)
		}
		if !hasNonASCII(name) {
			continue
		}
		if containsHan(name) {
			if full, initials, ok := pinyinKeys(name); ok {
				ix.py.set(int32(i), full, initials)
			}
		}
		if folded, ok := foldedName(name); ok {
			if ix.folded == nil {
				ix.folded = make(map[int32]string)
			}
			bit := int(i) >> 6
			if bit >= len(ix.foldBits) {
				ix.foldBits = append(ix.foldBits, make([]uint64, bit+1-len(ix.foldBits))...)
			}
			ix.foldBits[bit] |= 1 << uint(i&63)
			ix.folded[int32(i)] = folded
		}
	}
}

// foldedName returns the precomputed normalized name for a record. The caller
// holds the index read lock.
func (ix *Index) foldedName(id int32) (string, bool) {
	if int(id) < 0 {
		return "", false
	}
	bit := int(id) >> 6
	if bit >= len(ix.foldBits) || ix.foldBits[bit]&(1<<uint(id&63)) == 0 {
		return "", false
	}
	name, ok := ix.folded[id]
	return name, ok
}

// pinyinOf returns the record's pinyin keys. The caller holds the index read
// lock.
func (ix *Index) pinyinOf(id int32) (full, initials string, ok bool) {
	if !ix.py.hasKey(id) {
		return "", "", false
	}
	return ix.py.get(id)
}

// HasPinyin reports whether the index holds any transliterated name. It lets
// callers skip the pinyin fallback entirely on an ASCII-only index.
func (ix *Index) HasPinyin() bool {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return !ix.py.empty()
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
	if ix.journalActiveLocked() {
		ix.journalDeleteLocked(full)
	}
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

// searchNameLocked returns the name search terms are matched against. A record
// without a parent stores its whole absolute path in the name arena, because
// pathLocked assembles the absolute path from it and AddRoot has no parent to
// attach to. Its own name is still the last path component, exactly like the
// Hit.Name the server returns. Matching the raw stored bytes would turn every
// ancestor directory into part of the searchable name: on macOS the temporary
// directory lives under "/var/folders", so the bare term "old" matched every
// index root (old=2 where the deleted file should have left 0 hits).
func (ix *Index) searchNameLocked(id int32, name string) string {
	if ix.recs[id].Parent < 0 {
		return filepath.Base(name)
	}
	return name
}

// matchNameLocked is searchNameLocked for the record's stored name.
func (ix *Index) matchNameLocked(id int32) string {
	return ix.searchNameLocked(id, ix.nameLocked(id))
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
//
// The file/dir split is an O(records) walk (7.4ms on a 1.5M-entry index), and
// status polls it every second. The result is memoised by generation: every
// mutation advances gen, so a cache hit is always exact. Stats must not be
// called while holding ix.mu (it takes the read lock itself).
func (ix *Index) Stats() Stats {
	ix.statsMu.Lock()
	defer ix.statsMu.Unlock()
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	if ix.statsValid && ix.statsGen == ix.gen {
		return ix.statsCache
	}
	s := Stats{
		Records:    len(ix.recs),
		Dirs:       0,
		Roots:      len(ix.roots),
		NameBytes:  len(ix.names),
		Deleted:    ix.nDelet,
		BuiltAt:    ix.built,
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
	ix.statsCache = s
	ix.statsGen = ix.gen
	ix.statsValid = true
	return s
}

// Compact rewrites the arenas, dropping tombstones and rebuilding the path
// table. It is called when deletions accumulate.
//
// The rebuild is copy-on-write: the arenas are copied under the read lock, the
// compacted records, name arena, path table and derived tables are computed
// without any lock, and the swap happens under the write lock only if the
// generation did not move. A concurrent mutation aborts the attempt and leaves
// the index untouched; the caller retries later. This keeps the write-lock
// stall at microseconds instead of the ~1.3s the old in-place rebuild held it.
func (ix *Index) Compact() {
	for attempt := 0; attempt < 4; attempt++ {
		if ix.tryCompactOnce() {
			return
		}
		runtime.Gosched()
	}
	// Heavy write traffic kept invalidating the snapshot; fall back to the
	// in-place rebuild so compaction is still guaranteed to make progress.
	ix.compactLocked()
}

// tryCompactOnce performs one copy-on-write compaction attempt and reports
// whether it committed. The caller holds no lock.
func (ix *Index) tryCompactOnce() bool {
	ix.mu.RLock()
	if ix.nDelet == 0 {
		ix.mu.RUnlock()
		return true
	}
	gen := ix.gen
	// Copy the records: their fields are mutated in place by metadata updates,
	// so handing the live arena to the lock-free phase would race. The name
	// arena is append-only and its existing bytes never change, so a slice
	// header is enough. Slots and roots are small and are copied for the same
	// reason as records.
	oldRecs := append([]Record(nil), ix.recs...)
	names := ix.names
	oldSlots := append([]int32(nil), ix.table.slots...)
	roots := append([]int32(nil), ix.roots...)
	nDelet := ix.nDelet
	ix.mu.RUnlock()

	live := len(oldRecs) - nDelet
	if live < 0 {
		return false
	}
	deadNames := 0
	hasOrphans := false
	for i := range oldRecs {
		r := &oldRecs[i]
		if r.Deleted() {
			deadNames += int(r.NameLen)
			continue
		}
		if r.Parent >= 0 && int(r.Parent) < len(oldRecs) && oldRecs[r.Parent].Deleted() {
			hasOrphans = true
		}
	}
	// Rewrite the name arena once 20% of it is dead. It is also required when a
	// deleted parent leaves live children: their absolute path must become the
	// stored name because parentless records store the whole path.
	rebuildNames := hasOrphans || deadNames*5 > len(names)
	var newNames []byte
	if rebuildNames {
		newNames = make([]byte, 0, len(names)-deadNames+64)
	}
	newRecs := make([]Record, 0, live)
	remap := make([]int32, len(oldRecs))
	for i := range remap {
		remap[i] = -1
	}
	for i := range oldRecs {
		old := &oldRecs[i]
		if old.Deleted() {
			continue
		}
		name := unsafeString(names[old.NameOff : old.NameOff+old.NameLen])
		rec := *old
		if old.Parent >= 0 && int(old.Parent) < len(remap) {
			if p := remap[old.Parent]; p >= 0 {
				rec.Parent = p
			} else {
				rec.Parent = -1
				name = pathInArena(oldRecs, names, int32(i))
			}
		} else {
			rec.Parent = -1
		}
		if rebuildNames {
			rec.NameOff = uint32(len(newNames))
			newNames = append(newNames, name...)
			rec.NameLen = uint32(len(name))
		}
		remap[i] = int32(len(newRecs))
		newRecs = append(newRecs, rec)
	}

	// Remap the open-addressing table in place instead of rehashing every path:
	// the slot position of a key is unchanged (paths did not change), only the
	// record id stored in the slot moves. pathMatchesLocked validates the path
	// on lookup, so no hash needs to be recomputed.
	newSlots := oldSlots
	count, tombs := 0, 0
	for i, v := range newSlots {
		switch {
		case v == 0:
		case v < 0:
			tombs++
		default:
			id := remap[v-1]
			if id < 0 {
				newSlots[i] = -1
				tombs++
				continue
			}
			newSlots[i] = id + 1
			count++
		}
	}
	if count != len(newRecs) {
		// The table and the records disagree (corrupt snapshot); let the
		// in-place fallback rebuild the table from paths.
		return false
	}
	newRoots := make([]int32, 0, len(roots))
	for _, id := range roots {
		if int(id) >= 0 && int(id) < len(remap) && remap[id] >= 0 {
			newRoots = append(newRoots, remap[id])
		}
	}
	arenaNames := names
	if rebuildNames {
		arenaNames = newNames
	}
	// Record ids changed, so the id-addressed pinyin and folded-name tables
	// must be rebuilt. Do that on a scratch Index: it is pure CPU on local
	// data, so it does not need the lock either.
	tmp := &Index{names: arenaNames, recs: newRecs}
	tmp.buildDerivedLocked()

	// Test seam: lets a test mutate the index between the copy and the commit.
	if compactPhaseHook != nil {
		compactPhaseHook()
	}
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if ix.gen != gen {
		return false
	}
	ix.recs = newRecs
	ix.names = arenaNames
	ix.roots = newRoots
	ix.table.reset(newSlots, count)
	ix.table.tombs = tombs
	ix.nDelet = 0
	ix.py = tmp.py
	ix.folded = tmp.folded
	ix.foldBits = tmp.foldBits
	ix.gen++
	return true
}

// compactPhaseHook is a test-only seam invoked between the lock-free compaction
// build and its commit. Production builds leave it nil.
var compactPhaseHook func()

// compactLocked is the pre-existing in-place rebuild, kept as the fallback for
// a compaction that keeps losing the generation race.
func (ix *Index) compactLocked() {
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
		rec := *old
		if old.Parent >= 0 && int(old.Parent) < len(remap) {
			if p := remap[old.Parent]; p >= 0 {
				rec.Parent = p
			} else {
				rec.Parent = -1
				name = ix.pathLocked(int32(i))
			}
		} else {
			rec.Parent = -1
		}
		rec.NameOff = uint32(len(names))
		names = append(names, name...)
		rec.NameLen = uint32(len(name))
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
	keptRoots := ix.roots[:0]
	for _, id := range ix.roots {
		if int(id) < len(remap) && remap[id] >= 0 {
			keptRoots = append(keptRoots, remap[id])
		}
	}
	ix.roots = keptRoots
	ix.buildDerivedLocked()
	ix.gen++
}

// pathInArena reconstructs an absolute path from a copied record/name arena.
func pathInArena(recs []Record, names []byte, id int32) string {
	if id < 0 || int(id) >= len(recs) {
		return ""
	}
	var chain [32]int32
	n := 0
	for cur := id; cur >= 0 && n < len(chain); cur = recs[cur].Parent {
		chain[n] = cur
		n++
	}
	if n == 0 {
		return ""
	}
	nameAt := func(id int32) string {
		r := &recs[id]
		return unsafeString(names[r.NameOff : r.NameOff+r.NameLen])
	}
	first := nameAt(chain[n-1])
	var b strings.Builder
	b.Grow(len(first) + 32*n)
	b.WriteString(first)
	for i := n - 2; i >= 0; i-- {
		if !strings.HasSuffix(b.String(), string(filepath.Separator)) {
			b.WriteByte(byte(filepath.Separator))
		}
		b.WriteString(nameAt(chain[i]))
	}
	return b.String()
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
				if ix.journalActiveLocked() {
					ix.journalDeleteLocked(p)
				}
			}
		}
	}
	if removed > 0 {
		// Dropping a root's record must also drop it from the roots list; a
		// later scan re-adds it with a fresh id. Without this the list would
		// keep pointing at the tombstone and Roots() would report duplicates.
		kept := ix.roots[:0]
		for _, id := range ix.roots {
			if int(id) < len(ix.recs) && !ix.recs[id].Deleted() {
				kept = append(kept, id)
			}
		}
		ix.roots = kept
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
	// FRN is the NTFS file reference number for USN scans; zero otherwise.
	FRN uint64
}

// AddBatch indexes many entries under one lock. It is used by the parallel
// scanner; callers must add a directory before its children so parents resolve.
func (ix *Index) AddBatch(items []AddItem) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	for _, item := range items {
		ix.addLockedFRN(item.Path, item.Info, item.FRN)
	}
}

func (ix *Index) addLocked(full string, info FileInfo) int32 {
	return ix.addLockedFRN(full, info, 0)
}

// addLockedFRN indexes one path. An existing record is updated in place, but
// the generation only advances when a persisted field actually changed: the
// watcher sees a lot of repeat notifications (create followed by close-write,
// attribute churn), and bumping the generation for every event made the daemon
// rewrite a multi-hundred-megabyte snapshot on a timer even when nothing had
// changed.
func (ix *Index) addLockedFRN(full string, info FileInfo, frn uint64) int32 {
	id, _ := ix.addOrUpdateLocked(full, info, frn)
	return id
}

// addOrUpdateLocked is addLockedFRN with a "new record" flag, used by the
// subtree diff to count created entries. The caller holds the write lock through
// addLockedFRN/AddBatch; DiffSubtree calls it directly while holding the lock.
func (ix *Index) addOrUpdateLocked(full string, info FileInfo, frn uint64) (int32, bool) {
	full = cleanPath(full)
	if id := ix.table.get(full, ix); id >= 0 {
		return ix.updateLocked(id, info, frn), false
	}
	parent := int32(-1)
	if dir := filepath.Dir(full); dir != full {
		parent = ix.table.get(dir, ix)
	}
	name := filepath.Base(full)
	if parent < 0 {
		name = full
	}
	id := ix.appendLocked(name, parent, info, frn)
	ix.gen++
	return id, true
}

// updateLocked refreshes the persisted fields of an existing record and reports
// whether anything actually changed (which is what moves the generation).
func (ix *Index) updateLocked(id int32, info FileInfo, frn uint64) int32 {
	changed := ix.updateFieldsLocked(id, info, frn)
	if changed {
		ix.gen++
		if ix.journalActiveLocked() {
			ix.journalPutLocked(ix.pathLocked(id), &ix.recs[id])
		}
	}
	return id
}

// updateFieldsLocked updates the fields of one record without touching the
// generation; callers decide what the change means.
func (ix *Index) updateFieldsLocked(id int32, info FileInfo, frn uint64) bool {
	r := &ix.recs[id]
	changed := false
	if r.Size != info.Size {
		r.Size = info.Size
		changed = true
	}
	if r.Mtime != info.Mtime {
		r.Mtime = info.Mtime
		changed = true
	}
	if flags := flagsFor(info.Mode, r.Flags); flags != r.Flags {
		r.Flags = flags
		changed = true
	}
	if frn != 0 && r.FRN != frn {
		r.FRN = frn
		changed = true
	}
	return changed
}

// addChildLocked indexes one direct child of an already-indexed directory. It
// skips the parent lookup the scanner already paid for (the batch knows its
// directory record), which removes one path hash per scanned entry.
func (ix *Index) addChildLocked(full string, parent int32, info FileInfo, frn uint64) (int32, bool) {
	full = cleanPath(full)
	if id := ix.table.get(full, ix); id >= 0 {
		return ix.updateLocked(id, info, frn), false
	}
	if int(parent) < 0 || int(parent) >= len(ix.recs) || ix.recs[parent].Deleted() || !ix.recs[parent].IsDir() {
		return ix.addOrUpdateLocked(full, info, frn)
	}
	name := full
	if sep := lastPathSep(full); sep >= 0 {
		name = full[sep+1:]
	} else {
		parent = -1
	}
	id := ix.appendLocked(name, parent, info, frn)
	ix.gen++
	return id, true
}

// AddBatchAt indexes many direct children of one directory under one lock. It is
// the scanner's hot path: the caller already resolved the directory record, so
// no per-item parent lookup or filepath.Dir allocation is needed.
func (ix *Index) AddBatchAt(parent int32, items []AddItem) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	for _, item := range items {
		ix.addChildLocked(item.Path, parent, item.Info, item.FRN)
	}
}

// pathMatchesLocked reports whether a record's absolute path equals key without
// materialising the path string. The path table probes it once or more per
// lookup; ix.pathLocked there accounted for 28.9% of a cold scan.
func (ix *Index) pathMatchesLocked(id int32, key string) bool {
	if id < 0 || int(id) >= len(ix.recs) {
		return false
	}
	cur := id
	for depth := 0; depth <= len(ix.recs); depth++ {
		if int(cur) < 0 || int(cur) >= len(ix.recs) {
			return false
		}
		r := &ix.recs[cur]
		name := unsafeString(ix.names[r.NameOff : r.NameOff+r.NameLen])
		if r.Parent < 0 {
			// Root (or orphan) records store their whole absolute path in the
			// name arena. A volume root keeps a trailing separator in that
			// string, while pathLocked does not repeat it.
			if pathsEqual(name, key) {
				return true
			}
			// A volume root (or "/" itself) keeps a trailing separator in the
			// stored name, while pathLocked does not repeat it for children.
			last := len(name) - 1
			return last >= 0 && isPathSepByte(name[last]) && pathsEqual(name[:last], key)
		}
		if len(key) <= len(name) {
			return false
		}
		off := len(key) - len(name)
		if !pathsEqual(name, key[off:]) || !isPathSepByte(key[off-1]) {
			return false
		}
		key = key[:off-1]
		cur = r.Parent
	}
	return false
}

// lastPathSep returns the byte offset of the last platform path separator in p,
// or -1. It mirrors filepath separator handling without allocating.
func lastPathSep(p string) int {
	for i := len(p) - 1; i >= 0; i-- {
		if isPathSepByte(p[i]) {
			return i
		}
	}
	return -1
}

// FRNPaths snapshots the FRN -> current path map for live records. It is used
// to resolve journal records after a restart.
func (ix *Index) FRNPaths() map[uint64]string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	paths := make(map[uint64]string, len(ix.recs))
	for i := range ix.recs {
		if ix.recs[i].FRN == 0 || ix.recs[i].Deleted() {
			continue
		}
		paths[ix.recs[i].FRN] = ix.pathLocked(int32(i))
	}
	return paths
}

// DumpEntry is one row of a paginated export.
type DumpEntry struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
	Ext   string `json:"ext"`
	Dir   bool   `json:"dir"`
}

// DumpPage returns up to limit live entries after the given record id. The
// cursor is a record id, so callers can stream the whole index without holding
// the lock between pages.
func (ix *Index) DumpPage(after int32, limit int) (entries []DumpEntry, next int32, done bool) {
	return ix.DumpPageFrom(after, limit, 0)
}

// DumpPageFrom is DumpPage with an optional modification-time floor in Unix
// milliseconds (the unit DumpEntry.Mtime uses). It lets a content index refresh
// skip bodies that cannot have changed instead of materialising and shipping
// every path again. mtimeFrom <= 0 exports everything.
func (ix *Index) DumpPageFrom(after int32, limit int, mtimeFrom int64) (entries []DumpEntry, next int32, done bool) {
	if limit <= 0 {
		limit = 1000
	}
	if after < 0 {
		after = 0
	}
	mtimeFloor := mtimeFrom * int64(time.Millisecond)
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	entries = make([]DumpEntry, 0, limit)
	i := int(after)
	for ; i < len(ix.recs) && len(entries) < limit; i++ {
		r := &ix.recs[i]
		if r.Deleted() {
			continue
		}
		if mtimeFrom > 0 && r.Mtime < mtimeFloor {
			continue
		}
		path := ix.pathLocked(int32(i))
		entries = append(entries, DumpEntry{
			Path:  path,
			Name:  filepath.Base(path),
			Size:  r.Size,
			Mtime: r.Mtime / int64(1e6),
			Ext:   ix.extOfID(r.Ext),
			Dir:   r.IsDir(),
		})
	}
	return entries, int32(i), i >= len(ix.recs)
}

// SnapshotState is the subset of index state that a saver must observe to
// decide whether the on-disk snapshot is stale.
type SnapshotState struct {
	Generation uint64
	Entries    int
	NameBytes  int
	BuiltAt    int64
}

// SnapshotState reports the state a snapshot write would persist. It takes only
// the read lock, so a caller can poll it cheaply.
func (ix *Index) SnapshotState() SnapshotState {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return SnapshotState{
		Generation: ix.gen,
		Entries:    len(ix.recs) - ix.nDelet,
		NameBytes:  len(ix.names),
		BuiltAt:    ix.built,
	}
}
