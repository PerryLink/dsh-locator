//go:build darwin && cgo

package watch

/*
#cgo LDFLAGS: -framework CoreServices -framework CoreFoundation
#include <CoreServices/CoreServices.h>
#include <stdint.h>

int dsh_locator_create(const char *const *roots, int count, int *read_fd,
                       FSEventStreamRef *stream_out, void **info_out);
void dsh_locator_destroy(FSEventStreamRef stream, void *info);
*/
import "C"

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

const (
	fseventMustScanSubDirs = 0x00000001
	fseventUserDropped     = 0x00000002
	fseventKernelDropped   = 0x00000004
	fseventEventIDsWrapped = 0x00000008
	fseventRootChanged     = 0x00000020
	fseventItemCreated     = 0x00000100
	fseventItemRemoved     = 0x00000200
	fseventItemRenamed     = 0x00000800
	fseventItemModified    = 0x00001000
	fseventItemInodeMeta   = 0x00000400
	fseventItemFinderMod   = 0x00002000
	fseventItemXattrMod    = 0x00008000
	fseventItemIsDir       = 0x00020000
)

type fsevent struct {
	path  string
	flags uint32
}

// watcher is the FSEvents backend: recursive and not bound to one descriptor
// per directory. It is available in cgo builds only.
type watcher struct {
	ix       *index.Index
	roots    []string
	excludes []string
	onError  func(error)

	file     *os.File
	stream   C.FSEventStreamRef
	info     unsafe.Pointer
	events   chan fsevent
	overflow atomic.Bool
	closed   atomic.Bool
	once     sync.Once
}

func newWatcher(ix *index.Index, opt Options) (Watcher, error) {
	if len(opt.Roots) == 0 {
		return nil, errors.New("FSEvents: no roots to watch")
	}
	roots := make([]*C.char, 0, len(opt.Roots))
	for _, root := range opt.Roots {
		roots = append(roots, C.CString(root))
	}
	defer func() {
		for _, root := range roots {
			C.free(unsafe.Pointer(root))
		}
	}()
	var readFD C.int
	var stream C.FSEventStreamRef
	var info unsafe.Pointer
	code := C.dsh_locator_create((**C.char)(unsafe.Pointer(&roots[0])), C.int(len(roots)), &readFD, &stream, &info)
	if code != 0 {
		return nil, errors.New("FSEvents: cannot create the stream")
	}
	w := &watcher{
		ix:       ix,
		roots:    opt.Roots,
		excludes: opt.Excludes,
		onError:  opt.OnError,
		file:     os.NewFile(uintptr(readFD), "dsh-locator-fsevents"),
		stream:   stream,
		info:     info,
		events:   make(chan fsevent, 4096),
	}
	go w.readEvents()
	return w, nil
}

// readEvents decodes the length-prefixed records written by the C callback.
func (w *watcher) readEvents() {
	var header struct {
		PathLen uint32
		Flags   uint32
	}
	for {
		if err := binary.Read(w.file, binary.LittleEndian, &header); err != nil {
			return
		}
		if header.PathLen > 1<<20 {
			return
		}
		path := make([]byte, header.PathLen)
		if _, err := io.ReadFull(w.file, path); err != nil {
			return
		}
		event := fsevent{path: string(path), flags: header.Flags}
		select {
		case w.events <- event:
		default:
			w.overflow.Store(true)
		}
	}
}

func (w *watcher) report(err error) {
	if w.onError != nil {
		w.onError(err)
	}
}

func (w *watcher) Run(ctx context.Context) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			w.Close()
			return ctx.Err()
		case event := <-w.events:
			w.apply(event)
		case <-ticker.C:
			if w.overflow.Swap(false) {
				w.rescan()
			}
		}
	}
}

func (w *watcher) apply(event fsevent) {
	if w.closed.Load() || event.path == "" {
		return
	}
	if event.flags&(fseventMustScanSubDirs|fseventUserDropped|fseventKernelDropped|fseventEventIDsWrapped|fseventRootChanged) != 0 {
		w.rescan()
		return
	}
	if excludedFSEventPath(event.path, w.excludes) {
		return
	}
	if event.flags&fseventItemRemoved != 0 && event.flags&fseventItemCreated == 0 {
		if event.flags&fseventItemIsDir != 0 {
			w.ix.RemoveSubtree(event.path)
		} else {
			w.ix.RemovePath(event.path)
		}
		return
	}
	if event.flags&(fseventItemCreated|fseventItemRenamed|fseventItemModified|fseventItemInodeMeta|fseventItemXattrMod|fseventItemFinderMod) == 0 {
		return
	}
	info, err := os.Lstat(event.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			w.ix.RemovePath(event.path)
		}
		return
	}
	w.ix.AddPath(event.path, index.FileInfo{
		Size:  info.Size(),
		Mtime: info.ModTime().UnixNano(),
		Mode:  info.Mode(),
	})
	if info.IsDir() {
		w.walkAdd(event.path)
	}
}

func (w *watcher) walkAdd(root string) {
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() && path != root && excludedFSEventPath(path, w.excludes) {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return nil
		}
		info, statErr := entry.Info()
		if statErr != nil {
			return nil
		}
		w.ix.AddPath(path, index.FileInfo{Size: info.Size(), Mtime: info.ModTime().UnixNano(), Mode: info.Mode()})
		return nil
	})
}

func (w *watcher) rescan() {
	for _, root := range w.roots {
		_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if entry.IsDir() && path != root && excludedFSEventPath(path, w.excludes) {
				return filepath.SkipDir
			}
			info, statErr := entry.Info()
			if statErr != nil {
				return nil
			}
			w.ix.AddPath(path, index.FileInfo{Size: info.Size(), Mtime: info.ModTime().UnixNano(), Mode: info.Mode()})
			return nil
		})
	}
}

func (w *watcher) Close() error {
	w.once.Do(func() {
		w.closed.Store(true)
		C.dsh_locator_destroy(w.stream, w.info)
		var zero C.FSEventStreamRef
		w.stream = zero
		w.info = nil
		if w.file != nil {
			_ = w.file.Close()
			w.file = nil
		}
	})
	return nil
}

func excludedFSEventPath(path string, patterns []string) bool {
	for _, segment := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' }) {
		if segment == "" {
			continue
		}
		for _, pattern := range patterns {
			pattern = strings.TrimSpace(pattern)
			if pattern == "" || strings.ContainsAny(pattern, `/\`) {
				continue
			}
			if ok, _ := filepath.Match(pattern, segment); ok {
				return true
			}
		}
	}
	return false
}
