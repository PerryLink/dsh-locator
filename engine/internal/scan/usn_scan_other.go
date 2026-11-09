//go:build !windows

package scan

import (
	"context"

	"github.com/PerryLink/dsh-locator/engine/internal/index"
)

// tryUSNScan is a no-op off Windows; the portable walk always runs.
func tryUSNScan(_ context.Context, _ *index.Index, _ Options, _ []string) (bool, Stats, error) {
	return false, Stats{}, nil
}
