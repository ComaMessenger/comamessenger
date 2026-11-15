package http

import (
	standardhttp "net/http"

	"github.com/go-chi/chi/v5"
)

// awayRoutes serve «Отсутствую» (phase 6.7 wave 4). The contract is in
// packages/protocol/openapi.yaml; until package A lands every route answers
// 501 not_implemented and the server does not announce the actor_away
// feature, so clients keep the away section hidden.
func (h *identityHandlers) awayRoutes(protected chi.Router) {
	protected.Get("/me/away", h.awayNotImplemented)
	protected.Put("/me/away", h.awayNotImplemented)
	protected.Delete("/me/away", h.awayNotImplemented)
	protected.Get("/me/substituting", h.awayNotImplemented)
}

func (h *identityHandlers) awayNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "Away status is not available on this server yet.")
}
