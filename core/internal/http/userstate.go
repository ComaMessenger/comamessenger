package http

import (
	"errors"
	standardhttp "net/http"

	"github.com/comamessenger/comamessenger/core/internal/userstate"
	"github.com/go-chi/chi/v5"
)

type markReadInput struct {
	LastReadSeq int64 `json:"last_read_seq"`
}

func (h *identityHandlers) markChatRead(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input markReadInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, _, err := h.userState.MarkChatRead(r.Context(), auth.User, auth.Identity.SessionID, chi.URLParam(r, "chatID"), input.LastReadSeq)
	if err != nil {
		h.userStateError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) markThreadRead(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input markReadInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, _, err := h.userState.MarkThreadRead(r.Context(), auth.User, auth.Identity.SessionID, chi.URLParam(r, "messageID"), input.LastReadSeq)
	if err != nil {
		h.userStateError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) unreadSnapshot(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.userState.Unread(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.userStateError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) listDrafts(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.userState.ListDrafts(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.userStateError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]any{"drafts": result})
}

func (h *identityHandlers) putDraft(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input userstate.PutDraftInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, created, err := h.userState.PutDraft(r.Context(), auth.User, auth.Identity.SessionID, chi.URLParam(r, "chatID"), input)
	if err != nil {
		h.userStateError(w, r, err)
		return
	}
	status := standardhttp.StatusOK
	if created {
		status = standardhttp.StatusCreated
	}
	writeJSON(h.logger, w, status, result)
}

func (h *identityHandlers) deleteDraft(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var root *string
	if value := r.URL.Query().Get("thread_root_id"); value != "" {
		root = &value
	}
	auth := authFromContext(r.Context())
	if _, err := h.userState.DeleteDraft(r.Context(), auth.User, auth.Identity.SessionID, chi.URLParam(r, "chatID"), root); err != nil {
		h.userStateError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) userStateError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, userstate.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You do not have permission for this user-state action.")
	case errors.Is(err, userstate.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "message_not_found", "The chat or thread was not found.")
	case errors.Is(err, userstate.ErrVersionConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "version_conflict", "The draft was changed by another request.")
	case errors.Is(err, userstate.ErrTooLarge):
		h.writeError(w, r, standardhttp.StatusRequestEntityTooLarge, "payload_too_large", "The draft body is too large.")
	case errors.Is(err, userstate.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	default:
		h.internalError(w, r, err)
	}
}
