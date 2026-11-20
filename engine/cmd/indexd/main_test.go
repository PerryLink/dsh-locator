package main

import (
	"path/filepath"
	"testing"
	"time"
)

// TestParseServeFlagsUnwatchedRefresh pins the --unwatched-refresh contract:
// the engine default is 10 minutes (so an older plugin that does not pass the
// flag still gets the faster watcher-less cadence) and an explicit 0 follows
// --refresh.
func TestParseServeFlagsUnwatchedRefresh(t *testing.T) {
	state := t.TempDir()
	root := t.TempDir()
	tests := []struct {
		name    string
		args    []string
		want    time.Duration
		wantErr bool
	}{
		{
			name: "engine default is ten minutes",
			args: []string{"--state", state, "--root", root},
			want: 10 * time.Minute,
		},
		{
			name: "explicit zero follows --refresh",
			args: []string{"--state", state, "--root", root, "--unwatched-refresh", "0"},
			want: 0,
		},
		{
			name: "explicit cadence",
			args: []string{"--state", state, "--root", root, "--unwatched-refresh", "90s"},
			want: 90 * time.Second,
		},
		{
			name:    "negative is rejected",
			args:    []string{"--state", state, "--root", root, "--unwatched-refresh", "-1s"},
			wantErr: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f, err := parseServeFlags(tc.args)
			if err != nil {
				t.Fatalf("parseServeFlags: %v", err)
			}
			opt, err := f.options()
			if tc.wantErr {
				if err == nil {
					t.Fatal("options accepted a negative --unwatched-refresh")
				}
				return
			}
			if err != nil {
				t.Fatalf("options: %v", err)
			}
			if opt.UnwatchedRefreshInterval != tc.want {
				t.Fatalf("UnwatchedRefreshInterval = %v, want %v", opt.UnwatchedRefreshInterval, tc.want)
			}
		})
	}
}

// TestServeOptionsWireRefreshIntervals: both refresh flags reach the engine
// options together so the fallback can combine them (min for unwatched roots).
func TestServeOptionsWireRefreshIntervals(t *testing.T) {
	root := t.TempDir()
	state := t.TempDir()
	f, err := parseServeFlags([]string{
		"--state", state,
		"--root", root,
		"--refresh", "30m",
		"--unwatched-refresh", "5m",
	})
	if err != nil {
		t.Fatalf("parseServeFlags: %v", err)
	}
	opt, err := f.options()
	if err != nil {
		t.Fatalf("options: %v", err)
	}
	if opt.RefreshInterval != 30*time.Minute {
		t.Fatalf("RefreshInterval = %v, want 30m", opt.RefreshInterval)
	}
	if opt.UnwatchedRefreshInterval != 5*time.Minute {
		t.Fatalf("UnwatchedRefreshInterval = %v, want 5m", opt.UnwatchedRefreshInterval)
	}
	if !opt.Watch {
		t.Fatal("watching is off by default")
	}
	if len(opt.Roots) != 1 || !filepath.IsAbs(opt.Roots[0]) {
		t.Fatalf("Roots = %v, want one absolute root", opt.Roots)
	}
	if opt.StateDir != state {
		t.Fatalf("StateDir = %q, want %q", opt.StateDir, state)
	}

	// --no-watch and --refresh 0 still disable the fallback path.
	off, err := parseServeFlags([]string{"--state", state, "--root", root, "--no-watch", "--refresh", "0"})
	if err != nil {
		t.Fatalf("parseServeFlags(off): %v", err)
	}
	offOpt, err := off.options()
	if err != nil {
		t.Fatalf("options(off): %v", err)
	}
	if offOpt.Watch || offOpt.RefreshInterval != 0 {
		t.Fatalf("disabled fallback options = watch=%v refresh=%v", offOpt.Watch, offOpt.RefreshInterval)
	}
}

// TestServeOptionsRequiresRoots: the moved validation still rejects a serve with
// neither --root nor a snapshot.
func TestServeOptionsRequiresRoots(t *testing.T) {
	f, err := parseServeFlags([]string{"--state", t.TempDir()})
	if err != nil {
		t.Fatalf("parseServeFlags: %v", err)
	}
	if _, err := f.options(); err == nil {
		t.Fatal("options accepted a serve without roots")
	}
}
