//go:build windows

package server

import (
	"context"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/scan"
	"github.com/PerryLink/dsh-locator/engine/internal/usn"
)

const maxCatchUpRecords = 1_000_000

type usnOpened struct {
	volume     *usn.Volume
	journal    usn.Journal
	next       int64
	roots      []string
	volumeName string
}

// resumeUSN validates the persisted journal cursor, applies the records that
// arrived while the daemon was stopped, and keeps polling the journal. It
// returns false (and closes every volume it opened) when any volume cannot be
// resumed, so the caller falls back to the portable watcher.
func (s *Server) resumeUSN(ctx context.Context) bool {
	states := s.loadUSNStates()
	if len(states) == 0 {
		return false
	}
	ix := s.current()
	paths := ix.FRNPaths()
	if len(paths) == 0 {
		return false
	}

	var ready []usnOpened
	for _, state := range states {
		if len(state.Roots) == 0 || !sameRoots(state.Roots, s.opt.Roots) {
			closeOpened(ready)
			return false
		}
		volume, err := usn.OpenVolume(state.Volume)
		if err != nil {
			closeOpened(ready)
			return false
		}
		journal, err := volume.Journal()
		if err != nil || journal.ID != state.JournalID || state.NextUSN < journal.FirstUSN || state.NextUSN > journal.NextUSN+1 {
			_ = volume.Close()
			closeOpened(ready)
			return false
		}
		var records []usn.Record
		truncated := false
		if _, err := volume.ReadJournal(journal, state.NextUSN, func(record usn.Record) bool {
			if len(records) >= maxCatchUpRecords {
				truncated = true
				return false
			}
			records = append(records, record)
			return true
		}); err != nil || truncated {
			_ = volume.Close()
			closeOpened(ready)
			return false
		}
		if len(records) > 0 {
			usn.ApplyChanges(records, paths, ix, s.opt.Excludes, state.Roots)
		}
		next := state.NextUSN
		if len(records) > 0 {
			next = records[len(records)-1].USN + 1
		} else if journal.NextUSN > next {
			next = journal.NextUSN
		}
		s.saveUSNState(scan.USNState{Volume: state.Volume, JournalID: journal.ID, NextUSN: next, Roots: append([]string(nil), state.Roots...)})
		ready = append(ready, usnOpened{volume: volume, journal: journal, next: next, roots: append([]string(nil), state.Roots...), volumeName: state.Volume})
	}

	childCtx, cancel := context.WithCancel(ctx)
	s.usnMu.Lock()
	s.usnCancel = cancel
	s.usnMu.Unlock()
	s.mu.Lock()
	s.usnActive = true
	s.mu.Unlock()
	for _, item := range ready {
		go s.pollUSN(childCtx, item.volume, item.journal, item.next, item.roots, item.volumeName, paths)
	}
	return true
}

func (s *Server) pollUSN(ctx context.Context, volume *usn.Volume, journal usn.Journal, next int64, roots []string, volumeName string, paths usn.ChangePaths) {
	defer volume.Close()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
		var batch []usn.Record
		if _, err := volume.ReadJournal(journal, next, func(record usn.Record) bool {
			batch = append(batch, record)
			return len(batch) < 20_000
		}); err != nil {
			s.logf("usn journal stopped: %v", err)
			s.event("warning", map[string]string{"message": "USN journal stopped: " + err.Error()})
			return
		}
		if len(batch) == 0 {
			continue
		}
		ix := s.current()
		usn.ApplyChanges(batch, paths, ix, s.opt.Excludes, roots)
		next = batch[len(batch)-1].USN + 1
		s.saveUSNState(scan.USNState{Volume: volumeName, JournalID: journal.ID, NextUSN: next, Roots: append([]string(nil), roots...)})
	}
}

func closeOpened(items []usnOpened) {
	for _, item := range items {
		_ = item.volume.Close()
	}
}
