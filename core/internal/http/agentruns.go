package http

import (
	"errors"
	"github.com/comamessenger/comamessenger/core/internal/agentrun"
	"github.com/go-chi/chi/v5"
	standardhttp "net/http"
)

func (h *identityHandlers) invokeAgent(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentrun.InvokeInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agentRuns.Invoke(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), input)
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusAccepted, result)
}
func (h *identityHandlers) listAgentRuns(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentRuns.List(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"))
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) getAgentRun(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentRuns.Get(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "runID"))
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) cancelAgentRun(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentRuns.RequestCancel(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "runID"))
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) writeAgentRunError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, agentrun.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	case errors.Is(err, agentrun.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "The agent run action is not allowed.")
	case errors.Is(err, agentrun.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "agent_not_found", "The agent run was not found.")
	case errors.Is(err, agentrun.ErrConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "agent_conflict", "The agent run state has already changed.")
	default:
		h.internalError(w, r, err)
	}
}
