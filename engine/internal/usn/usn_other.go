//go:build !windows

package usn

import "errors"

// ErrUnsupported is returned on platforms without NTFS USN journals.
var ErrUnsupported = errors.New("USN journals are only available on Windows/NTFS")

// Probe is unavailable off Windows.
func Probe(ProbeOptions) (ProbeResult, error) {
	return ProbeResult{}, ErrUnsupported
}
