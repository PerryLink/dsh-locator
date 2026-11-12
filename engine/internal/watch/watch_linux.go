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

	onDegraded  func(Health)
	rootsWatch  int // roots with at least one watch
	dirsWatched int
	dirsFailed  int
	degraded    bool
	reasons     []string

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
		ix:         ix,
		roots:      opt.Roots,
		excludes:   opt.Excludes,
		onError:    opt.OnError,
		onDegraded: opt.OnDegraded,
		fd:         fd,
		wdDir:      make(map[int32]string),
		dirWD:      make(map[string]int32),
		started:    time.Now(),
		stopCh:     make(chan struct{}),
	}
	for _, root := range opt.Roots {
		if reason := unreliableNotifyFS(root); reason != "" {
			w.markDegraded(reason)
		}
		before := w.watchedDirCount()
		if err := w.addTree(root, true); err != nil {
			w.report(err)
		}
		if w.watchedDirCount() > before {
			w.rootsWatch++
		}
	}
	if w.watchedDirCount() == 0 {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("inotify: no directory could be watched (check fs.inotify.max_user_watches)")
	}
	return w, nil
}

func (w *watcher) report(err error) {
	if w.onError != nil {
		w.onError(err)
	}
}

func (w *watcher) watchedDirCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.dirsWatched
}

func (w *watcher) healthLocked() Health {
	reasons := w.reasons
	degraded := w.degraded || w.rootsWatch < len(w.roots) || w.dirsFailed > 0
	if w.rootsWatch < len(w.roots) && len(reasons) == 0 {
		reasons = []string{fmt.Sprintf("%d of %d root(s) could not be watched", len(w.roots)-w.rootsWatch, len(w.roots))}
	}
	return Health{
		Roots:    len(w.roots),
		Watching: w.rootsWatch,
		Dirs:     w.dirsWatched,
		Degraded: degraded,
		Reason:   strings.Join(reasons, "; "),
	}
}

// Health reports the inotify coverage counted while adding watches.
func (w *watcher) Health() Health {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.healthLocked()
}

// markDegraded records incomplete coverage and notifies the daemon on the
// transition into the degraded state.
func (w *watcher) markDegraded(reason string) {
	if reason == "" {
		return
	}
	w.mu.Lock()
	first := !w.degraded
	w.degraded = true
	dup := false
	for _, existing := range w.reasons {
		if existing == reason {
			dup = true
			break
		}
	}
	if !dup && len(w.reasons) < 4 {
		w.reasons = append(w.reasons, reason)
	}
	h := w.healthLocked()
	w.mu.Unlock()
	if first && w.onDegraded != nil {
		w.onDegraded(h)
	}
}

// addTree walks root and adds one inotify watch per directory. Failures are
// reported and counted; as long as the root itself was added the tree is still
// partially covered and the daemon's refresh fallback covers the rest.
func (w *watcher) addTree(root string, required bool) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// Temporary build/test directories (pnpm _tmp, editor swaps) can
			// disappear between readdir and lstat. That is normal churn, not
			// missing watcher coverage: treat it as a vanished entry instead of
			// disabling the native watcher and falling back to a 30-minute rescan.
			if (!required || path != root) && transientWatchError(err) {
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			w.report(err)
			w.noteWatchFailure(fmt.Errorf("walk %s: %w", path, err))
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
			if (!required || path != root) && transientWatchError(werr) {
				return fs.SkipDir
			}
			w.report(werr)
			w.noteWatchFailure(werr)
			return fs.SkipDir
		}
		return nil
	})
}

// add registers one directory watch.
func (w *watcher) add(dir string) (int32, error) {
	mask := uint32(syscall.IN_CREATE | syscall.IN_DELETE | syscall.IN_MOVED_FROM |
		syscall.IN_MOVED_TO | syscall.IN_CLOSE_WRITE | syscall.IN_ATTRIB |
		syscall.IN_DELETE_SELF | syscall.IN_MOVE_SELF | syscall.IN_ONLYDIR)
	wd, err := syscall.InotifyAddWatch(w.fd, dir, mask)
	if err != nil {
		return -1, fmt.Errorf("inotify_add_watch %s: %w%s", dir, err, inotifyLimitHint(err))
	}
	id := int32(wd)
	w.mu.Lock()
	_, existed := w.wdDir[id]
	w.wdDir[id] = dir
	w.dirWD[dir] = id
	if !existed {
		w.dirsWatched++
	}
	w.mu.Unlock()
	return id, nil
}

// transientWatchError reports path races that do not mean incomplete coverage:
// a directory disappeared between the walk's readdir and lstat/add-watch.
func transientWatchError(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ENOTDIR)
}

// noteWatchFailure counts a directory that could not be watched. The periodic
// refresh fallback makes up for the missing notifications.
func (w *watcher) noteWatchFailure(err error) {
	if err == nil {
		return
	}
	w.mu.Lock()
	w.dirsFailed++
	w.mu.Unlock()
	w.markDegraded(fmt.Sprintf("inotify coverage is incomplete (%d directorie(s) unwatched): %v", w.failedDirs(), err))
}

func (w *watcher) failedDirs() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.dirsFailed
}

func (w *watcher) removeWatch(dir string) {
	w.mu.Lock()
	id, ok := w.dirWD[dir]
	if ok {
		delete(w.dirWD, dir)
		delete(w.wdDir, id)
		w.dirsWatched--
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
					if err := w.addTree(path, false); err != nil {
						w.report(err)
					}
					w.upsert(path)
					// A directory moved in from outside the tree already has
					// contents; its own watch cannot replay them.
					w.indexTree(path)
				}
			case mask&(syscall.IN_DELETE|syscall.IN_MOVED_FROM) != 0:
				w.remove(path, true)
				w.removeWatch(path)
			}
		default:
			switch {
			case mask&(syscall.IN_CREATE|syscall.IN_CLOSE_WRITE|syscall.IN_ATTRIB|syscall.IN_MOVED_TO|syscall.IN_MODIFY) != 0:
				w.upsert(path)
			case mask&(syscall.IN_DELETE|syscall.IN_MOVED_FROM) != 0:
				w.remove(path, false)
			}
		}
	}
}

// remove deletes one path, sweeping the subtree only for directories.
func (w *watcher) remove(path string, isDir bool) {
	if isDir || w.ix.IsDir(path) {
		w.ix.RemoveSubtree(path)
		return
	}
	w.ix.RemovePath(path)
}

// indexTree adds existing files below root without touching watches.
func (w *watcher) indexTree(root string) {
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && excluded(path, d.Name(), w.excludes) {
				return fs.SkipDir
			}
			return nil
		}
		if !excluded(path, d.Name(), w.excludes) {
			w.upsert(path)
		}
		return nil
	})
}

func (w *watcher) upsert(path string) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			w.remove(path, false)
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

// Filesystem magic numbers for mounts where inotify notifications cannot be
// trusted. The watcher still installs its watches (local subtrees may work) but
// reports degraded so the daemon also runs the periodic rebuild.
const (
	nfsSuperMagic  = 0x6969
	smbSuperMagic  = 0x517B
	cifsMagic      = 0xFF534D42
	smb2Magic      = 0xFE534D42
	v9fsMagic      = 0x01021997 // WSL 9p/DrvFs (Windows drives under /mnt)
	fuseSuperMagic = 0x65735546
	cephSuperMagic = 0x00C36400
	afsSuperMagic  = 0x5346414F
	overlayMagic   = 0x794C7630
	ecryptfsMagic  = 0xF15F
	aufsSuperMagic = 0x61756673
)

// unreliableNotifyFS names the filesystem type when inotify cannot report
// changes for root. Network and FUSE mounts either never deliver events or drop
// them silently; WSL DrvFs mounts (Windows drives under /mnt) are the common
// case on this platform.
func unreliableNotifyFS(root string) string {
	var st syscall.Statfs_t
	if err := syscall.Statfs(root, &st); err != nil {
		return ""
	}
	switch magic := uint64(uint32(st.Type)); magic {
	case nfsSuperMagic:
		return "NFS does not deliver inotify events; changes are picked up by the periodic rebuild"
	case smbSuperMagic, cifsMagic, smb2Magic:
		return "SMB/CIFS does not deliver inotify events; changes are picked up by the periodic rebuild"
	case v9fsMagic:
		return "9p/DrvFs (WSL Windows drive) does not deliver inotify events; changes are picked up by the periodic rebuild"
	case fuseSuperMagic:
		return "FUSE may not deliver inotify events; changes are picked up by the periodic rebuild"
	case cephSuperMagic:
		return "Ceph may not deliver inotify events; changes are picked up by the periodic rebuild"
	case afsSuperMagic:
		return "AFS does not deliver inotify events; changes are picked up by the periodic rebuild"
	case overlayMagic, ecryptfsMagic, aufsSuperMagic:
		// Local, but some container/stacked filesystems drop events.
		return ""
	}
	if isWSL() && strings.HasPrefix(filepath.ToSlash(root), "/mnt/") {
		return "WSL DrvFs mount does not deliver inotify events; changes are picked up by the periodic rebuild"
	}
	return ""
}

// inotifyLimitHint appends the configured watch limit to an ENOSPC failure,
// which is the usual reason inotify_add_watch fails on a large tree.
func inotifyLimitHint(err error) string {
	if !errors.Is(err, syscall.ENOSPC) {
		return ""
	}
	if b, readErr := os.ReadFile("/proc/sys/fs/inotify/max_user_watches"); readErr == nil {
		if limit := strings.TrimSpace(string(b)); limit != "" {
			return " (fs.inotify.max_user_watches=" + limit + ")"
		}
	}
	return " (the inotify watch limit may be exhausted)"
}

var (
	wslOnce sync.Once
	wslHost bool
)

func isWSL() bool {
	wslOnce.Do(func() {
		b, err := os.ReadFile("/proc/version")
		wslHost = err == nil && strings.Contains(strings.ToLower(string(b)), "microsoft")
	})
	return wslHost
}
