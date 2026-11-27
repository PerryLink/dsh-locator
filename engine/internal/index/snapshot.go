package index

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/PerryLink/dsh-locator/engine/internal/statefs"
)

const (
	snapshotMagic = "DSHLOC01"
	// snapshotVersion is the legacy v1 format. It stays readable forever: a
	// v1 snapshot has a 48-byte header and no journal. New writes use v2.
	snapshotVersion        = 1
	snapshotVersionCurrent = 2
	headerSize             = 48             // v1 header
	headerSizeV2           = 64             // v2 header
	recordSize             = 40             // FRN reuses the old padding
	snapshotFlagZstd       = 1 << 0         // v2 payload is a zstd frame
	maxSnapshotPayload     = int64(1) << 34 // sanity ceiling for a corrupt header
)

// Compression selects how a snapshot payload is stored.
type Compression uint8

// Supported snapshot payload encodings.
const (
	CompressionNone Compression = iota
	CompressionZstd
)

// ParseCompression parses the --snapshot-compression value.
func ParseCompression(s string) (Compression, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "none":
		return CompressionNone, nil
	case "zstd":
		return CompressionZstd, nil
	}
	return CompressionNone, fmt.Errorf("unsupported snapshot compression %q (want none or zstd)", s)
}

// String returns the CLI spelling of the compression.
func (c Compression) String() string {
	if c == CompressionZstd {
		return "zstd"
	}
	return "none"
}

// SnapshotInfo describes a snapshot header plus what loading it did. It is
// deliberately plain data: status reports it, the store uses Version/BaseID to
// decide between a full rewrite and a journal append.
type SnapshotInfo struct {
	Version    uint32
	Flags      uint32
	BaseID     uint64
	Built      int64
	Records    int
	NameBytes  int
	Extensions int
	Roots      int
	TableCap   int
	Deleted    int
	// PayloadBytes is the uncompressed payload length (records, names, ext
	// table, roots and path-table slots).
	PayloadBytes int64
	// FileBytes is the size of the snapshot file on disk, when known.
	FileBytes int64
	// JournalEntries and JournalBytes describe the journal replayed on load.
	JournalEntries  int
	JournalBytes    int64
	JournalReplayed bool
	// JournalIgnored is true when a journal file existed but could not be
	// trusted (wrong base or corrupt header); it is then simply skipped.
	JournalIgnored bool
	// JournalTruncated is true when the journal ended in a partial/corrupt
	// frame (for example kill -9 during a write); the valid prefix was applied.
	JournalTruncated bool
}

// FormatVersion is the on-disk base format version (1 or 2).
func (i SnapshotInfo) FormatVersion() uint32 { return i.Version }

// UsesZstd reports whether the payload is zstd-compressed.
func (i SnapshotInfo) UsesZstd() bool { return i.Flags&snapshotFlagZstd != 0 }

// SupportsJournal reports whether an incremental journal may be attached to
// this base. v1 snapshots have no base id, so the first save migrates to v2.
func (i SnapshotInfo) SupportsJournal() bool {
	return i.Version >= snapshotVersionCurrent && i.BaseID != 0
}

// Compression is the compression a snapshot was written with.
func (i SnapshotInfo) Compression() Compression {
	if i.UsesZstd() {
		return CompressionZstd
	}
	return CompressionNone
}

// SnapshotOptions controls how a base snapshot is written.
type SnapshotOptions struct {
	Compression Compression
	// BaseID identifies this base so a journal can be tied to it. Zero means
	// "generate a fresh id".
	BaseID uint64
}

// baseIDCounter guarantees two bases written in the same nanosecond differ.
var baseIDCounter atomic.Uint64

// newBaseID returns a non-zero identifier for one base snapshot write.
func newBaseID() uint64 {
	for {
		id := uint64(time.Now().UnixNano()) + baseIDCounter.Add(1)
		if id != 0 {
			return id
		}
	}
}

// Save writes the index to path atomically (temporary file plus rename). It is
// the format-default entry point; the server uses SaveBase so it can pick the
// compression and base id.
func (ix *Index) Save(path string) error {
	_, err := ix.SaveBase(path, SnapshotOptions{})
	return err
}

// SaveBase writes a full v2 base snapshot. The arena copy is taken under the
// read lock and released before the payload is compressed and written, so a
// multi-hundred-millisecond disk write never blocks watcher writes.
func (ix *Index) SaveBase(path string, opt SnapshotOptions) (SnapshotInfo, error) {
	baseID := opt.BaseID
	if baseID == 0 {
		baseID = newBaseID()
	}
	header, payload, info := ix.encodeBaseSnapshot(baseID, opt.Compression)
	if err := statefs.MkdirAll(filepath.Dir(path)); err != nil {
		return info, err
	}
	tmp := path + ".tmp"
	if err := snapshotWriteFile(tmp, header, payload, opt.Compression); err != nil {
		_ = os.Remove(tmp)
		return info, err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return info, err
	}
	if st, err := os.Stat(path); err == nil {
		info.FileBytes = st.Size()
	}
	return info, nil
}

// snapshotWriteFile is the file-write seam of SaveBase. Tests replace it to
// prove that no index lock is held while bytes go to disk.
var snapshotWriteFile = writeSnapshotFile

// writeSnapshotFile writes the header and (optionally compressed) payload.
func writeSnapshotFile(tmp string, header, payload []byte, comp Compression) error {
	f, err := statefs.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := f.Write(header); err != nil {
		f.Close()
		return err
	}
	if comp == CompressionZstd {
		zw, err := zstd.NewWriter(f, zstd.WithEncoderLevel(zstd.SpeedFastest))
		if err != nil {
			f.Close()
			return err
		}
		if _, err := zw.Write(payload); err != nil {
			zw.Close()
			f.Close()
			return err
		}
		if err := zw.Close(); err != nil {
			f.Close()
			return err
		}
	} else if _, err := f.Write(payload); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// encodeBaseSnapshot copies the arenas into one payload buffer under the read
// lock. Compression and I/O happen in SaveBase after the lock is released.
func (ix *Index) encodeBaseSnapshot(baseID uint64, comp Compression) (header, payload []byte, info SnapshotInfo) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()

	var extBytes int
	for _, e := range ix.exts {
		extBytes += 2 + len(e)
	}
	payloadBytes := len(ix.recs)*recordSize + len(ix.names) +
		extBytes + len(ix.roots)*4 + len(ix.table.slots)*4
	payload = make([]byte, payloadBytes)
	encodeRecords(payload, ix.recs)
	off := len(ix.recs) * recordSize
	off += copy(payload[off:], ix.names)
	for _, e := range ix.exts {
		binary.LittleEndian.PutUint16(payload[off:], uint16(len(e)))
		off += 2 + copy(payload[off+2:], e)
	}
	for _, id := range ix.roots {
		binary.LittleEndian.PutUint32(payload[off:], uint32(id))
		off += 4
	}
	for _, v := range ix.table.slots {
		binary.LittleEndian.PutUint32(payload[off:], uint32(v))
		off += 4
	}

	header = make([]byte, headerSizeV2)
	copy(header[0:8], snapshotMagic)
	binary.LittleEndian.PutUint32(header[8:], snapshotVersionCurrent)
	var flags uint32
	if comp == CompressionZstd {
		flags |= snapshotFlagZstd
	}
	binary.LittleEndian.PutUint32(header[12:], flags)
	binary.LittleEndian.PutUint64(header[16:], baseID)
	binary.LittleEndian.PutUint64(header[24:], uint64(len(payload)))
	binary.LittleEndian.PutUint64(header[32:], uint64(ix.built))
	binary.LittleEndian.PutUint32(header[40:], uint32(len(ix.recs)))
	binary.LittleEndian.PutUint32(header[44:], uint32(len(ix.names)))
	binary.LittleEndian.PutUint32(header[48:], uint32(len(ix.exts)))
	binary.LittleEndian.PutUint32(header[52:], uint32(len(ix.roots)))
	binary.LittleEndian.PutUint32(header[56:], uint32(len(ix.table.slots)))
	binary.LittleEndian.PutUint32(header[60:], uint32(ix.nDelet))

	info = SnapshotInfo{
		Version:      snapshotVersionCurrent,
		Flags:        flags,
		BaseID:       baseID,
		Built:        ix.built,
		Records:      len(ix.recs),
		NameBytes:    len(ix.names),
		Extensions:   len(ix.exts),
		Roots:        len(ix.roots),
		TableCap:     len(ix.table.slots),
		Deleted:      ix.nDelet,
		PayloadBytes: int64(payloadBytes),
	}
	return header, payload, info
}

// encodeRecords serialises the fixed-size record arena. The per-record field
// stores are the CPU-bound part of a full save, so they are split across
// goroutines: the snapshot is still taken under one read lock, but the lock is
// held for a fraction of the wall time (the copies write disjoint payload
// ranges, so there is no sharing).
func encodeRecords(payload []byte, recs []Record) {
	workers := runtime.GOMAXPROCS(0)
	if workers > 8 {
		workers = 8
	}
	if workers <= 1 || len(recs) < 8192 {
		encodeRecordRange(payload, recs, 0, len(recs))
		return
	}
	chunk := (len(recs) + workers - 1) / workers
	var wg sync.WaitGroup
	for start := 0; start < len(recs); start += chunk {
		end := start + chunk
		if end > len(recs) {
			end = len(recs)
		}
		wg.Add(1)
		go func(start, end int) {
			defer wg.Done()
			encodeRecordRange(payload, recs, start, end)
		}(start, end)
	}
	wg.Wait()
}

// encodeRecordRange writes records [start,end) into their payload slots.
func encodeRecordRange(payload []byte, recs []Record, start, end int) {
	for i := start; i < end; i++ {
		r := &recs[i]
		off := i * recordSize
		binary.LittleEndian.PutUint32(payload[off:], r.NameOff)
		binary.LittleEndian.PutUint32(payload[off+4:], r.NameLen)
		binary.LittleEndian.PutUint32(payload[off+8:], uint32(r.Parent))
		binary.LittleEndian.PutUint64(payload[off+12:], uint64(r.Size))
		binary.LittleEndian.PutUint64(payload[off+20:], uint64(r.Mtime))
		binary.LittleEndian.PutUint16(payload[off+28:], r.Ext)
		payload[off+30] = byte(r.Flags)
		binary.LittleEndian.PutUint64(payload[off+32:], r.FRN)
	}
}

// ReadSnapshotInfo reads only the snapshot header. It is cheap enough to call
// before every save to decide whether a journal can be appended.
func ReadSnapshotInfo(path string) (SnapshotInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return SnapshotInfo{}, err
	}
	defer f.Close()
	br := bufio.NewReaderSize(f, headerSizeV2)
	info, _, err := readSnapshotHeader(br)
	if err != nil {
		return SnapshotInfo{}, err
	}
	if st, err := f.Stat(); err == nil {
		info.FileBytes = st.Size()
	}
	return info, nil
}

// Load reads a snapshot written by Save. A v2 base is followed by its journal
// when one is present; v1 snapshots keep loading unchanged.
func Load(path string) (*Index, error) {
	ix, _, err := LoadWithInfo(path)
	return ix, err
}

// LoadWithInfo is Load plus the header/journal facts the server reports.
func LoadWithInfo(path string) (*Index, SnapshotInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, SnapshotInfo{}, err
	}
	defer f.Close()
	br := bufio.NewReaderSize(f, 256<<10)
	info, hdrSize, err := readSnapshotHeader(br)
	if err != nil {
		return nil, info, err
	}
	var fileSize int64
	if st, err := f.Stat(); err == nil {
		fileSize = st.Size()
		info.FileBytes = fileSize
	}
	if err := validateSnapshotCounts(info, hdrSize, fileSize); err != nil {
		return nil, info, err
	}

	// Journal replay is deferred until after the base payload so the derived
	// tables are built exactly once, after both sources are applied.
	ix := &Index{deferDerived: true}
	if info.Version == snapshotVersionCurrent {
		if info.UsesZstd() {
			dec, err := zstd.NewReader(br, zstd.WithDecoderConcurrency(1))
			if err != nil {
				return nil, info, fmt.Errorf("snapshot zstd: %w", err)
			}
			defer dec.Close()
			err = loadBasePayload(ix, info, bufio.NewReaderSize(dec, 256<<10))
			if err != nil {
				return nil, info, err
			}
		} else {
			if err := loadBasePayload(ix, info, br); err != nil {
				return nil, info, err
			}
		}
		jr, jerr := loadJournal(filepath.Join(filepath.Dir(path), JournalName), ix, info.BaseID)
		switch {
		case errors.Is(jerr, os.ErrNotExist):
			// No journal: the base is the full state.
		case errors.Is(jerr, errJournalBaseMismatch):
			info.JournalIgnored = true
		case jerr != nil:
			info.JournalIgnored = true
		default:
			info.JournalEntries = jr.Entries
			info.JournalBytes = jr.Bytes
			info.JournalReplayed = jr.Entries > 0
			info.JournalTruncated = jr.Truncated
		}
	} else {
		if err := loadBasePayloadV1(ix, info, br); err != nil {
			return nil, info, err
		}
	}
	ix.deferDerived = false
	ix.buildDerivedLocked()
	return ix, info, nil
}

// readSnapshotHeader parses either header version and returns the header size.
func readSnapshotHeader(r io.Reader) (SnapshotInfo, int, error) {
	var info SnapshotInfo
	buf := make([]byte, headerSizeV2)
	if _, err := io.ReadFull(r, buf[:headerSize]); err != nil {
		return info, 0, errors.New("truncated index snapshot header")
	}
	if string(buf[0:8]) != snapshotMagic {
		return info, 0, errors.New("not a locator index snapshot")
	}
	info.Version = binary.LittleEndian.Uint32(buf[8:])
	switch info.Version {
	case snapshotVersion:
		info.Built = int64(binary.LittleEndian.Uint64(buf[16:]))
		info.Records = int(binary.LittleEndian.Uint32(buf[24:]))
		info.NameBytes = int(binary.LittleEndian.Uint32(buf[28:]))
		info.Extensions = int(binary.LittleEndian.Uint32(buf[32:]))
		info.Roots = int(binary.LittleEndian.Uint32(buf[36:]))
		info.TableCap = int(binary.LittleEndian.Uint32(buf[40:]))
		info.Deleted = int(binary.LittleEndian.Uint32(buf[44:]))
		return info, headerSize, nil
	case snapshotVersionCurrent:
		if _, err := io.ReadFull(r, buf[headerSize:headerSizeV2]); err != nil {
			return info, 0, errors.New("truncated index snapshot header")
		}
		info.Flags = binary.LittleEndian.Uint32(buf[12:])
		info.BaseID = binary.LittleEndian.Uint64(buf[16:])
		info.PayloadBytes = int64(binary.LittleEndian.Uint64(buf[24:]))
		info.Built = int64(binary.LittleEndian.Uint64(buf[32:]))
		info.Records = int(binary.LittleEndian.Uint32(buf[40:]))
		info.NameBytes = int(binary.LittleEndian.Uint32(buf[44:]))
		info.Extensions = int(binary.LittleEndian.Uint32(buf[48:]))
		info.Roots = int(binary.LittleEndian.Uint32(buf[52:]))
		info.TableCap = int(binary.LittleEndian.Uint32(buf[56:]))
		info.Deleted = int(binary.LittleEndian.Uint32(buf[60:]))
		return info, headerSizeV2, nil
	default:
		return info, 0, fmt.Errorf("unsupported snapshot version %d", info.Version)
	}
}

// validateSnapshotCounts rejects corrupt headers before they can make Load
// allocate gigabytes from a few attacker-controlled integers.
func validateSnapshotCounts(info SnapshotInfo, hdrSize int, fileSize int64) error {
	if info.TableCap < 16 || info.TableCap&(info.TableCap-1) != 0 {
		return errors.New("index snapshot has an invalid path table size")
	}
	dataBytes := fileSize - int64(hdrSize)
	if dataBytes < 0 {
		return errors.New("truncated index snapshot")
	}
	minPayload := int64(info.Records)*recordSize + int64(info.NameBytes) +
		int64(info.Roots)*4 + int64(info.TableCap)*4
	if info.Version == snapshotVersionCurrent {
		if info.PayloadBytes < minPayload || info.PayloadBytes > maxSnapshotPayload {
			return errors.New("index snapshot has an invalid payload size")
		}
		if info.PayloadBytes <= maxSnapshotPayload {
			// A compressed payload cannot be smaller than a few bytes, and an
			// uncompressed one must fit the file exactly.
			if !info.UsesZstd() && info.PayloadBytes != dataBytes {
				return errors.New("index snapshot has an invalid payload size")
			}
			if info.UsesZstd() && dataBytes == 0 {
				return errors.New("truncated index snapshot")
			}
		}
		return nil
	}
	// v1 had no payload length; the record/name/root/table regions must at
	// least fit the file, and the extension table is validated while reading.
	if minPayload > dataBytes {
		return errors.New("truncated index snapshot")
	}
	return nil
}

// loadBasePayload decodes the shared v2 payload layout and verifies that the
// decoded size matches the header.
func loadBasePayload(ix *Index, info SnapshotInfo, rd io.Reader) error {
	cr := &countingReader{r: rd}
	if err := loadPayloadInto(ix, info, cr); err != nil {
		return err
	}
	if cr.n != info.PayloadBytes {
		return errors.New("index snapshot payload size mismatch")
	}
	return nil
}

// loadBasePayloadV1 decodes the legacy v1 layout (48-byte header, no payload
// length); trailing bytes are tolerated exactly like the old reader did.
func loadBasePayloadV1(ix *Index, info SnapshotInfo, rd io.Reader) error {
	return loadPayloadInto(ix, info, rd)
}

// loadPayloadInto streams the records in bounded chunks and allocates the name
// arena at its exact size. Nothing keeps the whole file buffered: a v2
// snapshot's path bytes are not pinned by a slice of a multi-hundred-megabyte
// read buffer.
func loadPayloadInto(ix *Index, info SnapshotInfo, rd io.Reader) error {
	recs := make([]Record, info.Records)
	chunkRecs := 4096
	chunk := make([]byte, recordSize*chunkRecs)
	for start := 0; start < len(recs); {
		n := chunkRecs
		if rest := len(recs) - start; rest < n {
			n = rest
		}
		if _, err := io.ReadFull(rd, chunk[:n*recordSize]); err != nil {
			return errors.New("truncated index snapshot")
		}
		base := 0
		for i := 0; i < n; i++ {
			r := &recs[start+i]
			r.NameOff = binary.LittleEndian.Uint32(chunk[base:])
			r.NameLen = binary.LittleEndian.Uint32(chunk[base+4:])
			r.Parent = int32(binary.LittleEndian.Uint32(chunk[base+8:]))
			r.Size = int64(binary.LittleEndian.Uint64(chunk[base+12:]))
			r.Mtime = int64(binary.LittleEndian.Uint64(chunk[base+20:]))
			r.Ext = binary.LittleEndian.Uint16(chunk[base+28:])
			r.Flags = Flags(chunk[base+30])
			r.FRN = binary.LittleEndian.Uint64(chunk[base+32:])
			if int(r.NameOff)+int(r.NameLen) > info.NameBytes {
				return errors.New("index snapshot name out of range")
			}
			if r.Parent >= int32(info.Records) {
				return errors.New("index snapshot parent out of range")
			}
			base += recordSize
		}
		start += n
	}
	names := make([]byte, info.NameBytes)
	if _, err := io.ReadFull(rd, names); err != nil {
		return errors.New("truncated index snapshot")
	}
	exts := make([]string, 0, info.Extensions)
	extIdx := make(map[string]uint16, info.Extensions)
	var lenBuf [2]byte
	for i := 0; i < info.Extensions; i++ {
		if _, err := io.ReadFull(rd, lenBuf[:]); err != nil {
			return errors.New("truncated extension table")
		}
		n := int(binary.LittleEndian.Uint16(lenBuf[:]))
		b := make([]byte, n)
		if _, err := io.ReadFull(rd, b); err != nil {
			return errors.New("truncated extension table")
		}
		e := string(b)
		exts = append(exts, e)
		extIdx[e] = uint16(i + 1)
	}
	roots := make([]int32, info.Roots)
	if err := readInt32s(rd, roots); err != nil {
		return errors.New("truncated index snapshot roots")
	}
	slots := make([]int32, info.TableCap)
	if err := readInt32s(rd, slots); err != nil {
		return errors.New("truncated index snapshot path table")
	}
	count := 0
	for _, v := range slots {
		if v > 0 {
			count++
		}
	}
	table := newPathTable(16)
	table.reset(slots, count)
	ix.names = names
	ix.recs = recs
	ix.exts = exts
	ix.extIdx = extIdx
	ix.roots = roots
	ix.table = table
	ix.nDelet = info.Deleted
	ix.built = info.Built
	return nil
}

// readInt32s fills dst from rd in bounded chunks.
func readInt32s(rd io.Reader, dst []int32) error {
	const chunkInts = 8192
	buf := make([]byte, chunkInts*4)
	for start := 0; start < len(dst); {
		n := chunkInts
		if rest := len(dst) - start; rest < n {
			n = rest
		}
		if _, err := io.ReadFull(rd, buf[:n*4]); err != nil {
			return err
		}
		for i := 0; i < n; i++ {
			dst[start+i] = int32(binary.LittleEndian.Uint32(buf[i*4:]))
		}
		start += n
	}
	return nil
}

// countingReader tracks how many payload bytes were consumed.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}
