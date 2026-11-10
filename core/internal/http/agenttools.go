package http

import (
	"encoding/json"
	"errors"
	standardhttp "net/http"
	"strings"

	"github.com/comamessenger/comamessenger/core/internal/agentauthz"
	"github.com/comamessenger/comamessenger/core/internal/agenttool"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/interactive"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/go-chi/chi/v5"
)

type invokeAgentToolRequest struct {
	Arguments     json.RawMessage `json:"arguments"`
	RunID         string          `json:"run_id"`
	LeaseToken    string          `json:"lease_token"`
	CorrelationID string          `json:"correlation_id"`
	ToolCallID    string          `json:"tool_call_id"`
}

func (h *identityHandlers) listAgentTools(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	writeJSON(h.logger, w, standardhttp.StatusOK, h.agentTools.Definitions())
}

func (h *identityHandlers) invokeAgentTool(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input invokeAgentToolRequest
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, err := h.agentTools.Invoke(r.Context(), agenttool.Invocation{User: auth.User, Identity: auth.Identity, Name: chi.URLParam(r, "toolName"), Arguments: input.Arguments, RunID: input.RunID, LeaseToken: input.LeaseToken, CorrelationID: input.CorrelationID, ToolCallID: input.ToolCallID})
	if err != nil {
		h.writeAgentToolError(w, r, err)
		return
	}
	if result.Confirmation != nil {
		writeJSON(h.logger, w, standardhttp.StatusAccepted, result.Confirmation)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(standardhttp.StatusOK)
	if _, err := w.Write(result.Output); err != nil {
		h.logger.Error("write agent tool result", "error", err)
	}
}

func (h *identityHandlers) listAgentToolConfirmations(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentTools.ListConfirmations(r.Context(), authFromContext(r.Context()).User, r.URL.Query().Get("status"))
	if err != nil {
		h.writeAgentToolError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) approveAgentToolConfirmation(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.decideAgentToolConfirmation(w, r, true)
}

func (h *identityHandlers) denyAgentToolConfirmation(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.decideAgentToolConfirmation(w, r, false)
}

func (h *identityHandlers) decideAgentToolConfirmation(w standardhttp.ResponseWriter, r *standardhttp.Request, approve bool) {
	result, err := h.agentTools.DecideConfirmation(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "confirmationID"), approve)
	if err != nil {
		h.writeAgentToolError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) writeAgentToolError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, interactive.ErrQuietHours):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "quiet_hours", err.Error())
	case errors.Is(err, interactive.ErrLimit):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "limit_reached", err.Error())
	case errors.Is(err, agenttool.ErrInvalid), errors.Is(err, message.ErrInvalid), errors.Is(err, files.ErrInvalid), errors.Is(err, interactive.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	case errors.Is(err, agenttool.ErrForbidden), errors.Is(err, message.ErrForbidden), errors.Is(err, files.ErrForbidden), errors.Is(err, chat.ErrForbidden), errors.Is(err, interactive.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "The agent tool call is not allowed.")
	case errors.Is(err, agenttool.ErrConfirmationNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "agent_confirmation_not_found", "The requested confirmation was not found.")
	case errors.Is(err, agenttool.ErrConfirmationConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "agent_confirmation_conflict", "The confirmation was already decided, expired, or does not match the original call.")
	case errors.Is(err, message.ErrIdempotencyConflict), errors.Is(err, message.ErrVersionConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "message_conflict", "The agent run has already published a different final message.")
	case errors.Is(err, message.ErrNotFound), errors.Is(err, files.ErrNotFound), errors.Is(err, chat.ErrNotFound), errors.Is(err, interactive.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "message_not_found", "The requested tool resource was not found.")
	case errors.Is(err, agenttool.ErrOutputTooLarge):
		h.writeError(w, r, standardhttp.StatusBadGateway, "payload_too_large", "The agent tool output exceeded its limit.")
	default:
		h.internalError(w, r, err)
	}
}

// listAgentResponseCollections and listAgentFollowups feed the agent activity
// view: what agents are waiting for and what they planned to do later.
func (h *identityHandlers) listAgentResponseCollections(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	current := authFromContext(r.Context()).User
	if !agentauthz.New().CanObserve(current) {
		h.writeAgentToolError(w, r, agenttool.ErrForbidden)
		return
	}
	query := r.URL.Query()
	result, err := h.interactive.ListCollections(r.Context(), current.OrgID, query.Get("agent_id"), defaultStatus(query.Get("status"), "open"))
	if err != nil {
		h.writeAgentToolError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) listAgentFollowups(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	current := authFromContext(r.Context()).User
	if !agentauthz.New().CanObserve(current) {
		h.writeAgentToolError(w, r, agenttool.ErrForbidden)
		return
	}
	query := r.URL.Query()
	result, err := h.interactive.ListOrganizationFollowups(r.Context(), current.OrgID, query.Get("agent_id"), defaultStatus(query.Get("status"), "pending"))
	if err != nil {
		h.writeAgentToolError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func defaultStatus(value, fallback string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return fallback
	}
	return value
}
