//go:build !linux && !windows && !darwin

package watch

import (
	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

func newWatcher(_ *index.Index, _ Options) (Watcher, error) {
	return nil, ErrUnsupported
}
