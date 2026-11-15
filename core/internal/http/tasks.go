package http

import (
	standardhttp "net/http"

	"github.com/go-chi/chi/v5"
)

// taskRoutes serve tasks («Задача», phase 6.6 wave 3). The contract is in
// packages/protocol/openapi.yaml; until package T lands every route answers
// 501 not_implemented and the server does not announce the message_tasks
// feature, so clients keep tasks hidden.
func (h *identityHandlers) taskRoutes(protected chi.Router) {
	protected.Post("/chats/{chatID}/tasks", h.tasksNotImplemented)
	protected.Get("/chats/{chatID}/tasks", h.tasksNotImplemented)
	protected.Get("/tasks/mine", h.tasksNotImplemented)
	protected.Get("/tasks/{messageID}", h.tasksNotImplemented)
	protected.Patch("/tasks/{messageID}", h.tasksNotImplemented)
	protected.Put("/tasks/{messageID}/status", h.tasksNotImplemented)
	protected.Post("/tasks/{messageID}/take", h.tasksNotImplemented)
	protected.Post("/tasks/{messageID}/items", h.tasksNotImplemented)
	protected.Patch("/tasks/{messageID}/items/{itemID}", h.tasksNotImplemented)
	protected.Delete("/tasks/{messageID}/items/{itemID}", h.tasksNotImplemented)
	protected.Post("/tasks/{messageID}/nudge", h.tasksNotImplemented)
}

func (h *identityHandlers) tasksNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "Tasks are not available on this server yet.")
}
