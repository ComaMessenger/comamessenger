package http

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	standardhttp "net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agentauthz"
	"github.com/comamessenger/comamessenger/core/internal/agentconfig"
	"github.com/comamessenger/comamessenger/core/internal/agentprovider"
	"github.com/comamessenger/comamessenger/core/internal/agentrun"
	"github.com/comamessenger/comamessenger/core/internal/agenttool"
	"github.com/comamessenger/comamessenger/core/internal/agenttrigger"
	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/push"
	"github.com/comamessenger/comamessenger/core/internal/search"
	"github.com/comamessenger/comamessenger/core/internal/userstate"
	"github.com/comamessenger/comamessenger/core/internal/workspace"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

const refreshCookieName = "comamessenger_refresh"

type Dependencies struct {
	Identity              *identity.Service
	Agents                *agent.Service
	AgentConfig           *agentconfig.Service
	AgentProvider         *agentprovider.Service
	AgentTools            *agenttool.Executor
	AgentRuns             *agentrun.Service
	AgentTriggers         *agenttrigger.Service
	Chats                 *chat.Service
	Messages              *message.Service
	UserState             *userstate.Service
	Push                  *push.Service
	Workspace             *workspace.Service
	Files                 *files.Service
	Search                *search.Service
	Realtime              standardhttp.Handler
	CookieSecure          bool
	RefreshTokenTTL       time.Duration
	BootstrapToken        string
	RequireBootstrapToken bool
	TrustedProxyCIDRs     []netip.Prefix
	RevokeRealtimeSession func(string)
}

type identityHandlers struct {
	logger                *slog.Logger
	service               *identity.Service
	agents                *agent.Service
	agentConfig           *agentconfig.Service
	agentProvider         *agentprovider.Service
	agentTools            *agenttool.Executor
	agentRuns             *agentrun.Service
	agentTriggers         *agenttrigger.Service
	chats                 *chat.Service
	messages              *message.Service
	userState             *userstate.Service
	push                  *push.Service
	workspace             *workspace.Service
	files                 *files.Service
	search                *search.Service
	realtime              standardhttp.Handler
	allowedOrigin         string
	cookieSecure          bool
	refreshTTL            time.Duration
	bootstrapRate         *ipRateLimiter
	loginRate             *ipRateLimiter
	refreshRate           *ipRateLimiter
	invitationRate        *ipRateLimiter
	websocketRate         *ipRateLimiter
	actorRate             *ipRateLimiter
	ownershipRate         *ipRateLimiter
	bootstrapToken        string
	requireBootstrapToken bool
	trustedProxyCIDRs     []netip.Prefix
	revokeRealtimeSession func(string)
}

type authContextKey struct{}

type authenticated struct {
	User     identity.User
	Identity access.Identity
}

func newIdentityHandlers(logger *slog.Logger, allowedOrigin string, dependencies Dependencies) *identityHandlers {
	return &identityHandlers{
		logger: logger, service: dependencies.Identity, agents: dependencies.Agents, agentConfig: dependencies.AgentConfig, agentProvider: dependencies.AgentProvider, agentTools: dependencies.AgentTools, agentRuns: dependencies.AgentRuns, agentTriggers: dependencies.AgentTriggers, chats: dependencies.Chats, messages: dependencies.Messages, userState: dependencies.UserState, push: dependencies.Push, workspace: dependencies.Workspace, files: dependencies.Files, search: dependencies.Search, realtime: dependencies.Realtime, allowedOrigin: allowedOrigin,
		cookieSecure: dependencies.CookieSecure, refreshTTL: dependencies.RefreshTokenTTL,
		bootstrapRate: newIPRateLimiter(5, 5), loginRate: newIPRateLimiter(10, 10),
		refreshRate: newIPRateLimiter(30, 20), invitationRate: newIPRateLimiter(10, 10), websocketRate: newIPRateLimiter(60, 20), actorRate: newIPRateLimiter(1200, 200),
		ownershipRate:  newIPRateLimiter(5, 5),
		bootstrapToken: dependencies.BootstrapToken, requireBootstrapToken: dependencies.RequireBootstrapToken,
		trustedProxyCIDRs: dependencies.TrustedProxyCIDRs, revokeRealtimeSession: dependencies.RevokeRealtimeSession,
	}
}

func (h *identityHandlers) routes(router chi.Router) {
	router.Get("/bootstrap/status", h.bootstrapStatus)
	router.With(h.rateLimit("bootstrap", h.bootstrapRate)).Post("/bootstrap", h.bootstrap)
	router.With(h.rateLimit("login", h.loginRate)).Post("/auth/login", h.login)
	router.With(h.rateLimit("refresh", h.refreshRate)).Post("/auth/refresh", h.refresh)
	router.With(h.rateLimit("password-forgot", h.loginRate)).Post("/auth/password/forgot", h.forgotPassword)
	router.With(h.rateLimit("password-reset", h.loginRate)).Post("/auth/password/reset", h.resetPassword)
	router.With(h.rateLimit("invitation-accept", h.invitationRate)).Post("/invitations/{token}/accept", h.acceptInvitation)
	if h.workspace != nil {
		router.Get("/branding", h.publicBranding)
		router.Get("/branding/{kind}", h.brandingAsset)
	}
	if h.realtime != nil {
		router.With(h.rateLimit("websocket", h.websocketRate)).Handle("/ws", h.realtime)
	}

	router.Group(func(protected chi.Router) {
		protected.Use(h.authenticate)
		protected.Use(h.requireCompletedPasswordChange)
		protected.Use(h.actorRateLimit("authenticated", h.actorRate))
		protected.Post("/auth/logout", h.logout)
		protected.Get("/me", h.me)
		protected.Patch("/me", h.updateMe)
		protected.Put("/me/status", h.setStatus)
		protected.Delete("/me/status", h.clearStatus)
		protected.Post("/me/password", h.changePassword)
		protected.Post("/me/email/change", h.changeEmail)
		protected.Post("/me/email/confirm", h.confirmEmail)
		protected.Get("/sessions", h.sessions)
		protected.Delete("/sessions/{sessionID}", h.revokeSession)
		protected.Post("/sessions/revoke-others", h.revokeOtherSessions)
		protected.Post("/invitations", h.createInvitation)
		protected.Get("/invitations", h.listInvitations)
		protected.Delete("/invitations/{invitationID}", h.revokeInvitation)
		protected.Post("/invitations/{invitationID}/rotate", h.rotateInvitation)
		if h.agents != nil {
			protected.Get("/agents", h.listAgents)
			protected.Get("/agents/product-metrics", h.agentProductMetrics)
			protected.Post("/agents", h.createAgent)
			protected.Get("/agents/settings", h.agentPlatformSettings)
			protected.Patch("/agents/settings", h.updateAgentPlatformSettings)
			protected.Get("/agents/{agentID}", h.getAgent)
			protected.Get("/agents/{agentID}/usage", h.agentUsage)
			protected.Patch("/agents/{agentID}", h.updateAgent)
			protected.Delete("/agents/{agentID}", h.deleteAgent)
			protected.Post("/agents/{agentID}/duplicate", h.duplicateAgent)
			protected.Post("/agents/{agentID}/reset-recipe", h.resetAgentRecipe)
			protected.Get("/agents/{agentID}/versions", h.listAgentVersions)
			protected.Post("/agents/{agentID}/publish", h.publishAgent)
			protected.Post("/agents/{agentID}/pause", h.pauseAgent)
			protected.Post("/agents/{agentID}/resume", h.resumeAgent)
			protected.Post("/agents/{agentID}/versions/{versionID}/rollback", h.rollbackAgent)
			protected.Get("/agents/{agentID}/keys", h.listAgentKeys)
			protected.Post("/agents/{agentID}/keys", h.createAgentKey)
			protected.Delete("/agents/{agentID}/keys/{keyID}", h.revokeAgentKey)
		}
		if h.agentConfig != nil {
			protected.Get("/agent-connections", h.listAgentLLMConnections)
			protected.Post("/agent-connections", h.createAgentLLMConnection)
			protected.Get("/agent-connections/{connectionID}", h.agentLLMConnection)
			protected.Patch("/agent-connections/{connectionID}", h.updateAgentLLMConnection)
			protected.Delete("/agent-connections/{connectionID}", h.deleteAgentLLMConnection)
			protected.Post("/agent-connections/{connectionID}/test", h.testAgentLLMConnection)
			protected.Get("/agents/{agentID}/provider-credentials", h.agentProviderCredential)
			protected.Put("/agents/{agentID}/provider-credentials", h.updateAgentProviderCredential)
			protected.Get("/agents/{agentID}/mcp-servers", h.listAgentMCPServers)
			protected.Post("/agents/{agentID}/mcp-servers", h.createAgentMCPServer)
			protected.Patch("/agents/{agentID}/mcp-servers/{serverID}", h.updateAgentMCPServer)
			protected.Delete("/agents/{agentID}/mcp-servers/{serverID}", h.deleteAgentMCPServer)
			protected.Post("/agent-runtime/mcp-servers", h.agentRuntimeMCPServers)
		}
		if h.agentTools != nil {
			protected.Get("/agent-tools", h.listAgentTools)
			protected.Post("/agent-tools/{toolName}", h.invokeAgentTool)
			protected.Get("/agents/tool-confirmations", h.listAgentToolConfirmations)
			protected.Post("/agents/tool-confirmations/{confirmationID}/approve", h.approveAgentToolConfirmation)
			protected.Post("/agents/tool-confirmations/{confirmationID}/deny", h.denyAgentToolConfirmation)
		}
		if h.agentRuns != nil {
			protected.Post("/agents/{agentID}/invoke", h.invokeAgent)
			protected.Get("/agents/{agentID}/runs", h.listAgentRuns)
			protected.Get("/agent-runs/{runID}", h.getAgentRun)
			protected.Post("/agent-runs/{runID}/cancel", h.cancelAgentRun)
			protected.Post("/agent-runtime/runs/claim", h.claimAgentRun)
			protected.Post("/agent-runtime/runs/{runID}/heartbeat", h.heartbeatAgentRun)
			protected.Post("/agent-runtime/runs/{runID}/publish", h.publishAgentRun)
			protected.Post("/agent-runtime/runs/{runID}/complete", h.completeAgentRun)
			protected.Post("/agent-runtime/runs/{runID}/fail", h.failAgentRun)
			protected.Get("/agent-runtime/checkpoints/{consumer}", h.getAgentRuntimeCheckpoint)
			protected.Put("/agent-runtime/checkpoints/{consumer}", h.updateAgentRuntimeCheckpoint)
			protected.Post("/agent-runtime/provider-calls", h.startAgentProviderCall)
			protected.Post("/agent-runtime/provider-calls/{callID}/finish", h.finishAgentProviderCall)
			protected.Post("/agent-runtime/mcp-tool-calls", h.startAgentMCPToolCall)
			protected.Post("/agent-runtime/mcp-tool-calls/{callID}/finish", h.finishAgentMCPToolCall)
		}
		if h.agentProvider != nil {
			protected.Post("/agent-runtime/provider/chat", h.proxyAgentProviderChat)
		}
		if h.agentTriggers != nil {
			protected.Get("/agents/{agentID}/triggers", h.listAgentTriggers)
			protected.Post("/agents/{agentID}/triggers", h.createAgentTrigger)
			protected.Patch("/agents/{agentID}/triggers/{triggerID}", h.updateAgentTrigger)
			protected.Delete("/agents/{agentID}/triggers/{triggerID}", h.deleteAgentTrigger)
		}
		protected.With(h.actorRateLimit("ownership-transfer", h.ownershipRate)).Post("/organization/transfer-ownership", h.transferOwnership)
		if h.workspace != nil {
			protected.Get("/organization", h.workspaceSettings)
			protected.Patch("/organization", h.updateWorkspaceSettings)
			protected.Put("/organization/branding/{kind}", h.putBrandingAsset)
			protected.Delete("/organization/branding/{kind}", h.deleteBrandingAsset)
			protected.Get("/organization/infrastructure", h.infrastructureSettings)
			protected.Patch("/organization/infrastructure", h.updateInfrastructureSettings)
			protected.Post("/organization/infrastructure/test", h.testInfrastructureConnection)
			protected.Get("/organization/members", h.organizationMembers)
			protected.Patch("/organization/members/{actorID}", h.updateOrganizationMember)
			protected.Post("/organization/members/{actorID}/password-reset", h.issueMemberPasswordReset)
			protected.Post("/organization/members/{actorID}/require-password-change", h.requireMemberPasswordChange)
			protected.Get("/organization/audit", h.organizationAudit)
		}
		if h.chats != nil {
			protected.Get("/actors", h.listActors)
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
		if h.messages != nil {
			protected.Get("/threads", h.listFollowedThreads)
			protected.Get("/chats/{chatID}/messages", h.listMessages)
			protected.Get("/chats/{chatID}/pins", h.listMessagePins)
			protected.Post("/chats/{chatID}/messages", h.createMessage)
			protected.Patch("/messages/{messageID}", h.updateMessage)
			protected.Get("/messages/{messageID}/context", h.messageContext)
			protected.Delete("/messages/{messageID}", h.deleteMessage)
			protected.Put("/messages/{messageID}/reactions/{emoji}", h.putReaction)
			protected.Get("/messages/{messageID}/reactions", h.listReactions)
			protected.Get("/messages/{messageID}/receipts", h.listMessageReceipts)
			protected.Delete("/messages/{messageID}/reactions/{emoji}", h.deleteReaction)
			protected.Put("/messages/{messageID}/pin", h.putMessagePin)
			protected.Delete("/messages/{messageID}/pin", h.deleteMessagePin)
			protected.Post("/messages/{messageID}/forward", h.forwardMessage)
			protected.Get("/messages/{messageID}/thread", h.listThread)
			protected.Put("/messages/{messageID}/thread/follow", h.followThread)
			protected.Delete("/messages/{messageID}/thread/follow", h.unfollowThread)
		}
		if h.files != nil {
			protected.Put("/me/avatar", h.putMyAvatar)
			protected.Delete("/me/avatar", h.deleteMyAvatar)
			protected.Put("/organization/members/{actorID}/avatar", h.putMemberAvatar)
			protected.Delete("/organization/members/{actorID}/avatar", h.deleteMemberAvatar)
			protected.Get("/actors/{actorID}/avatar", h.getActorAvatar)
			protected.Post("/files/uploads", h.createFileUpload)
			protected.Put("/files/uploads/{uploadID}/content", h.putFileUploadContent)
			protected.Post("/files/uploads/{uploadID}/parts", h.signFileUploadParts)
			protected.Post("/files/uploads/{uploadID}/complete", h.completeFileUpload)
			protected.Delete("/files/uploads/{uploadID}", h.abortFileUpload)
			protected.Get("/files/{fileID}", h.getFile)
			protected.Get("/files/{fileID}/download", h.downloadFile)
		}
		if h.search != nil {
			protected.Get("/search", h.searchMessagesAndFiles)
		}
		if h.userState != nil {
			protected.Get("/unread", h.unreadSnapshot)
			protected.Post("/chats/{chatID}/read", h.markChatRead)
			protected.Post("/messages/{messageID}/thread/read", h.markThreadRead)
			protected.Get("/drafts", h.listDrafts)
			protected.Put("/drafts/{chatID}", h.putDraft)
			protected.Delete("/drafts/{chatID}", h.deleteDraft)
		}
		if h.push != nil {
			protected.Get("/push/config", h.pushConfig)
			protected.Post("/push/test", h.testPush)
			protected.Get("/push/subscriptions", h.listPushSubscriptions)
			protected.Put("/push/subscriptions", h.putPushSubscription)
			protected.Delete("/push/subscriptions/{subscriptionID}", h.deletePushSubscription)
			protected.Get("/preferences", h.getPreferences)
			protected.Patch("/preferences", h.patchPreferences)
			protected.Get("/preferences/chat-folders", h.getChatFolders)
			protected.Put("/preferences/chat-folders", h.putChatFolders)
			protected.Get("/preferences/pinned-chats", h.getPinnedChats)
			protected.Put("/preferences/pinned-chats", h.putPinnedChats)
			protected.Get("/chats/notification-overrides", h.listChatOverrides)
			protected.Get("/chats/{chatID}/notification-preferences", h.getChatPreferences)
			protected.Patch("/chats/{chatID}/notification-preferences", h.patchChatPreferences)
			protected.Delete("/chats/{chatID}/notification-preferences", h.resetChatPreferences)
		}
	})
}

func (h *identityHandlers) requireCompletedPasswordChange(next standardhttp.Handler) standardhttp.Handler {
	return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
		if authFromContext(r.Context()).User.MustChangePassword {
			allowed := (r.Method == standardhttp.MethodGet && r.URL.Path == "/api/v1/me") ||
				(r.Method == standardhttp.MethodPost && (r.URL.Path == "/api/v1/me/password" || r.URL.Path == "/api/v1/auth/logout"))
			if !allowed {
				h.writeError(w, r, standardhttp.StatusForbidden, "password_change_required", "Password change is required before continuing.")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (h *identityHandlers) forgotPassword(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input identity.ForgotPasswordInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if err := h.service.ForgotPassword(r.Context(), input); err != nil {
		h.logger.Warn("password recovery request failed", "error", err)
	}
	w.WriteHeader(standardhttp.StatusAccepted)
}

func (h *identityHandlers) resetPassword(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input identity.ResetPasswordInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	revoked, err := h.service.ResetPassword(r.Context(), input)
	if err != nil {
		switch {
		case errors.Is(err, identity.ErrTokenInvalid):
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "token_invalid", "Password reset token is invalid or expired.")
		case identity.IsValidationError(err):
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
		default:
			h.internalError(w, r, err)
		}
		return
	}
	if h.revokeRealtimeSession != nil {
		for _, sessionID := range revoked {
			h.revokeRealtimeSession(sessionID)
		}
	}
	h.clearRefreshCookie(w)
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) listActors(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", "limit must be an integer.")
			return
		}
		limit = parsed
	}
	result, err := h.chats.ListActors(r.Context(), authFromContext(r.Context()).User, r.URL.Query().Get("q"), r.URL.Query().Get("after_id"), limit)
	if err != nil {
		if errors.Is(err, chat.ErrInvalid) {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
			return
		}
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) setStatus(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input identity.SetStatusInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	status, err := h.service.SetStatus(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		if identity.IsValidationError(err) {
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
		} else {
			h.internalError(w, r, err)
		}
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, status)
}

func (h *identityHandlers) clearStatus(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	status, err := h.service.ClearStatus(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, status)
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
	if h.requireBootstrapToken && !secureTokenEqual(h.bootstrapToken, r.Header.Get("X-Coma-Bootstrap-Token")) {
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "A valid bootstrap token is required.")
		return
	}
	var input identity.BootstrapInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	tokens, err := h.service.Bootstrap(r.Context(), input, h.requestDevice(r))
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
	tokens, err := h.service.Login(r.Context(), input, h.requestDevice(r))
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
	tokens, err := h.service.Refresh(r.Context(), cookie.Value, h.requestDevice(r))
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
	if h.revokeRealtimeSession != nil {
		h.revokeRealtimeSession(auth.Identity.SessionID)
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

func (h *identityHandlers) changePassword(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input identity.ChangePasswordInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	revoked, err := h.service.ChangePassword(r.Context(), auth.User, auth.Identity.SessionID, input)
	if err != nil {
		switch {
		case errors.Is(err, identity.ErrReauthentication):
			h.writeError(w, r, standardhttp.StatusForbidden, "reauthentication_failed", "Current password is incorrect.")
		case identity.IsValidationError(err):
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
		default:
			h.internalError(w, r, err)
		}
		return
	}
	if h.revokeRealtimeSession != nil {
		for _, sessionID := range revoked {
			h.revokeRealtimeSession(sessionID)
		}
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) changeEmail(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input identity.ChangeEmailInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	result, revoked, err := h.service.ChangeEmail(r.Context(), auth.User, auth.Identity.SessionID, input)
	if err != nil {
		h.writeEmailChangeError(w, r, err)
		return
	}
	if h.revokeRealtimeSession != nil {
		for _, sessionID := range revoked {
			h.revokeRealtimeSession(sessionID)
		}
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) confirmEmail(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input identity.ConfirmEmailInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	auth := authFromContext(r.Context())
	user, revoked, err := h.service.ConfirmEmail(r.Context(), auth.User, auth.Identity.SessionID, input)
	if err != nil {
		h.writeEmailChangeError(w, r, err)
		return
	}
	if h.revokeRealtimeSession != nil {
		for _, sessionID := range revoked {
			h.revokeRealtimeSession(sessionID)
		}
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, user)
}

func (h *identityHandlers) writeEmailChangeError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, identity.ErrReauthentication):
		h.writeError(w, r, standardhttp.StatusForbidden, "reauthentication_failed", "Current password is incorrect.")
	case errors.Is(err, identity.ErrEmailTaken):
		h.writeError(w, r, standardhttp.StatusConflict, "email_taken", "Email is already in use in this workspace.")
	case errors.Is(err, identity.ErrTokenInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "token_invalid", "Email confirmation token is invalid or expired.")
	case identity.IsValidationError(err):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	default:
		h.internalError(w, r, err)
	}
}

func (h *identityHandlers) transferOwnership(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input identity.TransferOwnershipInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	user, err := h.service.TransferOwnership(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		switch {
		case errors.Is(err, identity.ErrForbidden):
			h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "Only the current workspace owner can transfer ownership.")
		case errors.Is(err, identity.ErrReauthentication):
			h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "Current password is incorrect.")
		case errors.Is(err, identity.ErrNotFound):
			h.writeError(w, r, standardhttp.StatusNotFound, "workspace_not_found", "Ownership target was not found.")
		case errors.Is(err, identity.ErrConflict):
			h.writeError(w, r, standardhttp.StatusConflict, "version_conflict", "Workspace ownership changed. Reload and try again.")
		case identity.IsValidationError(err):
			h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
		default:
			h.internalError(w, r, err)
		}
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
	if h.revokeRealtimeSession != nil {
		h.revokeRealtimeSession(sessionID)
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) revokeOtherSessions(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	auth := authFromContext(r.Context())
	revoked, err := h.service.RevokeOtherSessions(r.Context(), auth.User.ActorID, auth.Identity.SessionID)
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	if h.revokeRealtimeSession != nil {
		for _, sessionID := range revoked {
			h.revokeRealtimeSession(sessionID)
		}
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]int{"revoked": len(revoked)})
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

func (h *identityHandlers) listInvitations(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	items, err := h.service.Invitations(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		if errors.Is(err, identity.ErrForbidden) {
			h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You do not have permission to list invitations.")
			return
		}
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, items)
}

func (h *identityHandlers) revokeInvitation(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	err := h.service.RevokeInvitation(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "invitationID"))
	if err != nil {
		switch {
		case errors.Is(err, identity.ErrForbidden):
			h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You do not have permission to revoke invitations.")
		case errors.Is(err, identity.ErrNotFound):
			h.writeError(w, r, standardhttp.StatusNotFound, "not_found", "Invitation was not found.")
		default:
			h.internalError(w, r, err)
		}
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) rotateInvitation(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	invitation, err := h.service.RotateInvitation(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "invitationID"))
	if err != nil {
		switch {
		case errors.Is(err, identity.ErrForbidden):
			h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You do not have permission to rotate invitations.")
		case errors.Is(err, identity.ErrNotFound):
			h.writeError(w, r, standardhttp.StatusNotFound, "not_found", "Invitation was not found.")
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
	tokens, err := h.service.AcceptInvitation(r.Context(), chi.URLParam(r, "token"), input, h.requestDevice(r))
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
			if errors.Is(err, agent.ErrRateLimited) {
				w.Header().Set("Retry-After", "60")
				h.writeError(w, r, standardhttp.StatusTooManyRequests, "rate_limited", "The agent API rate limit was exceeded.")
				return
			}
			h.writeError(w, r, standardhttp.StatusUnauthorized, "unauthorized", "Authentication is required.")
			return
		}
		if accessIdentity.AuthenticationKind == "api_key" {
			required, allowed := requiredAgentScope(r.Method, r.URL.Path)
			hasRequiredScope := agentauthz.HasScope(accessIdentity.Scopes, required) ||
				(required == string(agent.ScopeRuntimeExecute) && agentauthz.HasScope(accessIdentity.Scopes, string(agent.ScopeRuntimeWorker)))
			if !allowed || !hasRequiredScope {
				h.writeError(w, r, standardhttp.StatusForbidden, "agent_scope_required", "The agent key does not allow this API operation.")
				return
			}
		}
		ctx := context.WithValue(r.Context(), authContextKey{}, authenticated{User: user, Identity: accessIdentity})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func requiredAgentScope(method, path string) (string, bool) {
	path = strings.TrimPrefix(path, "/api/v1")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 0 {
		return "", false
	}
	if method == standardhttp.MethodGet && len(parts) == 1 && parts[0] == "me" {
		return "", true
	}
	if parts[0] == "agent-runtime" && runtimeAgentRoute(method, parts[1:]) {
		return string(agent.ScopeRuntimeExecute), true
	}
	if method == standardhttp.MethodGet && parts[0] == "actors" {
		return string(agent.ScopeMembersRead), true
	}
	if parts[0] == "agent-tools" && ((method == standardhttp.MethodGet && len(parts) == 1) || (method == standardhttp.MethodPost && len(parts) == 2)) {
		return "", true
	}
	if method == standardhttp.MethodGet && parts[0] == "search" {
		return string(agent.ScopeSearchRead), true
	}
	if method == standardhttp.MethodGet && parts[0] == "files" && len(parts) >= 2 && parts[1] != "uploads" {
		return string(agent.ScopeFilesRead), true
	}
	if parts[0] == "chats" {
		if method == standardhttp.MethodPost && len(parts) == 3 && parts[2] == "messages" {
			return string(agent.ScopeMessagesWrite), true
		}
		if method == standardhttp.MethodGet && len(parts) >= 3 && parts[2] == "messages" {
			return string(agent.ScopeMessagesRead), true
		}
		if method == standardhttp.MethodGet && len(parts) >= 3 && parts[2] == "members" {
			return string(agent.ScopeMembersRead), true
		}
		if method == standardhttp.MethodGet && len(parts) <= 2 {
			return string(agent.ScopeChatsRead), true
		}
	}
	if parts[0] == "threads" && method == standardhttp.MethodGet {
		return string(agent.ScopeMessagesRead), true
	}
	if parts[0] == "messages" && len(parts) >= 2 {
		if len(parts) >= 3 && parts[2] == "reactions" {
			if method == standardhttp.MethodGet {
				return string(agent.ScopeMessagesRead), true
			}
			if method == standardhttp.MethodPut || method == standardhttp.MethodDelete {
				return string(agent.ScopeReactionsWrite), true
			}
		}
		if method == standardhttp.MethodGet {
			return string(agent.ScopeMessagesRead), true
		}
	}
	return "", false
}

func runtimeAgentRoute(method string, parts []string) bool {
	if method == standardhttp.MethodGet {
		return len(parts) == 2 && parts[0] == "checkpoints"
	}
	if method == standardhttp.MethodPut {
		return len(parts) == 2 && parts[0] == "checkpoints"
	}
	if method != standardhttp.MethodPost {
		return false
	}
	return (len(parts) == 2 && parts[0] == "runs" && parts[1] == "claim") ||
		(len(parts) == 3 && parts[0] == "runs" && (parts[2] == "heartbeat" || parts[2] == "publish" || parts[2] == "complete" || parts[2] == "fail")) ||
		(len(parts) == 2 && parts[0] == "provider" && parts[1] == "chat") ||
		(len(parts) == 1 && parts[0] == "mcp-servers") ||
		(len(parts) == 1 && (parts[0] == "provider-calls" || parts[0] == "mcp-tool-calls")) ||
		(len(parts) == 3 && (parts[0] == "provider-calls" || parts[0] == "mcp-tool-calls") && parts[2] == "finish")
}

func authFromContext(ctx context.Context) authenticated {
	auth, _ := ctx.Value(authContextKey{}).(authenticated)
	return auth
}

func (h *identityHandlers) actorRateLimit(name string, limiter *ipRateLimiter) func(standardhttp.Handler) standardhttp.Handler {
	return func(next standardhttp.Handler) standardhttp.Handler {
		return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
			actorID := authFromContext(r.Context()).User.ActorID
			if !limiter.Allow(name + ":" + actorID) {
				w.Header().Set("Retry-After", "1")
				h.writeError(w, r, standardhttp.StatusTooManyRequests, "rate_limited", "Too many requests.")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (h *identityHandlers) rateLimit(name string, limiter *ipRateLimiter) func(standardhttp.Handler) standardhttp.Handler {
	return func(next standardhttp.Handler) standardhttp.Handler {
		return standardhttp.HandlerFunc(func(w standardhttp.ResponseWriter, r *standardhttp.Request) {
			if !limiter.Allow(name + ":" + h.clientIP(r)) {
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

func (h *identityHandlers) writeError(w standardhttp.ResponseWriter, r *standardhttp.Request, status int, code api.ErrorCode, message string) {
	writeJSON(h.logger, w, status, api.Error{Code: code, Message: message, RequestId: middleware.GetReqID(r.Context())})
}

func (h *identityHandlers) internalError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	h.logger.Error("api request failed", "error", err, "request_id", middleware.GetReqID(r.Context()))
	h.writeError(w, r, standardhttp.StatusInternalServerError, "internal_error", "An internal error occurred.")
}

func decodeJSON(w standardhttp.ResponseWriter, r *standardhttp.Request, destination any) error {
	controller := standardhttp.NewResponseController(w)
	if err := controller.SetReadDeadline(time.Now().Add(15 * time.Second)); err == nil {
		defer controller.SetReadDeadline(time.Time{})
	}
	r.Body = standardhttp.MaxBytesReader(w, r.Body, 2<<20)
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

func (h *identityHandlers) requestDevice(r *standardhttp.Request) identity.Device {
	return identity.Device{UserAgent: r.UserAgent(), IPAddress: h.clientIP(r)}
}

func (h *identityHandlers) clientIP(r *standardhttp.Request) string {
	peer, ok := parseRemoteAddress(r.RemoteAddr)
	if !ok || !prefixContains(h.trustedProxyCIDRs, peer) {
		return peer.String()
	}
	parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for index := len(parts) - 1; index >= 0; index-- {
		candidate, err := netip.ParseAddr(strings.TrimSpace(parts[index]))
		if err != nil {
			continue
		}
		candidate = candidate.Unmap()
		if !prefixContains(h.trustedProxyCIDRs, candidate) {
			return candidate.String()
		}
	}
	return peer.String()
}

func parseRemoteAddress(remote string) (netip.Addr, bool) {
	if addressPort, err := netip.ParseAddrPort(remote); err == nil {
		return addressPort.Addr().Unmap(), true
	}
	address, err := netip.ParseAddr(remote)
	return address.Unmap(), err == nil
}

func prefixContains(prefixes []netip.Prefix, address netip.Addr) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func secureTokenEqual(expected, actual string) bool {
	expectedHash := sha256.Sum256([]byte(expected))
	actualHash := sha256.Sum256([]byte(actual))
	return subtle.ConstantTimeCompare(expectedHash[:], actualHash[:]) == 1
}
