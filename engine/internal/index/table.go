package index

import (
	"path/filepath"
	"strings"
)

// pathTable is an open-addressing hash map from an absolute path to its record
// id. It avoids the roughly 50 bytes per entry a map[string]int32 costs, which
// matters once a whole-disk index reaches millions of entries.
type pathTable struct {
	slots []int32 // 0 empty, -1 tombstone, otherwise id+1
	count int
	tombs int
}

func newPathTable(capacity int) *pathTable {
	if capacity < 16 {
		capacity = 16
	}
	// Keep a power-of-two table at or below a 0.7 load factor.
	size := 16
	for size*7/10 < capacity {
		size <<= 1
	}
	return &pathTable{slots: make([]int32, size)}
}

func pathHash(key string) uint64 {
	// FNV-1a. Windows file names compare case-insensitively, so the hash folds
	// ASCII case there; the collision check still compares the real path.
	const (
		offset64 = 14695981039346656037
		prime64  = 1099511628211
	)
	var h uint64 = offset64
	for i := 0; i < len(key); i++ {
		c := key[i]
		if caseInsensitiveFS && c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		h ^= uint64(c)
		h *= prime64
	}
	return h
}

// get returns the record id stored under key, or -1.
func (t *pathTable) get(key string, ix *Index) int32 {
	mask := uint64(len(t.slots) - 1)
	probes := 0
	for i := pathHash(key) & mask; ; i = (i + 1) & mask {
		probes++
		if probes > len(t.slots) {
			return -1
		}
		v := t.slots[i]
		if v == 0 {
			return -1
		}
		if v > 0 {
			id := v - 1
			if pathsEqual(ix.pathLocked(int32(id)), key) {
				return int32(id)
			}
		}
	}
}

// set inserts or replaces key. It reports whether a new key was inserted.
func (t *pathTable) set(key string, id int32, ix *Index) bool {
	if (t.count+1)*10 >= len(t.slots)*7 || (t.count+t.tombs+1)*10 >= len(t.slots)*7 && t.tombs*4 >= len(t.slots) {
		t.grow(ix)
	}
	mask := uint64(len(t.slots) - 1)
	firstTombstone := -1
	for i := pathHash(key) & mask; ; i = (i + 1) & mask {
		v := t.slots[i]
		if v == 0 {
			if firstTombstone >= 0 {
				t.slots[firstTombstone] = id + 1
				t.tombs--
			} else {
				t.slots[i] = id + 1
			}
			t.count++
			return true
		}
		if v > 0 {
			if pathsEqual(ix.pathLocked(int32(v-1)), key) {
				t.slots[i] = id + 1
				return false
			}
			continue
		}
		if firstTombstone < 0 {
			firstTombstone = int(i)
		}
	}
}

// remove deletes key, leaving a tombstone so probe chains stay intact.
func (t *pathTable) remove(key string, ix *Index) int32 {
	mask := uint64(len(t.slots) - 1)
	for i := pathHash(key) & mask; ; i = (i + 1) & mask {
		v := t.slots[i]
		if v == 0 {
			return -1
		}
		if v > 0 && pathsEqual(ix.pathLocked(int32(v-1)), key) {
			t.slots[i] = -1
			t.count--
			t.tombs++
			if t.tombs*4 > len(t.slots) {
				t.rehash(ix)
			}
			return v - 1
		}
	}
}

func (t *pathTable) grow(ix *Index) {
	old := t.slots
	t.slots = make([]int32, len(old)*2)
	t.count = 0
	t.tombs = 0
	for _, v := range old {
		if v > 0 {
			id := v - 1
			t.set(ix.pathLocked(int32(id)), int32(id), ix)
		}
	}
}

// rehash rebuilds the table at the same size, dropping tombstones. Remove
// calls it when tombstones would otherwise starve probe chains of empty slots.
func (t *pathTable) rehash(ix *Index) {
	old := t.slots
	t.slots = make([]int32, len(old))
	t.count = 0
	t.tombs = 0
	for _, v := range old {
		if v > 0 {
			id := v - 1
			t.set(ix.pathLocked(int32(id)), int32(id), ix)
		}
	}
}

func (t *pathTable) reset(slots []int32, count int) {
	t.slots = slots
	t.count = count
	t.tombs = 0
}

// pathsEqual compares a stored path with a lookup key. Windows comparisons are
// case-insensitive.
func pathsEqual(a, b string) bool {
	if !caseInsensitiveFS {
		return a == b
	}
	return strings.EqualFold(a, b)
}

// cleanPath normalizes a user-supplied path for storage.
func cleanPath(p string) string {
	if p == "" {
		return p
	}
	c := filepath.Clean(p)
	// filepath.Clean turns `C:\` into `C:\` already, but a bare drive stays
	// `C:`. Keep it usable as a root.
	if len(c) == 2 && c[1] == ':' {
		c += string(filepath.Separator)
	}
	return c
}
