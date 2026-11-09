//go:build darwin && cgo

package watch

/*
#cgo LDFLAGS: -framework CoreServices -framework CoreFoundation
#include <CoreServices/CoreServices.h>
#include <stdint.h>
#include <stdlib.h>

void *dsh_locator_info_new(uint64_t id);
void dsh_locator_info_free(void *info);
CFArrayRef dsh_locator_paths_new(void);
void dsh_locator_paths_add(CFArrayRef array, const char *path);
void dsh_locator_paths_free(CFArrayRef array);
FSEventStreamRef dsh_locator_stream_create(CFArrayRef paths, void *info, double latency);
void dsh_locator_stream_start(FSEventStreamRef stream);
void dsh_locator_stream_stop(FSEventStreamRef stream);
*/
import "C"

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

// FSEvents event flags used here (CoreServices values).
const (
	fseventMustScanSubDirs = 0x00000001
	fseventUserDropped     = 0x00000002
	fseventKernelDropped   = 0x00000004
	fseventEventIDsWrapped = 0x00000008
	fseventRootChanged     = 0x00000020
	fseventItemRemoved     = 0x00000200
	fseventItemCreated     = 0x00000100
	fseventItemRenamed     = 0x00000800
	fseventItemModified    = 0x00001000
	fseventItemInodeMeta   = 0x00000400
	fseventItemXattrMod    = 0x00008000
	fseventItemFinderMod   = 0x00002000
	fseventItemIsDir       = 0x00020000
)

type fsevent struct {
	path  string
	flags uint32
}

// watcher is the FSEvents backend. Unlike kqueue it is recursive and has no
// per-directory descriptor limit, but it is only available in cgo builds.
type watcher struct {
	ix       *index.Index
	roots    []string
	excludes []string
	onError  func(error)

	events   chan fsevent
	overflow atomic.Bool
	closed   atomic.Bool

	info   unsafe.Pointer
	stream C.FSEventStreamRef

	once sync.Once
	wg   sync.WaitGroup
}

var (
	fseventsRegistry sync.Map // uint64 -> *watcher
	fseventsNextID   atomic.Uint64
)

func newWatcher(ix *index.Index, opt Options) (Watcher, error) {
	paths := C.dsh_locator_paths_new()
	if paths == nil {
		return nil, errors.New("FSEvents: cannot allocate the watched path array")
	}
	defer C.dsh_locator_paths_free(paths)
	for _, root := range opt.Roots {
		cpath := C.CString(root)
		C.dsh_locator_paths_add(paths, cpath)
		C.free(unsafe.Pointer(cpath))
	}
	id := fseventsNextID.Add(1)
	info := C.dsh_locator_info_new(C.uint64_t(id))
	if info == nil {
		return nil, errors.New("FSEvents: cannot allocate the callback context")
	}
	stream := C.dsh_locator_stream_create(paths, info, 0.2)
	if stream == nil {
		C.dsh_locator_info_free(info)
		return nil, errors.New("FSEvents: FSEventStreamCreate failed")
	}
	w := &watcher{
		ix:       ix,
		roots:    opt.Roots,
		excludes: opt.Excludes,
		onError:  opt.OnError,
		events:   make(chan fsevent, 4096),
		info:     info,
		stream:   stream,
	}
	fseventsRegistry.Store(id, w)
	C.dsh_locator_stream_start(stream)
	return w, nil
}

//export dshLocatorFSEventCallback
func dshLocatorFSEventCallback(stream C.FSEventStreamRef, info unsafe.Pointer, numEvents C.size_t, paths **C.char, flags *C.FSEventStreamEventFlags, ids *C.FSEventStreamEventId) {
	if info == nil || numEvents == 0 {
		return
	}
	id := uint64(*(*C.uint64_t)(info))
	value, ok := fseventsRegistry.Load(id)
	if !ok {
		return
	}
	w := value.(*watcher)
	if w.closed.Load() {
		return
	}
	count := int(numEvents)
	pathSlice := unsafe.Slice(paths, count)
	flagSlice := unsafe.Slice(flags, count)
	for i := 0; i < count; i++ {
		if pathSlice[i] == nil {
			continue
		}
		event := fsevent{path: C.GoString(pathSlice[i]), flags: uint32(flagSlice[i])}
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
	w.wg.Add(1)
	defer w.wg.Done()
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

// walkAdd indexes a directory subtree without registering extra watches; the
// single FSEvents stream already covers it.
func (w *watcher) walkAdd(root string) {
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
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
		w.ix.AddPath(path, index.FileInfo{
			Size:  info.Size(),
			Mtime: info.ModTime().UnixNano(),
			Mode:  info.Mode(),
		})
		return nil
	})
}

func (w *watcher) rescan() {
	for _, root := range w.roots {
		_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if entry.IsDir() {
				if path != root && excludedFSEventPath(path, w.excludes) {
					return filepath.SkipDir
				}
				info, statErr := entry.Info()
				if statErr == nil {
					w.ix.AddPath(path, index.FileInfo{Mode: info.Mode(), Mtime: info.ModTime().UnixNano()})
				}
				return nil
			}
			info, statErr := entry.Info()
			if statErr != nil {
				return nil
			}
			w.ix.AddPath(path, index.FileInfo{
				Size:  info.Size(),
				Mtime: info.ModTime().UnixNano(),
				Mode:  info.Mode(),
			})
			return nil
		})
	}
}

func (w *watcher) Close() error {
	w.once.Do(func() {
		w.closed.Store(true)
		if w.stream != nil {
			C.dsh_locator_stream_stop(w.stream)
			w.stream = nil
		}
		if w.info != nil {
			C.dsh_locator_info_free(w.info)
			w.info = nil
		}
		fseventsRegistry.Range(func(key, value any) bool {
			if value == w {
				fseventsRegistry.Delete(key)
			}
			return true
		})
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

