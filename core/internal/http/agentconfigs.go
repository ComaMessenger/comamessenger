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

func (h *identityHandlers) agentRuntimeProviderCredential(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	auth := authFromContext(r.Context())
	result, err := h.agentConfig.RuntimeCredential(r.Context(), auth.User, auth.Identity)
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
