package http

import (
	"errors"
	standardhttp "net/http"

	"github.com/comamessenger/comamessenger/core/internal/agentconfig"
	"github.com/go-chi/chi/v5"
)

func (h *identityHandlers) agentProviderCredential(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentConfig.Credential(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"))
	if err != nil {
		h.writeAgentConfigError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) updateAgentProviderCredential(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentconfig.UpdateCredentialInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agentConfig.UpdateCredential(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), input)
	if err != nil {
		h.writeAgentConfigError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) listAgentMCPServers(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentConfig.ListMCPServers(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"))
	if err != nil {
		h.writeAgentConfigError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) createAgentMCPServer(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentconfig.CreateMCPServerInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agentConfig.CreateMCPServer(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), input)
	if err != nil {
		h.writeAgentConfigError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}

func (h *identityHandlers) updateAgentMCPServer(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentconfig.UpdateMCPServerInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agentConfig.UpdateMCPServer(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), chi.URLParam(r, "serverID"), input)
	if err != nil {
		h.writeAgentConfigError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) deleteAgentMCPServer(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	err := h.agentConfig.DeleteMCPServer(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), chi.URLParam(r, "serverID"))
	if err != nil {
		h.writeAgentConfigError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) agentRuntimeMCPServers(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input struct {
		RunID      string `json:"run_id"`
		LeaseToken string `json:"lease_token"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	agentID, err := h.agentRuns.RuntimeAgentID(r.Context(), auth.User, auth.Identity, input.RunID, input.LeaseToken)
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	result, err := h.agentConfig.RuntimeMCPServersForAgent(r.Context(), auth.User, auth.Identity, agentID)
	if err != nil {
		h.writeAgentConfigError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) writeAgentConfigError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, agentconfig.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	case errors.Is(err, agentconfig.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "The agent configuration action is not allowed.")
	case errors.Is(err, agentconfig.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "agent_configuration_not_found", "The agent configuration was not found.")
	default:
		h.internalError(w, r, err)
	}
}
