package http

import (
	standardhttp "net/http"

	"github.com/go-chi/chi/v5"
)

// pollRoutes serve polls («Опрос», phase 6.7 wave 4). The contract is in
// packages/protocol/openapi.yaml; until package P lands every route answers
// 501 not_implemented and the server does not announce the message_polls
// feature, so clients keep polls hidden.
func (h *identityHandlers) pollRoutes(protected chi.Router) {
	protected.Post("/chats/{chatID}/polls", h.pollsNotImplemented)
	protected.Get("/polls/{messageID}", h.pollsNotImplemented)
	protected.Put("/polls/{messageID}/vote", h.pollsNotImplemented)
	protected.Delete("/polls/{messageID}/vote", h.pollsNotImplemented)
	protected.Get("/polls/{messageID}/voters", h.pollsNotImplemented)
	protected.Post("/polls/{messageID}/remind", h.pollsNotImplemented)
	protected.Post("/polls/{messageID}/close", h.pollsNotImplemented)
}

func (h *identityHandlers) pollsNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "Polls are not available on this server yet.")
}
