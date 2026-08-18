package http

import (
	"errors"
	standardhttp "net/http"
	"strconv"

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
	case errors.Is(err, message.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	default:
		h.internalError(w, r, err)
	}
}
