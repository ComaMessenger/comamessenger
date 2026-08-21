package http

import (
	"errors"
	standardhttp "net/http"

	"github.com/comamessenger/comamessenger/core/internal/agenttrigger"
	"github.com/go-chi/chi/v5"
)

func (h *identityHandlers) listAgentTriggers(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentTriggers.List(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"))
	if err != nil {
		h.writeAgentTriggerError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) createAgentTrigger(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agenttrigger.CreateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agentTriggers.Create(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), input)
	if err != nil {
		h.writeAgentTriggerError(w, r, err)
		return
	}
	w.Header().Set("Location", "/api/v1/agents/"+result.AgentID+"/triggers/"+result.ID)
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}

func (h *identityHandlers) updateAgentTrigger(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agenttrigger.UpdateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agentTriggers.Update(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), chi.URLParam(r, "triggerID"), input)
	if err != nil {
		h.writeAgentTriggerError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) deleteAgentTrigger(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	err := h.agentTriggers.Delete(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), chi.URLParam(r, "triggerID"))
	if err != nil {
		h.writeAgentTriggerError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) writeAgentTriggerError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, agenttrigger.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	case errors.Is(err, agenttrigger.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "The agent trigger action is not allowed.")
	case errors.Is(err, agenttrigger.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "agent_trigger_not_found", "The agent trigger was not found.")
	case errors.Is(err, agenttrigger.ErrConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "agent_trigger_conflict", "Disable triggers with run history instead of deleting them.")
	default:
		h.internalError(w, r, err)
	}
}
