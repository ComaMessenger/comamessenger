package http

import (
	standardhttp "net/http"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/go-chi/chi/v5"
)

// inboxRoutes serve «Ждут вас» as one list of requests and tasks (phase 6.6
// wave 3; polls join in wave 4). GET /requests/inbox stays for older
// clients and the «Отвечено» tab. Access to every chat is checked in the
// query on every read. Without requests and tasks the route answers 501.
func (h *identityHandlers) inboxRoutes(protected chi.Router) {
	if h.messages == nil || h.messages.Tasks() == nil || h.requests == nil {
		protected.Get("/inbox/waiting", h.inboxNotImplemented)
		return
	}
	protected.With(h.taskPeopleOnly, h.actorRateLimit("tasks-read", h.taskReadRate)).Get("/inbox/waiting", h.listWaitingInbox)
}

func (h *identityHandlers) inboxNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "The waiting inbox is not available on this server yet.")
}

func (h *identityHandlers) listWaitingInbox(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	limit, ok := h.taskLimit(w, r)
	if !ok {
		return
	}
	options := message.WaitingInboxOptions{Kind: r.URL.Query().Get("kind"), Limit: limit}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		options.Cursor = &cursor
	}
	result, err := h.messages.WaitingInbox(r.Context(), authFromContext(r.Context()).User, options)
	if err != nil {
		h.taskError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
