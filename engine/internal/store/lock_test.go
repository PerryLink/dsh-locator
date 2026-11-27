package store

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// deadPID returns the PID of a process that has already been reaped.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=TestStoreLockHelperNeverMatches")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper process: %v", err)
	}
	pid := cmd.Process.Pid
	_ = cmd.Wait()
	return pid
}

// TestStoreLockHelperNeverMatches exists only so deadPID has a harmless test
// binary invocation to start and reap.
func TestStoreLockHelperNeverMatches(t *testing.T) {
	t.Skip("helper process only")
}

// writeLockForTest writes a raw engine.lock, bypassing the liveness rules.
func writeLockForTest(t *testing.T, dir string, info LockInfo) {
	t.Helper()
	b, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(LockPath(dir), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// acquireForTest is AcquireLock plus the must-succeed assertions most tests
// need.
func acquireForTest(t *testing.T, dir string) *Lock {
	t.Helper()
	lock, holder, err := AcquireLock(dir, "test")
	if err != nil {
		t.Fatalf("AcquireLock: %v", err)
	}
	if lock == nil {
		t.Fatalf("AcquireLock refused a free state dir (holder %+v)", holder)
	}
	return lock
}

// TestAcquireLockOwnsAndReleases: one engine takes the lock, a second acquire
// in the same process (the HMR double-engine case) is refused with the holder.
func TestAcquireLockOwnsAndReleases(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	lock := acquireForTest(t, dir)
	if !lock.Held() {
		t.Fatal("fresh lock is not held")
	}
	info, err := ReadLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.PID != os.Getpid() || info.Version != "test" {
		t.Fatalf("lock info = %+v", info)
	}
	second, holder, err := AcquireLock(dir, "test")
	if err != nil {
		t.Fatal(err)
	}
	if second != nil {
		_ = second.Release()
		t.Fatal("a second engine acquired a held state dir")
	}
	if holder == nil || holder.PID != os.Getpid() {
		t.Fatalf("holder = %+v", holder)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	if lock.Held() {
		t.Fatal("lock still held after Release")
	}
	if _, err := os.Stat(LockPath(dir)); !os.IsNotExist(err) {
		t.Fatalf("lock file survived Release: %v", err)
	}
}

// TestAcquireLockTakesOverDeadOwner: a lock whose PID is gone is stale.
func TestAcquireLockTakesOverDeadOwner(t *testing.T) {
	dir := t.TempDir()
	writeLockForTest(t, dir, LockInfo{
		PID:         deadPID(t),
		ProcStart:   time.Now().Add(-time.Hour).UnixMilli(),
		StartedAt:   time.Now().Add(-time.Hour).UnixMilli(),
		HeartbeatAt: time.Now().Add(-time.Hour).UnixMilli(),
	})
	lock := acquireForTest(t, dir)
	defer func() { _ = lock.Release() }()
	info, err := ReadLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.PID != os.Getpid() {
		t.Fatalf("stale lock was not replaced: %+v", info)
	}
}

// TestAcquireLockTakesOverStaleHeartbeat: a live-looking PID with a heartbeat
// older than the staleness window belongs to a hung or interrupted engine.
func TestAcquireLockTakesOverStaleHeartbeat(t *testing.T) {
	dir := t.TempDir()
	old := time.Now().Add(-2 * DefaultLockStaleAfter).UnixMilli()
	writeLockForTest(t, dir, LockInfo{PID: os.Getpid(), ProcStart: ProcessStart(), StartedAt: old, HeartbeatAt: old})
	lock := acquireForTest(t, dir)
	defer func() { _ = lock.Release() }()
}

// TestAcquireLockTakesOverReusedPID: the same PID from a different process
// incarnation (procStart mismatch) must not block the directory forever.
func TestAcquireLockTakesOverReusedPID(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().UnixMilli()
	writeLockForTest(t, dir, LockInfo{PID: os.Getpid(), ProcStart: ProcessStart() - 60_000, StartedAt: now, HeartbeatAt: now})
	lock := acquireForTest(t, dir)
	defer func() { _ = lock.Release() }()
}

// TestAcquireLockTakesOverReformattedLock: the stale-takeover path compares the
// lock identity, not its byte representation, so a reformatted JSON record is
// still recognisable as the same stale acquisition.
func TestAcquireLockTakesOverReformattedLock(t *testing.T) {
	dir := t.TempDir()
	pid := deadPID(t)
	old := time.Now().Add(-2 * time.Hour).UnixMilli()
	raw := "{\n  \"version\": \"old\",\n  \"stateDir\": \"x\",\n  \"pid\": " + strconv.Itoa(pid) +
		",\n  \"heartbeatAt\": " + strconv.FormatInt(old, 10) +
		",\n  \"procStart\": 1,\n  \"startedAt\": " + strconv.FormatInt(old, 10) + "\n}\n"
	if err := os.WriteFile(LockPath(dir), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	lock := acquireForTest(t, dir)
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
}

// TestAcquireLockClearsGarbage: a crashed writer can leave a partial file.
func TestAcquireLockClearsGarbage(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(LockPath(dir), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	lock := acquireForTest(t, dir)
	_ = lock.Release()
}

// TestHeartbeatAndKeepAlive: the owner refreshes the timestamp so a long run is
// never mistaken for a stale lock.
func TestHeartbeatAndKeepAlive(t *testing.T) {
	dir := t.TempDir()
	lock := acquireForTest(t, dir)
	defer func() { _ = lock.Release() }()
	before, err := ReadLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if err := lock.Heartbeat(); err != nil {
		t.Fatal(err)
	}
	after, err := ReadLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if after.HeartbeatAt <= before.HeartbeatAt {
		t.Fatalf("heartbeat did not advance: before %d after %d", before.HeartbeatAt, after.HeartbeatAt)
	}
	stop := lock.KeepAlive(5 * time.Millisecond)
	time.Sleep(40 * time.Millisecond)
	stop()
	beat, err := ReadLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if beat.HeartbeatAt <= after.HeartbeatAt {
		t.Fatal("KeepAlive did not refresh the heartbeat")
	}
}

// TestReleaseKeepsStolenLock: after another engine took the directory over, the
// previous owner must not delete the new lock when it exits.
func TestReleaseKeepsStolenLock(t *testing.T) {
	dir := t.TempDir()
	lock := acquireForTest(t, dir)
	now := time.Now().UnixMilli()
	writeLockForTest(t, dir, LockInfo{PID: os.Getpid() + 1, ProcStart: 1, StartedAt: now, HeartbeatAt: now})
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(LockPath(dir)); err != nil {
		t.Fatalf("release deleted a lock owned by another engine: %v", err)
	}
}
