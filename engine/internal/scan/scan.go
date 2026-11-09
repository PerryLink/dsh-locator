// Package scan enumerates directory trees into an index.
package scan

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
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

	every := opt.ProgressEvery
	if every <= 0 {
		every = 250 * time.Millisecond
	}
	last := time.Now()
	report := func(root, current string) {
		if opt.Progress == nil || time.Since(last) < every {
			return
		}
		last = time.Now()
		opt.Progress(Progress{Root: root, Entries: st.Entries, Dirs: st.Dirs, Current: current})
	}

	var walkErr error
	for _, root := range valid {
		if err := ctx.Err(); err != nil {
			walkErr = err
			break
		}
		rootInfo, err := os.Stat(root)
		if err != nil {
			st.Errors++
			continue
		}
		ix.AddRoot(root)
		ix.AddPath(root, infoOf(rootInfo))

		err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			if err != nil {
				// Permission denied on one subtree must not abort the scan.
				st.Errors++
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if path != root && excluded(path, d.Name(), d.IsDir(), opt.Excludes) {
				st.Skipped++
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if d.IsDir() {
				st.Dirs++
			} else {
				st.Files++
			}
			st.Entries++
			if d.Type()&fs.ModeSymlink != 0 && !opt.FollowSymlinks {
				if li, lerr := os.Lstat(path); lerr == nil {
					ix.AddPath(path, infoOf(li))
				}
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			info, ierr := d.Info()
			if ierr != nil {
				st.Errors++
				return nil
			}
			ix.AddPath(path, infoOf(info))
			report(root, path)
			return nil
		})
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				walkErr = err
				break
			}
			// WalkDir already counted per-entry failures; a root-level failure
			// still leaves the rest indexed.
			st.Errors++
		}
	}
	st.Took = time.Since(start)
	if opt.Progress != nil {
		opt.Progress(Progress{Entries: st.Entries, Dirs: st.Dirs})
	}
	return st, walkErr
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
			// A directory pattern such as `**/node_modules/**` is matched by
			// its base-name segment when the full path does not match.
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
