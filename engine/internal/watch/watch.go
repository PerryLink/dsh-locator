// Package watch keeps an index current by subscribing to filesystem change
// notifications. Each platform has its own native backend; platforms without
// one report ErrUnsupported and the daemon falls back to periodic rescans.
package watch

import (
	"context"
	"errors"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

// ErrUnsupported means this platform has no change-notification backend yet.
var ErrUnsupported = errors.New("filesystem watching is not supported on this platform")

// Options configures a watcher.
type Options struct {
	// Roots are the indexed directories to watch.
	Roots []string
	// Excludes skip subtrees from watching, using the same globs as the scan.
	Excludes []string
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

// Watcher applies filesystem changes to an index.
type Watcher interface {
	// Run blocks until ctx is cancelled or the backend fails.
	Run(ctx context.Context) error
	// Close releases the backend. It is safe to call more than once.
	Close() error
}

// New creates the platform watcher.
func New(ix *index.Index, opt Options) (Watcher, error) {
	return newWatcher(ix, opt)
}
