package usn

import (
	"encoding/binary"
	"testing"
	"unicode/utf16"
)

func recordBytes(record Record) []byte {
	name := utf16.Encode([]rune(record.Name))
	length := 60 + len(name)*2
	buf := make([]byte, length)
	binary.LittleEndian.PutUint32(buf[0:], uint32(length))
	binary.LittleEndian.PutUint16(buf[4:], Version2)
	binary.LittleEndian.PutUint16(buf[6:], 0)
	binary.LittleEndian.PutUint64(buf[8:], record.FRN)
	binary.LittleEndian.PutUint64(buf[16:], record.ParentFRN)
	binary.LittleEndian.PutUint64(buf[24:], uint64(record.USN))
	binary.LittleEndian.PutUint64(buf[32:], uint64(record.Timestamp))
	binary.LittleEndian.PutUint32(buf[40:], record.Reason)
	binary.LittleEndian.PutUint32(buf[52:], record.Attributes)
	binary.LittleEndian.PutUint16(buf[56:], uint16(len(name)*2))
	binary.LittleEndian.PutUint16(buf[58:], 60)
	for i, unit := range name {
		binary.LittleEndian.PutUint16(buf[60+2*i:], unit)
	}
	return buf
}

func TestParseRecords(t *testing.T) {
	records := []Record{
		{FRN: 5, ParentFRN: 5, Name: "."},
		{FRN: 100, ParentFRN: 5, Name: "Users", Attributes: AttributeDirectory},
		{FRN: 101, ParentFRN: 100, Name: "zzhdz", Attributes: AttributeDirectory},
		{FRN: 102, ParentFRN: 101, Name: "报告 2026.pdf", Reason: 1, Timestamp: 133000000000000000},
	}
	var buf []byte
	for _, record := range records {
		buf = append(buf, recordBytes(record)...)
	}
	parsed, err := ParseRecords(buf)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed) != 4 {
		t.Fatalf("parsed %d records", len(parsed))
	}
	if parsed[3].Name != "报告 2026.pdf" {
		t.Fatalf("name = %q", parsed[3].Name)
	}
	if parsed[1].IsDir() != true || parsed[3].IsDir() != false {
		t.Fatal("directory attribute not decoded")
	}
	if parsed[3].ModTimeNanos() <= 0 {
		t.Fatal("FILETIME conversion failed")
	}
}

func TestParseRecordsRejectsTruncated(t *testing.T) {
	buf := recordBytes(Record{FRN: 5, ParentFRN: 5, Name: "x"})
	if _, err := ParseRecords(buf[:20]); err == nil {
		t.Fatal("expected a truncation error")
	}
}

func TestTreePaths(t *testing.T) {
	tree := NewTree([]Record{
		{FRN: 5, ParentFRN: 5, Name: "."},
		{FRN: 100, ParentFRN: 5, Name: "Users", Attributes: AttributeDirectory},
		{FRN: 101, ParentFRN: 100, Name: "zzhdz", Attributes: AttributeDirectory},
		{FRN: 102, ParentFRN: 101, Name: "report.pdf"},
	})
	cases := map[uint64]string{
		100: `C:\Users`,
		101: `C:\Users\zzhdz`,
		102: `C:\Users\zzhdz\report.pdf`,
	}
	for frn, want := range cases {
		got, ok := tree.Path(frn, `C:\`)
		if !ok || got != want {
			t.Fatalf("Path(%d) = %q, %v; want %q", frn, got, ok, want)
		}
	}
	if _, ok := tree.Path(999, `C:\`); ok {
		t.Fatal("missing parent must fail")
	}
}

func TestTreeCycleIsRejected(t *testing.T) {
	tree := NewTree([]Record{
		{FRN: 10, ParentFRN: 11, Name: "a", Attributes: AttributeDirectory},
		{FRN: 11, ParentFRN: 10, Name: "b", Attributes: AttributeDirectory},
	})
	if _, ok := tree.Path(10, `/`); ok {
		t.Fatal("cycle must not produce a path")
	}
}

func TestWithin(t *testing.T) {
	if !Within(`C:\Users\zzhdz\a.txt`, `C:\Users\zzhdz`) {
		t.Fatal("child not within root")
	}
	if !Within(`C:\Users\zzhdz`, `C:\Users\zzhdz`) {
		t.Fatal("root not within itself")
	}
	if Within(`C:\Users\zzhdz2\a.txt`, `C:\Users\zzhdz`) {
		t.Fatal("sibling prefix must not match")
	}
}

func TestTreeResolvesWithoutRootRecord(t *testing.T) {
	// ENUM_USN_DATA omits the volume root; top-level entries point at the full
	// sequenced root reference.
	rootFRN := uint64(0x0005000000000005)
	tree := NewTree([]Record{
		{FRN: 100, ParentFRN: rootFRN, Name: "Users", Attributes: AttributeDirectory},
		{FRN: 101, ParentFRN: 100, Name: "me", Attributes: AttributeDirectory},
		{FRN: 102, ParentFRN: 101, Name: "report.pdf"},
	})
	path, ok := tree.Path(102, `C:\`)
	if !ok || path != `C:\Users\me\report.pdf` {
		t.Fatalf("Path = %q, %v", path, ok)
	}
	if _, ok := tree.Path(rootFRN, `C:\`); !ok {
		t.Fatal("root reference must resolve to the volume root")
	}
}
