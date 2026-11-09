//go:build windows

package scan

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/usn"
)

// maxUSNRecords bounds the records held for one volume. Beyond this the
// portable walk is cheaper in memory and equally correct.
const maxUSNRecords = 4_000_000

type volumeGroup struct {
	volume string
	root   string
	roots  []string
}

// tryUSNScan enumerates each involved volume's MFT. It returns handled=false
// (with no error) when USN is unavailable on any volume, so the caller can
// fall back to the portable walk.
func tryUSNScan(ctx context.Context, ix *index.Index, opt Options, roots []string) (bool, Stats, error) {
	start := time.Now()
	groups := make(map[string]*volumeGroup, 2)
	for _, root := range roots {
		volume := filepath.VolumeName(root)
		if volume == "" {
			return false, Stats{}, errors.New("USN needs a DOS volume path")
		}
		group, ok := groups[volume]
		if !ok {
			group = &volumeGroup{volume: volume, root: volume + `\`}
			groups[volume] = group
		}
		group.roots = append(group.roots, root)
	}

	var st Stats
	st.Roots = len(roots)
	st.USN = true
	for _, group := range groups {
		volume, err := usn.OpenVolume(group.volume)
		if err != nil {
			return false, Stats{}, err
		}
		journal, err := volume.Journal()
		if err != nil {
			_ = volume.Close()
			return false, Stats{}, err
		}
		records := make([]usn.Record, 0, 1<<20)
		truncated := false
		lastReport := time.Now()
		_, enumErr := volume.Enumerate(journal, func(record usn.Record) bool {
			if ctx.Err() != nil {
				return false
			}
			if len(records) >= maxUSNRecords {
				truncated = true
				return false
			}
			records = append(records, record)
			if opt.Progress != nil && time.Since(lastReport) > 250*time.Millisecond {
				lastReport = time.Now()
				opt.Progress(Progress{Entries: st.Entries + int64(len(records)), Dirs: st.Dirs, Current: group.root})
			}
			return true
		})
		_ = volume.Close()
		if enumErr != nil {
			return false, Stats{}, enumErr
		}
		if truncated || len(records) == 0 {
			return false, Stats{}, errors.New("USN enumeration produced too many or no records")
		}
		items, buildStats := usn.BuildItems(records, usn.BuildOptions{
			VolumeRoot: group.root,
			Roots:      group.roots,
			Excludes:   opt.Excludes,
		})
		for _, root := range group.roots {
			ix.AddRoot(root)
			if info, statErr := os.Stat(root); statErr == nil {
				ix.AddPath(root, index.FileInfo{Mode: info.Mode()})
			}
		}
		// Chunk the batch so the index lock is released between chunks.
		const chunk = 50_000
		for start := 0; start < len(items); start += chunk {
			end := start + chunk
			if end > len(items) {
				end = len(items)
			}
			ix.AddBatch(items[start:end])
		}
		st.Entries += buildStats.Entries
		st.Files += buildStats.Files
		st.Dirs += buildStats.Dirs
		st.Skipped += buildStats.Skipped
	}
	st.Took = time.Since(start)
	return true, st, nil
}
