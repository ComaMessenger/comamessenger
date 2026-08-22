package http

import (
	"errors"
	"github.com/comamessenger/comamessenger/core/internal/agentrun"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/go-chi/chi/v5"
	standardhttp "net/http"
)

type publishAgentRunInput struct {
	LeaseToken        string   `json:"lease_token"`
	ClientMsgID       string   `json:"client_msg_id"`
	Body              string   `json:"body"`
	BodyFormat        string   `json:"body_format"`
	MentionedActorIDs []string `json:"mentioned_actor_ids"`
	FileIDs           []string `json:"file_ids"`
}

func (h *identityHandlers) invokeAgent(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentrun.InvokeInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.agentRuns.Invoke(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"), input)
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusAccepted, result)
}
func (h *identityHandlers) listAgentRuns(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentRuns.List(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "agentID"))
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) getAgentRun(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentRuns.Get(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "runID"))
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) cancelAgentRun(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.agentRuns.RequestCancel(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "runID"))
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) claimAgentRun(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentrun.ClaimInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, err := h.agentRuns.ClaimForAgent(r.Context(), auth.User, auth.Identity, input)
	if errors.Is(err, agentrun.ErrNotFound) {
		w.WriteHeader(standardhttp.StatusNoContent)
		return
	}
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) heartbeatAgentRun(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentrun.LeaseInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, err := h.agentRuns.HeartbeatForAgent(r.Context(), auth.User, auth.Identity, chi.URLParam(r, "runID"), input)
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) publishAgentRun(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input publishAgentRunInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	runID := chi.URLParam(r, "runID")
	target, err := h.agentRuns.RuntimeTarget(r.Context(), auth.User, auth.Identity, runID, input.LeaseToken)
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	if target.DryRun {
		h.writeError(w, r, standardhttp.StatusConflict, "dry_run_write_forbidden", "Dry runs cannot publish messages.")
		return
	}
	created, _, err := h.messages.CreateFinalForAgentRun(r.Context(), identity.User{ActorID: target.AgentID, OrgID: auth.User.OrgID, OrgRole: "member"}, target.ChatID, message.CreateInput{
		ClientMsgID: input.ClientMsgID, Body: input.Body, BodyFormat: input.BodyFormat,
		ReplyToID: target.ThreadRootID, ThreadRootID: target.ThreadRootID,
		MentionedActorIDs: input.MentionedActorIDs, FileIDs: input.FileIDs,
	}, message.AgentProvenance{RunID: runID})
	if err != nil {
		h.writeAgentToolError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, created)
}

func (h *identityHandlers) completeAgentRun(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentrun.RuntimeCompletion
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, err := h.agentRuns.CompleteForAgent(r.Context(), auth.User, auth.Identity, chi.URLParam(r, "runID"), input)
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) failAgentRun(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentrun.RuntimeFailure
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, err := h.agentRuns.FailForAgent(r.Context(), auth.User, auth.Identity, chi.URLParam(r, "runID"), input)
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) getAgentRuntimeCheckpoint(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	auth := authFromContext(r.Context())
	result, err := h.agentRuns.GetRuntimeCheckpoint(r.Context(), auth.User, auth.Identity, chi.URLParam(r, "consumer"))
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) updateAgentRuntimeCheckpoint(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentrun.UpdateRuntimeCheckpoint
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, err := h.agentRuns.UpdateRuntimeCheckpoint(r.Context(), auth.User, auth.Identity, chi.URLParam(r, "consumer"), input)
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) startAgentProviderCall(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentrun.StartProviderCallInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, err := h.agentRuns.StartProviderCall(r.Context(), auth.User, auth.Identity, input)
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}

func (h *identityHandlers) finishAgentProviderCall(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentrun.FinishProviderCallInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, err := h.agentRuns.FinishProviderCall(r.Context(), auth.User, auth.Identity, chi.URLParam(r, "callID"), input)
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) startAgentMCPToolCall(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentrun.StartMCPToolCallInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, err := h.agentRuns.StartMCPToolCall(r.Context(), auth.User, auth.Identity, input)
	if err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}

func (h *identityHandlers) finishAgentMCPToolCall(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input agentrun.FinishMCPToolCallInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	if err := h.agentRuns.FinishMCPToolCall(r.Context(), auth.User, auth.Identity, chi.URLParam(r, "callID"), input); err != nil {
		h.writeAgentRunError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}
func (h *identityHandlers) writeAgentRunError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, agentrun.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	case errors.Is(err, agentrun.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "The agent run action is not allowed.")
	case errors.Is(err, agentrun.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "agent_not_found", "The agent run was not found.")
	case errors.Is(err, agentrun.ErrConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "agent_conflict", "The agent run state has already changed.")
	case errors.Is(err, agentrun.ErrBudget):
		h.writeError(w, r, standardhttp.StatusPaymentRequired, "agent_budget_exceeded", "The agent cost budget has been reached.")
	case errors.Is(err, agentrun.ErrRateLimited):
		h.writeError(w, r, standardhttp.StatusTooManyRequests, "agent_provider_rate_limited", "The agent provider rate limit has been reached.")
	default:
		h.internalError(w, r, err)
	}
}
