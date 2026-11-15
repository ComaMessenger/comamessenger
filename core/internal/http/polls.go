package http

import (
	"errors"
	"math"
	standardhttp "net/http"
	"strconv"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/poll"
	"github.com/go-chi/chi/v5"
)

// pollRoutes serve polls («Опрос», phase 6.7 wave 4). People only: agents
// and API keys get 403, agents read a poll as its text. Without a poll
// service (tests, tools) every route answers 501 not_implemented.
//
// The body of votePoll is never logged: requestLogger writes the method,
// the route and the timing only, and the errors below never quote the
// chosen options.
func (h *identityHandlers) pollRoutes(protected chi.Router) {
	if h.messages == nil || h.messages.Polls() == nil {
		protected.Post("/chats/{chatID}/polls", h.pollsNotImplemented)
		protected.Get("/polls/{messageID}", h.pollsNotImplemented)
		protected.Patch("/polls/{messageID}", h.pollsNotImplemented)
		protected.Put("/polls/{messageID}/vote", h.pollsNotImplemented)
		protected.Delete("/polls/{messageID}/vote", h.pollsNotImplemented)
		protected.Get("/polls/{messageID}/voters", h.pollsNotImplemented)
		protected.Post("/polls/{messageID}/remind", h.pollsNotImplemented)
		protected.Post("/polls/{messageID}/close", h.pollsNotImplemented)
		return
	}
	create, vote, read := h.actorRateLimit("polls-create", h.pollRate), h.actorRateLimit("polls-vote", h.pollVoteRate), h.actorRateLimit("polls-read", h.pollReadRate)
	people := h.pollPeopleOnly
	protected.With(people, create).Post("/chats/{chatID}/polls", h.createPoll)
	protected.With(people, read).Get("/polls/{messageID}", h.getPoll)
	protected.With(people, vote).Patch("/polls/{messageID}", h.updatePoll)
	protected.With(people, vote).Put("/polls/{messageID}/vote", h.votePoll)
	protected.With(people, vote).Delete("/polls/{messageID}/vote", h.retractPollVote)
	protected.With(people, read).Get("/polls/{messageID}/voters", h.listPollVoters)
	protected.With(people, vote).Post("/polls/{messageID}/remind", h.remindPoll)
	protected.With(people, vote).Post("/polls/{messageID}/close", h.closePoll)
}

func (h *identityHandlers) pollsNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "Polls are not available on this server yet.")
}

func (h *identityHandlers) pollPeopleOnly(next standardhttp.Handler) standardhttp.Handler {
	return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
		if authFromContext(r.Context()).Identity.AuthenticationKind == "api_key" {
			h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "Polls are available to people only.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *identityHandlers) createPoll(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input message.CreatePollInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, created, err := h.messages.CreatePoll(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"), input)
	if err != nil {
		h.pollError(w, r, err)
		return
	}
	status := standardhttp.StatusOK
	if created {
		status = standardhttp.StatusCreated
		w.Header().Set("Location", "/api/v1/polls/"+result.ID)
	}
	writeJSON(h.logger, w, status, result)
}

func (h *identityHandlers) getPoll(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.messages.Polls().Get(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.pollError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) updatePoll(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input poll.EditInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.messages.UpdatePoll(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), input)
	if err != nil {
		h.pollError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) votePoll(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input poll.VoteInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", "Request body must be a vote.")
		return
	}
	if input.ExpectedVersion != nil && *input.ExpectedVersion < 1 {
		h.writePollInvalid(w, r, "expected_version", "expected_version must be positive.")
		return
	}
	result, err := h.messages.Polls().Vote(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), input)
	if err != nil {
		h.pollError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) retractPollVote(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if err := h.messages.Polls().Retract(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID")); err != nil {
		h.pollError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) listPollVoters(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	query := r.URL.Query()
	options := poll.VotersOptions{Filter: query.Get("filter")}
	if raw := query.Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 100 {
			h.writePollInvalid(w, r, "limit", "limit must be an integer between 1 and 100.")
			return
		}
		options.Limit = value
	}
	if cursor := query.Get("cursor"); cursor != "" {
		if len(cursor) > 200 {
			h.writePollInvalid(w, r, "cursor", "cursor is malformed.")
			return
		}
		options.Cursor = &cursor
	}
	result, err := h.messages.Polls().Voters(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"), options)
	if err != nil {
		h.pollError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) remindPoll(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.messages.Polls().Remind(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.pollError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) closePoll(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.messages.Polls().Close(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "messageID"))
	if err != nil {
		h.pollError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) writePollInvalid(w standardhttp.ResponseWriter, r *standardhttp.Request, field, text string) {
	details := map[string]any{"field": field}
	writeJSON(h.logger, w, standardhttp.StatusUnprocessableEntity, apiError(r, "poll_invalid", text, &details))
}

func (h *identityHandlers) pollError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	var invalidField *poll.InvalidError
	var tooSoon *poll.RemindTooSoonError
	switch {
	case errors.As(err, &invalidField):
		h.writePollInvalid(w, r, invalidField.Field, invalidField.Message)
	case errors.As(err, &tooSoon):
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(tooSoon.RetryAfter.Seconds()))))
		h.writeError(w, r, standardhttp.StatusTooManyRequests, "poll_remind_too_soon", "The people were reminded recently; try again later.")
	case errors.Is(err, poll.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "poll_not_found", "The poll was not found.")
	case errors.Is(err, poll.ErrNotMember):
		h.writeError(w, r, standardhttp.StatusForbidden, "not_member", "You are not a member of this chat.")
	case errors.Is(err, poll.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You may not do this with the poll.")
	case errors.Is(err, poll.ErrClosed):
		h.writeError(w, r, standardhttp.StatusConflict, "poll_closed", "The poll is closed.")
	case errors.Is(err, poll.ErrVoteFinal):
		h.writeError(w, r, standardhttp.StatusConflict, "poll_vote_final", "A vote in an anonymous poll cannot be changed.")
	case errors.Is(err, poll.ErrChatArchived):
		h.writeError(w, r, standardhttp.StatusConflict, "chat_archived", "The chat is archived.")
	case errors.Is(err, poll.ErrLimitReached):
		h.writeError(w, r, standardhttp.StatusConflict, "poll_limit_reached", "The poll limit was reached.")
	case errors.Is(err, poll.ErrVersionConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "version_conflict", "The poll was changed by someone else.")
	case errors.Is(err, poll.ErrUnavailable):
		h.pollsNotImplemented(w, r)
	case errors.Is(err, message.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "poll_invalid", err.Error())
	default:
		h.messageError(w, r, err)
	}
}
