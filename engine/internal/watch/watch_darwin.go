//go:build darwin

package watch

import (
	"context"
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

// maxWatchedDirs bounds open descriptors. macOS defaults to a modest
// RLIMIT_NOFILE, and one descriptor per directory is the price of kqueue
// vnode watches. Directories beyond the cap are still indexed; their changes
// are picked up by the periodic rebuild (refreshIntervalMs) and by
// locator_rebuild.
const maxWatchedDirs = 4096

type watchedDir struct {
	fd    int
	known map[string]struct{}
}

type watcher struct {
	ix       *index.Index
	roots    []string
	excludes []string
	onError  func(error)

	kq      int
	mu      sync.Mutex
	dirs    map[int]*watchedDir
	fdPaths map[int]string
	paths   map[string]int
	names   map[string]*watchedDir
	closed bool
	warned bool
}

func newWatcher(ix *index.Index, opt Options) (Watcher, error) {
	kq, err := syscall.Kqueue()
	if err != nil {
		return nil, fmt.Errorf("kqueue: %w", err)
	}
	w := &watcher{
		ix:       ix,
		roots:    opt.Roots,
		excludes: opt.Excludes,
		onError:  opt.OnError,
		kq:       kq,
		dirs:     make(map[int]*watchedDir),
		fdPaths:  make(map[int]string),
		paths:    make(map[string]int),
		names:    make(map[string]*watchedDir),
	}
	for _, root := range opt.Roots {
		w.addTree(root, false)
	}
	return w, nil
}

func (w *watcher) report(err error) {
	if w.onError != nil {
		w.onError(err)
	}
}

func (w *watcher) addTree(root string, indexChildren bool) {
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if path != root && excluded(path, d.Name(), w.excludes) {
			return fs.SkipDir
		}
		if !w.addDir(path) {
			// Beyond the watch budget the subtree is still indexed; only its
			// change notifications are lost.
			return nil
		}
		if indexChildren {
			// A directory that appeared after the last full scan needs its
			// direct children indexed; deeper ones follow from WalkDir.
			w.upsertChildren(path)
		}
		return nil
	})
}

// addDir opens one directory and registers a vnode watch. It returns false
// when the watch budget is exhausted or the directory cannot be watched.
func (w *watcher) addDir(path string) bool {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return false
	}
	if _, ok := w.names[path]; ok {
		w.mu.Unlock()
		return true
	}
	if len(w.dirs) >= maxWatchedDirs {
		if !w.warned {
			w.warned = true
			w.report(fmt.Errorf("kqueue watch limit reached (%d directories); deeper changes rely on the periodic rebuild", maxWatchedDirs))
		}
		w.mu.Unlock()
		return false
	}
	w.mu.Unlock()

	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		w.report(fmt.Errorf("open %s: %w", path, err))
		return false
	}
	change := syscall.Kevent_t{
		Ident:  uint64(fd),
		Filter: syscall.EVFILT_VNODE,
		Flags:  syscall.EV_ADD | syscall.EV_CLEAR,
		Fflags: syscall.NOTE_WRITE | syscall.NOTE_DELETE | syscall.NOTE_RENAME | syscall.NOTE_ATTRIB | syscall.NOTE_EXTEND,
	}
	if _, err := syscall.Kevent(w.kq, []syscall.Kevent_t{change}, nil, nil); err != nil {
		_ = syscall.Close(fd)
		w.report(fmt.Errorf("kevent add %s: %w", path, err))
		return false
	}
	entry := &watchedDir{fd: fd, known: listNames(path)}
	w.mu.Lock()
	w.dirs[fd] = entry
	w.fdPaths[fd] = path
	w.paths[path] = fd
	w.names[path] = entry
	w.mu.Unlock()
	return true
}

func listNames(dir string) map[string]struct{} {
	out := make(map[string]struct{})
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, entry := range entries {
		out[entry.Name()] = struct{}{}
	}
	return out
}

func (w *watcher) upsertChildren(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if excluded(filepath.Join(dir, name), name, w.excludes) {
			continue
		}
		path := filepath.Join(dir, name)
		info, err := entry.Info()
		if err != nil {
			continue
		}
		w.ix.AddPath(path, index.FileInfo{
			Size:  info.Size(),
			Mtime: info.ModTime().UnixNano(),
			Mode:  info.Mode(),
		})
	}
}

func (w *watcher) removeDir(path string) {
	w.mu.Lock()
	fd, ok := w.paths[path]
	delete(w.paths, path)
	if ok {
		delete(w.dirs, fd)
		delete(w.fdPaths, fd)
	}
	delete(w.names, path)
	w.mu.Unlock()
	if ok {
		_, _ = syscall.Kevent(w.kq, []syscall.Kevent_t{{
			Ident:  uint64(fd),
			Filter: syscall.EVFILT_VNODE,
			Flags:  syscall.EV_DELETE,
		}}, nil, nil)
		_ = syscall.Close(fd)
	}
}

func (w *watcher) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	fds := make([]int, 0, len(w.dirs))
	for fd := range w.dirs {
		fds = append(fds, fd)
	}
	w.dirs = make(map[int]*watchedDir)
	w.fdPaths = make(map[int]string)
	w.paths = make(map[string]int)
	w.names = make(map[string]*watchedDir)
	w.mu.Unlock()
	for _, fd := range fds {
		_ = syscall.Close(fd)
	}
	return syscall.Close(w.kq)
}

func (w *watcher) Run(ctx context.Context) error {
	events := make([]syscall.Kevent_t, 64)
	timeout := syscall.Timespec{Sec: 0, Nsec: int64(300 * time.Millisecond)}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		n, err := syscall.Kevent(w.kq, nil, events, &timeout)
		if err != nil {
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			return err
		}
		for i := 0; i < n; i++ {
			w.handleEvent(events[i])
		}
	}
}

func (w *watcher) handleEvent(event syscall.Kevent_t) {
	fd := int(event.Ident)
	w.mu.Lock()
	entry, ok := w.dirs[fd]
	path := w.fdPaths[fd]
	w.mu.Unlock()
	if !ok || path == "" {
		return
	}
	if event.Fflags&(syscall.NOTE_DELETE|syscall.NOTE_RENAME) != 0 {
		w.ix.RemoveSubtree(path)
		w.removeDir(path)
		return
	}
	w.reconcile(path, entry)
}

// reconcile compares the directory's current entries with the set captured at
// watch time: new names are indexed (and watched when directories), vanished
// names are removed. File content changes do not raise directory vnode events;
// the periodic rebuild refreshes size and modification time.
func (w *watcher) reconcile(dir string, entry *watchedDir) {
	current := listNames(dir)
	w.mu.Lock()
	known := entry.known
	for name := range current {
		if _, ok := known[name]; !ok {
			w.mu.Unlock()
			w.addChild(dir, name)
			w.mu.Lock()
		}
	}
	removed := make([]string, 0, 4)
	for name := range known {
		if _, ok := current[name]; !ok {
			removed = append(removed, name)
		}
	}
	entry.known = current
	w.mu.Unlock()
	for _, name := range removed {
		path := filepath.Join(dir, name)
		w.ix.RemoveSubtree(path)
		w.removeDir(path)
	}
}

func (w *watcher) addChild(dir, name string) {
	path := filepath.Join(dir, name)
	if excluded(path, name, w.excludes) {
		return
	}
	info, err := os.Lstat(path)
	if err != nil {
		return
	}
	w.ix.AddPath(path, index.FileInfo{
		Size:  info.Size(),
		Mtime: info.ModTime().UnixNano(),
		Mode:  info.Mode(),
	})
	if info.IsDir() {
		w.addTree(path, true)
	}
}

// excluded mirrors the scanner's base-name rules.
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
