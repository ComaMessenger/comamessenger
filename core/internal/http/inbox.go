package http

import (
	standardhttp "net/http"

	"github.com/go-chi/chi/v5"
)

// inboxRoutes serve «Ждут вас» as one list of requests and tasks (phase 6.6
// wave 3; polls join in wave 4). GET /requests/inbox stays for older
// clients and the «Отвечено» tab. Until package T lands the route answers
// 501 not_implemented.
func (h *identityHandlers) inboxRoutes(protected chi.Router) {
	protected.Get("/inbox/waiting", h.inboxNotImplemented)
}

func (h *identityHandlers) inboxNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "The waiting inbox is not available on this server yet.")
}
