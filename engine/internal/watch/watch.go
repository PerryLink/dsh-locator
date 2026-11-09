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
