// Package index implements the in-memory file index, its on-disk snapshot and
// the query engine used by the locator daemon.
package index

import (
	"io/fs"
	"time"
)

// Flags describe one indexed entry.
type Flags uint8

const (
	// FlagDir marks a directory.
	FlagDir Flags = 1 << iota
	// FlagSymlink marks a symbolic link or reparse point.
	FlagSymlink
	// FlagHidden marks a hidden entry.
	FlagHidden
	// FlagReadonly marks a read-only entry.
	FlagReadonly
	// FlagDeleted is an internal tombstone; it is never persisted.
	FlagDeleted
)

// FileInfo is the metadata the index keeps for one entry.
type FileInfo struct {
	Size  int64
	Mtime int64 // Unix nanoseconds
	Mode  fs.FileMode
}

// Record is one fixed-size index entry. Names live in a shared arena and
// directories are reconstructed by walking Parent, which keeps memory close to
// the raw path bytes instead of one string header per file.
type Record struct {
	NameOff uint32
	NameLen uint32
	Parent  int32
	Size    int64
	Mtime   int64
	Ext     uint16
	Flags   Flags
	_       [5]byte
}

// IsDir reports whether the record is a directory.
func (r *Record) IsDir() bool { return r.Flags&FlagDir != 0 }

// Deleted reports whether the record is a tombstone.
func (r *Record) Deleted() bool { return r.Flags&FlagDeleted != 0 }

// ModTime returns the record's modification time.
func (r *Record) ModTime() time.Time { return time.Unix(0, r.Mtime) }

// Stats summarizes an index.
type Stats struct {
	Entries   int   `json:"entries"`
	Files     int   `json:"files"`
	Dirs      int   `json:"dirs"`
	Roots     int   `json:"roots"`
	NameBytes int   `json:"nameBytes"`
	Records   int   `json:"records"`
	Deleted   int   `json:"deleted"`
	BuiltAt   int64 `json:"builtAt"`
	Generation uint64 `json:"generation"`
}

// Hit is one search result.
type Hit struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
	Ext   string `json:"ext"`
	Dir   bool   `json:"dir"`
}

// Result is one search answer.
type Result struct {
	Total     int   `json:"total"`
	Returned  int   `json:"returned"`
	Offset    int   `json:"offset"`
	Truncated bool  `json:"truncated"`
	TookNanos int64 `json:"tookNs"`
	Hits      []Hit `json:"hits"`
}
