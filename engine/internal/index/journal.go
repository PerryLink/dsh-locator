package index

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"

	"github.com/PerryLink/dsh-locator/engine/internal/statefs"
)

// JournalName is the file the daemon keeps next to index.snapshot. It holds the
// path-level mutations made since the base snapshot was written, so an autosave
// only has to append a few kilobytes instead of rewriting the whole arena.
const JournalName = "index.journal"

// errJournalBaseMismatch marks a well-formed journal written for another base.
// It is never fatal: the base is authoritative and is left alone.
var errJournalBaseMismatch = errors.New("journal belongs to another base snapshot")

const (
	journalMagic      = "DSHLJRN1"
	journalHeaderSize = 24
	journalOpPut      = byte(1)
	journalOpDelete   = byte(2)
	journalOpAddRoot  = byte(3)

	// maxJournalEntries and maxJournalBytes bound the memory a busy index keeps
	// for incremental state. Past either bound the journal is dropped and the
	// next save writes a full base snapshot instead.
	maxJournalEntries = 100000
	maxJournalBytes   = 8 << 20
	journalFileLimit  = 64 << 20 // refuse to load an absurd/corrupt journal
)

// journalEntry is one recorded mutation. Entries are path-addressed, so a
// journal survives a compaction (which renumbers record ids) and replaying it
// onto a newer base is idempotent.
type journalEntry struct {
	seq   uint64
	op    byte
	path  string
	size  int64
	mtime int64
	frn   uint64
	flags Flags
}

// encodedSize is the number of payload bytes plus the frame header.
func (e *journalEntry) encodedSize() int {
	n := 1 + 2 + len(e.path)
	switch e.op {
	case journalOpPut:
		n += 8 + 8 + 8 + 1
	}
	return n + 8
}

// journalState is the in-memory recorder. It is guarded by Index.mu.
type journalState struct {
	enabled  bool
	overflow bool
	nextSeq  uint64
	entries  []journalEntry
	bytes    int
}

// journalLoadInfo reports what a LoadJournal call did.
type journalLoadInfo struct {
	Entries   int
	Bytes     int64
	Truncated bool
	Applied   bool
}

// SetJournalEnabled turns mutation recording on or off. The server enables it
// once a base snapshot exists and disables it while a bulk scan is running.
func (ix *Index) SetJournalEnabled(on bool) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if on {
		if ix.journal == nil {
			ix.journal = &journalState{nextSeq: 1}
		}
		ix.journal.enabled = true
		return
	}
	if ix.journal != nil {
		ix.journal.enabled = false
	}
}

// JournalEnabled reports whether mutations are currently recorded.
func (ix *Index) JournalEnabled() bool {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.journal != nil && ix.journal.enabled
}

// JournalStats reports the pending incremental state for status and for the
// store's full-rewrite decision.
func (ix *Index) JournalStats() (entries int, bytes int64, overflow bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	if ix.journal == nil {
		return 0, 0, false
	}
	return len(ix.journal.entries), int64(ix.journal.bytes), ix.journal.overflow
}

// JournalOverflowed reports whether the bounded recorder gave up and the next
// save must write a full base snapshot.
func (ix *Index) JournalOverflowed() bool {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.journal != nil && ix.journal.overflow
}

// JournalMarker returns the sequence number of the newest recorded mutation.
// A full save passes it to WriteJournalTo so entries that made it into the new
// base are not duplicated in the journal.
func (ix *Index) JournalMarker() uint64 {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	if ix.journal == nil || len(ix.journal.entries) == 0 {
		return 0
	}
	return ix.journal.entries[len(ix.journal.entries)-1].seq
}

// JournalResetAfter drops every entry at or below seq, keeping mutations that
// were recorded after the base snapshot was encoded. Used after a full save.
func (ix *Index) JournalResetAfter(seq uint64) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	j := ix.journal
	if j == nil {
		return
	}
	kept := j.entries[:0]
	bytes := 0
	for i := range j.entries {
		if j.entries[i].seq > seq {
			kept = append(kept, j.entries[i])
			bytes += j.entries[i].encodedSize()
		}
	}
	j.entries = kept
	j.bytes = bytes
	j.overflow = false
}

// JournalReset drops the whole incremental state.
func (ix *Index) JournalReset() {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if ix.journal == nil {
		return
	}
	ix.journal.entries = nil
	ix.journal.bytes = 0
	ix.journal.overflow = false
}

// journalActiveLocked reports whether a mutation should be recorded. It is the
// fast path every mutator pays: one nil/enabled check when no base snapshot is
// being journaled (for example during the initial scan).
func (ix *Index) journalActiveLocked() bool {
	j := ix.journal
	return j != nil && j.enabled && !j.overflow
}

// journalPutLocked records an upsert. The caller holds the write lock (or is
// replaying into a private index, where journal is nil or disabled).
func (ix *Index) journalPutLocked(path string, r *Record) {
	j := ix.journal
	if j == nil || !j.enabled || j.overflow {
		return
	}
	ix.journalAppendLocked(journalEntry{
		op: journalOpPut, path: path,
		size: r.Size, mtime: r.Mtime, frn: r.FRN, flags: r.Flags,
	})
}

// journalDeleteLocked records one tombstone.
func (ix *Index) journalDeleteLocked(path string) {
	j := ix.journal
	if j == nil || !j.enabled || j.overflow {
		return
	}
	ix.journalAppendLocked(journalEntry{op: journalOpDelete, path: path})
}

// journalAddRootLocked records that path became an index root.
func (ix *Index) journalAddRootLocked(path string) {
	j := ix.journal
	if j == nil || !j.enabled || j.overflow {
		return
	}
	ix.journalAppendLocked(journalEntry{op: journalOpAddRoot, path: path})
}

// journalAppendLocked appends one entry or trips the overflow flag.
func (ix *Index) journalAppendLocked(e journalEntry) {
	j := ix.journal
	size := e.encodedSize()
	if len(e.path) > 0xFFFF {
		// The frame stores the path length in 16 bits; such a path cannot be
		// journaled, so force the next save to write a full base.
		j.overflow = true
		j.entries = nil
		j.bytes = 0
		return
	}
	if len(j.entries)+1 > maxJournalEntries || j.bytes+size > maxJournalBytes {
		// Too much since the last base: drop the recorder and let the next
		// save write a full snapshot. Dropping is safe because a full base
		// carries the complete current state.
		j.overflow = true
		j.entries = nil
		j.bytes = 0
		return
	}
	e.seq = j.nextSeq
	j.nextSeq++
	j.entries = append(j.entries, e)
	j.bytes += size
}

// WriteJournalTo writes every recorded mutation after afterSeq into path
// atomically (temporary file plus rename). It returns the number of bytes and
// entries written. An empty journal removes the file: a base with no journal
// means "the base is current".
func (ix *Index) WriteJournalTo(path string, baseID, afterSeq uint64) (int, int, error) {
	ix.mu.RLock()
	if ix.journal == nil || len(ix.journal.entries) == 0 {
		ix.mu.RUnlock()
		_ = os.Remove(path)
		return 0, 0, nil
	}
	start := 0
	if afterSeq > 0 {
		for start < len(ix.journal.entries) && ix.journal.entries[start].seq <= afterSeq {
			start++
		}
	}
	src := ix.journal.entries[start:]
	// Entries are immutable once appended, so encoding can happen without the
	// index lock; only the slice header had to be read under it.
	src = append([]journalEntry(nil), src...)
	ix.mu.RUnlock()
	if len(src) == 0 {
		// Nothing is pending relative to this base: the base is current and the
		// journal file must not exist at all.
		_ = os.Remove(path)
		return 0, 0, nil
	}

	total := journalHeaderSize
	for i := range src {
		total += src[i].encodedSize()
	}
	if len(src) > maxJournalEntries || total > journalFileLimit {
		return 0, 0, errors.New("journal exceeds its size budget; a full base snapshot is required")
	}
	buf := make([]byte, journalHeaderSize, total)
	copy(buf[0:8], journalMagic)
	binary.LittleEndian.PutUint64(buf[8:], baseID)
	binary.LittleEndian.PutUint32(buf[16:], uint32(len(src)))
	var frame [8]byte
	for i := range src {
		e := &src[i]
		payload := make([]byte, e.encodedSize()-8)
		n := encodeJournalPayload(payload, e)
		binary.LittleEndian.PutUint32(frame[0:], uint32(n))
		binary.LittleEndian.PutUint32(frame[4:], crc32.ChecksumIEEE(payload[:n]))
		buf = append(buf, frame[:]...)
		buf = append(buf, payload[:n]...)
	}
	if err := statefs.MkdirAll(filepath.Dir(path)); err != nil {
		return 0, 0, err
	}
	tmp := path + ".tmp"
	if err := statefs.WriteFile(tmp, buf); err != nil {
		_ = os.Remove(tmp)
		return 0, 0, err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return 0, 0, err
	}
	return len(buf), len(src), nil
}

// encodeJournalPayload writes one entry payload and returns its length.
func encodeJournalPayload(dst []byte, e *journalEntry) int {
	dst[0] = e.op
	binary.LittleEndian.PutUint16(dst[1:], uint16(len(e.path)))
	off := 3 + copy(dst[3:], e.path)
	if e.op == journalOpPut {
		binary.LittleEndian.PutUint64(dst[off:], uint64(e.size))
		binary.LittleEndian.PutUint64(dst[off+8:], uint64(e.mtime))
		binary.LittleEndian.PutUint64(dst[off+16:], e.frn)
		dst[off+24] = byte(e.flags)
		off += 25
	}
	return off
}

// decodeJournalPayload parses one entry payload.
func decodeJournalPayload(p []byte) (journalEntry, error) {
	var e journalEntry
	if len(p) < 3 {
		return e, errors.New("short journal entry")
	}
	e.op = p[0]
	n := int(binary.LittleEndian.Uint16(p[1:]))
	if 3+n > len(p) {
		return e, errors.New("short journal entry path")
	}
	e.path = string(p[3 : 3+n])
	off := 3 + n
	switch e.op {
	case journalOpPut:
		if off+25 > len(p) {
			return e, errors.New("short journal put entry")
		}
		e.size = int64(binary.LittleEndian.Uint64(p[off:]))
		e.mtime = int64(binary.LittleEndian.Uint64(p[off+8:]))
		e.frn = binary.LittleEndian.Uint64(p[off+16:])
		e.flags = Flags(p[off+24])
	case journalOpDelete, journalOpAddRoot:
	default:
		return e, fmt.Errorf("unknown journal operation %d", e.op)
	}
	return e, nil
}

// loadJournal replays the journal for baseID into ix (which must not be
// published yet). A missing journal is os.ErrNotExist. A truncated, corrupt or
// mismatched journal never fails the load: the valid prefix is applied and the
// rest is ignored, which is what makes kill -9 during an append harmless. The
// replayed entries are kept so the next incremental save rewrites them
// together with earlier ones.
func loadJournal(path string, ix *Index, baseID uint64) (journalLoadInfo, error) {
	var info journalLoadInfo
	f, err := os.Open(path)
	if err != nil {
		return info, err
	}
	defer f.Close()
	if st, err := f.Stat(); err == nil && st.Size() > journalFileLimit {
		return info, errors.New("journal file too large")
	}
	st, err := os.Stat(path)
	if err == nil {
		info.Bytes = st.Size()
	}
	br := bufio.NewReaderSize(f, 64<<10)
	var hdr [journalHeaderSize]byte
	if _, err := io.ReadFull(br, hdr[:]); err != nil {
		return info, errors.New("truncated journal header")
	}
	if string(hdr[0:8]) != journalMagic {
		return info, errors.New("not a locator journal")
	}
	if binary.LittleEndian.Uint64(hdr[8:]) != baseID {
		// A journal from an older base: the base already has a newer state, so
		// replaying this would roll fields back. Skip it.
		return info, errJournalBaseMismatch
	}
	want := int(binary.LittleEndian.Uint32(hdr[16:]))
	var entries []journalEntry
	var frame [8]byte
	for i := 0; i < want; i++ {
		if _, err := io.ReadFull(br, frame[:]); err != nil {
			info.Truncated = true
			break
		}
		n := int(binary.LittleEndian.Uint32(frame[0:]))
		crc := binary.LittleEndian.Uint32(frame[4:])
		if n <= 0 || n > 1<<20 {
			info.Truncated = true
			break
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(br, payload); err != nil {
			info.Truncated = true
			break
		}
		if crc32.ChecksumIEEE(payload) != crc {
			info.Truncated = true
			break
		}
		e, err := decodeJournalPayload(payload)
		if err != nil {
			info.Truncated = true
			break
		}
		entries = append(entries, e)
	}
	info.Entries = len(entries)
	// Keep the bytes actually replayed, not the possibly larger file size.
	info.Bytes = journalHeaderSize
	var bytes int
	for i := range entries {
		e := &entries[i]
		e.seq = uint64(i + 1)
		entries[i] = *e
		bytes += e.encodedSize()
	}
	info.Bytes += int64(bytes)
	if len(entries) > 0 {
		ix.mu.Lock()
		for i := range entries {
			ix.applyJournalEntryLocked(&entries[i])
		}
		// A deleted root must leave the roots list just like RemoveSubtree's
		// live path does.
		kept := ix.roots[:0]
		for _, id := range ix.roots {
			if int(id) < len(ix.recs) && !ix.recs[id].Deleted() {
				kept = append(kept, id)
			}
		}
		ix.roots = kept
		ix.mu.Unlock()
		info.Applied = true
	}
	// Retain the replayed prefix as the pending journal: the next incremental
	// save must rewrite it together with new mutations, otherwise removing or
	// replacing the file would drop state that only lives in the journal.
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if ix.journal == nil {
		ix.journal = &journalState{}
	}
	ix.journal.entries = entries
	ix.journal.bytes = bytes
	ix.journal.nextSeq = uint64(len(entries) + 1)
	if len(entries) > maxJournalEntries || bytes > maxJournalBytes {
		// Everything was replayed (the state is complete), but the result is
		// past the incremental budget: force the next save to write a fresh
		// base and drop the oversized journal.
		ix.journal.overflow = true
	}
	return info, nil
}

// applyJournalEntryLocked folds one recorded mutation into the arena.
func (ix *Index) applyJournalEntryLocked(e *journalEntry) {
	switch e.op {
	case journalOpPut:
		_, _ = ix.addOrUpdateLocked(e.path, FileInfo{
			Size:  e.size,
			Mtime: e.mtime,
			Mode:  modeFromFlags(e.flags),
		}, e.frn)
	case journalOpDelete:
		if id := ix.table.remove(e.path, ix); id >= 0 {
			ix.recs[id].Flags |= FlagDeleted
			ix.nDelet++
		}
	case journalOpAddRoot:
		id := ix.table.get(e.path, ix)
		if id < 0 {
			id, _ = ix.addOrUpdateLocked(e.path, FileInfo{Mode: modeFromFlags(FlagDir)}, 0)
		}
		found := false
		for _, r := range ix.roots {
			if r == id {
				found = true
				break
			}
		}
		if !found {
			ix.roots = append(ix.roots, id)
		}
	}
}
