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
	ready := waitForEvent(t, scanner, "ready")
	if ready["entries"].(float64) < 3 {
		t.Fatalf("ready entries = %v", ready["entries"])
	}

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

	writeLine(t, inW, map[string]any{"id": 3, "method": "shutdown"})
	_ = waitForID(t, scanner, 3)
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
