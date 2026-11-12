//go:build windows

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
	"unsafe"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

const (
	fileListDirectory      = 0x00000001
	fileShareRead          = 0x00000001
	fileShareWrite         = 0x00000002
	fileShareDelete        = 0x00000004
	openExisting           = 3
	fileFlagBackupSemantic = 0x02000000

	notifyChangeFileName   = 0x00000001
	notifyChangeDirName    = 0x00000002
	notifyChangeAttributes = 0x00000004
	notifyChangeSize       = 0x00000008
	notifyChangeLastWrite  = 0x00000010
	notifyChangeCreation   = 0x00000040

	actionAdded      = 1
	actionRemoved    = 2
	actionModified   = 3
	actionRenamedOld = 4
	actionRenamedNew = 5

	// Win32 error codes; syscall does not export every one of them.
	errorInvalidHandle    = syscall.Errno(6)
	errorOperationAborted = syscall.Errno(995)
)

type fileNotifyInformation struct {
	NextEntryOffset uint32
	Action          uint32
	FileNameLength  uint32
	FileName        [1]uint16
}

var (
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	procReadDirectoryChangesW = kernel32.NewProc("ReadDirectoryChangesW")
	procCancelIoEx            = kernel32.NewProc("CancelIoEx")
)

type watcher struct {
	ix       *index.Index
	roots    []string
	excludes []string
	onError  func(error)

	onDegraded func(Health)

	mu         sync.Mutex
	watched    []watchedRoot // root and handle always travel together
	closed     bool
	degraded   bool
	reasons    []string
	dirsFailed int
	done       chan struct{}
}

// watchedRoot keeps one root path and its directory handle paired, so a root
// that failed to open never shifts the index of another root's handle.
type watchedRoot struct {
	root   string
	handle syscall.Handle
}

func newWatcher(ix *index.Index, opt Options) (Watcher, error) {
	w := &watcher{
		ix:         ix,
		roots:      opt.Roots,
		excludes:   opt.Excludes,
		onError:    opt.OnError,
		onDegraded: opt.OnDegraded,
		done:       make(chan struct{}),
	}
	var firstErr error
	for _, root := range opt.Roots {
		h, err := openRoot(root)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			w.report(fmt.Errorf("watch %s: %w", root, err))
			w.markDegraded(fmt.Sprintf("root %s could not be opened: %v", root, err))
			continue
		}
		w.mu.Lock()
		w.watched = append(w.watched, watchedRoot{root: root, handle: h})
		w.mu.Unlock()
	}
	w.mu.Lock()
	opened := len(w.watched)
	w.mu.Unlock()
	if opened == 0 {
		// Nothing can be watched: let the server switch to the refresh fallback
		// instead of pretending the index is live.
		return nil, fmt.Errorf("ReadDirectoryChangesW: no root could be watched: %w", firstErr)
	}
	return w, nil
}

func openRoot(root string) (syscall.Handle, error) {
	name, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return 0, err
	}
	return syscall.CreateFile(
		name,
		fileListDirectory,
		fileShareRead|fileShareWrite|fileShareDelete,
		nil,
		openExisting,
		fileFlagBackupSemantic,
		0,
	)
}

func (w *watcher) report(err error) {
	if w.onError != nil {
		w.onError(err)
	}
}

// Health reports how many roots still have a live ReadDirectoryChangesW loop.
func (w *watcher) Health() Health {
	w.mu.Lock()
	defer w.mu.Unlock()
	return Health{
		Roots:    len(w.roots),
		Watching: len(w.watched),
		Degraded: w.degraded || len(w.watched) < len(w.roots),
		Reason:   strings.Join(w.reasons, "; "),
	}
}

// markDegraded records incomplete coverage and notifies the daemon once, so it
// can start the periodic rebuild for the roots that are not watched.
func (w *watcher) markDegraded(reason string) {
	if reason == "" {
		return
	}
	w.mu.Lock()
	first := !w.degraded && !w.closed
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
	h := Health{
		Roots:    len(w.roots),
		Watching: len(w.watched),
		Degraded: true,
		Reason:   strings.Join(w.reasons, "; "),
	}
	w.mu.Unlock()
	if first && w.onDegraded != nil {
		w.onDegraded(h)
	}
}

// noteRootStopped drops a handle whose read loop ended and records why.
func (w *watcher) noteRootStopped(root string, err error) {
	w.mu.Lock()
	closed := w.closed
	for i, wr := range w.watched {
		if wr.root != root {
			continue
		}
		w.watched = append(w.watched[:i], w.watched[i+1:]...)
		break
	}
	remaining := len(w.watched)
	w.mu.Unlock()
	if closed {
		return // a deliberate Close, not a failure
	}
	reason := fmt.Sprintf("root %s stopped being watched", root)
	if err != nil {
		reason += ": " + err.Error()
	}
	w.markDegraded(reason)
	if remaining == 0 {
		w.markDegraded("no root is watched any more")
	}
}

func (w *watcher) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	handles := make([]syscall.Handle, 0, len(w.watched))
	for _, wr := range w.watched {
		handles = append(handles, wr.handle)
	}
	w.watched = nil
	w.mu.Unlock()
	close(w.done)
	for _, h := range handles {
		// CancelIoEx makes a synchronous ReadDirectoryChangesW return before
		// the handle disappears; CloseHandle alone can leave it blocked.
		_, _, _ = procCancelIoEx.Call(uintptr(h), 0)
		_ = syscall.CloseHandle(h)
	}
	return nil
}

func (w *watcher) Run(ctx context.Context) error {
	w.mu.Lock()
	watched := append([]watchedRoot(nil), w.watched...)
	w.mu.Unlock()
	type loopExit struct {
		root string
		err  error
	}
	exits := make(chan loopExit, len(watched))
	for _, wr := range watched {
		go func(root string, handle syscall.Handle) {
			exits <- loopExit{root: root, err: w.readLoop(ctx, root, handle)}
		}(wr.root, wr.handle)
	}
	go func() {
		select {
		case <-ctx.Done():
			_ = w.Close()
		case <-w.done:
		}
	}()
	var firstErr error
	for range watched {
		exit := <-exits
		if ctx.Err() != nil {
			continue
		}
		if exit.err != nil && firstErr == nil {
			firstErr = exit.err
		}
		if remaining := w.Health().Watching; remaining < len(watched) {
			// One root of several died: keep the others running, but tell the
			// daemon so the periodic rebuild covers the gap.
			w.noteRootStopped(exit.root, exit.err)
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if firstErr == nil {
		firstErr = errors.New("all watched roots stopped")
	}
	return firstErr
}

func (w *watcher) readLoop(ctx context.Context, root string, h syscall.Handle) error {
	const filter = notifyChangeFileName | notifyChangeDirName | notifyChangeAttributes |
		notifyChangeSize | notifyChangeLastWrite | notifyChangeCreation
	buf := make([]byte, 128*1024)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var returned uint32
		ok, _, callErr := procReadDirectoryChangesW.Call(
			uintptr(h),
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(len(buf)),
			1, // watch subtree
			uintptr(filter),
			uintptr(unsafe.Pointer(&returned)),
			0,
			0,
		)
		if ok == 0 {
			if errors.Is(callErr, errorOperationAborted) || errors.Is(callErr, errorInvalidHandle) {
				return nil
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			err := fmt.Errorf("ReadDirectoryChangesW(%s): %w", root, callErr)
			w.report(err)
			return err
		}
		if returned == 0 {
			// Buffer overflow: the kernel dropped events, so rebuild this root.
			w.rescan(root)
			continue
		}
		w.handleBuffer(root, buf[:returned])
	}
}

func (w *watcher) handleBuffer(root string, buf []byte) {
	pendingOld := ""
	for off := 0; off+12 <= len(buf); {
		entry := (*fileNotifyInformation)(unsafe.Pointer(&buf[off]))
		nameLen := int(entry.FileNameLength) / 2
		if nameLen > 0 && off+12+int(entry.FileNameLength) <= len(buf) {
			name := syscall.UTF16ToString(unsafe.Slice(&entry.FileName[0], nameLen))
			path := filepath.Join(root, name)
			switch entry.Action {
			case actionAdded, actionModified:
				if w.excludedPath(path) {
					break
				}
				w.upsert(path)
				if info, err := os.Lstat(path); err == nil && info.IsDir() {
					w.addTree(path)
				}
			case actionRemoved:
				w.remove(path)
			case actionRenamedOld:
				pendingOld = path
			case actionRenamedNew:
				if pendingOld != "" {
					w.remove(pendingOld)
					pendingOld = ""
				}
				if !w.excludedPath(path) {
					w.upsert(path)
					if info, err := os.Lstat(path); err == nil && info.IsDir() {
						w.addTree(path)
					}
				}
			}
		}
		if entry.NextEntryOffset == 0 {
			break
		}
		off += int(entry.NextEntryOffset)
	}
	if pendingOld != "" {
		// Renamed out of the watched tree: only the old name arrived.
		w.remove(pendingOld)
	}
}

func (w *watcher) addTree(root string) {
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && w.excludedPath(path) {
				return fs.SkipDir
			}
			w.upsert(path)
			return nil
		}
		if !w.excludedPath(path) {
			w.upsert(path)
		}
		return nil
	})
}

func (w *watcher) rescan(root string) {
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && path != root && w.excludedPath(path) {
			return fs.SkipDir
		}
		w.upsert(path)
		return nil
	})
}

func (w *watcher) remove(path string) {
	if w.ix.IsDir(path) {
		w.ix.RemoveSubtree(path)
		return
	}
	w.ix.RemovePath(path)
}

func (w *watcher) upsert(path string) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			w.remove(path)
		}
		return
	}
	w.ix.AddPath(path, index.FileInfo{
		Size:  info.Size(),
		Mtime: info.ModTime().UnixNano(),
		Mode:  info.Mode(),
	})
}

func (w *watcher) excludedPath(path string) bool {
	if len(w.excludes) == 0 {
		return false
	}
	volume := filepath.VolumeName(path)
	rest := strings.TrimPrefix(path, volume)
	for _, part := range strings.Split(rest, string(filepath.Separator)) {
		if part == "" {
			continue
		}
		for _, pattern := range w.excludes {
			pattern = strings.TrimSpace(pattern)
			if pattern == "" || strings.ContainsAny(pattern, `/\`) {
				continue
			}
			if ok, _ := filepath.Match(pattern, part); ok {
				return true
			}
		}
	}
	return false
}
