package http

import (
	"errors"
	standardhttp "net/http"

	"github.com/comamessenger/comamessenger/core/internal/architect"
	"github.com/go-chi/chi/v5"
)

func (h *identityHandlers) startArchitectSession(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input architect.StartInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, created, err := h.architect.Start(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.writeArchitectError(w, r, err)
		return
	}
	status := standardhttp.StatusOK
	if created {
		status = standardhttp.StatusCreated
	}
	writeJSON(h.logger, w, status, result)
}

func (h *identityHandlers) getArchitectSession(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.architect.Get(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "sessionID"))
	if err != nil {
		h.writeArchitectError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) closeArchitectSession(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if err := h.architect.Close(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "sessionID")); err != nil {
		h.writeArchitectError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) sendArchitectMessage(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input architect.SendInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.architect.Send(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "sessionID"), input)
	if err != nil {
		h.writeArchitectError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) writeArchitectError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, architect.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You do not have permission to build agents.")
	case errors.Is(err, architect.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "architect_session_not_found", "The conversation or agent was not found.")
	case errors.Is(err, architect.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	case errors.Is(err, architect.ErrConnectionRequired):
		h.writeError(w, r, standardhttp.StatusConflict, "architect_connection_required", "Connect a language model to the workspace first.")
	case errors.Is(err, architect.ErrBusy):
		h.writeError(w, r, standardhttp.StatusConflict, "architect_busy", "The Architect is still answering the previous message.")
	case errors.Is(err, architect.ErrExpired):
		h.writeError(w, r, standardhttp.StatusGone, "architect_session_expired", "The conversation has expired. Start a new one.")
	case errors.Is(err, architect.ErrBudget):
		w.Header().Set("Retry-After", "60")
		h.writeError(w, r, standardhttp.StatusTooManyRequests, "architect_budget_exceeded", "The Architect's spending limit was reached.")
	case errors.Is(err, architect.ErrModel):
		h.logger.WarnContext(r.Context(), "architect model call failed", "error", err)
		h.writeError(w, r, standardhttp.StatusBadGateway, "architect_model_error", "The language model did not answer. Try again.")
	default:
		h.internalError(w, r, err)
	}
}
