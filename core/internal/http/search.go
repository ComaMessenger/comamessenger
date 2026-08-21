package http

import (
	"errors"
	standardhttp "net/http"
	"strconv"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/search"
)

func (h *identityHandlers) searchMessagesAndFiles(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	query := r.URL.Query()
	input := search.Input{
		Query: query.Get("q"), ChatID: query.Get("chat_id"), AuthorID: query.Get("author_id"),
		Type: query.Get("type"), Cursor: query.Get("cursor"),
	}
	if raw := query.Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "limit must be an integer")
			return
		}
		input.Limit = value
	}
	if raw := query.Get("from"); raw != "" {
		value, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "from must use RFC 3339")
			return
		}
		input.From = &value
	}
	if raw := query.Get("to"); raw != "" {
		value, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "to must use RFC 3339")
			return
		}
		input.To = &value
	}
	if raw := query.Get("in_thread"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "in_thread must be true or false")
			return
		}
		input.InThread = &value
	}
	page, err := h.search.Search(r.Context(), authFromContext(r.Context()).User, input)
	if errors.Is(err, search.ErrInvalid) {
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, page)
}
