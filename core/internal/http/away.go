package http

import (
	"errors"
	standardhttp "net/http"

	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/away"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// awayRoutes serve «Отсутствую» (phase 6.7 wave 4). Every route works only
// on the caller's own status; nobody, an administrator included, reads or
// sets another person's (decision 11). People only: API keys get 403 and
// the service refuses agents. Without the away service (tests, tools) every
// route answers 501 not_implemented.
func (h *identityHandlers) awayRoutes(protected chi.Router) {
	if h.away == nil {
		protected.Get("/me/away", h.awayNotImplemented)
		protected.Put("/me/away", h.awayNotImplemented)
		protected.Delete("/me/away", h.awayNotImplemented)
		protected.Get("/me/substituting", h.awayNotImplemented)
		return
	}
	write, read := h.actorRateLimit("away", h.awayRate), h.actorRateLimit("away-read", h.awayReadRate)
	people := h.awayPeopleOnly
	protected.With(people, read).Get("/me/away", h.getAway)
	protected.With(people, write).Put("/me/away", h.setAway)
	protected.With(people, write).Delete("/me/away", h.clearAway)
	protected.With(people, read).Get("/me/substituting", h.listSubstituting)
}

func (h *identityHandlers) awayNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "Away status is not available on this server yet.")
}

func (h *identityHandlers) awayPeopleOnly(next standardhttp.Handler) standardhttp.Handler {
	return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
		if authFromContext(r.Context()).Identity.AuthenticationKind == "api_key" {
			h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "The away status is set by people only.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *identityHandlers) getAway(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	status, ok, err := h.away.Get(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	if !ok {
		w.WriteHeader(standardhttp.StatusNoContent)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, status)
}

func (h *identityHandlers) setAway(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input away.SetInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	status, err := h.away.Set(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.writeAwayError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, status)
}

func (h *identityHandlers) clearAway(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if err := h.away.Clear(r.Context(), authFromContext(r.Context()).User); err != nil {
		h.writeAwayError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) listSubstituting(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.away.Substituting(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) writeAwayError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	var invalid *away.InvalidError
	switch {
	case errors.As(err, &invalid):
		details := map[string]any{"field": invalid.Field}
		writeJSON(h.logger, w, standardhttp.StatusUnprocessableEntity, api.Error{
			Code: api.ErrorCodeAwayInvalid, Message: invalid.Error(), Details: &details, RequestId: middleware.GetReqID(r.Context()),
		})
	case errors.Is(err, away.ErrSubstituteInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, api.ErrorCodeAwaySubstituteInvalid, "The substitute must be another active person of the workspace.")
	case errors.Is(err, away.ErrVersionConflict):
		h.writeError(w, r, standardhttp.StatusConflict, api.ErrorCodeAwayVersionConflict, "The away status changed meanwhile.")
	case errors.Is(err, away.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, api.ErrorCodeForbidden, "The away status is set by people only.")
	default:
		h.internalError(w, r, err)
	}
}
