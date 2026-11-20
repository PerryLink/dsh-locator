package server

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/watch"
)

// TestPressureReasons pins the pure pressure policy: the gate only fires on
// evidence it actually has, and the thresholds match the content index's
// adaptive throttle (0.8x CPUs, PSI io 30%, PSI cpu 60%).
func TestPressureReasons(t *testing.T) {
	tests := []struct {
		name string
		in   pressureInput
		want int
	}{
		{name: "no signals is never pressure", in: pressureInput{}},
		{name: "load below 0.8x CPUs is fine", in: pressureInput{load: 3.19, loadOK: true, cpuCores: 4}},
		{name: "load above 0.8x CPUs skips", in: pressureInput{load: 3.21, loadOK: true, cpuCores: 4}, want: 1},
		{name: "load without a reading is ignored", in: pressureInput{load: 100, cpuCores: 4}},
		{name: "zero cores never divides", in: pressureInput{load: 100, loadOK: true}},
		{name: "io pressure skips", in: pressureInput{ioPSI: psiLine(10, 42, 5)}, want: 1},
		{name: "io pressure below threshold is fine", in: pressureInput{ioPSI: psiLine(10, 29.9, 5)}},
		{name: "cpu pressure skips", in: pressureInput{cpuPSI: psiLine(10, 60, 5)}, want: 1},
		{name: "cpu pressure below threshold is fine", in: pressureInput{cpuPSI: psiLine(10, 59.9, 5)}},
		{
			name: "load and io and cpu all report",
			in: pressureInput{
				load: 9, loadOK: true, cpuCores: 4,
				ioPSI:  psiLine(10, 40, 10),
				cpuPSI: psiLine(10, 70, 10),
			},
			want: 3,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reasons := pressureReasons(tc.in)
			if len(reasons) != tc.want {
				t.Fatalf("reasons = %v, want %d", reasons, tc.want)
			}
			for _, reason := range reasons {
				if reason == "" {
					t.Fatal("empty pressure reason")
				}
			}
		})
	}
	// The reason must name the signal and the threshold so status explains why
	// a refresh was postponed.
	reasons := pressureReasons(pressureInput{load: 9, loadOK: true, cpuCores: 4})
	if len(reasons) != 1 || !strings.Contains(reasons[0], "load 9.00") || !strings.Contains(reasons[0], "3.20") {
		t.Fatalf("load reason = %v", reasons)
	}
}

// psiLine renders one PSI file body the way /proc/pressure/* reports it. The
// "full" line is deliberately busy: only the "some" line may trigger the gate.
func psiLine(avg10, avg60, avg300 float64) string {
	return fmt.Sprintf("some avg10=%.2f avg60=%.2f avg300=%.2f total=1234\n"+
		"full avg10=99.00 avg60=99.00 avg300=99.00 total=1\n", avg10, avg60, avg300)
}

// TestPressureAvg60: only the "some" line carries the throttle signal; the
// "full" line must never trigger the gate.
func TestPressureAvg60(t *testing.T) {
	in := "some avg10=1.00 avg60=42.50 avg300=3.00 total=9\nfull avg10=88.00 avg60=88.00 avg300=88.00 total=2\n"
	if v, ok := pressureAvg60(in); !ok || v != 42.5 {
		t.Fatalf("pressureAvg60 = %v, %v; want 42.5, true", v, ok)
	}
	for _, bad := range []string{"", "garbage", "some total=1", "some avg60=nope"} {
		if v, ok := pressureAvg60(bad); ok {
			t.Fatalf("pressureAvg60(%q) = %v, %v; want not ok", bad, v, ok)
		}
	}
}

// TestUnwatchedRefreshInterval pins the min() rule: an unset value follows
// --refresh, a larger one is clamped, and a disabled fallback has no cadence.
func TestUnwatchedRefreshInterval(t *testing.T) {
	const base = 30 * time.Minute
	const fast = 10 * time.Minute
	tests := []struct {
		name      string
		refresh   time.Duration
		unwatched time.Duration
		watch     bool
		want      time.Duration
	}{
		{name: "faster unwatched cadence wins", refresh: base, unwatched: fast, watch: true, want: fast},
		{name: "never slower than the base interval", refresh: base, unwatched: 45 * time.Minute, watch: true, want: base},
		{name: "zero follows the base interval", refresh: base, unwatched: 0, watch: true, want: base},
		{name: "negative follows the base interval", refresh: base, unwatched: -time.Minute, watch: true, want: base},
		{name: "disabled fallback has no cadence", refresh: 0, unwatched: fast, watch: true, want: 0},
		{name: "disabled watcher has no cadence", refresh: base, unwatched: fast, watch: false, want: 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := New(Options{Watch: tc.watch, RefreshInterval: tc.refresh, UnwatchedRefreshInterval: tc.unwatched})
			if got := s.unwatchedRefreshInterval(); got != tc.want {
				t.Fatalf("unwatchedRefreshInterval = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestFallbackCadence: a fallback that exists to cover watcher-less roots starts
// on the unwatched cadence; complete watcher coverage keeps the base interval.
func TestFallbackCadence(t *testing.T) {
	s := New(Options{Watch: true, RefreshInterval: 30 * time.Minute, UnwatchedRefreshInterval: 10 * time.Minute})
	mixed := watch.Health{Coverage: []watch.RootCoverage{
		{Path: "/a", Watched: true},
		{Path: "/b", Watched: false},
	}}
	if got := s.fallbackCadence(mixed); got != 10*time.Minute {
		t.Fatalf("mixed coverage cadence = %v, want 10m", got)
	}
	if got := s.fallbackCadence(watch.Health{}); got != 10*time.Minute {
		t.Fatalf("unknown coverage cadence = %v, want 10m (the fallback covers everything)", got)
	}
	watched := watch.Health{Coverage: []watch.RootCoverage{{Path: "/a", Watched: true}}}
	if got := s.fallbackCadence(watched); got != 30*time.Minute {
		t.Fatalf("complete coverage cadence = %v, want the base interval", got)
	}
}

// TestPlanServesUnwatched: only rounds that actually refresh watcher-less roots
// select the faster cadence.
func TestPlanServesUnwatched(t *testing.T) {
	home := filepath.Clean("/home/user")
	remote := filepath.Clean("/mnt/c")
	roots := []string{home, remote}
	mixed := watch.Health{Roots: 2, Watching: 1, Degraded: true, Coverage: []watch.RootCoverage{
		{Path: home, Watched: true},
		{Path: remote, Watched: false, Reason: "9p"},
	}}
	watchedAll := watch.Health{Roots: 2, Watching: 2, Coverage: []watch.RootCoverage{
		{Path: home, Watched: true},
		{Path: remote, Watched: true},
	}}
	unwatchedAll := watch.Health{Roots: 2, Watching: 0, Degraded: true, Coverage: []watch.RootCoverage{
		{Path: home, Watched: false},
		{Path: remote, Watched: false},
	}}
	tests := []struct {
		name   string
		health watch.Health
		plan   refreshPlan
		want   bool
	}{
		{
			name:   "incremental rescan of an unwatched root",
			health: mixed,
			plan:   planRefresh(roots, mixed, roots, true),
			want:   true,
		},
		{
			name:   "all roots watched skips the round",
			health: watchedAll,
			plan:   planRefresh(roots, watchedAll, roots, true),
			want:   false,
		},
		{
			name:   "full rebuild with no watcher at all",
			health: unwatchedAll,
			plan:   planRefresh(roots, unwatchedAll, roots, true),
			want:   true,
		},
		{
			name:   "full rebuild with unknown coverage",
			health: watch.Health{},
			plan:   planRefresh(roots, watch.Health{}, roots, true),
			want:   true,
		},
		{
			name: "degraded watcher that still covers every root keeps the base cadence",
			health: watch.Health{Roots: 2, Watching: 2, Degraded: true, Coverage: []watch.RootCoverage{
				{Path: home, Watched: true},
				{Path: remote, Watched: true},
			}},
			plan: planRefresh(roots, watch.Health{Roots: 2, Watching: 2, Degraded: true, Coverage: []watch.RootCoverage{
				{Path: home, Watched: true},
				{Path: remote, Watched: true},
			}}, roots, true),
			want: false,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := planServesUnwatched(tc.plan, tc.health); got != tc.want {
				t.Fatalf("planServesUnwatched = %v, want %v (mode %v)", got, tc.want, tc.plan.Mode)
			}
		})
	}
}

// TestNextRefreshDelayUnwatchedBackoff: the watcher-less cadence resets on a
// change and is capped at 2x instead of the base cadence's 8x.
func TestNextRefreshDelayUnwatchedBackoff(t *testing.T) {
	s := New(Options{Watch: true, RefreshInterval: 30 * time.Minute, UnwatchedRefreshInterval: 10 * time.Minute})
	check := func(got, base time.Duration) {
		t.Helper()
		min := time.Duration(float64(base) * 0.88)
		max := time.Duration(float64(base) * 1.12)
		if got < min || got > max {
			t.Fatalf("delay = %v, want %v..%v", got, min, max)
		}
	}
	// The initial timer already waited the unwatched cadence, so the first
	// unchanged round doubles it once and the 2x cap holds it there.
	check(s.nextRefreshDelayFor(cadenceUnwatched, false, 0), 20*time.Minute)
	check(s.nextRefreshDelayFor(cadenceUnwatched, false, 0), 20*time.Minute)
	check(s.nextRefreshDelayFor(cadenceUnwatched, false, 0), 20*time.Minute)
	// A changed round resets the backoff to the unwatched cadence.
	check(s.nextRefreshDelayFor(cadenceUnwatched, true, 0), 10*time.Minute)

	// The base cadence keeps its 8x semantics for watched roots.
	s2 := New(Options{Watch: true, RefreshInterval: 30 * time.Minute, UnwatchedRefreshInterval: 10 * time.Minute})
	check(s2.nextRefreshDelayFor(cadenceBase, false, 0), 60*time.Minute)
	check(s2.nextRefreshDelayFor(cadenceBase, false, 0), 120*time.Minute)
	check(s2.nextRefreshDelayFor(cadenceBase, false, 0), 240*time.Minute)
	check(s2.nextRefreshDelayFor(cadenceBase, false, 0), 240*time.Minute)
	check(s2.nextRefreshDelayFor(cadenceBase, false, 0), 240*time.Minute)
	// The legacy helper is the base cadence.
	if got := s2.nextRefreshDelay(true, 0); got < 26*time.Minute || got > 34*time.Minute {
		t.Fatalf("nextRefreshDelay did not reset to the base interval: %v", got)
	}
}

// TestPressureRetryInterval: a skipped round is retried within a minute and
// never more often than once a second.
func TestPressureRetryInterval(t *testing.T) {
	tests := []struct {
		cadence time.Duration
		want    time.Duration
	}{
		{cadence: time.Millisecond, want: time.Second},
		{cadence: 8 * time.Second, want: 2 * time.Second},
		{cadence: 10 * time.Minute, want: time.Minute},
		{cadence: time.Hour, want: time.Minute},
	}
	for _, tc := range tests {
		if got := pressureRetryInterval(tc.cadence); got != tc.want {
			t.Fatalf("pressureRetryInterval(%v) = %v, want %v", tc.cadence, got, tc.want)
		}
	}
}

// TestRecordPressureSkip: a declined round is recorded in status instead of
// disappearing, and it does not count as a refresh round.
func TestRecordPressureSkip(t *testing.T) {
	s := New(Options{Version: "test", Watch: true, RefreshInterval: time.Hour, UnwatchedRefreshInterval: 10 * time.Minute})
	s.out = io.Discard
	s.opt.Log = io.Discard
	ix := index.New()
	s.mu.Lock()
	s.ix = ix
	s.mu.Unlock()
	s.recordPressureSkip([]string{"load 9.00 over 6.40 (0.8 x 8 cpus)"})
	status := s.statusPayload()
	if got := status["refreshSkippedByPressure"].(int64); got != 1 {
		t.Fatalf("refreshSkippedByPressure = %v, want 1", got)
	}
	if got := status["refreshRounds"].(int64); got != 0 {
		t.Fatalf("refreshRounds = %v, want 0 for a skipped round", got)
	}
	if status["refreshMode"] != "pressure" {
		t.Fatalf("refreshMode = %v, want pressure", status["refreshMode"])
	}
	reason, _ := status["refreshReason"].(string)
	if !strings.Contains(reason, "load 9.00") {
		t.Fatalf("refreshReason = %q", reason)
	}
	if status["refreshChanged"] != false {
		t.Fatalf("refreshChanged = %v", status["refreshChanged"])
	}
}

// TestPeriodicRefreshOutcome: the outcome flags distinguish a skipped round, an
// unchanged incremental round and a full rebuild, and only the latter two scan.
func TestPeriodicRefreshOutcome(t *testing.T) {
	healthy := t.TempDir()
	degraded := t.TempDir()
	s, _ := refreshServer(t, healthy, degraded)
	outcome := s.periodicRefresh(context.Background())
	if outcome.Changed || !outcome.Scanned || !outcome.Unwatched {
		t.Fatalf("incremental outcome = %+v, want scanned, unchanged, unwatched", outcome)
	}
	if got := s.statusPayload()["refreshRounds"].(int64); got != 1 {
		t.Fatalf("refreshRounds = %d, want 1", got)
	}

	// Complete coverage: the round skips and scans nothing.
	watched, _ := refreshServer(t, healthy, degraded)
	watched.mu.Lock()
	watched.watch = watch.Health{Roots: 2, Watching: 2, Coverage: []watch.RootCoverage{
		{Path: filepath.Clean(healthy), Watched: true},
		{Path: filepath.Clean(degraded), Watched: true},
	}}
	watched.mu.Unlock()
	skipped := watched.periodicRefresh(context.Background())
	if skipped.Changed || skipped.Scanned || skipped.Unwatched {
		t.Fatalf("skipped outcome = %+v, want a no-scan base-cadence round", skipped)
	}

	// No coverage report at all forces a full rebuild of watcher-less roots.
	full := New(Options{StateDir: t.TempDir(), Roots: []string{healthy, degraded}, Version: "test"})
	full.out = io.Discard
	full.opt.Log = io.Discard
	fullIx := index.New()
	if _, err := scanForTest(t, fullIx, []string{healthy, degraded}); err != nil {
		t.Fatal(err)
	}
	full.mu.Lock()
	full.ix = fullIx
	full.mu.Unlock()
	rebuilt := full.periodicRefresh(context.Background())
	if !rebuilt.Changed || !rebuilt.Scanned || !rebuilt.Unwatched {
		t.Fatalf("full outcome = %+v, want changed, scanned, unwatched", rebuilt)
	}
}

// TestStatusUnwatchedRefreshFields: ready/status expose the resolved cadence,
// the absolute next round and the pressure skip counter.
func TestStatusUnwatchedRefreshFields(t *testing.T) {
	s := New(Options{Version: "test", Watch: true, RefreshInterval: 30 * time.Minute, UnwatchedRefreshInterval: 10 * time.Minute})
	s.out = io.Discard
	s.opt.Log = io.Discard
	ix := index.New()
	s.mu.Lock()
	s.ix = ix
	s.refreshCancel = func() {}
	s.mu.Unlock()
	before := time.Now()
	if !s.setRefreshSchedule(10 * time.Minute) {
		t.Fatal("setRefreshSchedule failed with an active fallback")
	}
	status := s.statusPayload()
	if got := status["unwatchedRefreshMs"].(int64); got != int64((10 * time.Minute).Milliseconds()) {
		t.Fatalf("unwatchedRefreshMs = %v, want 600000", got)
	}
	if got := status["refreshBackoffMs"].(int64); got != int64((10 * time.Minute).Milliseconds()) {
		t.Fatalf("refreshBackoffMs = %v, want the unwatched cadence", got)
	}
	nextAt := status["nextRefreshAt"].(int64)
	if nextAt < before.Add(9*time.Minute).UnixMilli() || nextAt > time.Now().Add(10*time.Minute).Add(time.Second).UnixMilli() {
		t.Fatalf("nextRefreshAt = %d, want about now+10m", nextAt)
	}
	if got := status["refreshNextInMs"].(int64); got <= 0 || got > int64((10*time.Minute).Milliseconds()) {
		t.Fatalf("refreshNextInMs = %d", got)
	}
	if got := status["refreshRounds"].(int64); got != 0 {
		t.Fatalf("refreshRounds = %v, want 0", got)
	}
	if got := status["refreshSkippedByPressure"].(int64); got != 0 {
		t.Fatalf("refreshSkippedByPressure = %v, want 0", got)
	}
	s.mu.Lock()
	s.refreshCancel = nil
	s.mu.Unlock()

	// A disabled fallback reports no cadence.
	disabled := New(Options{Watch: true, RefreshInterval: 0, UnwatchedRefreshInterval: time.Minute})
	disabled.out = io.Discard
	disabled.mu.Lock()
	disabled.ix = index.New()
	disabled.mu.Unlock()
	if got := disabled.statusPayload()["unwatchedRefreshMs"].(int64); got != 0 {
		t.Fatalf("unwatchedRefreshMs with a disabled fallback = %v, want 0", got)
	}
}

// BenchmarkPressureGate measures the per-round cost of the pressure gate. It
// must stay negligible next to the rescan it guards (a 9p refresh measured at
// 9.6s/25.3k entries in the 0.20.1 study).
func BenchmarkPressureGate(b *testing.B) {
	s := New(Options{})
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = s.pressureVerdict()
	}
}

// TestFallbackLoopPressureGateAndRecovery exercises the P0 wiring end to end: a
// busy host must skip rounds (without scanning), and once the pressure clears the
// loop must refresh, release memory and report the round.
func TestFallbackLoopPressureGateAndRecovery(t *testing.T) {
	healthy := t.TempDir()
	degraded := t.TempDir()
	mustWrite(t, filepath.Join(healthy, "keep.txt"))
	mustWrite(t, filepath.Join(degraded, "old.txt"))
	ix := index.New()
	if _, err := scanForTest(t, ix, []string{healthy, degraded}); err != nil {
		t.Fatal(err)
	}
	s := New(Options{
		StateDir:                 t.TempDir(),
		Roots:                    []string{healthy, degraded},
		Watch:                    true,
		RefreshInterval:          80 * time.Millisecond,
		UnwatchedRefreshInterval: 80 * time.Millisecond,
		Version:                  "test",
	})
	s.out = io.Discard
	s.opt.Log = io.Discard
	s.mu.Lock()
	s.ix = ix
	s.watch = watch.Health{Roots: 2, Watching: 1, Degraded: true, Coverage: []watch.RootCoverage{
		{Path: filepath.Clean(healthy), Watched: true},
		{Path: filepath.Clean(degraded), Watched: false, Reason: "9p"},
	}}
	s.mu.Unlock()

	var busy atomic.Bool
	busy.Store(true)
	s.pressureProbe = func() pressureInput {
		if busy.Load() {
			return pressureInput{load: 100, loadOK: true, cpuCores: 2}
		}
		return pressureInput{}
	}
	var freed atomic.Int64
	originalFree := freeOSMemory
	freeOSMemory = func() { freed.Add(1) }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.startRefreshFallback(ctx)
	defer func() {
		s.stopRefreshFallback()
		cancel()
		deadline := time.Now().Add(5 * time.Second)
		for s.refreshActive() {
			if time.Now().After(deadline) {
				t.Error("fallback loop did not stop")
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		freeOSMemory = originalFree
	}()

	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				status := s.statusPayload()
				t.Fatalf("timed out waiting for %s (status: mode=%v reason=%v rounds=%v pressureSkips=%v)",
					what, status["refreshMode"], status["refreshReason"], status["refreshRounds"], status["refreshSkippedByPressure"])
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	waitFor("the pressure gate to skip a round", func() bool {
		s.mu.RLock()
		defer s.mu.RUnlock()
		return s.refreshSkippedByPressure >= 1
	})
	// Still busy: the gate must keep the loop from scanning.
	s.mu.RLock()
	roundsWhileBusy := s.refreshRounds
	skips := s.refreshSkippedByPressure
	s.mu.RUnlock()
	if roundsWhileBusy != 0 {
		t.Fatalf("refreshRounds = %d while the host was busy, want 0", roundsWhileBusy)
	}
	if skips < 1 {
		t.Fatalf("refreshSkippedByPressure = %d, want at least 1", skips)
	}
	if got := s.statusPayload()["refreshMode"]; got != "pressure" {
		t.Fatalf("refreshMode while busy = %v, want pressure", got)
	}

	// Pressure clears: the loop must refresh, hand memory back and stay cheap.
	busy.Store(false)
	waitFor("a refresh round after the pressure cleared", func() bool {
		s.mu.RLock()
		defer s.mu.RUnlock()
		return s.refreshRounds >= 1
	})
	waitFor("FreeOSMemory after the refresh", func() bool { return freed.Load() >= 1 })
	status := s.statusPayload()
	if status["refreshMode"] != "incremental" {
		t.Fatalf("refreshMode after recovery = %v, want incremental", status["refreshMode"])
	}
	if status["refreshChanged"] != false {
		t.Fatalf("refreshChanged = %v for an untouched tree", status["refreshChanged"])
	}
	if got := status["refreshSkippedByPressure"].(int64); got < 1 {
		t.Fatalf("refreshSkippedByPressure = %v after recovery, want the skip to persist", got)
	}
	if got := status["unwatchedRefreshMs"].(int64); got != int64((80 * time.Millisecond).Milliseconds()) {
		t.Fatalf("unwatchedRefreshMs = %v, want 80", got)
	}
	if got := status["nextRefreshAt"].(int64); got <= 0 {
		t.Fatalf("nextRefreshAt = %d after a round, want a scheduled time", got)
	}
	// A no-change round must still not persist anything.
	s.saveMu.Lock()
	dirty := s.dirty
	s.saveMu.Unlock()
	if dirty {
		t.Fatal("a no-change fallback round marked the snapshot dirty")
	}
	if got := s.current().Generation(); got != ix.Generation() {
		t.Fatalf("no-change round moved the generation %d -> %d", ix.Generation(), got)
	}
}
