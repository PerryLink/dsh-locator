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
)

func TestServeSearchAndStatus(t *testing.T) {
	root := t.TempDir()
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "report.pdf"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	srv := New(Options{StateDir: state, Roots: []string{root}, Watch: false, Version: "test"})
	done := make(chan error, 1)
	go func() { done <- srv.Run(ctx, inR, outW) }()

	scanner := bufio.NewScanner(outR)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	waitForEvent(t, scanner, "ready")
	waitForEntries(t, scanner, inW, 3)

	writeLine(t, inW, map[string]any{"id": 1, "method": "search", "params": map[string]any{"query": "report", "limit": 5}})
	result := waitForID(t, scanner, 1)
	hits := result["hits"].([]any)
	if len(hits) != 1 {
		t.Fatalf("hits = %v", hits)
	}
	hit := hits[0].(map[string]any)
	if hit["name"] != "report.pdf" {
		t.Fatalf("hit = %v", hit)
	}

	writeLine(t, inW, map[string]any{"id": 2, "method": "status"})
	status := waitForID(t, scanner, 2)
	if status["entries"].(float64) < 3 {
		t.Fatalf("status = %v", status)
	}

	writeLine(t, inW, map[string]any{"id": 4, "method": "no-such-method"})
	unknown := waitForMessage(t, scanner, 4)
	if unknown["error"] == nil {
		t.Fatalf("unknown method did not return an error: %v", unknown)
	}

	writeLine(t, inW, map[string]any{"id": 5, "method": "shutdown"})
	_ = waitForID(t, scanner, 5)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop")
	}
}

func waitForEvent(t *testing.T, scanner *bufio.Scanner, name string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		line, ok := readLine(t, scanner)
		if !ok {
			t.Fatal("server closed before ready")
		}
		var message map[string]any
		if err := json.Unmarshal(line, &message); err != nil {
			t.Fatal(err)
		}
		if message["event"] == name {
			params, _ := message["params"].(map[string]any)
			return params
		}
	}
	t.Fatalf("event %q not seen", name)
	return nil
}

// waitForEntries polls status until the asynchronous initial scan has indexed
// at least want entries.
func waitForEntries(t *testing.T, scanner *bufio.Scanner, in io.Writer, want float64) {
	t.Helper()
	nextID := 100
	for attempt := 0; attempt < 100; attempt++ {
		id := float64(nextID)
		nextID++
		writeLine(t, in, map[string]any{"id": id, "method": "status"})
		status := waitForID(t, scanner, id)
		if status["entries"].(float64) >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("entries never reached %v", want)
}

// waitForMessage returns the raw response for id, including error responses.
func waitForMessage(t *testing.T, scanner *bufio.Scanner, id float64) map[string]any {
	t.Helper()
	for {
		line, ok := readLine(t, scanner)
		if !ok {
			t.Fatalf("server closed before response %v", id)
		}
		var message map[string]any
		if err := json.Unmarshal(line, &message); err != nil {
			t.Fatal(err)
		}
		if message["id"] == id {
			return message
		}
	}
}

func waitForID(t *testing.T, scanner *bufio.Scanner, id float64) map[string]any {
	t.Helper()
	for {
		line, ok := readLine(t, scanner)
		if !ok {
			t.Fatalf("server closed before response %v", id)
		}
		var message map[string]any
		if err := json.Unmarshal(line, &message); err != nil {
			t.Fatal(err)
		}
		if message["id"] != id {
			continue
		}
		if rpcErr, ok := message["error"]; ok {
			t.Fatalf("rpc error: %v", rpcErr)
		}
		result, _ := message["result"].(map[string]any)
		return result
	}
}

func readLine(t *testing.T, scanner *bufio.Scanner) ([]byte, bool) {
	t.Helper()
	if !scanner.Scan() {
		return nil, false
	}
	return append([]byte(nil), scanner.Bytes()...), true
}

func writeLine(t *testing.T, w io.Writer, value map[string]any) {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(append(b, '\n')); err != nil {
		t.Fatal(err)
	}
}

func TestFillMissingMetadata(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file.bin")
	if err := os.WriteFile(path, []byte("abc"), 0o644); err != nil {
		t.Fatal(err)
	}
	hits := []index.Hit{{Path: path, Name: "file.bin", Dir: false}}
	fillMissingMetadata(hits)
	if hits[0].Size != 3 || hits[0].Mtime == 0 {
		t.Fatalf("metadata not filled: %+v", hits[0])
	}
}
