package http

import (
	"context"
	"errors"
	"io"
	standardhttp "net/http"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/agentconfig"
	"github.com/comamessenger/comamessenger/core/internal/agentprovider"
	"github.com/comamessenger/comamessenger/core/internal/agentrun"
)

func (h *identityHandlers) proxyAgentProviderChat(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentprovider.ProxyInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	response, session, err := h.agentProvider.Start(r.Context(), auth.User, auth.Identity, input)
	if err != nil {
		h.writeAgentProviderError(w, r, err)
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		h.finishProviderSession(session, "failed")
		if response.StatusCode == standardhttp.StatusTooManyRequests {
			h.writeError(w, r, standardhttp.StatusTooManyRequests, "provider_rate_limited", "The configured model provider rejected the request.")
			return
		}
		h.writeError(w, r, standardhttp.StatusBadGateway, "provider_error", "The configured model provider rejected the request.")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, _ := w.(standardhttp.Flusher)
	buffer := make([]byte, 32<<10)
	var total int64
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			total += int64(count)
			if total > 32<<20 {
				h.finishProviderSession(session, "failed")
				return
			}
			chunk := buffer[:count]
			session.Observe(chunk)
			if _, err := w.Write(chunk); err != nil {
				h.finishProviderSession(session, "failed")
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if errors.Is(readErr, io.EOF) {
			h.finishProviderSession(session, "completed")
			return
		}
		if readErr != nil {
			h.finishProviderSession(session, "failed")
			return
		}
	}
}

func (h *identityHandlers) finishProviderSession(session *agentprovider.Session, status string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := session.Finish(ctx, status); err != nil {
		h.logger.Error("finish proxied agent provider call", "status", status, "error", err)
	}
}

func (h *identityHandlers) writeAgentProviderError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, agentprovider.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	case errors.Is(err, agentprovider.ErrUnsupported):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "unsupported_provider", "The selected model provider is not supported.")
	case errors.Is(err, agentconfig.ErrNotFound), errors.Is(err, agentrun.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "provider_credential_required", "Configure the model provider before running this agent.")
	case errors.Is(err, agentrun.ErrBudget):
		h.writeError(w, r, standardhttp.StatusPaymentRequired, "agent_budget_exceeded", "The agent cost budget has been reached.")
	case errors.Is(err, agentrun.ErrRateLimited):
		h.writeError(w, r, standardhttp.StatusTooManyRequests, "agent_provider_rate_limited", "The agent provider rate limit has been reached.")
	case errors.Is(err, agentrun.ErrConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "agent_conflict", "The agent run lease is no longer active.")
	case errors.Is(err, agentrun.ErrForbidden), errors.Is(err, agentconfig.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "The provider request is not allowed.")
	default:
		h.internalError(w, r, err)
	}
}
