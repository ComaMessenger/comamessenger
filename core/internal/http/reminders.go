package http

import (
	"errors"
	standardhttp "net/http"
	"strconv"

	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/reminder"
	"github.com/go-chi/chi/v5"
)

// reminderRoutes serve personal reminders («Напомнить мне», phase 6.4 wave
// 1). Every route works only on the caller's own reminders. Without the
// reminder service (tests, a server without package R2) every route answers
// 501 not_implemented.
func (h *identityHandlers) reminderRoutes(protected chi.Router) {
	// Writing is a person's tap, a script does not need more; reading joins
	// messages, chats and members per row, like «Important».
	write := h.actorRateLimit("reminders", newIPRateLimiter(60, 20))
	read := h.actorRateLimit("reminders-read", newIPRateLimiter(240, 60))
	protected.With(write).Put("/messages/{messageID}/reminder", h.setMessageReminder)
	protected.With(write).Delete("/messages/{messageID}/reminder", h.deleteMessageReminder)
	protected.With(read).Get("/reminders", h.listReminders)
	protected.With(read).Get("/reminders/ids", h.listReminderIDs)
	protected.With(write).Put("/reminders/{reminderID}", h.updateReminder)
	protected.With(write).Delete("/reminders/{reminderID}", h.deleteReminder)
}

func (h *identityHandlers) remindersNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "Reminders are not available on this server yet.")
}

// reminderView is api.Reminder: the reminder with the message while its
// owner can read it right now.
type reminderView struct {
	reminder.Reminder
	Access  string                   `json:"access"`
	Message *message.ReadableMessage `json:"message"`
}

const (
	reminderAccessAvailable = "available"
	reminderAccessNone      = "none"
	reminderAccessDeleted   = "deleted"
)

// reminderViews adds the messages. Access is decided by message.Service with
// the rule of «Important», as of this request: a message the owner cannot
// read is never sent, only the note.
func (h *identityHandlers) reminderViews(r *standardhttp.Request, user identity.User, items []reminder.Reminder) ([]reminderView, error) {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		if item.MessageID != nil {
			ids = append(ids, *item.MessageID)
		}
	}
	readable := map[string]message.ReadableMessage{}
	if h.messages != nil && len(ids) > 0 {
		var err error
		readable, err = h.messages.ReadableMessages(r.Context(), user, ids)
		if err != nil {
			return nil, err
		}
	}
	views := make([]reminderView, len(items))
	for index, item := range items {
		views[index] = reminderView{Reminder: item, Access: reminderAccessNone}
		if item.MessageID == nil {
			views[index].Access = reminderAccessDeleted
			continue
		}
		// The message must be the one of the reminder's chat: ids are unique,
		// this only guards the rule against a future change.
		if found, ok := readable[*item.MessageID]; ok && found.Message.ChatID == item.ChatID {
			views[index].Access = reminderAccessAvailable
			views[index].Message = &found
		}
	}
	return views, nil
}

func (h *identityHandlers) writeReminder(w standardhttp.ResponseWriter, r *standardhttp.Request, user identity.User, status int, item reminder.Reminder) {
	views, err := h.reminderViews(r, user, []reminder.Reminder{item})
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, status, views[0])
}

func (h *identityHandlers) decodeReminderInput(w standardhttp.ResponseWriter, r *standardhttp.Request) (reminder.SetInput, bool) {
	var input reminder.SetInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "reminder_invalid", err.Error())
		return reminder.SetInput{}, false
	}
	return input, true
}

func (h *identityHandlers) setMessageReminder(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if h.reminders == nil {
		h.remindersNotImplemented(w, r)
		return
	}
	input, ok := h.decodeReminderInput(w, r)
	if !ok {
		return
	}
	user := authFromContext(r.Context()).User
	result, created, err := h.reminders.Set(r.Context(), user, chi.URLParam(r, "messageID"), input)
	if err != nil {
		h.reminderError(w, r, err, "message_not_found", "The message was not found.")
		return
	}
	status := standardhttp.StatusOK
	if created {
		status = standardhttp.StatusCreated
	}
	h.writeReminder(w, r, user, status, result)
}

func (h *identityHandlers) deleteMessageReminder(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if h.reminders == nil {
		h.remindersNotImplemented(w, r)
		return
	}
	if err := h.reminders.DeleteByMessage(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID")); err != nil {
		h.reminderError(w, r, err, "reminder_not_found", "The reminder was not found.")
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) updateReminder(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if h.reminders == nil {
		h.remindersNotImplemented(w, r)
		return
	}
	input, ok := h.decodeReminderInput(w, r)
	if !ok {
		return
	}
	user := authFromContext(r.Context()).User
	result, err := h.reminders.Update(r.Context(), user, chi.URLParam(r, "reminderID"), input)
	if err != nil {
		h.reminderError(w, r, err, "reminder_not_found", "The reminder was not found.")
		return
	}
	h.writeReminder(w, r, user, standardhttp.StatusOK, result)
}

func (h *identityHandlers) deleteReminder(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if h.reminders == nil {
		h.remindersNotImplemented(w, r)
		return
	}
	// Someone else's id and an unknown one also answer 204: the reply never
	// tells whether another person's reminder exists.
	if err := h.reminders.Delete(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "reminderID")); err != nil {
		h.internalError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) listReminders(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if h.reminders == nil {
		h.remindersNotImplemented(w, r)
		return
	}
	query := r.URL.Query()
	options := reminder.ListOptions{State: query.Get("state")}
	if value := query.Get("cursor"); value != "" {
		options.Cursor = &value
	}
	if value := query.Get("limit"); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "limit must be an integer")
			return
		}
		options.Limit = limit
	}
	user := authFromContext(r.Context()).User
	page, err := h.reminders.List(r.Context(), user, options)
	if err != nil {
		h.reminderError(w, r, err, "reminder_not_found", "The reminder was not found.")
		return
	}
	views, err := h.reminderViews(r, user, page.Items)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]any{"items": views, "next_cursor": page.NextCursor})
}

func (h *identityHandlers) listReminderIDs(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if h.reminders == nil {
		h.remindersNotImplemented(w, r)
		return
	}
	result, err := h.reminders.IDs(r.Context(), authFromContext(r.Context()).User, r.URL.Query().Get("chat_id"))
	if err != nil {
		h.reminderError(w, r, err, "chat_not_found", "The chat was not found.")
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]any{"reminders": result})
}

func (h *identityHandlers) reminderError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error, notFoundCode, notFoundMessage string) {
	switch {
	case errors.Is(err, reminder.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, api.ErrorCode(notFoundCode), notFoundMessage)
	case errors.Is(err, reminder.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "reminder_invalid", err.Error())
	case errors.Is(err, reminder.ErrLimitReached):
		h.writeError(w, r, standardhttp.StatusConflict, "reminder_limit_reached", "Too many pending reminders. Close the ones you no longer need, then try again.")
	default:
		h.internalError(w, r, err)
	}
}
