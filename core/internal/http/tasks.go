package http

import (
	"errors"
	"math"
	standardhttp "net/http"
	"strconv"

	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/task"
	"github.com/go-chi/chi/v5"
)

// taskRoutes serve tasks («Задача», phase 6.6 wave 3). People only: agents
// and API keys get 403, the agent API has no tasks in wave 3. Without a task
// service (tests, tools) every route answers 501 and the server does not
// announce message_tasks to such clients' expectations.
func (h *identityHandlers) taskRoutes(protected chi.Router) {
	if h.messages == nil || h.messages.Tasks() == nil {
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
		return
	}
	// Creating: 30 a minute with bursts of 10 per person. Changes of tasks
	// and items: 120 a minute. Reads share one budget, like saved messages.
	create, write, read := h.actorRateLimit("tasks-create", h.taskRate), h.actorRateLimit("tasks-write", h.taskWriteRate), h.actorRateLimit("tasks-read", h.taskReadRate)
	people := h.taskPeopleOnly
	protected.With(people, create).Post("/chats/{chatID}/tasks", h.createTask)
	protected.With(people, read).Get("/chats/{chatID}/tasks", h.listChatTasks)
	protected.With(people, read).Get("/tasks/mine", h.listMyTasks)
	protected.With(people, read).Get("/tasks/{messageID}", h.getTask)
	protected.With(people, write).Patch("/tasks/{messageID}", h.updateTask)
	protected.With(people, write).Put("/tasks/{messageID}/status", h.setTaskStatus)
	protected.With(people, write).Post("/tasks/{messageID}/take", h.takeTask)
	protected.With(people, write).Post("/tasks/{messageID}/items", h.addTaskItem)
	protected.With(people, write).Patch("/tasks/{messageID}/items/{itemID}", h.updateTaskItem)
	protected.With(people, write).Delete("/tasks/{messageID}/items/{itemID}", h.deleteTaskItem)
	protected.With(people, write).Post("/tasks/{messageID}/nudge", h.nudgeTask)
}

func (h *identityHandlers) tasksNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "Tasks are not available on this server yet.")
}

func (h *identityHandlers) taskPeopleOnly(next standardhttp.Handler) standardhttp.Handler {
	return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
		if authFromContext(r.Context()).Identity.AuthenticationKind == "api_key" {
			h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "Tasks are available to people only.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *identityHandlers) createTask(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input message.CreateTaskInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, created, err := h.messages.CreateTask(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"), input)
	if err != nil {
		h.taskError(w, r, err)
		return
	}
	status := standardhttp.StatusOK
	if created {
		status = standardhttp.StatusCreated
		w.Header().Set("Location", "/api/v1/tasks/"+result.ID)
	}
	writeJSON(h.logger, w, status, result)
}

func (h *identityHandlers) listChatTasks(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	limit, ok := h.taskLimit(w, r)
	if !ok {
		return
	}
	options := task.ChatListOptions{State: r.URL.Query().Get("state"), Limit: limit}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		options.Cursor = &cursor
	}
	result, err := h.messages.ListChatTasks(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"), options)
	if err != nil {
		h.taskError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) listMyTasks(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	limit, ok := h.taskLimit(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	options := task.MineListOptions{Role: query.Get("role"), State: query.Get("state"), Limit: limit}
	if cursor := query.Get("cursor"); cursor != "" {
		options.Cursor = &cursor
	}
	result, err := h.messages.ListMyTasks(r.Context(), authFromContext(r.Context()).User, options)
	if err != nil {
		h.taskError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) getTask(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.messages.GetTask(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.taskError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) updateTask(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input task.UpdateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.messages.UpdateTask(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), input)
	if err != nil {
		h.taskError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) setTaskStatus(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input task.StatusInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.messages.SetTaskStatus(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), input)
	if err != nil {
		h.taskError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) takeTask(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.messages.TakeTask(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.taskError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) addTaskItem(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input task.AddItemInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.messages.AddTaskItem(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), input)
	if err != nil {
		h.taskError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}

func (h *identityHandlers) updateTaskItem(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input task.UpdateItemInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.messages.UpdateTaskItem(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), chi.URLParam(r, "itemID"), input)
	if err != nil {
		h.taskError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) deleteTaskItem(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if err := h.messages.DeleteTaskItem(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), chi.URLParam(r, "itemID")); err != nil {
		h.taskError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) nudgeTask(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.messages.NudgeTask(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.taskError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) taskLimit(w standardhttp.ResponseWriter, r *standardhttp.Request) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return 0, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > 100 {
		h.writeTaskInvalid(w, r, "limit", "limit must be an integer between 1 and 100.")
		return 0, false
	}
	return value, true
}

func (h *identityHandlers) writeTaskInvalid(w standardhttp.ResponseWriter, r *standardhttp.Request, field, text string) {
	details := map[string]any{"field": field}
	writeJSON(h.logger, w, standardhttp.StatusUnprocessableEntity, apiError(r, "task_invalid", text, &details))
}

func (h *identityHandlers) taskError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	var invalidField *task.InvalidError
	var conflict *task.ConflictError
	var tooSoon *task.NudgeTooSoonError
	switch {
	case errors.As(err, &invalidField):
		h.writeTaskInvalid(w, r, invalidField.Field, invalidField.Message)
	case errors.As(err, &conflict):
		details := map[string]any{"task": conflict.Task}
		text := "The task was changed by someone else."
		if conflict.Code == "task_already_taken" {
			text = "Somebody has already taken the task."
		}
		writeJSON(h.logger, w, standardhttp.StatusConflict, apiError(r, conflictCode(conflict.Code), text, &details))
	case errors.As(err, &tooSoon):
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(tooSoon.RetryAfter.Seconds()))))
		h.writeError(w, r, standardhttp.StatusTooManyRequests, "task_nudge_too_soon", "The responsible person was reminded recently; try again later.")
	case errors.Is(err, task.ErrAssigneeInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "task_assignee_invalid", "The assignee must be an active person who is a member of the chat.")
	case errors.Is(err, task.ErrTooManyCandidates):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "task_too_many_candidates", "A queue may have at most 100 people.")
	case errors.Is(err, task.ErrAudienceEmpty):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "task_audience_empty", "Nobody of the department or position is in this chat.")
	case errors.Is(err, task.ErrAudienceForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "task_audience_forbidden", "Addressing departments and positions needs a permission.")
	case errors.Is(err, task.ErrDepartmentMissing):
		h.writeError(w, r, standardhttp.StatusNotFound, "department_not_found", "The department was not found.")
	case errors.Is(err, task.ErrPositionMissing):
		h.writeError(w, r, standardhttp.StatusNotFound, "position_not_found", "The position was not found.")
	case errors.Is(err, task.ErrNotMember):
		h.writeError(w, r, standardhttp.StatusForbidden, "not_member", "You are not a member of this chat.")
	case errors.Is(err, task.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "task_forbidden", "You may not do this with the task.")
	case errors.Is(err, task.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "task_not_found", "The task was not found.")
	case errors.Is(err, task.ErrStatusInvalid):
		h.writeError(w, r, standardhttp.StatusConflict, "task_status_invalid", "The task status does not allow this.")
	case errors.Is(err, task.ErrLimitReached):
		h.writeError(w, r, standardhttp.StatusConflict, "task_limit_reached", "The task limit was reached.")
	case errors.Is(err, task.ErrChatArchived):
		h.writeError(w, r, standardhttp.StatusConflict, "chat_archived", "The chat is archived.")
	case errors.Is(err, task.ErrUnavailable):
		h.tasksNotImplemented(w, r)
	case errors.Is(err, message.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "task_invalid", err.Error())
	default:
		h.messageError(w, r, err)
	}
}

func conflictCode(code string) api.ErrorCode {
	if code == "task_already_taken" {
		return api.ErrorCodeTaskAlreadyTaken
	}
	return api.ErrorCodeTaskVersionConflict
}
