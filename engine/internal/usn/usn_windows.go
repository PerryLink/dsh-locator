//go:build windows

package usn

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	fileReadData        = 0x80000000
	fileShareRead       = 0x00000001
	fileShareWrite      = 0x00000002
	fileShareDelete     = 0x00000004
	openExisting        = 3
	fsctlQueryUSNJournal = 0x000900F4
	fsctlEnumUSNData    = 0x000900B3
	fsctlReadUSNJournal = 0x000900BB
	errorHandleEOF      = syscall.Errno(38)
	errorInvalidParam   = syscall.Errno(87)
	errorMoreData       = syscall.Errno(234)

	maxProbeRecords = 4_000_000
)

var procDeviceIoControl = syscall.NewLazyDLL("kernel32.dll").NewProc("DeviceIoControl")

// Volume is an open NTFS volume handle.
type Volume struct {
	handle syscall.Handle
	name   string
}

type journalData struct {
	UsnJournalID    uint64
	FirstUsn        int64
	NextUsn         int64
	LowestValidUsn  int64
	MaxUsn          int64
	MaximumSize     uint64
	AllocationDelta uint64
}

type mftEnumData struct {
	StartFileReferenceNumber uint64
	LowUsn                   int64
	HighUsn                  int64
}

type readJournalData struct {
	StartUsn        int64
	ReasonMask      uint32
	ReturnOnlyClose uint32
	Timeout         uint64
	BytesToWaitFor  uint64
	UsnJournalID    uint64
}

// NormalizeVolume turns `C:` or `C:\` into the device path `\\.\C:`.
func NormalizeVolume(name string) string {
	v := strings.TrimSpace(name)
	v = strings.TrimRight(v, `\`)
	if len(v) == 2 && v[1] == ':' {
		return `\\.\` + v
	}
	if strings.HasPrefix(v, `\\.\`) {
		return v
	}
	return v
}

// OpenVolume opens a volume for USN queries. This requires administrator
// rights; a normal user gets ERROR_ACCESS_DENIED.
func OpenVolume(name string) (*Volume, error) {
	path := NormalizeVolume(name)
	ptr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(ptr, fileReadData, fileShareRead|fileShareWrite|fileShareDelete, nil, openExisting, 0, 0)
	if err != nil {
		return nil, fmt.Errorf("open %s (administrator rights are required for USN): %w", path, err)
	}
	return &Volume{handle: handle, name: path}, nil
}

// Close releases the volume handle.
func (v *Volume) Close() error {
	if v.handle == 0 {
		return nil
	}
	err := syscall.CloseHandle(v.handle)
	v.handle = 0
	return err
}

// Journal queries the volume's current journal state.
func (v *Volume) Journal() (Journal, error) {
	var data journalData
	var returned uint32
	if err := deviceIoControl(v.handle, fsctlQueryUSNJournal, nil, 0, unsafe.Pointer(&data), uint32(unsafe.Sizeof(data)), &returned); err != nil {
		return Journal{}, fmt.Errorf("query USN journal: %w", err)
	}
	return Journal{
		ID:              data.UsnJournalID,
		FirstUSN:        data.FirstUsn,
		NextUSN:         data.NextUsn,
		LowestValidUSN:  data.LowestValidUsn,
		MaxUSN:          data.MaxUsn,
		MaximumSize:     data.MaximumSize,
		AllocationDelta: data.AllocationDelta,
	}, nil
}

// Enumerate walks every MFT record that has a name. It is the USN analogue of
// a directory walk: one device query per buffer instead of one syscall per
// directory entry.
func (v *Volume) Enumerate(journal Journal, visit func(Record) bool) (int64, error) {
	input := mftEnumData{StartFileReferenceNumber: 0, LowUsn: 0, HighUsn: journal.NextUSN}
	buf := make([]byte, 1<<20)
	var total int64
	for {
		var returned uint32
		err := deviceIoControl(v.handle, fsctlEnumUSNData, unsafe.Pointer(&input), uint32(unsafe.Sizeof(input)), unsafe.Pointer(&buf[0]), uint32(len(buf)), &returned)
		if err != nil {
			if errors.Is(err, errorHandleEOF) || errors.Is(err, errorInvalidParam) {
				return total, nil
			}
			return total, fmt.Errorf("enumerate MFT: %w", err)
		}
		if returned <= 8 {
			return total, nil
		}
		next := *(*uint64)(unsafe.Pointer(&buf[0]))
		records, parseErr := ParseRecords(buf[8:returned])
		for _, record := range records {
			if !visit(record) {
				return total, nil
			}
			total++
		}
		if parseErr != nil && len(records) == 0 {
			return total, parseErr
		}
		if next == 0 {
			return total, nil
		}
		input.StartFileReferenceNumber = next
	}
}

// ReadJournal decodes records after startUSN. It is not used by the index yet;
// the probe command prints a few records to validate the decoder.
func (v *Volume) ReadJournal(journal Journal, startUSN int64, visit func(Record) bool) (int64, error) {
	input := readJournalData{
		StartUsn:        startUSN,
		ReasonMask:      math.MaxUint32,
		ReturnOnlyClose: 0,
		Timeout:         0,
		BytesToWaitFor:  0,
		UsnJournalID:    journal.ID,
	}
	buf := make([]byte, 1<<20)
	var total int64
	for {
		var returned uint32
		err := deviceIoControl(v.handle, fsctlReadUSNJournal, unsafe.Pointer(&input), uint32(unsafe.Sizeof(input)), unsafe.Pointer(&buf[0]), uint32(len(buf)), &returned)
		if err != nil {
			if errors.Is(err, errorHandleEOF) || errors.Is(err, errorInvalidParam) {
				return total, nil
			}
			return total, fmt.Errorf("read USN journal: %w", err)
		}
		if returned <= 8 {
			return total, nil
		}
		next := *(*int64)(unsafe.Pointer(&buf[0]))
		records, parseErr := ParseRecords(buf[8:returned])
		for _, record := range records {
			if !visit(record) {
				return total, nil
			}
			total++
		}
		if parseErr != nil && len(records) == 0 {
			return total, parseErr
		}
		if next <= input.StartUsn {
			return total, nil
		}
		input.StartUsn = next
	}
}

// Probe opens a volume, reports its journal, and optionally enumerates the MFT
// to measure throughput and path reconstruction.
func Probe(opt ProbeOptions) (ProbeResult, error) {
	start := time.Now()
	volume, err := OpenVolume(opt.Volume)
	if err != nil {
		return ProbeResult{}, err
	}
	defer volume.Close()
	journal, err := volume.Journal()
	if err != nil {
		return ProbeResult{}, err
	}
	result := ProbeResult{Volume: NormalizeVolume(opt.Volume), Journal: journal}
	volumeRootPath := volumeRoot(opt.Volume)
	root := opt.Root
	if root == "" {
		root = volumeRootPath
	}
	result.Root = root
	if opt.JournalSamples > 0 {
		from := journal.NextUSN - 1<<20
		if from < journal.FirstUSN {
			from = journal.FirstUSN
		}
		count, readErr := volume.ReadJournal(journal, from, func(record Record) bool {
			if len(result.JournalList) < opt.JournalSamples {
				result.JournalList = append(result.JournalList, fmt.Sprintf("%s  reason=0x%x frn=%d usn=%d", record.Name, record.Reason, record.FRN, record.USN))
			}
			return true
		})
		result.JournalRead = count
		if readErr != nil {
			return result, readErr
		}
	}
	if !opt.Enumerate {
		result.ElapsedMS = time.Since(start).Milliseconds()
		return result, nil
	}

	records := make([]Record, 0, 1<<20)
	truncated := false
	count, err := volume.Enumerate(journal, func(record Record) bool {
		if len(records) >= maxProbeRecords {
			truncated = true
			return false
		}
		records = append(records, record)
		return true
	})
	if err != nil {
		return result, err
	}
	result.Records = count
	result.Truncated = truncated
	tree := NewTree(records)
	result.TreeNodes = tree.Len()
	limit := opt.Limit
	if limit < 0 {
		limit = 10
	}
	for _, record := range records {
		path, ok := tree.Path(record.FRN, volumeRootPath)
		if !ok {
			result.Unresolved++
			continue
		}
		result.Resolved++
		if len(result.AnySamples) < 5 {
			result.AnySamples = append(result.AnySamples, path)
		}
		if !Within(path, root) {
			continue
		}
		result.UnderRoot++
		if record.IsDir() {
			result.Dirs++
		} else {
			result.Files++
		}
		if len(result.Samples) < limit {
			result.Samples = append(result.Samples, path)
		}
	}
	result.ElapsedMS = time.Since(start).Milliseconds()
	if result.ElapsedMS > 0 {
		result.RecordsPerS = count * 1000 / result.ElapsedMS
	}
	return result, nil
}

func volumeRoot(volume string) string {
	v := strings.TrimSpace(volume)
	v = strings.TrimRight(v, `\`)
	v = strings.TrimPrefix(v, `\\.\`)
	if len(v) == 2 && v[1] == ':' {
		return v + `\`
	}
	return v
}

func deviceIoControl(handle syscall.Handle, code uint32, in unsafe.Pointer, inSize uint32, out unsafe.Pointer, outSize uint32, returned *uint32) error {
	r1, _, callErr := procDeviceIoControl.Call(
		uintptr(handle),
		uintptr(code),
		uintptr(in),
		uintptr(inSize),
		uintptr(out),
		uintptr(outSize),
		uintptr(unsafe.Pointer(returned)),
		0,
	)
	if r1 == 0 {
		if callErr == syscall.Errno(0) {
			return errors.New("DeviceIoControl failed")
		}
		return callErr
	}
	return nil
}
