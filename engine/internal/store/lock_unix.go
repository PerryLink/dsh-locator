//go:build !windows

package store

import (
	"errors"
	"syscall"
)

// processAlive reports whether pid names a live process on this host. Signal 0
// performs the permission/existence check without delivering a signal; EPERM
// means the process exists but belongs to another user, which still counts.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	return errors.Is(err, syscall.EPERM)
}
