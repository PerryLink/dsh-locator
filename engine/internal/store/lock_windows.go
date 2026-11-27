//go:build windows

package store

import "os"

// processAlive reports whether pid names a live process on this host.
//
// os.FindProcess on Windows opens a real process handle with
// PROCESS_QUERY_INFORMATION, so it fails exactly when the process no longer
// exists (including a PID reused by a different incarnation, which is caught by
// the procStart comparison in lockLive). The handle is released immediately.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	_ = p.Release()
	return true
}
