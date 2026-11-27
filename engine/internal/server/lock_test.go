package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/store"
)

// engineHarness runs one server over pipes with a reader goroutine that never
// stops draining events (the server blocks on an unbuffered stdout pipe, so the
// test must keep reading like the plugin runtime does).
type engineHarness struct {
	in        *io.PipeWriter
	events    chan map[string]any
	responses chan map[string]any
	done      chan error
	warnings  []string
	ready     map[string]any
	nextID    int
	// stopped is set after a clean shutdown consumed the Run result, so the
	// cleanup does not wait another full timeout on an empty channel.
	stopped bool
}

func startEngineHarness(t *testing.T, opt Options) *engineHarness {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	srv := New(opt)
	h := &engineHarness{
		in:        inW,
		events:    make(chan map[string]any, 256),
		responses: make(chan map[string]any, 16),
		done:      make(chan error, 1),
		nextID:    900,
	}
	go func() { h.done <- srv.Run(ctx, inR, outW) }()
	go func() {
		scanner := bufio.NewScanner(outR)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)
		for scanner.Scan() {
			var message map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
				continue
			}
			if message["event"] != nil {
				h.events <- message
			} else {
				h.responses <- message
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		_ = inW.Close()
		if h.stopped {
			return
		}
		select {
		case <-h.done:
		case <-time.After(5 * time.Second):
		}
	})
	deadline := time.After(10 * time.Second)
	for {
		select {
		case event := <-h.events:
			if event["event"] == "warning" {
				if params, ok := event["params"].(map[string]any); ok {
					if text, ok := params["message"].(string); ok {
						h.warnings = append(h.warnings, text)
					}
				}
			}
			if event["event"] == "ready" {
				h.ready, _ = event["params"].(map[string]any)
				// Keep the pipe drained for the rest of the test; tests read state
				// through RPCs, not through the event stream.
				go func() {
					for range h.events {
					}
				}()
				return h
			}
		case <-deadline:
			t.Fatal("server never emitted ready")
		}
	}
}

func (h *engineHarness) request(t *testing.T, method string, params map[string]any) map[string]any {
	t.Helper()
	h.nextID++
	id := float64(h.nextID)
	payload := map[string]any{"id": id, "method": method}
	if params != nil {
		payload["params"] = params
	}
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.in.Write(append(b, '\n')); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(10 * time.Second)
	for {
		select {
		case message := <-h.responses:
			if message["id"] != id {
				continue
			}
			if rpcErr, ok := message["error"]; ok {
				t.Fatalf("rpc error: %v", rpcErr)
			}
			result, _ := message["result"].(map[string]any)
			return result
		case <-deadline:
			t.Fatalf("no response to %q", method)
		}
	}
}

// waitEntries polls status until the initial scan is done and want entries are
// indexed.
func (h *engineHarness) waitEntries(t *testing.T, want float64) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		status := h.request(t, "status", nil)
		if status["scanning"] != true && status["entries"].(float64) >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("entries never reached %v", want)
}

func (h *engineHarness) stop(t *testing.T) {
	t.Helper()
	h.request(t, "shutdown", nil)
	select {
	case err := <-h.done:
		h.stopped = true
		if err != nil {
			t.Fatalf("server shutdown: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("server did not stop")
	}
}

// waitForFile polls until path exists.
func waitForFile(t *testing.T, path string) os.FileInfo {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if info, err := os.Stat(path); err == nil {
			return info
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("file %s never appeared", path)
	return nil
}

// newTestRoot builds a small indexed tree.
func newTestRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "b.txt"), []byte("b"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// TestEngineOwnsStateDirLock: the first engine takes the write lock and releases
// it on a clean shutdown.
func TestEngineOwnsStateDirLock(t *testing.T) {
	root := newTestRoot(t)
	state := t.TempDir()
	h := startEngineHarness(t, Options{StateDir: state, Roots: []string{root}, Watch: false, Version: "test"})
	if h.ready["readOnly"] == true {
		t.Fatalf("readOnly moved into the ready payload: %v", h.ready)
	}
	if h.ready["lockPid"].(float64) != float64(os.Getpid()) {
		t.Fatalf("lockPid = %v, want %d", h.ready["lockPid"], os.Getpid())
	}
	info, err := store.ReadLock(state)
	if err != nil {
		t.Fatalf("lock file: %v", err)
	}
	if info.PID != os.Getpid() {
		t.Fatalf("lock pid = %d", info.PID)
	}
	h.stop(t)
	if _, err := os.Stat(store.LockPath(state)); !os.IsNotExist(err) {
		t.Fatalf("lock survived a clean shutdown: %v", err)
	}
}

// TestSecondEngineServesReadOnly simulates the HMR double-engine case: a second
// server on the same state directory must serve the snapshot but never write.
func TestSecondEngineServesReadOnly(t *testing.T) {
	root := newTestRoot(t)
	state := t.TempDir()
	first := startEngineHarness(t, Options{StateDir: state, Roots: []string{root}, Watch: false, Version: "test", SaveDebounce: 20 * time.Millisecond})
	first.waitEntries(t, 3)
	snap, metaPath := store.Paths(state)
	waitForFile(t, snap)
	metaInfo := waitForFile(t, metaPath)
	snapInfo := waitForFile(t, snap)

	second := startEngineHarness(t, Options{StateDir: state, Roots: []string{root}, Watch: false, Version: "test"})
	if second.ready["readOnly"] != true {
		t.Fatalf("second engine is not read-only: %v", second.ready)
	}
	if second.ready["lockPid"].(float64) != float64(os.Getpid()) {
		t.Fatalf("second engine reports the wrong lock owner: %v", second.ready)
	}
	if second.ready["entries"].(float64) < 3 {
		t.Fatalf("read-only engine did not load the snapshot: %v", second.ready)
	}
	if len(second.warnings) == 0 {
		t.Fatal("read-only engine emitted no warning about the lock owner")
	}
	second.stop(t)
	// The read-only instance must leave the owner's files untouched.
	if info, err := os.Stat(snap); err != nil || !info.ModTime().Equal(snapInfo.ModTime()) || info.Size() != snapInfo.Size() {
		t.Fatalf("read-only engine rewrote the snapshot: %v", err)
	}
	if info, err := os.Stat(metaPath); err != nil || !info.ModTime().Equal(metaInfo.ModTime()) {
		t.Fatalf("read-only engine rewrote meta.json: %v", err)
	}
	if _, err := store.ReadLock(state); err != nil {
		t.Fatalf("read-only engine removed the owner's lock: %v", err)
	}
	first.stop(t)
}

// TestReadOnlyEngineTakesOverWhenOwnerExits: the HMR handover must let the new
// instance start writing once the old engine released the directory.
func TestReadOnlyEngineTakesOverWhenOwnerExits(t *testing.T) {
	root := newTestRoot(t)
	state := t.TempDir()
	ix := index.New()
	ix.AddRoot(root)
	ix.AddPath(filepath.Join(root, "a.txt"), index.FileInfo{Size: 1, Mtime: 10})
	if err := store.Save(state, ix, store.Meta{Version: "test"}); err != nil {
		t.Fatal(err)
	}
	// Simulate the previous plugin instance still owning the state directory.
	owner, holder, err := store.AcquireLock(state, "test")
	if err != nil || owner == nil || holder != nil {
		t.Fatalf("test lock: %v %v %v", owner, holder, err)
	}
	h := startEngineHarness(t, Options{StateDir: state, Roots: []string{root}, Watch: false, Version: "test", SaveDebounce: 20 * time.Millisecond})
	if h.ready["readOnly"] != true {
		t.Fatalf("engine with a held lock is not read-only: %v", h.ready)
	}
	if err := owner.Release(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	upgraded := false
	for time.Now().Before(deadline) {
		status := h.request(t, "status", nil)
		if status["readOnly"] != true {
			upgraded = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !upgraded {
		t.Fatal("read-only engine never took the released write lock")
	}
	if info, err := store.ReadLock(state); err != nil || info.PID != os.Getpid() {
		t.Fatalf("engine did not record the new lock owner: %+v %v", info, err)
	}
	h.stop(t)
	if _, err := os.Stat(store.LockPath(state)); !os.IsNotExist(err) {
		t.Fatalf("released lock survived: %v", err)
	}
}

// TestUnwritableStateDirFallsBackToReadOnly: a state directory that cannot be
// locked/created must not disable search; the engine serves from memory and
// writes nothing.
func TestUnwritableStateDirFallsBackToReadOnly(t *testing.T) {
	root := newTestRoot(t)
	blocker := filepath.Join(t.TempDir(), "state-is-a-file")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := startEngineHarness(t, Options{StateDir: blocker, Roots: []string{root}, Watch: false, Version: "test", SaveDebounce: 20 * time.Millisecond})
	if h.ready["readOnly"] != true {
		t.Fatalf("unlockable state dir is not read-only: %v", h.ready)
	}
	if len(h.warnings) == 0 {
		t.Fatal("no warning about the unusable state directory")
	}
	h.waitEntries(t, 3)
	h.stop(t)
	b, err := os.ReadFile(blocker)
	if err != nil || string(b) != "x" {
		t.Fatalf("state path was modified: %q %v", b, err)
	}
}

// TestBootstrapRebuildsMissingMeta: a deleted meta.json must not trigger a
// rescan; the server loads the snapshot and rewrites the metadata.
func TestBootstrapRebuildsMissingMeta(t *testing.T) {
	root := newTestRoot(t)
	state := t.TempDir()
	ix := index.New()
	ix.AddRoot(root)
	ix.AddPath(filepath.Join(root, "a.txt"), index.FileInfo{Size: 1, Mtime: 10})
	ix.AddPath(filepath.Join(root, "b.txt"), index.FileInfo{Size: 2, Mtime: 20})
	if err := store.Save(state, ix, store.Meta{Version: "test"}); err != nil {
		t.Fatal(err)
	}
	_, metaPath := store.Paths(state)
	if err := os.Remove(metaPath); err != nil {
		t.Fatal(err)
	}
	h := startEngineHarness(t, Options{StateDir: state, Roots: []string{root}, Watch: false, Version: "test", SaveDebounce: 20 * time.Millisecond})
	if h.ready["entries"].(float64) != 3 {
		t.Fatalf("rebuilt-meta bootstrap rescanned instead of loading: %v", h.ready)
	}
	if len(h.warnings) == 0 {
		t.Fatal("missing meta.json was not reported as a warning")
	}
	h.stop(t)
	b, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("rebuilt meta.json was not persisted: %v", err)
	}
	var meta store.Meta
	if err := json.Unmarshal(b, &meta); err != nil {
		t.Fatal(err)
	}
	if meta.IndexStats == nil || meta.IndexStats.Entries != 3 {
		t.Fatalf("persisted meta has no correct indexStats: %+v", meta.IndexStats)
	}
}
