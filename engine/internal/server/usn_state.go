package server

import (
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
	"github.com/PerryLink/dsh-locator/engine/internal/usnstate"
)

func (s *Server) saveUSNState(st scan.USNState) {
	// A read-only instance must not write the resumable cursor either: the owning
	// engine advanced it and this scan's view could move it backwards.
	if s.isReadOnly() {
		return
	}
	_ = usnstate.Save(s.opt.StateDir, st)
}

func (s *Server) loadUSNStates() []scan.USNState {
	return usnstate.Load(s.opt.StateDir)
}

func (s *Server) clearUSNStates() {
	if s.isReadOnly() {
		return
	}
	_ = usnstate.Clear(s.opt.StateDir)
}
