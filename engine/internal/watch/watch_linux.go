//go:build linux

package watch

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

type watcher struct {
	ix       *index.Index
	roots    []string
	excludes []string
	onError  func(error)

	fd      int
	mu      sync.Mutex
	wdDir   map[int32]string
	dirWD   map[string]int32
	closed  bool
	stopCh  chan struct{}
	started time.Time
	events  uint64
}

func newWatcher(ix *index.Index, opt Options) (Watcher, error) {
	fd, err := syscall.InotifyInit1(syscall.IN_CLOEXEC)
	if err != nil {
		return nil, fmt.Errorf("inotify_init1: %w", err)
	}
	// Non-blocking reads let Run observe Close promptly. Closing a descriptor
	// does not reliably wake a thread blocked in read(2) on Linux.
	if err := syscall.SetNonblock(fd, true); err != nil {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("inotify nonblock: %w", err)
	}
	w := &watcher{
		ix:       ix,
		roots:    opt.Roots,
		excludes: opt.Excludes,
		onError:  opt.OnError,
		fd:       fd,
		wdDir:    make(map[int32]string),
		dirWD:    make(map[string]int32),
		started:  time.Now(),
		stopCh:   make(chan struct{}),
	}
	for _, root := range opt.Roots {
		if err := w.addTree(root); err != nil {
			w.report(err)
		}
	}
	return w, nil
}

func (w *watcher) report(err error) {
	if w.onError != nil {
		w.onError(err)
	}
}

func (w *watcher) addTree(root string) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			w.report(err)
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if path != root && excluded(path, d.Name(), w.excludes) {
			return fs.SkipDir
		}
		_, werr := w.add(path)
		if werr != nil {
			w.report(werr)
			return fs.SkipDir
		}
		return nil
	})
}

func (w *watcher) add(dir string) (int32, error) {
	mask := uint32(syscall.IN_CREATE | syscall.IN_DELETE | syscall.IN_MOVED_FROM |
		syscall.IN_MOVED_TO | syscall.IN_CLOSE_WRITE | syscall.IN_ATTRIB |
		syscall.IN_DELETE_SELF | syscall.IN_MOVE_SELF | syscall.IN_ONLYDIR)
	wd, err := syscall.InotifyAddWatch(w.fd, dir, mask)
	if err != nil {
		return -1, fmt.Errorf("inotify_add_watch %s: %w", dir, err)
	}
	id := int32(wd)
	w.mu.Lock()
	w.wdDir[id] = dir
	w.dirWD[dir] = id
	w.mu.Unlock()
	return id, nil
}

func (w *watcher) removeWatch(dir string) {
	w.mu.Lock()
	id, ok := w.dirWD[dir]
	if ok {
		delete(w.dirWD, dir)
		delete(w.wdDir, id)
	}
	w.mu.Unlock()
	if ok {
		_, _ = syscall.InotifyRmWatch(w.fd, uint32(id))
	}
}

func (w *watcher) stopped() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.closed
}

func (w *watcher) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	close(w.stopCh)
	w.mu.Unlock()
	return syscall.Close(w.fd)
}

func (w *watcher) Run(ctx context.Context) error {
	buf := make([]byte, 256*1024)
	idle := time.NewTimer(0)
	<-idle.C
	defer idle.Stop()
	for {
		if w.stopped() {
			return ctx.Err()
		}
		n, err := syscall.Read(w.fd, buf)
		switch {
		case err == nil && n > 0:
			w.handle(buf[:n])
			continue
		case errors.Is(err, syscall.EAGAIN):
			idle.Reset(100 * time.Millisecond)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-w.stopCh:
				return ctx.Err()
			case <-idle.C:
			}
			continue
		case errors.Is(err, syscall.EINTR):
			continue
		case errors.Is(err, syscall.EBADF) || errors.Is(err, syscall.EINVAL):
			return ctx.Err()
		case err != nil:
			return err
		}
	}
}

func (w *watcher) handle(buf []byte) {
	for off := 0; off+16 <= len(buf); {
		wd := int32(binary.NativeEndian.Uint32(buf[off:]))
		mask := binary.NativeEndian.Uint32(buf[off+4:])
		// cookie is at off+8.
		nameLen := int(binary.NativeEndian.Uint32(buf[off+12:]))
		if off+16+nameLen > len(buf) {
			return
		}
		name := string(bytes.TrimRight(buf[off+16:off+16+nameLen], "\x00"))
		off += 16 + nameLen
		w.events++

		if mask&syscall.IN_Q_OVERFLOW != 0 {
			w.report(errors.New("inotify queue overflow; rescanning roots"))
			w.rescan()
			continue
		}
		w.mu.Lock()
		dir, ok := w.wdDir[wd]
		w.mu.Unlock()
		if !ok {
			continue
		}
		if mask&syscall.IN_IGNORED != 0 {
			w.removeWatch(dir)
			continue
		}
		if name == "" {
			// An event about the watched directory itself.
			if mask&(syscall.IN_DELETE_SELF|syscall.IN_MOVE_SELF) != 0 {
				w.ix.RemoveSubtree(dir)
				w.removeWatch(dir)
			}
			continue
		}
		path := filepath.Join(dir, name)
		switch {
		case mask&syscall.IN_ISDIR != 0:
			switch {
			case mask&(syscall.IN_CREATE|syscall.IN_MOVED_TO) != 0:
				if !excluded(path, name, w.excludes) {
					if err := w.addTree(path); err != nil {
						w.report(err)
					}
					w.upsert(path)
				}
			case mask&(syscall.IN_DELETE|syscall.IN_MOVED_FROM) != 0:
				w.ix.RemoveSubtree(path)
				w.removeWatch(path)
			}
		default:
			switch {
			case mask&(syscall.IN_CREATE|syscall.IN_CLOSE_WRITE|syscall.IN_ATTRIB|syscall.IN_MOVED_TO|syscall.IN_MODIFY) != 0:
				w.upsert(path)
			case mask&(syscall.IN_DELETE|syscall.IN_MOVED_FROM) != 0:
				w.ix.RemoveSubtree(path)
			}
		}
	}
}

func (w *watcher) upsert(path string) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			w.ix.RemoveSubtree(path)
		}
		return
	}
	w.ix.AddPath(path, index.FileInfo{
		Size:  info.Size(),
		Mtime: info.ModTime().UnixNano(),
		Mode:  info.Mode(),
	})
}

func (w *watcher) rescan() {
	for _, root := range w.roots {
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() && path != root && excluded(path, d.Name(), w.excludes) {
				return fs.SkipDir
			}
			w.upsert(path)
			return nil
		})
	}
}

func excluded(path, name string, patterns []string) bool {
	for _, p := range patterns {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if strings.ContainsAny(p, `/\`) {
			if ok, _ := filepath.Match(p, path); ok {
				return true
			}
			continue
		}
		if ok, _ := filepath.Match(p, name); ok {
			return true
		}
	}
	return false
}
