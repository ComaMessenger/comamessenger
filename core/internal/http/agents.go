package http

import (
	"errors"
	standardhttp "net/http"

	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func (h *identityHandlers) listAgents(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.List(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) listChatAgents(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.ChatAgents(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"))
	if errors.Is(err, agent.ErrNotFound) {
		h.writeError(w, r, standardhttp.StatusNotFound, "chat_not_found", "Chat was not found.")
		return
	}
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) agentProductMetrics(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.Metrics(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

// listAgentRecipes serves the built-in role catalog in the requested
// language (?locale=, then Accept-Language), falling back to English.
func (h *identityHandlers) listAgentRecipes(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.Recipes(r.Context(), authFromContext(r.Context()).User, requestLocale(r))
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func requestLocale(r *standardhttp.Request) string {
	if locale := r.URL.Query().Get("locale"); locale != "" {
		return locale
	}
	return r.Header.Get("Accept-Language")
}

func (h *identityHandlers) createAgent(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agent.CreateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.Locale == "" {
		input.Locale = r.Header.Get("Accept-Language")
	}
	if input.Enabled {
		h.writeAgentError(w, r, agent.ErrNotReady)
		return
	}
	result, err := h.agents.Create(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	w.Header().Set("Location", "/api/v1/agents/"+result.ID)
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}

func (h *identityHandlers) agentPlatformSettings(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.PlatformSettings(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) updateAgentPlatformSettings(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agent.UpdatePlatformSettingsInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agents.UpdatePlatformSettings(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) getAgent(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.Get(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"))
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) agentUsage(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.Usage(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"))
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) updateAgent(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agent.UpdateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agents.Update(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), input)
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) duplicateAgent(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agent.DuplicateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agents.Duplicate(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), input)
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}

func (h *identityHandlers) resetAgentRecipe(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.ResetRecipeIn(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), r.URL.Query().Get("locale"))
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) listAgentVersions(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.Versions(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"))
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) publishAgent(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var options agent.PublishOptions
	if r.ContentLength != 0 {
		if err := decodeJSON(w, r, &options); err != nil {
			h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
			return
		}
	}
	result, err := h.agents.Publish(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), options)
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) pauseAgent(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.Pause(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"))
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) resumeAgent(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.Resume(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"))
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) rollbackAgent(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.Rollback(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), chi.URLParam(r, "versionID"))
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) deleteAgent(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if err := h.agents.Delete(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID")); err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) listAgentKeys(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agents.ListKeys(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"))
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) createAgentKey(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agent.CreateKeyInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agents.CreateKey(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), input)
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}

func (h *identityHandlers) revokeAgentKey(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	err := h.agents.RevokeKey(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), chi.URLParam(r, "keyID"))
	if err != nil {
		h.writeAgentError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) writeAgentError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, agent.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "agent_not_found", "Agent or key was not found.")
	case errors.Is(err, agent.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You do not have permission to manage agents.")
	case errors.Is(err, agent.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	case errors.Is(err, agent.ErrConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "agent_conflict", "The agent configuration conflicts with existing data.")
	case errors.Is(err, agent.ErrRateLimited):
		w.Header().Set("Retry-After", "60")
		h.writeError(w, r, standardhttp.StatusTooManyRequests, "rate_limited", "The agent rate limit was exceeded.")
	case errors.As(err, new(*agent.LooseningError)):
		var loosening *agent.LooseningError
		errors.As(err, &loosening)
		details := map[string]any{"loosened": loosening.Loosened}
		writeJSON(h.logger, w, standardhttp.StatusConflict, api.Error{Code: "agent_confirmation_loosened",
			Message: "Publishing lets these actions run without a person's approval. Confirm to publish.", RequestId: middleware.GetReqID(r.Context()), Details: &details})
	case errors.Is(err, agent.ErrNotReady):
		h.writeError(w, r, standardhttp.StatusConflict, "agent_not_ready", "Complete the agent readiness checklist before enabling it.")
	default:
		h.internalError(w, r, err)
	}
}
