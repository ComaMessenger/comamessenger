package http

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	standardhttp "net/http"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

const refreshCookieName = "comamessenger_refresh"

type Dependencies struct {
	Identity        *identity.Service
	Chats           *chat.Service
	CookieSecure    bool
	RefreshTokenTTL time.Duration
}

type identityHandlers struct {
	logger         *slog.Logger
	service        *identity.Service
	chats          *chat.Service
	allowedOrigin  string
	cookieSecure   bool
	refreshTTL     time.Duration
	bootstrapRate  *ipRateLimiter
	loginRate      *ipRateLimiter
	refreshRate    *ipRateLimiter
	invitationRate *ipRateLimiter
}

type authContextKey struct{}

type authenticated struct {
	User     identity.User
	Identity access.Identity
}

func newIdentityHandlers(logger *slog.Logger, allowedOrigin string, dependencies Dependencies) *identityHandlers {
	return &identityHandlers{
		logger: logger, service: dependencies.Identity, chats: dependencies.Chats, allowedOrigin: allowedOrigin,
		cookieSecure: dependencies.CookieSecure, refreshTTL: dependencies.RefreshTokenTTL,
		bootstrapRate: newIPRateLimiter(5, 5), loginRate: newIPRateLimiter(10, 10),
		refreshRate: newIPRateLimiter(30, 20), invitationRate: newIPRateLimiter(10, 10),
	}
}

func (h *identityHandlers) routes(router chi.Router) {
	router.Get("/bootstrap/status", h.bootstrapStatus)
	router.With(h.rateLimit("bootstrap", h.bootstrapRate)).Post("/bootstrap", h.bootstrap)
	router.With(h.rateLimit("login", h.loginRate)).Post("/auth/login", h.login)
	router.With(h.rateLimit("refresh", h.refreshRate)).Post("/auth/refresh", h.refresh)
	router.With(h.rateLimit("invitation-accept", h.invitationRate)).Post("/invitations/{token}/accept", h.acceptInvitation)

	router.Group(func(protected chi.Router) {
		protected.Use(h.authenticate)
		protected.Post("/auth/logout", h.logout)
		protected.Get("/me", h.me)
		protected.Patch("/me", h.updateMe)
		protected.Get("/sessions", h.sessions)
		protected.Delete("/sessions/{sessionID}", h.revokeSession)
		protected.Post("/invitations", h.createInvitation)
		if h.chats != nil {
			protected.Get("/chats", h.listChats)
			protected.Post("/chats", h.createChat)
			protected.Get("/chats/discover", h.discoverChats)
			protected.Get("/chats/{chatID}", h.getChat)
			protected.Patch("/chats/{chatID}", h.updateChat)
			protected.Delete("/chats/{chatID}", h.archiveChat)
			protected.Post("/chats/{chatID}/join", h.joinChat)
			protected.Get("/chats/{chatID}/members", h.listChatMembers)
			protected.Post("/chats/{chatID}/members", h.addChatMember)
			protected.Patch("/chats/{chatID}/members/{actorID}", h.updateChatMember)
			protected.Delete("/chats/{chatID}/members/{actorID}", h.removeChatMember)
		}
	})
}

func (h *identityHandlers) bootstrapStatus(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	bootstrapped, err := h.service.BootstrapStatus(r.Context())
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]bool{"bootstrapped": bootstrapped})
}

func (h *identityHandlers) bootstrap(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input identity.BootstrapInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	tokens, err := h.service.Bootstrap(r.Context(), input, requestDevice(r))
	if errors.Is(err, identity.ErrAlreadyBootstrapped) {
		h.writeError(w, r, standardhttp.StatusConflict, "already_bootstrapped", "The instance has already been bootstrapped.")
		return
	}
	if err != nil {
		if identity.IsValidationError(err) {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
			return
		}
		h.internalError(w, r, err)
		return
	}
	h.setRefreshCookie(w, tokens.RefreshToken)
	writeJSON(h.logger, w, standardhttp.StatusCreated, tokens)
}

func (h *identityHandlers) login(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input identity.LoginInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	tokens, err := h.service.Login(r.Context(), input, requestDevice(r))
	if errors.Is(err, identity.ErrInvalidCredentials) {
		h.writeError(w, r, standardhttp.StatusUnauthorized, "invalid_credentials", "Email or password is incorrect.")
		return
	}
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	h.setRefreshCookie(w, tokens.RefreshToken)
	writeJSON(h.logger, w, standardhttp.StatusOK, tokens)
}

func (h *identityHandlers) refresh(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if !h.validOrigin(r) {
		h.writeError(w, r, standardhttp.StatusForbidden, "origin_not_allowed", "Request origin is not allowed.")
		return
	}
	cookie, err := r.Cookie(refreshCookieName)
	if err != nil {
		h.clearRefreshCookie(w)
		h.writeError(w, r, standardhttp.StatusUnauthorized, "invalid_refresh_token", "Refresh token is invalid.")
		return
	}
	tokens, err := h.service.Refresh(r.Context(), cookie.Value, requestDevice(r))
	if errors.Is(err, identity.ErrInvalidRefreshToken) || errors.Is(err, identity.ErrRefreshReuse) {
		h.clearRefreshCookie(w)
		h.writeError(w, r, standardhttp.StatusUnauthorized, "invalid_refresh_token", "Refresh token is invalid.")
		return
	}
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	h.setRefreshCookie(w, tokens.RefreshToken)
	writeJSON(h.logger, w, standardhttp.StatusOK, tokens)
}

func (h *identityHandlers) logout(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	auth := authFromContext(r.Context())
	if err := h.service.Logout(r.Context(), auth.User.ActorID, auth.Identity.SessionID); err != nil && !errors.Is(err, identity.ErrNotFound) {
		h.internalError(w, r, err)
		return
	}
	h.clearRefreshCookie(w)
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) me(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	writeJSON(h.logger, w, standardhttp.StatusOK, authFromContext(r.Context()).User)
}

func (h *identityHandlers) updateMe(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input identity.UpdateProfileInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	user, err := h.service.UpdateProfile(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		if identity.IsValidationError(err) {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
			return
		}
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, user)
}

func (h *identityHandlers) sessions(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	auth := authFromContext(r.Context())
	sessions, err := h.service.ListSessions(r.Context(), auth.User.ActorID, auth.Identity.SessionID)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]any{"sessions": sessions})
}

func (h *identityHandlers) revokeSession(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	auth := authFromContext(r.Context())
	sessionID := chi.URLParam(r, "sessionID")
	if err := h.service.RevokeSession(r.Context(), auth.User.ActorID, sessionID); err != nil {
		if errors.Is(err, identity.ErrNotFound) {
			h.writeError(w, r, standardhttp.StatusNotFound, "session_not_found", "Session was not found.")
			return
		}
		h.internalError(w, r, err)
		return
	}
	if sessionID == auth.Identity.SessionID {
		h.clearRefreshCookie(w)
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) createInvitation(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input identity.CreateInvitationInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	invitation, err := h.service.CreateInvitation(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		switch {
		case errors.Is(err, identity.ErrForbidden):
			h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You do not have permission to create invitations.")
		case identity.IsValidationError(err):
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
		default:
			h.internalError(w, r, err)
		}
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusCreated, invitation)
}

func (h *identityHandlers) acceptInvitation(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input identity.AcceptInvitationInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	tokens, err := h.service.AcceptInvitation(r.Context(), chi.URLParam(r, "token"), input, requestDevice(r))
	if err != nil {
		switch {
		case errors.Is(err, identity.ErrInvitationInvalid):
			h.writeError(w, r, standardhttp.StatusGone, "invitation_invalid", "Invitation is invalid or has expired.")
		case identity.IsValidationError(err):
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
		default:
			h.internalError(w, r, err)
		}
		return
	}
	h.setRefreshCookie(w, tokens.RefreshToken)
	writeJSON(h.logger, w, standardhttp.StatusCreated, tokens)
}

func (h *identityHandlers) listChats(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	chats, err := h.chats.List(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]any{"chats": chats})
}

func (h *identityHandlers) createChat(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input chat.CreateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	created, err := h.chats.Create(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		switch {
		case errors.Is(err, chat.ErrForbidden):
			h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You do not have permission to create this chat.")
		case errors.Is(err, chat.ErrInvalid):
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
		default:
			h.internalError(w, r, err)
		}
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusCreated, created)
}

func (h *identityHandlers) getChat(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.chats.Get(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"))
	if errors.Is(err, chat.ErrNotFound) {
		h.writeError(w, r, standardhttp.StatusNotFound, "chat_not_found", "Chat was not found.")
		return
	}
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) discoverChats(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.chats.Discover(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]any{"chats": result})
}

func (h *identityHandlers) updateChat(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input chat.UpdateInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.chats.Update(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"), input)
	if err != nil {
		h.writeChatError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) archiveChat(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	err := h.chats.Archive(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"))
	if err != nil {
		h.writeChatError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) joinChat(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.chats.Join(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"))
	if err != nil {
		h.writeChatError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) listChatMembers(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.chats.ListMembers(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"))
	if err != nil {
		h.writeChatError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]any{"members": result})
}

func (h *identityHandlers) addChatMember(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input chat.MemberInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.chats.AddMember(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"), input)
	if err != nil {
		h.writeChatError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}

func (h *identityHandlers) updateChatMember(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input chat.UpdateMemberInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.chats.UpdateMember(r.Context(), authFromContext(r.Context()).User,
		chi.URLParam(r, "chatID"), chi.URLParam(r, "actorID"), input)
	if err != nil {
		h.writeChatError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) removeChatMember(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	err := h.chats.RemoveMember(r.Context(), authFromContext(r.Context()).User,
		chi.URLParam(r, "chatID"), chi.URLParam(r, "actorID"))
	if err != nil {
		h.writeChatError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) writeChatError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, chat.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "chat_not_found", "Chat or member was not found.")
	case errors.Is(err, chat.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You do not have permission for this chat action.")
	case errors.Is(err, chat.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	case errors.Is(err, chat.ErrConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "chat_conflict", "The chat action conflicts with its current state.")
	default:
		h.internalError(w, r, err)
	}
}

func (h *identityHandlers) authenticate(next standardhttp.Handler) standardhttp.Handler {
	return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
		header := r.Header.Get("Authorization")
		parts := strings.SplitN(header, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || strings.TrimSpace(parts[1]) == "" {
			h.writeError(w, r, standardhttp.StatusUnauthorized, "unauthorized", "Authentication is required.")
			return
		}
		user, accessIdentity, err := h.service.Authenticate(r.Context(), strings.TrimSpace(parts[1]))
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnauthorized, "unauthorized", "Authentication is required.")
			return
		}
		ctx := context.WithValue(r.Context(), authContextKey{}, authenticated{User: user, Identity: accessIdentity})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func authFromContext(ctx context.Context) authenticated {
	auth, _ := ctx.Value(authContextKey{}).(authenticated)
	return auth
}

func (h *identityHandlers) rateLimit(name string, limiter *ipRateLimiter) func(standardhttp.Handler) standardhttp.Handler {
	return func(next standardhttp.Handler) standardhttp.Handler {
		return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
			host, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				host = r.RemoteAddr
			}
			if !limiter.Allow(name + ":" + host) {
				w.Header().Set("Retry-After", "60")
				h.writeError(w, r, standardhttp.StatusTooManyRequests, "rate_limited", "Too many requests.")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (h *identityHandlers) setRefreshCookie(w standardhttp.ResponseWriter, value string) {
	standardhttp.SetCookie(w, &standardhttp.Cookie{
		Name: refreshCookieName, Value: value, Path: "/api/v1/auth", MaxAge: int(h.refreshTTL.Seconds()),
		HttpOnly: true, Secure: h.cookieSecure, SameSite: standardhttp.SameSiteLaxMode,
	})
}

func (h *identityHandlers) clearRefreshCookie(w standardhttp.ResponseWriter) {
	standardhttp.SetCookie(w, &standardhttp.Cookie{
		Name: refreshCookieName, Value: "", Path: "/api/v1/auth", MaxAge: -1,
		HttpOnly: true, Secure: h.cookieSecure, SameSite: standardhttp.SameSiteLaxMode,
	})
}

func (h *identityHandlers) validOrigin(r *standardhttp.Request) bool {
	origin := r.Header.Get("Origin")
	return origin == "" || origin == h.allowedOrigin
}

func (h *identityHandlers) writeError(w standardhttp.ResponseWriter, r *standardhttp.Request, status int, code, message string) {
	writeJSON(h.logger, w, status, api.Error{Code: code, Message: message, RequestId: middleware.GetReqID(r.Context())})
}

func (h *identityHandlers) internalError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	h.logger.Error("api request failed", "error", err, "request_id", middleware.GetReqID(r.Context()))
	h.writeError(w, r, standardhttp.StatusInternalServerError, "internal_error", "An internal error occurred.")
}

func decodeJSON(w standardhttp.ResponseWriter, r *standardhttp.Request, destination any) error {
	r.Body = standardhttp.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return errors.New("Request body must contain valid JSON.")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("Request body must contain a single JSON object.")
	}
	return nil
}

func requestDevice(r *standardhttp.Request) identity.Device {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = ""
	}
	return identity.Device{UserAgent: r.UserAgent(), IPAddress: host}
}
