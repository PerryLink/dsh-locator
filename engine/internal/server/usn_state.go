package server

import (
	"github.com/PerryLink/dsh-locator/engine/internal/scan"
	"github.com/PerryLink/dsh-locator/engine/internal/usnstate"
)

func (s *Server) saveUSNState(st scan.USNState) {
	_ = usnstate.Save(s.opt.StateDir, st)
}

func (s *Server) loadUSNStates() []scan.USNState {
	return usnstate.Load(s.opt.StateDir)
}

func (s *Server) clearUSNStates() {
	_ = usnstate.Clear(s.opt.StateDir)
}
