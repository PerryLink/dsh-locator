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
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
)

type watcher struct {
	ix       *index.Index
	roots    []string
	excludes []string
	onError  func(error)

	onDegraded   func(Health)
	rootsWatch   int // roots with at least one watch
	rootsSkipped int // roots intentionally not walked (remote filesystems)
	dirsWatched  int
	dirsFailed   int
	degraded     bool
	// limit is the watch directory budget; limited records that a budget or
	// kernel watch limit truncated coverage (an intermediate state covered by
	// the periodic refresh, not a backend failure).
	limit    int
	limited  bool
	excluder *scan.Excluder
	reasons  []string
	// coverage is one entry per requested root once the constructor finished;
	// ready distinguishes startup walk failures (recorded in coverage) from
	// runtime failures (which invalidate per-root attribution).
	coverage []RootCoverage
	ready    bool

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
		excluder:   newExcluder(opt),
		limit:      opt.maxDirs(),
		onError:    opt.OnError,
		onDegraded: opt.OnDegraded,
		fd:         fd,
		wdDir:      make(map[int32]string),
		dirWD:      make(map[string]int32),
		started:    time.Now(),
		stopCh:     make(chan struct{}),
	}
	// Install watches from the directory records the index already holds instead
	// of walking every root a second time. On a 155k-directory profile the
	// startup walk cost 2.5-2.8s warm (up to 80s cold) before any event could be
	// delivered; the index records are the same list the scan just produced.
	dirs, owners, counts, truncated := w.indexDirectories()
	if len(dirs) == 0 {
		// No directory record to start from (bare or empty index): keep the
		// pre-0.20 startup walk so direct callers and first-run edge cases still
		// install watches.
		w.installByWalk(opt.Roots)
	} else {
		w.installFromIndex(opt.Roots, dirs, owners, counts, truncated)
	}
	if w.watchedDirCount() == 0 {
		w.mu.Lock()
		skipped := w.rootsSkipped
		limited := w.limited
		w.mu.Unlock()
		if skipped == 0 && !limited {
			_ = syscall.Close(fd)
			return nil, fmt.Errorf("inotify: no directory could be watched (check fs.inotify.max_user_watches)")
		}
		// Every root was intentionally skipped (for example a 9p-only profile) or
		// the watch budget is exhausted. A degraded watcher with no watches is
		// still useful: it reports the reason and lets the daemon run the
		// periodic rebuild fallback.
	}
	w.mu.Lock()
	w.ready = true
	w.mu.Unlock()
	return w, nil
}

// maxDirEnumeration bounds the directory paths the watcher materialises from
// the index. Beyond it the extra directories cannot be watched anyway (the
// default budget is 120k), so the list is truncated and every root is reported
// limited, which keeps the daemon on the periodic-refresh path.
const maxDirEnumeration = 300_000

// indexDirectories streams the live directory records once and attributes each
// to the configured root that contains it. counts are complete even when the
// path list is truncated; owners runs parallel to paths.
func (w *watcher) indexDirectories() (paths []string, owners []int16, counts []int, truncated bool) {
	if w.ix == nil || len(w.roots) == 0 {
		return nil, nil, nil, false
	}
	counts = make([]int, len(w.roots))
	after := int32(0)
	for {
		page, next, done := w.ix.DirPage(after, 4096)
		for _, dir := range page {
			owner := rootIndexFor(dir, w.roots)
			if owner < 0 {
				continue
			}
			counts[owner]++
			if len(paths) < maxDirEnumeration {
				paths = append(paths, dir)
				owners = append(owners, int16(owner))
			} else {
				truncated = true
			}
		}
		if done {
			break
		}
		after = next
	}
	return paths, owners, counts, truncated
}

// installByWalk is the startup walk used when the index holds no directory
// records (bare index, direct watcher.New callers).
func (w *watcher) installByWalk(roots []string) {
	for _, root := range roots {
		cov := RootCoverage{Path: root}
		reason, skip := classifyRoot(root)
		if reason != "" {
			cov.Reason = reason
			w.markDegraded(reason)
			// Remote/9p roots never deliver usable inotify events: do not walk
			// their trees. The periodic rebuild fallback keeps them converging.
			if skip {
				w.mu.Lock()
				w.rootsSkipped++
				w.coverage = append(w.coverage, cov)
				w.mu.Unlock()
				continue
			}
		}
		before := w.watchedDirCount()
		beforeFailures := w.failedDirs()
		if err := w.addTree(root, true); err != nil {
			w.report(err)
		}
		watched := w.watchedDirCount() > before
		failures := w.failedDirs() - beforeFailures
		if watched {
			w.mu.Lock()
			w.rootsWatch++
			w.mu.Unlock()
		}
		cov.Limited = w.limited
		switch {
		case reason != "":
			// The filesystem may still drop events (FUSE/stacked mounts), so
			// keep the root in the rescan set even though it was walked.
		case w.limited:
			cov.Reason = w.limitMessage()
		case watched && failures == 0:
			cov.Watched = true
		case watched:
			cov.Reason = fmt.Sprintf("inotify coverage is incomplete (%d directorie(s) could not be watched)", failures)
		default:
			cov.Reason = "no directory below this root could be watched"
		}
		w.mu.Lock()
		w.coverage = append(w.coverage, cov)
		w.mu.Unlock()
	}
}

// installFromIndex installs one inotify watch per indexed directory, in index
// order, while respecting the watch budget. A root whose directories are all
// watched is reported healthy; a root cut short by the budget is reported as
// unwatched-but-limited so the periodic refresh rescans exactly that root.
func (w *watcher) installFromIndex(roots, dirs []string, owners []int16, counts []int, truncated bool) {
	for i, root := range roots {
		cov := RootCoverage{Path: root}
		reason, skip := classifyRoot(root)
		if reason != "" {
			cov.Reason = reason
			w.markDegraded(reason)
			if skip {
				w.mu.Lock()
				w.rootsSkipped++
				w.coverage = append(w.coverage, cov)
				w.mu.Unlock()
				continue
			}
		}
		beforeFailures := w.failedDirs()
		added := 0
		limitHit := false
		for j, dir := range dirs {
			if int(owners[j]) != i {
				continue
			}
			if dir != root && w.excluder.Skip(dir, dirBase(dir), true) {
				continue
			}
			if w.watchedDirCount() >= w.limit {
				w.noteLimit(w.limitMessage())
				limitHit = true
				break
			}
			if _, err := w.add(dir); err != nil {
				if isWatchLimitErr(err) {
					w.noteLimit(w.limitMessage())
					limitHit = true
					break
				}
				if transientWatchError(err) {
					continue
				}
				w.report(err)
				w.noteWatchFailure(err)
				continue
			}
			added++
		}
		if counts[i] == 0 && !limitHit && !truncated {
			// The snapshot holds no directory record for this root (a root added
			// after the build, or a partially written snapshot): fall back to the
			// startup walk so its changes are still delivered natively.
			fallbackBefore := w.watchedDirCount()
			if err := w.addTree(root, true); err != nil {
				w.report(err)
			}
			added = w.watchedDirCount() - fallbackBefore
		}
		failures := w.failedDirs() - beforeFailures
		if added > 0 {
			w.mu.Lock()
			w.rootsWatch++
			w.mu.Unlock()
		}
		limited := limitHit || truncated || added < counts[i]
		cov.Limited = limited
		switch {
		case reason != "":
			// Filesystem may still drop events; keep the root in the rescan set.
		case limited:
			cov.Reason = fmt.Sprintf("watch directory budget reached (%d of %d directories watched); the periodic refresh covers the rest", added, counts[i])
		case failures > 0:
			cov.Reason = fmt.Sprintf("inotify coverage is incomplete (%d directorie(s) could not be watched)", failures)
		case added == 0:
			cov.Reason = "no directory below this root could be watched"
		default:
			cov.Watched = true
		}
		w.mu.Lock()
		w.coverage = append(w.coverage, cov)
		w.mu.Unlock()
	}
}

// noteLimit records that a budget or kernel watch limit truncated coverage and
// notifies the daemon once.
func (w *watcher) noteLimit(reason string) {
	w.mu.Lock()
	first := !w.limited
	w.limited = true
	w.mu.Unlock()
	if first {
		w.markDegraded(reason)
	}
}

// limitMessage explains the truncated coverage in one line.
func (w *watcher) limitMessage() string {
	return fmt.Sprintf("watch directory budget reached (%d of %d directories); the periodic refresh covers the rest", w.watchedDirCount(), w.limit)
}

// dirBase returns the last path component without allocating for the common
// case.
func dirBase(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[i+1:]
		}
	}
	return p
}

// dirUnderRoot reports whether dir is root or below it.
func dirUnderRoot(dir, root string) bool {
	if dir == root {
		return true
	}
	if len(dir) <= len(root) || dir[:len(root)] != root {
		return false
	}
	return dir[len(root)] == '/'
}

// rootIndexFor returns the most specific configured root containing dir, or -1.
func rootIndexFor(dir string, roots []string) int {
	best := -1
	for i, root := range roots {
		if !dirUnderRoot(dir, root) {
			continue
		}
		if best < 0 || len(root) > len(roots[best]) {
			best = i
		}
	}
	return best
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
	degraded := w.degraded || w.limited || w.rootsWatch < len(w.roots) || w.dirsFailed > 0
	if w.rootsWatch < len(w.roots) && len(reasons) == 0 {
		reasons = []string{fmt.Sprintf("%d of %d root(s) could not be watched", len(w.roots)-w.rootsWatch, len(w.roots))}
	}
	var coverage []RootCoverage
	if len(w.coverage) > 0 {
		coverage = make([]RootCoverage, len(w.coverage))
		copy(coverage, w.coverage)
	}
	return Health{
		Roots:    len(w.roots),
		Watching: w.rootsWatch,
		Dirs:     w.dirsWatched,
		Degraded: degraded,
		Reason:   strings.Join(reasons, "; "),
		Coverage: coverage,
		Limit:    w.limit,
		Limited:  w.limited,
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
		if path != root && w.excluder.Skip(path, d.Name(), true) {
			return fs.SkipDir
		}
		_, werr := w.add(path)
		if werr != nil {
			if isWatchLimitErr(werr) {
				// Budget exhausted: stop walking instead of reporting every
				// remaining directory as a failure.
				return fs.SkipAll
			}
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

// add registers one directory watch. It refuses to grow past the directory
// budget and reports the limit as an intermediate state.
func (w *watcher) add(dir string) (int32, error) {
	w.mu.Lock()
	_, already := w.dirWD[dir]
	over := !already && w.limit > 0 && w.dirsWatched >= w.limit
	w.mu.Unlock()
	if over {
		w.noteLimit(w.limitMessage())
		return -1, errWatchLimit
	}
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
	if w.ready {
		// A directory that failed to watch after startup cannot be attributed
		// to one root, so the daemon must fall back to a full rebuild instead
		// of trusting the per-root coverage snapshot.
		w.coverage = nil
	}
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

// rootLost marks the coverage entry for a watched root whose watch was removed
// (the directory itself was deleted or moved). The daemon then knows this root
// must be rescanned by the periodic refresh instead of being reused.
func (w *watcher) rootLost(dir string) {
	w.mu.Lock()
	found := false
	for i := range w.coverage {
		if w.coverage[i].Path == dir && w.coverage[i].Watched {
			w.coverage[i].Watched = false
			w.coverage[i].Reason = "root watch was removed (directory deleted or moved)"
			found = true
			break
		}
	}
	if found && w.rootsWatch > 0 {
		w.rootsWatch--
	}
	w.mu.Unlock()
	if found {
		w.markDegraded("a watched root was deleted or moved; the periodic refresh will rescan it")
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
			w.rootLost(dir)
			continue
		}
		if name == "" {
			// An event about the watched directory itself.
			if mask&(syscall.IN_DELETE_SELF|syscall.IN_MOVE_SELF) != 0 {
				w.ix.RemoveSubtree(dir)
				w.removeWatch(dir)
				w.rootLost(dir)
			}
			continue
		}
		path := filepath.Join(dir, name)
		switch {
		case mask&syscall.IN_ISDIR != 0:
			switch {
			case mask&(syscall.IN_CREATE|syscall.IN_MOVED_TO) != 0:
				if !w.excluder.Skip(path, name, true) {
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
			if path != root && w.excluder.Skip(path, d.Name(), true) {
				return fs.SkipDir
			}
			return nil
		}
		if !w.excluder.Skip(path, d.Name(), false) {
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
			if d.IsDir() && path != root && w.excluder.Skip(path, d.Name(), true) {
				return fs.SkipDir
			}
			w.upsert(path)
			return nil
		})
	}
}

// Filesystem magic numbers for mounts where inotify notifications cannot be
// trusted. Remote filesystems are skipped entirely (no per-directory walk);
// FUSE/stacked roots still install their watches (local subtrees may work) and
// only report degraded so the daemon also runs the periodic rebuild.
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

// classifyRoot reports the degraded reason for one root and whether the
// watcher should skip walking it entirely instead of installing one inotify
// watch per directory. A variable so the linux watcher tests can exercise the
// skipped-root path without a remote mount.
var classifyRoot = classifyRootFS

func classifyRootFS(root string) (reason string, skip bool) {
	reason = unreliableNotifyFS(root)
	if reason == "" {
		return "", false
	}
	return reason, skipTreeWatchFS(root)
}

// skipTreeWatchFS reports whether the walk should skip root entirely. Remote
// filesystems (NFS, SMB/CIFS, Ceph, AFS, WSL 9p/DrvFs) never deliver usable
// events, so walking them only wastes startup/rebuild time and kernel watch
// slots. FUSE and stacked filesystems (overlay/ecryptfs/aufs) are still walked:
// they often do deliver events and remain merely "degraded".
var skipTreeWatchFS = func(root string) bool {
	var st syscall.Statfs_t
	if err := syscall.Statfs(root, &st); err != nil {
		return false
	}
	switch magic := uint64(uint32(st.Type)); magic {
	case nfsSuperMagic, smbSuperMagic, cifsMagic, smb2Magic, v9fsMagic, cephSuperMagic, afsSuperMagic:
		return true
	}
	return isWSL() && strings.HasPrefix(filepath.ToSlash(root), "/mnt/")
}

// unreliableNotifyFS names the filesystem type when inotify cannot report
// changes for root. Network and FUSE mounts either never deliver events or drop
// them silently; WSL DrvFs mounts (Windows drives under /mnt) are the common
// case on this platform. Remote roots are additionally skipped by
// skipTreeWatchFS; FUSE/stacked roots are still walked.
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
