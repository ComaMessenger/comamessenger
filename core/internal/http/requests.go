package http

import (
	standardhttp "net/http"

	"github.com/go-chi/chi/v5"
)

// requestRoutes serve requests («Запрос», phase 6.4 wave 1). The contract is
// in packages/protocol/openapi.yaml; until package R1 lands every route
// answers 501 not_implemented and the server does not announce the
// message_requests feature, so clients keep the feature hidden.
func (h *identityHandlers) requestRoutes(protected chi.Router) {
	protected.Post("/chats/{chatID}/requests", h.requestsNotImplemented)
	protected.Get("/requests/inbox", h.requestsNotImplemented)
	protected.Get("/requests/{messageID}", h.requestsNotImplemented)
	protected.Put("/requests/{messageID}/answer", h.requestsNotImplemented)
	protected.Get("/requests/{messageID}/answers", h.requestsNotImplemented)
	protected.Post("/requests/{messageID}/remind", h.requestsNotImplemented)
	protected.Post("/requests/{messageID}/close", h.requestsNotImplemented)
}

func (h *identityHandlers) requestsNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "Requests are not available on this server yet.")
}
