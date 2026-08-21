package http

import (
	"errors"
	standardhttp "net/http"

	"github.com/comamessenger/comamessenger/core/internal/push"
	"github.com/go-chi/chi/v5"
)

func (h *identityHandlers) pushConfig(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	writeJSON(h.logger, w, standardhttp.StatusOK, h.push.Config())
}
func (h *identityHandlers) testPush(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.push.Test(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.pushError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) putPushSubscription(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input push.SubscriptionInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, err := h.push.Subscribe(r.Context(), auth.User, auth.Identity.SessionID, r.UserAgent(), input)
	if err != nil {
		h.pushError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}
func (h *identityHandlers) listPushSubscriptions(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	auth := authFromContext(r.Context())
	result, err := h.push.ListSubscriptions(r.Context(), auth.User, auth.Identity.SessionID)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) deletePushSubscription(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	auth := authFromContext(r.Context())
	if err := h.push.Unsubscribe(r.Context(), auth.User, chi.URLParam(r, "subscriptionID")); err != nil {
		h.pushError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}
func (h *identityHandlers) getPreferences(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.push.GetPreferences(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) patchPreferences(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input push.UpdatePreferences
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.push.UpdatePreferences(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.pushError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) getChatFolders(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.push.GetChatFolders(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) putChatFolders(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input []push.ChatFolder
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.push.PutChatFolders(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.pushError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) getPinnedChats(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.push.GetPinnedChats(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) putPinnedChats(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input []string
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.push.PutPinnedChats(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.pushError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) getChatPreferences(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.push.GetChatPreferences(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"))
	if err != nil {
		h.pushError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) patchChatPreferences(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input push.ChatPreferences
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.push.UpdateChatPreferences(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"), input)
	if err != nil {
		h.pushError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) resetChatPreferences(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.push.ResetChatPreferences(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"))
	if err != nil {
		h.pushError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) listChatOverrides(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.push.ListChatOverrides(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}
func (h *identityHandlers) pushError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	if errors.Is(err, push.ErrUnavailable) {
		h.writeError(w, r, standardhttp.StatusServiceUnavailable, "push_unavailable", err.Error())
		return
	}
	if errors.Is(err, push.ErrInvalid) {
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	h.internalError(w, r, err)
}
