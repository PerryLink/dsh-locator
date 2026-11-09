package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	genericRead            = 0x80000000
	fileShareRead          = 1
	fileShareWrite         = 2
	fileShareDelete        = 4
	openExisting           = 3
	fsctlQueryUSNJournal   = 0x000900F4
)

type usnJournalData struct {
	UsnJournalID    uint64
	FirstUsn        int64
	NextUsn         int64
	LowestValidUsn  int64
	MaxUsn          int64
	MaximumSize     uint64
	AllocationDelta uint64
}

func main() {
	p, _ := syscall.UTF16PtrFromString(`\\.\C:`)
	h, err := syscall.CreateFile(p, genericRead, fileShareRead|fileShareWrite|fileShareDelete, nil, openExisting, 0, 0)
	if err != nil {
		fmt.Println("open failed:", err)
		return
	}
	defer syscall.CloseHandle(h)
	var out usnJournalData
	var returned uint32
	r, _, e := syscall.NewLazyDLL("kernel32.dll").NewProc("DeviceIoControl").Call(
		uintptr(h), fsctlQueryUSNJournal, 0, 0, uintptr(unsafe.Pointer(&out)), unsafe.Sizeof(out), uintptr(unsafe.Pointer(&returned)), 0)
	fmt.Println("ok:", r, "err:", e, "returned:", returned)
	fmt.Printf("journal id=%x first=%x next=%x\n", out.UsnJournalID, out.FirstUsn, out.NextUsn)
}
