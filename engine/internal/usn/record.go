// Package usn decodes NTFS USN change-journal records and rebuilds paths from
// the file-reference-number parent map.
//
// The record parser and the path builder are pure Go and live in this file so
// they can be tested on every platform. The volume ioctls are Windows-only
// (usn_windows.go); other platforms get a stub.
package usn

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
)

// USN record constants.
const (
	// Version2 is the common NTFS record layout.
	Version2 = 2
	// Version3 is the wider reference-number layout; it is reported but not
	// indexed yet.
	Version3 = 3

	// RootFileReferenceNumber is the NTFS root directory's FRN.
	RootFileReferenceNumber = 5
)

// isRootFRN reports whether frn is a volume root reference. ENUM_USN_DATA
// does not return the root record itself, and reference numbers carry a 16-bit
// sequence number in the high bits, so the low 48 bits are compared.
func isRootFRN(frn uint64) bool { return frn&0x0000FFFFFFFFFFFF == RootFileReferenceNumber }

// File attribute bits used by the index.
const (
	AttributeDirectory    = 0x00000010
	AttributeReparsePoint = 0x00000400
)

// Journal describes one volume's USN journal.
type Journal struct {
	ID              uint64 `json:"id"`
	FirstUSN        int64  `json:"firstUsn"`
	NextUSN         int64  `json:"nextUsn"`
	LowestValidUSN  int64  `json:"lowestValidUsn"`
	MaxUSN          int64  `json:"maxUsn"`
	MaximumSize     uint64 `json:"maximumSize"`
	AllocationDelta uint64 `json:"allocationDelta"`
}

// Record is one decoded USN_RECORD_V2.
type Record struct {
	FRN        uint64
	ParentFRN  uint64
	USN        int64
	Timestamp  int64 // FILETIME (100 ns since 1601-01-01)
	Reason     uint32
	Attributes uint32
	Name       string
}

// IsDir reports whether the record describes a directory.
func (r Record) IsDir() bool { return r.Attributes&AttributeDirectory != 0 }

// IsReparsePoint reports whether the record carries a reparse point (a
// junction or symlink on NTFS).
func (r Record) IsReparsePoint() bool { return r.Attributes&AttributeReparsePoint != 0 }

// ModTimeNanos converts the record's FILETIME to Unix nanoseconds. USN
// timestamps describe when the record changed, not the file's modification
// time, so callers must not present them as mtime.
func (r Record) ModTimeNanos() int64 {
	if r.Timestamp == 0 {
		return 0
	}
	const epochDelta = 116444736000000000 // 1601-01-01 to 1970-01-01 in 100ns
	return (r.Timestamp - epochDelta) * 100
}

// ProbeOptions configures one USN probe.
type ProbeOptions struct {
	Volume    string
	Root      string
	Limit     int
	Enumerate bool
	// JournalSamples asks for this many recent change-journal records. It
	// validates the journal decoder without touching the index.
	JournalSamples int
}

// ProbeResult is what the probe observed.
type ProbeResult struct {
	Volume      string   `json:"volume"`
	Root        string   `json:"root"`
	Journal     Journal  `json:"journal"`
	Records     int64    `json:"records"`
	Files       int64    `json:"files"`
	Dirs        int64    `json:"dirs"`
	UnderRoot   int64    `json:"underRoot"`
	Truncated   bool     `json:"truncated"`
	Samples     []string `json:"samples"`
	TreeNodes   int      `json:"treeNodes"`
	Resolved    int64    `json:"resolved"`
	Unresolved  int64    `json:"unresolved"`
	AnySamples  []string `json:"anySamples"`
	ElapsedMS   int64    `json:"elapsedMs"`
	RecordsPerS int64    `json:"recordsPerSecond"`
	JournalRead int64    `json:"journalRead"`
	JournalList []string `json:"journalSamples"`
}

// ParseRecords decodes the USN_RECORD sequence in buf. A record with an
// unsupported major version is skipped but counted in the returned error;
// callers that only want V2 can inspect the error and continue with the
// records that did parse.
func ParseRecords(buf []byte) ([]Record, error) {
	var records []Record
	var skipped int
	for offset := 0; offset+8 <= len(buf); {
		length := int(binary.LittleEndian.Uint32(buf[offset:]))
		if length == 0 {
			break
		}
		if length < 8 || offset+length > len(buf) {
			return records, fmt.Errorf("usn: record length %d exceeds buffer at offset %d", length, offset)
		}
		major := binary.LittleEndian.Uint16(buf[offset+4:])
		if major != Version2 {
			skipped++
			offset += length
			continue
		}
		record, err := parseV2(buf[offset : offset+length])
		if err != nil {
			return records, err
		}
		records = append(records, record)
		offset += length
	}
	if skipped > 0 {
		return records, fmt.Errorf("usn: skipped %d record(s) with an unsupported major version", skipped)
	}
	return records, nil
}

func parseV2(buf []byte) (Record, error) {
	const header = 60
	if len(buf) < header {
		return Record{}, errors.New("usn: short record")
	}
	nameLength := int(binary.LittleEndian.Uint16(buf[56:]))
	nameOffset := int(binary.LittleEndian.Uint16(buf[58:]))
	if nameOffset < header || nameOffset+nameLength > len(buf) {
		return Record{}, errors.New("usn: file name out of range")
	}
	units := make([]uint16, nameLength/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(buf[nameOffset+2*i:])
	}
	return Record{
		FRN:        binary.LittleEndian.Uint64(buf[8:]),
		ParentFRN:  binary.LittleEndian.Uint64(buf[16:]),
		USN:        int64(binary.LittleEndian.Uint64(buf[24:])),
		Timestamp:  int64(binary.LittleEndian.Uint64(buf[32:])),
		Reason:     binary.LittleEndian.Uint32(buf[40:]),
		Attributes: binary.LittleEndian.Uint32(buf[52:]),
		Name:       string(utf16.Decode(units)),
	}, nil
}

// Node is one entry kept for path reconstruction: its own name and parent.
type Node struct {
	Name       string
	Parent     uint64
	Attributes uint32
	Timestamp  int64
}

// Tree maps file reference numbers to their names and parents so a full path
// can be rebuilt without another device query.
type Tree struct {
	Nodes map[uint64]Node
	cache map[uint64]string
}

// NewTree indexes records by FRN. Later duplicates replace earlier ones, which
// matches a journal that may contain several records for one file.
func NewTree(records []Record) *Tree {
	t := &Tree{Nodes: make(map[uint64]Node, len(records)), cache: make(map[uint64]string, len(records))}
	for _, record := range records {
		if record.Name == "" || record.FRN == 0 {
			continue
		}
		t.Nodes[record.FRN] = Node{
			Name:       record.Name,
			Parent:     record.ParentFRN,
			Attributes: record.Attributes,
			Timestamp:  record.Timestamp,
		}
	}
	return t
}

// Len returns the number of indexed reference numbers.
func (t *Tree) Len() int { return len(t.Nodes) }

// Path rebuilds the absolute path of frn below rootPath (for example `C:\`).
// It returns false for cycles, missing parents and depths beyond 512.
func (t *Tree) Path(frn uint64, rootPath string) (string, bool) {
	if cached, ok := t.cache[frn]; ok {
		return cached, cached != ""
	}
	const maxDepth = 512
	parts := make([]string, 0, 16)
	seen := make(map[uint64]struct{}, 16)
	current := frn
	for depth := 0; depth < maxDepth; depth++ {
		if isRootFRN(current) {
			break
		}
		node, ok := t.Nodes[current]
		if !ok {
			t.cache[frn] = ""
			return "", false
		}
		if _, duplicate := seen[current]; duplicate {
			t.cache[frn] = ""
			return "", false
		}
		seen[current] = struct{}{}
		if node.Parent == current {
			break
		}
		parts = append(parts, node.Name)
		current = node.Parent
	}
	if len(parts) == 0 {
		// The root itself.
		t.cache[frn] = rootPath
		return rootPath, true
	}
	var b strings.Builder
	b.Grow(len(rootPath) + 64)
	b.WriteString(strings.TrimRight(rootPath, `\`))
	for i := len(parts) - 1; i >= 0; i-- {
		b.WriteString(`\`)
		b.WriteString(parts[i])
	}
	path := b.String()
	t.cache[frn] = path
	return path, true
}

// Within reports whether path is rootPath or below it, using the platform's
// separator and case rules.
func Within(path, rootPath string) bool {
	root := strings.TrimRight(rootPath, `\`)
	if strings.EqualFold(path, root) {
		return true
	}
	return strings.HasPrefix(strings.ToLower(path), strings.ToLower(root)+`\`)
}
