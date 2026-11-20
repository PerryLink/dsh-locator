//go:build windows

package scan

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
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
func tryUSNScan(ctx context.Context, ix *index.Index, opt Options, roots []string, excl *Excluder) (bool, Stats, error) {
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
		if enumErr != nil {
			_ = volume.Close()
			return false, Stats{}, enumErr
		}
		if truncated || len(records) == 0 {
			_ = volume.Close()
			return false, Stats{}, errors.New("USN enumeration produced too many or no records")
		}
		if opt.OnUSNState != nil {
			opt.OnUSNState(USNState{Volume: group.volume, JournalID: journal.ID, NextUSN: journal.NextUSN, Roots: append([]string(nil), group.roots...)})
		}
		items, buildStats := usn.BuildItems(records, usn.BuildOptions{
			VolumeRoot: group.root,
			Roots:      group.roots,
			Excludes:   opt.Excludes,
		})
		// BuildItems knows the pre-0.20 exclude globs; the cache-tree rule and
		// the precompiled matcher live in Excluder, so filter here as well.
		items, buildStats = filterUSNItems(items, excl, buildStats)
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
		startChangeWatcher(ctx, volume, journal, records, group, ix, opt, excl)
	}
	st.Took = time.Since(start)
	return true, st, nil
}

// filterUSNItems drops MFT items that only the cache-tree rule (or a glob the
// USN applier cannot express) excludes, and keeps the build statistics honest.
func filterUSNItems(items []index.AddItem, excl *Excluder, st usn.BuildStats) ([]index.AddItem, usn.BuildStats) {
	if excl == nil || excl.Empty() {
		return items, st
	}
	kept := items[:0]
	for _, item := range items {
		if excl.SkipPath(item.Path, item.Info.Mode.IsDir()) {
			st.Skipped++
			st.Entries--
			if item.Info.Mode.IsDir() {
				st.Dirs--
			} else {
				st.Files--
			}
			continue
		}
		kept = append(kept, item)
	}
	return kept, st
}

// filterUSNRecords resolves each journal record to its current path and drops
// the ones inside an excluded subtree, so the change applier stays consistent
// with the portable scanner default.
func filterUSNRecords(records []usn.Record, paths usn.ChangePaths, excl *Excluder) []usn.Record {
	if excl == nil || excl.Empty() {
		return records
	}
	kept := records[:0]
	for _, record := range records {
		if record.Name == "" {
			kept = append(kept, record)
			continue
		}
		parent := paths[record.ParentFRN]
		if parent == "" {
			kept = append(kept, record)
			continue
		}
		if excl.SkipPath(joinUSNPath(parent, record.Name), record.IsDir()) {
			continue
		}
		kept = append(kept, record)
	}
	return kept
}

// joinUSNPath mirrors the separator handling of the journal applier.
func joinUSNPath(parent, name string) string {
	sep := "\\"
	if strings.Contains(parent, "/") {
		sep = "/"
	}
	if strings.HasSuffix(parent, sep) {
		return parent + name
	}
	return parent + sep + name
}

// startChangeWatcher polls the change journal and applies create/delete/rename
// records. It owns the volume handle from here on and closes it when ctx ends.
// Failures are reported once and stop the watcher; the portable watcher and
// locator_rebuild remain available.
func startChangeWatcher(ctx context.Context, volume *usn.Volume, journal usn.Journal, records []usn.Record, group *volumeGroup, ix *index.Index, opt Options, excl *Excluder) {
	paths := usn.PathsFromRecords(records, group.root)
	go func() {
		defer volume.Close()
		lastUSN := journal.NextUSN
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
			var batch []usn.Record
			if _, err := volume.ReadJournal(journal, lastUSN, func(record usn.Record) bool {
				batch = append(batch, record)
				return len(batch) < 20_000
			}); err != nil {
				if opt.Warn != nil {
					opt.Warn(err)
				}
				return
			}
			if len(batch) == 0 {
				continue
			}
			before := len(batch)
			batch = filterUSNRecords(batch, paths, excl)
			if len(batch) < before {
				// Dropped records can still affect path resolution for later
				// journal entries; keeping the filtered set consistent is enough
				// because a later full refresh converges.
			}
			usn.ApplyChanges(batch, paths, ix, opt.Excludes, group.roots)
			lastUSN = batch[len(batch)-1].USN + 1
			if opt.OnUSNState != nil {
				opt.OnUSNState(USNState{Volume: group.volume, JournalID: journal.ID, NextUSN: lastUSN, Roots: append([]string(nil), group.roots...)})
			}
		}
	}()
}
