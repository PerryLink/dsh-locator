// Package statefs centralises the permission modes of files the locator
// engine creates inside its state directory.
//
// A state directory holds the name index (snapshot + journal), the metadata
// file, the resumable USN cursors and the engine write lock. None of it is
// meant to be world-readable: the snapshot exposes every indexed path. The
// engine therefore creates every directory 0700 and every file 0600.
//
// Helpers also tighten an object they are asked to (over)write, because
// os.WriteFile/os.OpenFile only apply the mode when a file is created: a
// temporary file left behind with 0644 by an older engine would otherwise keep
// its permissions forever. The chmod is best effort (a read-only install must
// not break a save) and harmless on Windows, where the mode only carries the
// read-only bit.
package statefs

import "os"

// DirMode is the permission of directories created inside a state directory.
const DirMode os.FileMode = 0o700

// FileMode is the permission of files created inside a state directory.
const FileMode os.FileMode = 0o600

// MkdirAll creates path (and any missing parents) with DirMode and tightens an
// already existing directory.
func MkdirAll(path string) error {
	if err := os.MkdirAll(path, DirMode); err != nil {
		return err
	}
	chmodBestEffort(path, DirMode)
	return nil
}

// WriteFile writes data with FileMode and tightens a pre-existing file.
func WriteFile(path string, data []byte) error {
	if err := os.WriteFile(path, data, FileMode); err != nil {
		return err
	}
	chmodBestEffort(path, FileMode)
	return nil
}

// Create opens path for writing with FileMode, truncating an existing file.
func Create(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, FileMode)
	if err != nil {
		return nil, err
	}
	chmodBestEffort(path, FileMode)
	return f, nil
}

// chmodBestEffort never reports an error: a read-only install or a
// profile-owned directory must not break a save. Windows ignores the POSIX
// bits.
func chmodBestEffort(path string, perm os.FileMode) {
	_ = os.Chmod(path, perm)
}
