package server

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/PerryLink/dsh-locator/engine/internal/scan"
)

func TestUSNStateRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := &Server{opt: Options{StateDir: dir}}
	s.saveUSNState(scan.USNState{Volume: "C:", JournalID: 7, NextUSN: 100, Roots: []string{`C:\Users\me`}})
	s.saveUSNState(scan.USNState{Volume: "D:", JournalID: 9, NextUSN: 200, Roots: []string{`D:\work`}})
	states := s.loadUSNStates()
	if len(states) != 2 {
		t.Fatalf("states = %d", len(states))
	}
	seen := map[string]scan.USNState{}
	for _, st := range states {
		seen[st.Volume] = st
	}
	if seen["C:"].NextUSN != 100 || seen["C:"].JournalID != 7 || len(seen["C:"].Roots) != 1 {
		t.Fatalf("C: state = %+v", seen["C:"])
	}
	s.clearUSNStates()
	if _, err := os.Stat(filepath.Join(dir, "usn-state.json")); !os.IsNotExist(err) {
		t.Fatalf("state file still exists: %v", err)
	}
	if len(s.loadUSNStates()) != 0 {
		t.Fatal("states survived clear")
	}
}
