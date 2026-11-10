package http

import (
	"errors"
	"io"
	standardhttp "net/http"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/agentconfig"
	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/webhook"
	"github.com/go-chi/chi/v5"
)

func (h *identityHandlers) listMCPConnections(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentConfig.ListMCPConnections(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) getMCPConnection(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentConfig.MCPConnection(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "connectionID"))
	if err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) createMCPConnection(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentconfig.CreateMCPConnectionInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agentConfig.CreateMCPConnection(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}

func (h *identityHandlers) updateMCPConnection(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentconfig.UpdateMCPConnectionInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agentConfig.UpdateMCPConnection(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "connectionID"), input)
	if err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) deleteMCPConnection(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if err := h.agentConfig.DeleteMCPConnection(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "connectionID")); err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) testMCPConnection(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentConfig.TestMCPConnection(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "connectionID"))
	if err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) mcpConnectionUsage(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentConfig.MCPConnectionUsage(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "connectionID"))
	if err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) detachMCPConnection(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentconfig.DetachMCPConnectionInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agentConfig.DetachMCPConnection(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "connectionID"), input)
	if err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) writeIntegrationError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, agentconfig.ErrUsageChanged):
		h.writeError(w, r, standardhttp.StatusConflict, "integration_usage_changed", "The list of affected agents changed. Review the impact again.")
	case errors.Is(err, agentconfig.ErrConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "integration_in_use", "The connection is used by agents. Disable or detach it first.")
	case errors.Is(err, webhook.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	case errors.Is(err, webhook.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "The integration action is not allowed.")
	case errors.Is(err, webhook.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "webhook_not_found", "The webhook was not found.")
	case errors.Is(err, webhook.ErrConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "integration_in_use", "The webhook is used by agent triggers.")
	default:
		h.writeAgentConfigError(w, r, err)
	}
}

func (h *identityHandlers) listWebhooks(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.webhooks.List(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) createWebhook(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input webhook.CreateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.webhooks.Create(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}

func (h *identityHandlers) updateWebhook(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input webhook.UpdateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.webhooks.Update(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "webhookID"), input)
	if err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) deleteWebhook(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if err := h.webhooks.Delete(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "webhookID")); err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) rotateWebhookSecret(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.webhooks.RotateSecret(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "webhookID"))
	if err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) webhookDeliveries(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.webhooks.Deliveries(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "webhookID"))
	if err != nil {
		h.writeIntegrationError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

// receiveWebhook is public: authenticity comes from the HMAC signature, not
// from a session. The body is read raw (the signature covers the exact
// bytes) and bounded before the webhook's own limit is known.
func (h *identityHandlers) receiveWebhook(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	controller := standardhttp.NewResponseController(w)
	if err := controller.SetReadDeadline(time.Now().Add(15 * time.Second)); err == nil {
		defer controller.SetReadDeadline(time.Time{})
	}
	// Requests without a valid signature are limited per client address
	// before any database work, so they cannot exhaust a webhook's quota.
	failureKey := "webhook-failure:" + h.clientIP(r)
	if h.webhookFailures != nil && h.webhookFailures.Exhausted(failureKey) {
		w.Header().Set("Retry-After", "60")
		h.writeError(w, r, standardhttp.StatusTooManyRequests, "rate_limited", "Too many rejected webhook requests.")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, webhook.MaxBodyBytes+1))
	if err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", "The request body could not be read.")
		return
	}
	outcome, err := h.webhooks.Receive(r.Context(), chi.URLParam(r, "webhookID"), r.Header, body)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	if outcome.Unsigned && h.webhookFailures != nil {
		h.webhookFailures.Allow(failureKey)
	}
	if outcome.Status >= 400 {
		code := api.ErrorCode("webhook_rejected")
		switch outcome.Status {
		case standardhttp.StatusNotFound:
			code = "webhook_not_found"
		case standardhttp.StatusTooManyRequests:
			code = "rate_limited"
		case standardhttp.StatusRequestEntityTooLarge:
			code = "payload_too_large"
		}
		h.writeError(w, r, outcome.Status, code, "The webhook delivery was rejected: "+outcome.Code+".")
		return
	}
	writeJSON(h.logger, w, outcome.Status, outcome)
}
