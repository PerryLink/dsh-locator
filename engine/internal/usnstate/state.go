// Package usnstate persists the resumable USN journal cursor for each volume.
package usnstate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/PerryLink/dsh-locator/engine/internal/scan"
)

// File is the on-disk shape.
type File struct {
	Volumes map[string]scan.USNState `json:"volumes"`
}

// Path returns the state file inside a state directory.
func Path(stateDir string) string { return filepath.Join(stateDir, "usn-state.json") }

var writeMu sync.Mutex

// Save merges one volume's cursor and writes the file atomically.
func Save(stateDir string, st scan.USNState) error {
	if stateDir == "" || st.Volume == "" {
		return nil
	}
	writeMu.Lock()
	defer writeMu.Unlock()
	file := File{Volumes: map[string]scan.USNState{}}
	if data, err := os.ReadFile(Path(stateDir)); err == nil {
		_ = json.Unmarshal(data, &file)
		if file.Volumes == nil {
			file.Volumes = map[string]scan.USNState{}
		}
	}
	file.Volumes[st.Volume] = st
	data, err := json.Marshal(file)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return err
	}
	tmp := Path(stateDir) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, Path(stateDir))
}

// Load returns every valid cursor.
func Load(stateDir string) []scan.USNState {
	if stateDir == "" {
		return nil
	}
	data, err := os.ReadFile(Path(stateDir))
	if err != nil {
		return nil
	}
	var file File
	if json.Unmarshal(data, &file) != nil {
		return nil
	}
	out := make([]scan.USNState, 0, len(file.Volumes))
	for _, volume := range file.Volumes {
		if volume.Volume != "" && volume.NextUSN > 0 {
			out = append(out, volume)
		}
	}
	return out
}

// Clear removes the cursor file.
func Clear(stateDir string) error {
	if stateDir == "" {
		return nil
	}
	err := os.Remove(Path(stateDir))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
