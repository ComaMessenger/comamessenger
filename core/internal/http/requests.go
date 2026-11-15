package http

import (
	"errors"
	"math"
	standardhttp "net/http"
	"strconv"

	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/request"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// requestRoutes serve requests («Запрос», phase 6.4 wave 1). People only:
// agents and API keys get 403, the agent API has no requests in wave 1.
// Without a request service (tests, tools) every route answers 501.
func (h *identityHandlers) requestRoutes(protected chi.Router) {
	if h.requests == nil || h.messages == nil {
		protected.Post("/chats/{chatID}/requests", h.requestsNotImplemented)
		protected.Get("/requests/inbox", h.requestsNotImplemented)
		protected.Get("/requests/{messageID}", h.requestsNotImplemented)
		protected.Put("/requests/{messageID}/answer", h.requestsNotImplemented)
		protected.Get("/requests/{messageID}/answers", h.requestsNotImplemented)
		protected.Post("/requests/{messageID}/remind", h.requestsNotImplemented)
		protected.Post("/requests/{messageID}/close", h.requestsNotImplemented)
		return
	}
	// Creating: 30 a minute with bursts of 10 per person. Answers: 120 a
	// minute. Reads share one budget, like the saved messages.
	createRate, answerRate, readRate := newIPRateLimiter(30, 10), newIPRateLimiter(120, 30), newIPRateLimiter(240, 60)
	people := h.requestPeopleOnly
	protected.With(people, h.actorRateLimit("requests-create", createRate)).Post("/chats/{chatID}/requests", h.createRequest)
	protected.With(people, h.actorRateLimit("requests-read", readRate)).Get("/requests/inbox", h.listRequestInbox)
	protected.With(people, h.actorRateLimit("requests-read", readRate)).Get("/requests/{messageID}", h.getRequest)
	protected.With(people, h.actorRateLimit("requests-answer", answerRate)).Put("/requests/{messageID}/answer", h.answerRequest)
	protected.With(people, h.actorRateLimit("requests-read", readRate)).Get("/requests/{messageID}/answers", h.listRequestAnswers)
	protected.With(people, h.actorRateLimit("requests-answer", answerRate)).Post("/requests/{messageID}/remind", h.remindRequest)
	protected.With(people, h.actorRateLimit("requests-answer", answerRate)).Post("/requests/{messageID}/close", h.closeRequest)
}

func (h *identityHandlers) requestsNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "Requests are not available on this server yet.")
}

func (h *identityHandlers) requestPeopleOnly(next standardhttp.Handler) standardhttp.Handler {
	return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
		if authFromContext(r.Context()).Identity.AuthenticationKind == "api_key" {
			h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "Requests are available to people only.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *identityHandlers) createRequest(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input message.CreateRequestInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, created, err := h.messages.CreateRequest(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"), input)
	if err != nil {
		h.requestError(w, r, err)
		return
	}
	status := standardhttp.StatusOK
	if created {
		status = standardhttp.StatusCreated
		w.Header().Set("Location", "/api/v1/messages/"+result.ID)
	}
	writeJSON(h.logger, w, status, result)
}

func (h *identityHandlers) listRequestInbox(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	options := message.RequestInboxOptions{State: r.URL.Query().Get("state")}
	limit, ok := h.requestLimit(w, r)
	if !ok {
		return
	}
	options.Limit = limit
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		options.Cursor = &cursor
	}
	result, err := h.messages.RequestInbox(r.Context(), authFromContext(r.Context()).User, options)
	if err != nil {
		h.requestError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) getRequest(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.requests.Get(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.requestError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) answerRequest(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input request.AnswerInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.requests.Answer(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), input)
	if err != nil {
		h.requestError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) listRequestAnswers(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	limit, ok := h.requestLimit(w, r)
	if !ok {
		return
	}
	options := request.AnswerListOptions{Filter: r.URL.Query().Get("filter"), Limit: limit}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		options.Cursor = &cursor
	}
	result, err := h.requests.Answers(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), options)
	if err != nil {
		h.requestError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) remindRequest(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.requests.Remind(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.requestError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) closeRequest(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.requests.Close(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.requestError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) requestLimit(w standardhttp.ResponseWriter, r *standardhttp.Request) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return 0, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > 100 {
		h.writeRequestInvalid(w, r, "limit", "limit must be an integer between 1 and 100.")
		return 0, false
	}
	return value, true
}

func (h *identityHandlers) writeRequestInvalid(w standardhttp.ResponseWriter, r *standardhttp.Request, field, text string) {
	details := map[string]any{"field": field}
	writeJSON(h.logger, w, standardhttp.StatusUnprocessableEntity, apiError(r, "request_invalid", text, &details))
}

func (h *identityHandlers) requestError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	var invalidField *request.InvalidError
	var tooSoon *request.RemindTooSoonError
	switch {
	case errors.As(err, &invalidField):
		h.writeRequestInvalid(w, r, invalidField.Field, invalidField.Message)
	case errors.As(err, &tooSoon):
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(tooSoon.RetryAfter.Seconds()))))
		h.writeError(w, r, standardhttp.StatusTooManyRequests, "request_remind_too_soon", "Those who have not answered were reminded recently; try again later.")
	case errors.Is(err, request.ErrAudienceEmpty):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "request_audience_empty", "Nobody in the chat matches the audience.")
	case errors.Is(err, request.ErrTooManyRecipients):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "request_too_many_recipients", "A request may ask at most 500 people.")
	case errors.Is(err, request.ErrAudienceUnavailable):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "request_audience_unavailable", "Departments and positions are not available yet.")
	case errors.Is(err, request.ErrNotMember):
		h.writeError(w, r, standardhttp.StatusForbidden, "not_member", "You are no longer a member of this chat.")
	case errors.Is(err, request.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You do not have permission to perform this request action.")
	case errors.Is(err, request.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "request_not_found", "The request was not found.")
	case errors.Is(err, request.ErrClosed):
		h.writeError(w, r, standardhttp.StatusConflict, "request_closed", "The request is closed.")
	case errors.Is(err, request.ErrChangeTooLate):
		h.writeError(w, r, standardhttp.StatusConflict, "request_change_too_late", "The answer can no longer be changed: the due date has passed.")
	case errors.Is(err, request.ErrChatArchived):
		h.writeError(w, r, standardhttp.StatusConflict, "chat_archived", "The chat is archived.")
	case errors.Is(err, request.ErrLimitReached):
		h.writeError(w, r, standardhttp.StatusConflict, "request_limit_reached", "The request limit was reached.")
	case errors.Is(err, request.ErrVersionConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "version_conflict", "The answer was changed by another request.")
	case errors.Is(err, request.ErrUnavailable):
		h.requestsNotImplemented(w, r)
	case errors.Is(err, message.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "request_invalid", err.Error())
	default:
		h.messageError(w, r, err)
	}
}

func apiError(r *standardhttp.Request, code api.ErrorCode, text string, details *map[string]any) api.Error {
	return api.Error{Code: code, Message: text, Details: details, RequestId: middleware.GetReqID(r.Context())}
}
