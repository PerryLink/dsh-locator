package store

// Engine write lock.
//
// Several plugin instances (and two DSH processes sharing a state directory)
// must never write index.snapshot / index.journal / meta.json concurrently: a
// torn snapshot is exactly the kind of damage that forces a full rescan. The
// lock is a small JSON file created with O_EXCL; the owner refreshes its
// heartbeat while it runs, and a lock whose process is dead, whose PID belongs
// to another process incarnation, or whose heartbeat went stale is taken over.
//
// The lock is advisory: it protects the engine's own writers. Read-only
// consumers (doctor, the CLI) only read the file and never touch the index.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/PerryLink/dsh-locator/engine/internal/statefs"
)

// LockName is the engine write-lock file inside a state directory.
const LockName = "engine.lock"

const (
	// DefaultLockStaleAfter is how long a lock may go without a heartbeat before
	// another engine may take it over. The owner refreshes every
	// LockHeartbeatInterval, so this tolerates many missed refreshes (a stopped
	// process, a paused VM) without stealing a merely busy engine.
	DefaultLockStaleAfter = 5 * time.Minute
	// LockHeartbeatInterval is the refresh cadence of a held lock.
	LockHeartbeatInterval = 30 * time.Second
	// procStartToleranceMs covers clock/scheduling jitter when the same PID is
	// compared across processes: two starts more than this far apart cannot be
	// the same process incarnation.
	procStartToleranceMs = 5_000
)

// LockInfo is the on-disk shape of engine.lock.
type LockInfo struct {
	PID         int    `json:"pid"`
	ProcStart   int64  `json:"procStart"`
	StartedAt   int64  `json:"startedAt"`
	HeartbeatAt int64  `json:"heartbeatAt"`
	Version     string `json:"version,omitempty"`
	StateDir    string `json:"stateDir,omitempty"`
}

// procStart is this process's start time, captured once at package init. It is
// written into the lock so a reused PID from an earlier process incarnation is
// recognised as stale instead of blocking every future engine forever.
var procStart = time.Now().UnixMilli()

// ProcessStart returns the procStart value this process writes into locks.
func ProcessStart() int64 { return procStart }

// LockPath returns the lock file inside dir.
func LockPath(dir string) string { return filepath.Join(dir, LockName) }

// Lock is an owned engine write lock. Its zero value is unheld.
type Lock struct {
	mu   sync.Mutex
	path string
	info LockInfo
	held bool
}

// ReadLock reads engine.lock from dir. It returns an error when the file is
// missing or does not contain a usable lock record.
func ReadLock(dir string) (*LockInfo, error) {
	b, err := os.ReadFile(LockPath(dir))
	if err != nil {
		return nil, err
	}
	var info LockInfo
	if err := json.Unmarshal(b, &info); err != nil {
		return nil, err
	}
	if info.PID <= 0 {
		return nil, errors.New("engine lock has no pid")
	}
	return &info, nil
}

// AcquireLock takes the engine write lock for dir.
//
// It returns the owned lock when the state directory is free. When another
// live engine owns it, the returned lock is nil and the second value carries
// the holder so the caller can run read-only and report who owns the writes.
// An I/O error is only returned when no lock decision could be made at all.
func AcquireLock(dir, version string) (*Lock, *LockInfo, error) {
	if err := statefs.MkdirAll(dir); err != nil {
		return nil, nil, err
	}
	path := LockPath(dir)
	now := time.Now()
	info := LockInfo{
		PID:         os.Getpid(),
		ProcStart:   procStart,
		StartedAt:   now.UnixMilli(),
		HeartbeatAt: now.UnixMilli(),
		Version:     version,
		StateDir:    dir,
	}
	for attempt := 0; attempt < 3; attempt++ {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, statefs.FileMode)
		if err == nil {
			_, werr := f.Write(marshalLock(info))
			cerr := f.Close()
			if werr != nil {
				_ = os.Remove(path)
				return nil, nil, werr
			}
			if cerr != nil {
				_ = os.Remove(path)
				return nil, nil, cerr
			}
			return &Lock{path: path, info: info, held: true}, nil, nil
		}
		if !os.IsExist(err) {
			return nil, nil, err
		}
		holder, rerr := ReadLock(dir)
		if rerr != nil {
			// An unreadable lock is a crashed writer; clear it and retry once more.
			if rmErr := os.Remove(path); rmErr != nil && !os.IsNotExist(rmErr) {
				return nil, nil, rmErr
			}
			continue
		}
		if lockLive(*holder, now) {
			return nil, holder, nil
		}
		// Stale: a dead process, a reused PID or a heartbeat that stopped. Re-read
		// immediately before removing so a fresh lock written by a racing engine
		// is not deleted on the strength of an outdated reading. Identity fields
		// are compared instead of raw bytes: another tool may have reformatted
		// the JSON without changing who owns the lock.
		if current, rerr := ReadLock(dir); rerr == nil && sameLockIdentity(*current, *holder) {
			_ = os.Remove(path)
		}
	}
	// Another engine kept winning the race. Report it as the owner rather than
	// pretending the directory is ours.
	if holder, err := ReadLock(dir); err == nil {
		return nil, holder, nil
	}
	return nil, nil, errors.New("state directory write lock is contended")
}

// Held reports whether this value still owns the lock.
func (l *Lock) Held() bool {
	if l == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.held
}

// Info returns a copy of the lock record this value owns.
func (l *Lock) Info() LockInfo {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.info
}

// Heartbeat refreshes the lock timestamp. The write is atomic (temporary file
// plus rename) so a concurrent reader never sees half a JSON document.
func (l *Lock) Heartbeat() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.held {
		return nil
	}
	l.info.HeartbeatAt = time.Now().UnixMilli()
	tmp := l.path + ".tmp"
	if err := statefs.WriteFile(tmp, marshalLock(l.info)); err != nil {
		return err
	}
	return os.Rename(tmp, l.path)
}

// KeepAlive refreshes the heartbeat every interval until stop is called.
// The returned stop function is idempotent and does not remove the lock.
func (l *Lock) KeepAlive(interval time.Duration) (stop func()) {
	if l == nil || interval <= 0 {
		return func() {}
	}
	done := make(chan struct{})
	var once sync.Once
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				_ = l.Heartbeat()
			case <-done:
				return
			}
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}

// Release drops the lock. It only removes the file when it still describes this
// exact acquisition, so a lock stolen by another engine is left alone.
func (l *Lock) Release() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.held {
		return nil
	}
	l.held = false
	if current, err := ReadLock(filepath.Dir(l.path)); err == nil {
		if !sameLockIdentity(*current, l.info) {
			// Another engine owns it now; do not delete its lock.
			return nil
		}
	}
	err := os.Remove(l.path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// sameLockIdentity reports whether two readings describe the same acquisition:
// same process incarnation and same acquisition timestamp.
func sameLockIdentity(a, b LockInfo) bool {
	return a.PID == b.PID && a.ProcStart == b.ProcStart && a.StartedAt == b.StartedAt
}

// lockLive reports whether info describes a lock a running engine still owns.
func lockLive(info LockInfo, now time.Time) bool {
	if info.PID <= 0 {
		return false
	}
	beat := info.HeartbeatAt
	if beat == 0 {
		beat = info.StartedAt
	}
	if beat == 0 {
		return false
	}
	age := now.Sub(time.UnixMilli(beat))
	if age > DefaultLockStaleAfter {
		return false
	}
	if !processAlive(info.PID) {
		return false
	}
	if info.PID == os.Getpid() && info.ProcStart != 0 && absInt64(info.ProcStart-procStart) > procStartToleranceMs {
		// Same PID but a different process incarnation: this host reused the PID,
		// so the old lock is stale rather than this process holding it twice.
		return false
	}
	return true
}

func marshalLock(info LockInfo) []byte {
	b, err := json.Marshal(info)
	if err != nil {
		return []byte("{}")
	}
	return b
}

func absInt64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
