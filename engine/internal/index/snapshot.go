package index

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	snapshotMagic   = "DSHLOC01"
	snapshotVersion = 1
	headerSize      = 48
	recordSize      = 40 // FRN reuses the old padding; v1 snapshots load with FRN 0
)

// Save writes the index to path atomically (temporary file plus rename).
func (ix *Index) Save(path string) error {
	ix.mu.RLock()
	defer ix.mu.RUnlock()

	var extBytes int
	for _, e := range ix.exts {
		extBytes += 2 + len(e)
	}
	total := headerSize + len(ix.recs)*recordSize + len(ix.names) +
		extBytes + len(ix.roots)*4 + len(ix.table.slots)*4
	buf := make([]byte, total)

	copy(buf[0:8], snapshotMagic)
	binary.LittleEndian.PutUint32(buf[8:], snapshotVersion)
	binary.LittleEndian.PutUint32(buf[12:], 0)
	binary.LittleEndian.PutUint64(buf[16:], uint64(ix.built))
	binary.LittleEndian.PutUint32(buf[24:], uint32(len(ix.recs)))
	binary.LittleEndian.PutUint32(buf[28:], uint32(len(ix.names)))
	binary.LittleEndian.PutUint32(buf[32:], uint32(len(ix.exts)))
	binary.LittleEndian.PutUint32(buf[36:], uint32(len(ix.roots)))
	binary.LittleEndian.PutUint32(buf[40:], uint32(len(ix.table.slots)))
	binary.LittleEndian.PutUint32(buf[44:], uint32(ix.nDelet))

	off := headerSize
	for i := range ix.recs {
		r := &ix.recs[i]
		binary.LittleEndian.PutUint32(buf[off:], r.NameOff)
		binary.LittleEndian.PutUint32(buf[off+4:], r.NameLen)
		binary.LittleEndian.PutUint32(buf[off+8:], uint32(r.Parent))
		binary.LittleEndian.PutUint64(buf[off+12:], uint64(r.Size))
		binary.LittleEndian.PutUint64(buf[off+20:], uint64(r.Mtime))
		binary.LittleEndian.PutUint16(buf[off+28:], r.Ext)
		buf[off+30] = byte(r.Flags)
		binary.LittleEndian.PutUint64(buf[off+32:], r.FRN)
		off += recordSize
	}
	copy(buf[off:], ix.names)
	off += len(ix.names)
	for _, e := range ix.exts {
		binary.LittleEndian.PutUint16(buf[off:], uint16(len(e)))
		copy(buf[off+2:], e)
		off += 2 + len(e)
	}
	for _, id := range ix.roots {
		binary.LittleEndian.PutUint32(buf[off:], uint32(id))
		off += 4
	}
	for _, v := range ix.table.slots {
		binary.LittleEndian.PutUint32(buf[off:], uint32(v))
		off += 4
	}

	tmp := path + ".tmp"
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(tmp, buf, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Load reads a snapshot written by Save. The returned index keeps the file's
// name arena; no second copy of the path bytes is made.
func Load(path string) (*Index, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) < headerSize || string(data[0:8]) != snapshotMagic {
		return nil, errors.New("not a locator index snapshot")
	}
	version := binary.LittleEndian.Uint32(data[8:])
	if version != snapshotVersion {
		return nil, fmt.Errorf("unsupported snapshot version %d", version)
	}
	built := int64(binary.LittleEndian.Uint64(data[16:]))
	recCount := int(binary.LittleEndian.Uint32(data[24:]))
	nameLen := int(binary.LittleEndian.Uint32(data[28:]))
	extCount := int(binary.LittleEndian.Uint32(data[32:]))
	rootCount := int(binary.LittleEndian.Uint32(data[36:]))
	tableCap := int(binary.LittleEndian.Uint32(data[40:]))
	deleted := int(binary.LittleEndian.Uint32(data[44:]))
	if tableCap < 16 || tableCap&(tableCap-1) != 0 {
		return nil, errors.New("index snapshot has an invalid path table size")
	}

	need := headerSize + recCount*recordSize + nameLen + rootCount*4 + tableCap*4
	if need > len(data) {
		return nil, errors.New("truncated index snapshot")
	}
	off := headerSize
	recs := make([]Record, recCount)
	for i := 0; i < recCount; i++ {
		r := &recs[i]
		r.NameOff = binary.LittleEndian.Uint32(data[off:])
		r.NameLen = binary.LittleEndian.Uint32(data[off+4:])
		r.Parent = int32(binary.LittleEndian.Uint32(data[off+8:]))
		r.Size = int64(binary.LittleEndian.Uint64(data[off+12:]))
		r.Mtime = int64(binary.LittleEndian.Uint64(data[off+20:]))
		r.Ext = binary.LittleEndian.Uint16(data[off+28:])
		r.Flags = Flags(data[off+30])
		r.FRN = binary.LittleEndian.Uint64(data[off+32:])
		if int(r.NameOff)+int(r.NameLen) > nameLen {
			return nil, errors.New("index snapshot name out of range")
		}
		if r.Parent >= int32(recCount) {
			return nil, errors.New("index snapshot parent out of range")
		}
		off += recordSize
	}
	names := data[off : off+nameLen]
	off += nameLen
	exts := make([]string, 0, extCount)
	extIdx := make(map[string]uint16, extCount)
	for i := 0; i < extCount; i++ {
		if off+2 > len(data) {
			return nil, errors.New("truncated extension table")
		}
		n := int(binary.LittleEndian.Uint16(data[off:]))
		off += 2
		if off+n > len(data) {
			return nil, errors.New("truncated extension table")
		}
		e := string(data[off : off+n])
		off += n
		exts = append(exts, e)
		extIdx[e] = uint16(i + 1)
	}
	roots := make([]int32, rootCount)
	for i := range roots {
		roots[i] = int32(binary.LittleEndian.Uint32(data[off:]))
		off += 4
	}
	slots := make([]int32, tableCap)
	count := 0
	for i := range slots {
		slots[i] = int32(binary.LittleEndian.Uint32(data[off:]))
		if slots[i] > 0 {
			count++
		}
		off += 4
	}
	ix := &Index{
		names:  names,
		recs:   recs,
		exts:   exts,
		extIdx: extIdx,
		roots:  roots,
		table:  newPathTable(16),
		nDelet: deleted,
		built:  built,
	}
	ix.table.reset(slots, count)
	return ix, nil
}
