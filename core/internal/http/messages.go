package http

import (
	"errors"
	standardhttp "net/http"
	"strconv"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/go-chi/chi/v5"
)

func (h *identityHandlers) listMessages(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	options := message.ListOptions{}
	if raw := r.URL.Query().Get("before_seq"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "before_seq must be a positive integer.")
			return
		}
		options.BeforeSeq = &value
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "limit must be an integer.")
			return
		}
		options.Limit = value
	}
	if value := r.URL.Query().Get("thread_root_id"); value != "" {
		options.ThreadRootID = &value
	}
	result, err := h.messages.List(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"), options)
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) createMessage(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input message.CreateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, created, err := h.messages.Create(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"), input)
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	status := standardhttp.StatusOK
	if created {
		status = standardhttp.StatusCreated
		w.Header().Set("Location", "/api/v1/messages/"+result.ID)
	}
	writeJSON(h.logger, w, status, result)
}

func (h *identityHandlers) messageContext(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "limit must be an integer.")
			return
		}
		limit = value
	}
	result, err := h.messages.Context(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), limit)
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) updateMessage(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input message.UpdateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.messages.Update(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), input)
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) deleteMessage(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.messages.Delete(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) putReaction(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, created, err := h.messages.PutReaction(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), chi.URLParam(r, "emoji"))
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	status := standardhttp.StatusOK
	if created {
		status = standardhttp.StatusCreated
	}
	writeJSON(h.logger, w, status, result)
}

func (h *identityHandlers) listReactions(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.messages.ListReactions(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]any{"reactions": result})
}

func (h *identityHandlers) deleteReaction(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if _, err := h.messages.DeleteReaction(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), chi.URLParam(r, "emoji")); err != nil {
		h.messageError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) putMessagePin(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, created, err := h.messages.PutPin(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	status := standardhttp.StatusOK
	if created {
		status = standardhttp.StatusCreated
	}
	writeJSON(h.logger, w, status, result)
}

func (h *identityHandlers) deleteMessagePin(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if _, err := h.messages.DeletePin(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID")); err != nil {
		h.messageError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) listMessagePins(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.messages.ListPins(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"))
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]any{"pins": result})
}

func (h *identityHandlers) forwardMessage(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input message.ForwardInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, created, err := h.messages.Forward(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), input)
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	status := standardhttp.StatusOK
	if created {
		status = standardhttp.StatusCreated
		w.Header().Set("Location", "/api/v1/messages/"+result.ID)
	}
	writeJSON(h.logger, w, status, result)
}

func (h *identityHandlers) followThread(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	followedAt, created, err := h.messages.FollowThread(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	status := standardhttp.StatusOK
	if created {
		status = standardhttp.StatusCreated
	}
	writeJSON(h.logger, w, status, struct {
		ThreadRootID string    `json:"thread_root_id"`
		FollowedAt   time.Time `json:"followed_at"`
	}{ThreadRootID: chi.URLParam(r, "messageID"), FollowedAt: followedAt})
}

func (h *identityHandlers) unfollowThread(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if _, err := h.messages.UnfollowThread(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID")); err != nil {
		h.messageError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) listFollowedThreads(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var beforeSeq *int64
	if raw := r.URL.Query().Get("before_seq"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "before_seq must be a positive integer.")
			return
		}
		beforeSeq = &value
	}
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "limit must be an integer.")
			return
		}
		limit = value
	}
	result, err := h.messages.ListFollowedThreads(r.Context(), authFromContext(r.Context()).User, beforeSeq, limit)
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) listThread(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	options := message.ListOptions{}
	if raw := r.URL.Query().Get("before_seq"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "before_seq must be a positive integer.")
			return
		}
		options.BeforeSeq = &value
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "limit must be an integer.")
			return
		}
		options.Limit = value
	}
	result, err := h.messages.ListThread(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), options)
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) messageError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, message.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You do not have permission to perform this message action.")
	case errors.Is(err, message.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "message_not_found", "The message or chat was not found.")
	case errors.Is(err, message.ErrIdempotencyConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "idempotency_conflict", "client_msg_id was already used for another message command.")
	case errors.Is(err, message.ErrVersionConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "version_conflict", "The message was changed by another request.")
	case errors.Is(err, message.ErrTooLarge):
		h.writeError(w, r, standardhttp.StatusRequestEntityTooLarge, "payload_too_large", "The message body is too large.")
	case errors.Is(err, message.ErrRateLimited):
		h.writeError(w, r, standardhttp.StatusTooManyRequests, "rate_limited", "The message action limit was reached.")
	case errors.Is(err, message.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	default:
		h.internalError(w, r, err)
	}
}
