package http

import (
	standardhttp "net/http"
	"strconv"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/go-chi/chi/v5"
)

// Shared media of a chat: the tabs of chat info. See message/shared.go.

func sharedListOptions(r *standardhttp.Request) (message.SharedListOptions, bool) {
	query := r.URL.Query()
	options := message.SharedListOptions{}
	if value := query.Get("cursor"); value != "" {
		options.Cursor = &value
	}
	if value := query.Get("limit"); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil {
			return options, false
		}
		options.Limit = limit
	}
	return options, true
}

func (h *identityHandlers) chatSharedCounts(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.messages.SharedCounts(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"))
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) listChatSharedAttachments(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	options, ok := sharedListOptions(r)
	if !ok {
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "limit must be an integer")
		return
	}
	result, err := h.messages.SharedAttachments(r.Context(), authFromContext(r.Context()).User,
		chi.URLParam(r, "chatID"), r.URL.Query().Get("kind"), options)
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) listChatSharedLinks(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	options, ok := sharedListOptions(r)
	if !ok {
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "limit must be an integer")
		return
	}
	result, err := h.messages.SharedLinks(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"), options)
	if err != nil {
		h.messageError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
