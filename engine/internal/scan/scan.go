// Package scan enumerates directory trees into an index.
package scan

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

// Options controls one scan.
type Options struct {
	// Roots are absolute directories to index.
	Roots []string
	// Excludes are base-name globs (node_modules, *.tmp) or path globs; a
	// matching directory is skipped with its whole subtree.
	Excludes []string
	// FollowSymlinks descends into directory symlinks when set.
	FollowSymlinks bool
	// Workers is the number of directory readers; zero uses GOMAXPROCS.
	Workers int
	// WindowsUSN tries the NTFS USN/MFT enumeration first (Windows only,
	// requires administrator rights) and falls back to the portable walk.
	WindowsUSN bool
	// Warn receives non-fatal setup errors, such as a USN probe that was denied.
	Warn func(error)
	// Progress, when set, is called periodically and once at the end.
	Progress func(Progress)
	// ProgressEvery is the minimum interval between progress calls.
	ProgressEvery time.Duration
}

// Progress is one scan progress report.
type Progress struct {
	Root    string
	Entries int64
	Dirs    int64
	Current string
}

// Stats summarizes a completed scan.
type Stats struct {
	Roots   int           `json:"roots"`
	Entries int64         `json:"entries"`
	Dirs    int64         `json:"dirs"`
	Files   int64         `json:"files"`
	Skipped int64         `json:"skipped"`
	Errors  int64         `json:"errors"`
	Workers int           `json:"workers"`
	USN     bool          `json:"usn"`
	Took    time.Duration `json:"tookNs"`
}

// ErrNoRoots is returned when no existing directory was supplied.
var ErrNoRoots = errors.New("no readable root directory")

// Run scans every root into ix. Cancel ctx to stop early; Run then returns the
// entries collected so far and ctx.Err().
func Run(ctx context.Context, ix *index.Index, opt Options) (Stats, error) {
	start := time.Now()
	var st Stats
	var valid []string
	for _, root := range opt.Roots {
		abs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		info, err := os.Stat(abs)
		if err != nil || !info.IsDir() {
			continue
		}
		valid = append(valid, filepath.Clean(abs))
	}
	if len(valid) == 0 {
		return st, ErrNoRoots
	}
	st.Roots = len(valid)

	if opt.WindowsUSN {
		handled, usnStats, usnErr := tryUSNScan(ctx, ix, opt, valid)
		if handled {
			return usnStats, ctx.Err()
		}
		if usnErr != nil && opt.Warn != nil {
			opt.Warn(usnErr)
		}
	}

	workers := opt.Workers
	if workers <= 0 {
		workers = runtime.GOMAXPROCS(0)
	}
	if workers < 1 {
		workers = 1
	}
	if workers > 16 {
		workers = 16
	}
	st.Workers = workers

	var entries, dirs, files, skipped, errs atomic.Int64
	progress := newProgress(opt)

	queue := make(chan string, workers*8)
	var pending sync.WaitGroup
	var workerGroup sync.WaitGroup

	// scanDir reads one directory, appends its entries to a local batch, flushes
	// it before enqueueing subdirectories so a parent record always exists
	// before its children are indexed.
	var scanDir func(path string)
	scanDir = func(path string) {
		if ctx.Err() != nil {
			return
		}
		list, err := os.ReadDir(path)
		if err != nil {
			errs.Add(1)
			progress.report(path, &entries, &dirs)
			return
		}
		batch := make([]index.AddItem, 0, len(list))
		children := make([]string, 0, 8)
		for _, entry := range list {
			if ctx.Err() != nil {
				break
			}
			name := entry.Name()
			child := filepath.Join(path, name)
			isDir := entry.IsDir()
			if excluded(child, name, isDir, opt.Excludes) {
				skipped.Add(1)
				continue
			}
			if isDir {
				dirs.Add(1)
			} else {
				files.Add(1)
			}
			entries.Add(1)
			if entry.Type()&fs.ModeSymlink != 0 && !opt.FollowSymlinks {
				if info, lerr := entry.Info(); lerr == nil {
					batch = append(batch, index.AddItem{Path: child, Info: infoOf(info)})
				}
				continue
			}
			info, ierr := entry.Info()
			if ierr != nil {
				errs.Add(1)
				continue
			}
			batch = append(batch, index.AddItem{Path: child, Info: infoOf(info)})
			if isDir {
				children = append(children, child)
			}
		}
		if len(batch) > 0 {
			ix.AddBatch(batch)
		}
		progress.report(path, &entries, &dirs)
		for _, child := range children {
			if ctx.Err() != nil {
				return
			}
			pending.Add(1)
			select {
			case queue <- child:
			default:
				// The queue is full: scan this subtree inline instead of
				// blocking a producer that might also be the only consumer.
				scanDir(child)
				pending.Done()
			}
		}
	}

	workerGroup.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer workerGroup.Done()
			for dir := range queue {
				scanDir(dir)
				pending.Done()
			}
		}()
	}

	for _, root := range valid {
		if ctx.Err() != nil {
			break
		}
		info, err := os.Stat(root)
		if err != nil {
			errs.Add(1)
			continue
		}
		ix.AddRoot(root)
		ix.AddPath(root, infoOf(info))
		entries.Add(1)
		dirs.Add(1)
		pending.Add(1)
		select {
		case queue <- root:
		default:
			scanDir(root)
			pending.Done()
		}
	}

	// Every queued directory is still counted in pending while it may discover
	// children, so this Wait cannot return with work in flight.
	pending.Wait()
	close(queue)
	workerGroup.Wait()

	st.Entries = entries.Load()
	st.Dirs = dirs.Load()
	st.Files = files.Load()
	st.Skipped = skipped.Load()
	st.Errors = errs.Load()
	st.Took = time.Since(start)
	progress.finish(&entries, &dirs)
	return st, ctx.Err()
}

func excluded(path, name string, isDir bool, patterns []string) bool {
	for _, p := range patterns {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if strings.ContainsAny(p, `/\`) {
			if ok, _ := filepath.Match(p, path); ok {
				return true
			}
			if isDir && strings.HasSuffix(p, "/**") {
				base := strings.TrimSuffix(strings.TrimSuffix(p, "/**"), "/")
				if ok, _ := filepath.Match(base, name); ok {
					return true
				}
			}
			continue
		}
		if ok, _ := filepath.Match(p, name); ok {
			return true
		}
	}
	return false
}

func infoOf(info fs.FileInfo) index.FileInfo {
	return index.FileInfo{
		Size:  info.Size(),
		Mtime: info.ModTime().UnixNano(),
		Mode:  info.Mode(),
	}
}

type progressReporter struct {
	mu      sync.Mutex
	fn      func(Progress)
	every   time.Duration
	last    time.Time
	lastCur string
}

func newProgress(opt Options) *progressReporter {
	every := opt.ProgressEvery
	if every <= 0 {
		every = 250 * time.Millisecond
	}
	return &progressReporter{fn: opt.Progress, every: every, last: time.Now()}
}

func (p *progressReporter) report(current string, entries, dirs *atomic.Int64) {
	if p.fn == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if time.Since(p.last) < p.every {
		return
	}
	p.last = time.Now()
	p.lastCur = current
	p.fn(Progress{Entries: entries.Load(), Dirs: dirs.Load(), Current: current})
}

func (p *progressReporter) finish(entries, dirs *atomic.Int64) {
	if p.fn == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.fn(Progress{Entries: entries.Load(), Dirs: dirs.Load()})
}
