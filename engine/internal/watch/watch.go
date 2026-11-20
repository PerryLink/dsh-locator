// Package watch keeps an index current by subscribing to filesystem change
// notifications. Each platform has its own native backend; platforms without
// one report ErrUnsupported and the daemon falls back to periodic rescans.
package watch

import (
	"context"
	"errors"
	"syscall"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
)

// ErrUnsupported means this platform has no change-notification backend yet.
var ErrUnsupported = errors.New("filesystem watching is not supported on this platform")

// DefaultMaxDirs is the default budget for watched directories across all
// roots. Beyond it the remaining directories are covered by the periodic
// incremental refresh instead of one kernel watch per directory.
const DefaultMaxDirs = 120_000

// Options configures a watcher.
type Options struct {
	// Roots are the indexed directories to watch.
	Roots []string
	// Excludes skip subtrees from watching, using the same globs as the scan.
	Excludes []string
	// IncludeCaches keeps toolchain/package cache trees watched. The default
	// false matches the scanner: those trees are excluded from the index, so
	// watching them would only report changes the index does not keep.
	IncludeCaches bool
	// MaxDirs caps the number of watched directories across all roots. Zero uses
	// DefaultMaxDirs. Backends that are recursive (Windows, FSEvents) ignore it.
	MaxDirs int
	// OnError receives non-fatal backend errors (watch limits, overflow).
	OnError func(error)
	// OnDegraded is called once when coverage becomes incomplete after startup
	// (a root handle died, a watch limit was hit, the notification stream was
	// dropped, or the filesystem cannot deliver events). The daemon then turns
	// on its periodic rebuild fallback so unwatched changes still converge.
	OnDegraded func(Health)
}

// Health reports how much of the requested tree a watcher actually covers.
// Backends report it honestly: a watcher that only sees part of the roots is
// degraded, and the daemon enables a periodic rebuild for the rest.
type Health struct {
	// Roots is the number of roots the watcher was asked to watch.
	Roots int `json:"roots"`
	// Watching is the number of roots that are actually covered.
	Watching int `json:"watching"`
	// Dirs is the number of directories with an active watch, when the backend
	// tracks them (0 otherwise).
	Dirs int `json:"dirs,omitempty"`
	// Degraded is true when coverage is known to be incomplete.
	Degraded bool `json:"degraded"`
	// Reason explains a degraded state in one short line.
	Reason string `json:"reason,omitempty"`
	// Coverage, when non-empty, has exactly one entry per requested root. It
	// tells the daemon's periodic refresh fallback which roots still have a
	// healthy native watcher and may therefore be skipped when only the others
	// are rescanned. Backends that cannot attribute coverage per root leave it
	// nil; the daemon then falls back to a full rebuild.
	Coverage []RootCoverage `json:"coverage,omitempty"`
	// Limit is the directory budget in effect when the backend enforces one
	// (zero means the backend is recursive or does not report a budget).
	Limit int `json:"limit,omitempty"`
	// Limited is true when the budget or a kernel watch limit truncated
	// coverage. The index is still complete; the truncated subtrees rely on the
	// periodic refresh, so this is an intermediate state rather than a failure.
	Limited bool `json:"limited,omitempty"`
}

// RootCoverage is the watcher state of one requested root.
type RootCoverage struct {
	// Path is the root as the daemon configured it.
	Path string `json:"path"`
	// Watched is true when changes below Path are delivered natively.
	Watched bool `json:"watched"`
	// Reason explains why an unwatched root is not covered.
	Reason string `json:"reason,omitempty"`
	// Limited is true when the root is partially watched because the directory
	// budget ran out, as opposed to a failed or unsupported backend.
	Limited bool `json:"limited,omitempty"`
}

// HealthReporter is implemented by backends that can describe their coverage.
type HealthReporter interface {
	Health() Health
}

// HealthOf returns the watcher's coverage; backends without a reporter report a
// zero value (unknown, not degraded).
func HealthOf(w Watcher) Health {
	if w == nil {
		return Health{}
	}
	if reporter, ok := w.(HealthReporter); ok {
		return reporter.Health()
	}
	return Health{}
}

// errWatchLimit marks a watch that was not installed because the directory
// budget (or a kernel watch limit) is exhausted. It is an intermediate state,
// not a failure: the periodic refresh covers the unwatched subtrees.
var errWatchLimit = errors.New("watch directory budget reached")

// isWatchLimitErr reports backend errors that mean "out of watch capacity".
func isWatchLimitErr(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, errWatchLimit) ||
		errors.Is(err, syscall.ENOSPC) ||
		errors.Is(err, syscall.EMFILE) ||
		errors.Is(err, syscall.ENFILE) ||
		errors.Is(err, syscall.ENOMEM)
}

// Watcher applies filesystem changes to an index.
type Watcher interface {
	// Run blocks until ctx is cancelled or the backend fails.
	Run(ctx context.Context) error
	// Close releases the backend. It is safe to call more than once.
	Close() error
}

// maxDirs returns the effective directory budget for this watcher.
func (o Options) maxDirs() int {
	if o.MaxDirs > 0 {
		return o.MaxDirs
	}
	return DefaultMaxDirs
}

// newExcluder compiles the exclude rules once for the platform backend.
func newExcluder(opt Options) *scan.Excluder {
	return scan.NewExcluder(opt.Excludes, opt.IncludeCaches)
}

// New creates the platform watcher.
func New(ix *index.Index, opt Options) (Watcher, error) {
	return newWatcher(ix, opt)
}
