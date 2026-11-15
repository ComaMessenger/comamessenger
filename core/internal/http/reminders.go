package http

import (
	standardhttp "net/http"

	"github.com/go-chi/chi/v5"
)

// reminderRoutes serve personal reminders («Напомнить мне», phase 6.4 wave
// 1). The contract is in packages/protocol/openapi.yaml; until package R2
// lands every route answers 501 not_implemented and the server does not
// announce the message_reminders feature, so clients keep it hidden.
func (h *identityHandlers) reminderRoutes(protected chi.Router) {
	protected.Put("/messages/{messageID}/reminder", h.remindersNotImplemented)
	protected.Delete("/messages/{messageID}/reminder", h.remindersNotImplemented)
	protected.Get("/reminders", h.remindersNotImplemented)
	protected.Get("/reminders/ids", h.remindersNotImplemented)
	protected.Put("/reminders/{reminderID}", h.remindersNotImplemented)
	protected.Delete("/reminders/{reminderID}", h.remindersNotImplemented)
}

func (h *identityHandlers) remindersNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "Reminders are not available on this server yet.")
}
