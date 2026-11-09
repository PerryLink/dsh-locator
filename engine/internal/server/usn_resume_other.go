//go:build !windows

package server

import "context"

// resumeUSN is a no-op outside Windows.
func (s *Server) resumeUSN(ctx context.Context) bool { return false }
