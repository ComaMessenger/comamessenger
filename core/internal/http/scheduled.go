package http

import (
	"errors"
	standardhttp "net/http"

	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/scheduled"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// scheduledRoutes serve a person's own scheduled messages. Every route is
// limited per actor on top of the general authenticated limit.
func (h *identityHandlers) scheduledRoutes(protected chi.Router) {
	limited := protected.With(h.actorRateLimit("scheduled-messages", h.scheduledRate))
	limited.Post("/chats/{chatID}/scheduled-messages", h.createScheduledMessage)
	limited.Get("/scheduled-messages", h.listScheduledMessages)
	limited.Get("/scheduled-messages/{scheduledID}", h.getScheduledMessage)
	limited.Patch("/scheduled-messages/{scheduledID}", h.updateScheduledMessage)
	limited.Delete("/scheduled-messages/{scheduledID}", h.deleteScheduledMessage)
	limited.Post("/scheduled-messages/{scheduledID}/send", h.sendScheduledMessageNow)
}

// scheduledAuthor allows only people signed in with a session; agent API
// keys carry no session and are refused by the service.
func scheduledAuthor(r *standardhttp.Request) scheduled.Author {
	auth := authFromContext(r.Context())
	if auth.Identity.AuthenticationKind == "api_key" {
		return scheduled.Author{User: auth.User}
	}
	return scheduled.Author{User: auth.User, SessionID: auth.Identity.SessionID}
}

func (h *identityHandlers) createScheduledMessage(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input scheduled.CreateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, created, err := h.scheduled.Create(r.Context(), scheduledAuthor(r), chi.URLParam(r, "chatID"), input)
	if err != nil {
		h.scheduledError(w, r, err)
		return
	}
	status := standardhttp.StatusOK
	if created {
		status = standardhttp.StatusCreated
		w.Header().Set("Location", "/api/v1/scheduled-messages/"+result.ID)
	}
	writeJSON(h.logger, w, status, result)
}

func (h *identityHandlers) listScheduledMessages(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var chatID *string
	if value := r.URL.Query().Get("chat_id"); value != "" {
		chatID = &value
	}
	result, err := h.scheduled.List(r.Context(), scheduledAuthor(r), chatID)
	if err != nil {
		h.scheduledError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]any{"scheduled_messages": result})
}

func (h *identityHandlers) getScheduledMessage(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.scheduled.Get(r.Context(), scheduledAuthor(r), chi.URLParam(r, "scheduledID"))
	if err != nil {
		h.scheduledError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) updateScheduledMessage(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input scheduled.UpdateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.scheduled.Update(r.Context(), scheduledAuthor(r), chi.URLParam(r, "scheduledID"), input)
	if err != nil {
		h.scheduledError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) deleteScheduledMessage(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if err := h.scheduled.Delete(r.Context(), scheduledAuthor(r), chi.URLParam(r, "scheduledID")); err != nil {
		h.scheduledError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) sendScheduledMessageNow(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.scheduled.SendNow(r.Context(), scheduledAuthor(r), chi.URLParam(r, "scheduledID"))
	if err != nil {
		h.scheduledError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) scheduledError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, scheduled.ErrNotRetryable):
		var refusal *scheduled.NotRetryableError
		reason := ""
		if errors.As(err, &refusal) {
			reason = refusal.Reason
		}
		details := map[string]any{"reason": reason}
		writeJSON(h.logger, w, standardhttp.StatusConflict, api.Error{
			Code: "scheduled_message_not_retryable", Message: "The message cannot be sent again: the reason it failed still holds.",
			RequestId: middleware.GetReqID(r.Context()), Details: &details,
		})
	case errors.Is(err, scheduled.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "Only a signed-in person with the right to write here may schedule messages.")
	case errors.Is(err, scheduled.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "scheduled_message_not_found", "The scheduled message or chat was not found.")
	case errors.Is(err, scheduled.ErrClosed):
		h.writeError(w, r, standardhttp.StatusConflict, "scheduled_message_closed", "The scheduled message was already sent or failed.")
	case errors.Is(err, scheduled.ErrVersionConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "version_conflict", "The scheduled message was changed by another request.")
	case errors.Is(err, scheduled.ErrIdempotencyConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "idempotency_conflict", "client_msg_id was already used for another message command.")
	case errors.Is(err, scheduled.ErrLimitReached):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "limit_reached", "Too many scheduled messages are waiting.")
	case errors.Is(err, scheduled.ErrTooLarge):
		h.writeError(w, r, standardhttp.StatusRequestEntityTooLarge, "payload_too_large", "The message body is too large.")
	case errors.Is(err, scheduled.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	default:
		h.internalError(w, r, err)
	}
}
