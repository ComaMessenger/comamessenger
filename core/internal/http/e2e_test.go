package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	standardhttp "net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agentmemory"
	"github.com/comamessenger/comamessenger/core/internal/agentrun"
	"github.com/comamessenger/comamessenger/core/internal/agenttool"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/password"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/push"
	"github.com/comamessenger/comamessenger/core/internal/realtime"
	"github.com/comamessenger/comamessenger/core/internal/search"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/comamessenger/comamessenger/core/internal/userstate"
	"github.com/comamessenger/comamessenger/core/internal/workspace"
)

func TestTwoUserRESTAndWebSocketE2E(t *testing.T) {
	pool := testdb.New(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := httptest.NewUnstartedServer(nil)
	baseURL := "http://" + server.Listener.Addr().String()

	hasher, err := password.NewHasher(password.Params{MemoryKiB: 19 * 1024, Iterations: 2, Parallelism: 1})
	if err != nil {
		t.Fatal(err)
	}
	tokenManager, err := access.NewManager("0123456789abcdef0123456789abcdef", 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	emailSender := &e2eEmailSender{}
	identityService, err := identity.NewService(
		identity.NewRepository(pool), hasher, tokenManager,
		24*time.Hour, 24*time.Hour, baseURL, true, emailSender,
	)
	if err != nil {
		t.Fatal(err)
	}
	agentService := agent.NewService(pool)
	identityService.SetBearerAuthenticator(agentService.AuthenticateKey)
	eventStore := eventlog.NewStore(pool)
	hub := realtime.NewHub(10)
	realtimeConfig := e2eRealtimeConfig()
	ephemeral, err := realtime.NewEphemeral(logger, pool, hub, realtimeConfig, config.RedisConfig{
		Mode: "disabled", Namespace: "coma:e2e", OperationTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	dispatcher := realtime.NewDispatcher(logger, eventStore, hub, 20*time.Millisecond, time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		hub.Shutdown(context.Canceled)
		_ = ephemeral.Close()
	})
	go dispatcher.Run(ctx)
	go ephemeral.Run(ctx)
	afterCommit := func(_ string, _ int64) { dispatcher.WakeLocal() }
	identityService.SetAfterCommit(afterCommit)
	realtimeServer := realtime.NewServer(logger, baseURL, eventStore, hub, identityService.Authenticate, realtimeConfig, ephemeral)
	agentService.SetRevokeSession(realtimeServer.RevokeSession)
	workspaceService, err := workspace.NewService(workspace.NewRepository(pool), "e2e-encryption-secret", e2eConnectionTester{})
	if err != nil {
		t.Fatal(err)
	}
	blobStore, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	fileService, err := files.NewService(pool, blobStore, "", 16<<20, 4<<20, 1<<20, time.Hour, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	fileService.SetAfterCommit(afterCommit)
	chatService := chat.NewService(pool)
	messageService := message.NewService(pool, 64*1024, 100, afterCommit)
	searchService := search.NewService(pool)
	agentToolExecutor, err := agenttool.NewExecutor(pool, agenttool.Services{Chats: chatService, Messages: messageService, Search: searchService, Files: fileService, Memory: agentmemory.NewService(pool)}, true)
	if err != nil {
		t.Fatal(err)
	}
	agentRunService := agentrun.NewService(pool)
	server.Config.Handler = NewHandler(logger, baseURL, pool.Ping, Dependencies{
		Identity: identityService, Agents: agentService, AgentTools: agentToolExecutor, AgentRuns: agentRunService, Chats: chatService,
		Messages:  messageService,
		UserState: userstate.NewService(pool, 64*1024, afterCommit), Realtime: realtimeServer,
		Push:            push.NewService(pool, config.PushConfig{}),
		Workspace:       workspaceService,
		Files:           fileService,
		Search:          searchService,
		RefreshTokenTTL: 24 * time.Hour, RevokeRealtimeSession: realtimeServer.RevokeSession,
	})
	server.Start()
	t.Cleanup(server.Close)

	var owner identity.Tokens
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/bootstrap", "", map[string]any{
		"organization_name": "E2E", "organization_slug": "e2e", "display_name": "Owner",
		"handle": "owner", "email": "owner@example.test", "password": "correct horse battery staple", "timezone": "UTC",
	}, standardhttp.StatusCreated, &owner)
	if owner.User.OrganizationName != "E2E" {
		t.Fatalf("bootstrap organization name = %q", owner.User.OrganizationName)
	}
	if len(owner.User.Permissions) != len(permission.All()) {
		t.Fatalf("owner permissions = %#v", owner.User.Permissions)
	}

	var invitation identity.Invitation
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/invitations", owner.AccessToken, map[string]any{
		"email": "member@example.test", "role": "member",
	}, standardhttp.StatusCreated, &invitation)
	acceptURL, err := url.Parse(invitation.AcceptURL)
	if err != nil || path.Base(acceptURL.Path) == "" {
		t.Fatalf("invitation accept URL = %q, error = %v", invitation.AcceptURL, err)
	}
	invitationToken := path.Base(acceptURL.Path)
	var member identity.Tokens
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/invitations/"+invitationToken+"/accept", "", map[string]any{
		"display_name": "Member", "handle": "member", "password": "another correct password", "timezone": "UTC",
	}, standardhttp.StatusCreated, &member)
	if member.User.Permissions == nil || len(member.User.Permissions) != 0 {
		t.Fatalf("member permissions = %#v", member.User.Permissions)
	}
	var pendingInvitation identity.Invitation
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/invitations", owner.AccessToken, map[string]any{
		"email": "pending@example.test", "role": "admin",
	}, standardhttp.StatusCreated, &pendingInvitation)
	var invitations []identity.InvitationSummary
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/invitations", owner.AccessToken, nil, standardhttp.StatusOK, &invitations)
	if len(invitations) != 1 || invitations[0].ID != pendingInvitation.ID || invitations[0].CreatedByName != "Owner" || invitations[0].Status != "active" {
		t.Fatalf("pending invitations = %+v", invitations)
	}
	var rotatedInvitation identity.Invitation
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/invitations/"+pendingInvitation.ID+"/rotate", owner.AccessToken, nil, standardhttp.StatusCreated, &rotatedInvitation)
	if rotatedInvitation.ID == pendingInvitation.ID || rotatedInvitation.AcceptURL == "" {
		t.Fatalf("rotated invitation = %+v", rotatedInvitation)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodDelete, baseURL+"/api/v1/invitations/"+rotatedInvitation.ID, owner.AccessToken, nil, standardhttp.StatusNoContent, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/invitations", owner.AccessToken, nil, standardhttp.StatusOK, &invitations)
	if len(invitations) != 0 {
		t.Fatalf("invitations after revoke = %+v", invitations)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/invitations", member.AccessToken, nil, standardhttp.StatusForbidden, nil)
	var memberOtherSession identity.Tokens
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/login", "", map[string]any{
		"email": "member@example.test", "password": "another correct password",
	}, standardhttp.StatusOK, &memberOtherSession)
	var updatedMember identity.User
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/me", member.AccessToken, map[string]any{
		"display_name": "Member", "handle": "member", "title": "Product designer",
		"about": "Designs Coma", "timezone": "Asia/Yekaterinburg",
	}, standardhttp.StatusOK, &updatedMember)
	if updatedMember.Title != "Product designer" || updatedMember.About != "Designs Coma" || updatedMember.Timezone != "Asia/Yekaterinburg" {
		t.Fatalf("updated profile = %+v", updatedMember)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/me/password", member.AccessToken, map[string]any{
		"current_password": "wrong password", "new_password": "new member password",
	}, standardhttp.StatusForbidden, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/me/password", member.AccessToken, map[string]any{
		"current_password": "another correct password", "new_password": "new member password",
	}, standardhttp.StatusNoContent, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/me", memberOtherSession.AccessToken, nil, standardhttp.StatusUnauthorized, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/login", "", map[string]any{
		"email": "member@example.test", "password": "another correct password",
	}, standardhttp.StatusUnauthorized, nil)
	var memberNewLogin identity.Tokens
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/login", "", map[string]any{
		"email": "member@example.test", "password": "new member password",
	}, standardhttp.StatusOK, &memberNewLogin)
	var emailChange identity.EmailChangeResult
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/me/email/change", member.AccessToken, map[string]any{
		"new_email": "member-new@example.test", "current_password": "wrong password",
	}, standardhttp.StatusForbidden, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/me/email/change", member.AccessToken, map[string]any{
		"new_email": "owner@example.test", "current_password": "new member password",
	}, standardhttp.StatusConflict, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/me/email/change", member.AccessToken, map[string]any{
		"new_email": "member-new@example.test", "current_password": "new member password",
	}, standardhttp.StatusOK, &emailChange)
	if emailChange.PendingConfirmation || emailChange.User == nil || emailChange.User.Email != "member-new@example.test" {
		t.Fatalf("immediate email change = %+v", emailChange)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/me", memberNewLogin.AccessToken, nil, standardhttp.StatusUnauthorized, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/login", "", map[string]any{
		"email": "member@example.test", "password": "new member password",
	}, standardhttp.StatusUnauthorized, nil)
	var memberEmailLogin identity.Tokens
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/login", "", map[string]any{
		"email": "member-new@example.test", "password": "new member password",
	}, standardhttp.StatusOK, &memberEmailLogin)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/organization/members/"+member.User.ActorID+"/password-reset", owner.AccessToken, nil, standardhttp.StatusServiceUnavailable, nil)
	emailSender.configured = true
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/me/email/change", member.AccessToken, map[string]any{
		"new_email": "member-final@example.test", "current_password": "new member password",
	}, standardhttp.StatusOK, &emailChange)
	if !emailChange.PendingConfirmation || emailChange.User != nil || len(emailSender.messages) != 2 {
		t.Fatalf("confirmed email change request = %+v messages=%+v", emailChange, emailSender.messages)
	}
	confirmationURL, err := url.Parse(strings.TrimSpace(strings.Split(emailSender.messages[0].body, "\n")[1]))
	if err != nil {
		t.Fatal(err)
	}
	emailToken := confirmationURL.Query().Get("email_token")
	if emailToken == "" {
		t.Fatalf("email confirmation URL = %q", confirmationURL.String())
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/me/email/confirm", member.AccessToken, map[string]any{
		"token": emailToken,
	}, standardhttp.StatusOK, &updatedMember)
	if updatedMember.Email != "member-final@example.test" {
		t.Fatalf("confirmed email = %+v", updatedMember)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/me/email/confirm", member.AccessToken, map[string]any{
		"token": emailToken,
	}, standardhttp.StatusUnprocessableEntity, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/me", memberEmailLogin.AccessToken, nil, standardhttp.StatusUnauthorized, nil)
	operatorResetURL, err := identityService.IssueOperatorPasswordReset(context.Background(), "member-final@example.test")
	if err != nil {
		t.Fatal(err)
	}
	parsedOperatorResetURL, err := url.Parse(operatorResetURL)
	if err != nil || parsedOperatorResetURL.Query().Get("token") == "" {
		t.Fatalf("operator reset URL = %q error=%v", operatorResetURL, err)
	}
	resetMessageCount := len(emailSender.messages)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/password/forgot", "", map[string]any{
		"email": "missing@example.test",
	}, standardhttp.StatusAccepted, nil)
	if len(emailSender.messages) != resetMessageCount {
		t.Fatalf("unknown account leaked through email delivery: messages=%d", len(emailSender.messages))
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/password/forgot", "", map[string]any{
		"email": "member-final@example.test",
	}, standardhttp.StatusAccepted, nil)
	if len(emailSender.messages) != resetMessageCount+1 {
		t.Fatalf("self-service reset messages=%d want=%d", len(emailSender.messages), resetMessageCount+1)
	}
	selfResetURL, err := url.Parse(strings.TrimSpace(strings.Split(emailSender.messages[resetMessageCount].body, "\n")[1]))
	if err != nil || selfResetURL.Query().Get("token") == "" {
		t.Fatalf("self reset URL = %q error=%v", selfResetURL, err)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/password/reset", "", map[string]any{
		"token": parsedOperatorResetURL.Query().Get("token"), "new_password": "must not be accepted",
	}, standardhttp.StatusUnprocessableEntity, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/organization/members/"+member.User.ActorID+"/password-reset", owner.AccessToken, nil, standardhttp.StatusAccepted, nil)
	if len(emailSender.messages) != resetMessageCount+2 {
		t.Fatalf("admin reset messages=%d want=%d", len(emailSender.messages), resetMessageCount+2)
	}
	adminResetURL, err := url.Parse(strings.TrimSpace(strings.Split(emailSender.messages[resetMessageCount+1].body, "\n")[1]))
	if err != nil || adminResetURL.Query().Get("token") == "" {
		t.Fatalf("admin reset URL = %q error=%v", adminResetURL, err)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/password/reset", "", map[string]any{
		"token": selfResetURL.Query().Get("token"), "new_password": "must not be accepted",
	}, standardhttp.StatusUnprocessableEntity, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/password/reset", "", map[string]any{
		"token": adminResetURL.Query().Get("token"), "new_password": "recovered member password",
	}, standardhttp.StatusNoContent, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/password/reset", "", map[string]any{
		"token": adminResetURL.Query().Get("token"), "new_password": "replayed member password",
	}, standardhttp.StatusUnprocessableEntity, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/me", member.AccessToken, nil, standardhttp.StatusUnauthorized, nil)
	var recoveredLogin identity.Tokens
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/login", "", map[string]any{
		"email": "member-final@example.test", "password": "recovered member password",
	}, standardhttp.StatusOK, &recoveredLogin)
	member = recoveredLogin
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/organization/members/"+member.User.ActorID+"/require-password-change", owner.AccessToken, nil, standardhttp.StatusNoContent, nil)
	var forcedLogin identity.Tokens
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/login", "", map[string]any{
		"email": "member-final@example.test", "password": "recovered member password",
	}, standardhttp.StatusOK, &forcedLogin)
	if !forcedLogin.User.MustChangePassword {
		t.Fatalf("mandatory password flag = %+v", forcedLogin.User)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/chats", forcedLogin.AccessToken, nil, standardhttp.StatusForbidden, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/me", forcedLogin.AccessToken, nil, standardhttp.StatusOK, &updatedMember)
	e2ePasswordChangeRequiredSocket(t, baseURL, forcedLogin.AccessToken)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/me/password", forcedLogin.AccessToken, map[string]any{
		"current_password": "recovered member password", "new_password": "final member password",
	}, standardhttp.StatusNoContent, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/me", forcedLogin.AccessToken, nil, standardhttp.StatusOK, &updatedMember)
	if updatedMember.MustChangePassword {
		t.Fatalf("mandatory password flag was not cleared: %+v", updatedMember)
	}
	member = forcedLogin

	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/invitations", owner.AccessToken, map[string]any{
		"email": "admin@example.test", "role": "admin",
	}, standardhttp.StatusCreated, &invitation)
	if !invitation.EmailSent || emailSender.messages[len(emailSender.messages)-1].recipient != "admin@example.test" {
		t.Fatalf("invitation email delivery = invitation %+v messages=%+v", invitation, emailSender.messages)
	}
	acceptURL, err = url.Parse(invitation.AcceptURL)
	if err != nil || path.Base(acceptURL.Path) == "" {
		t.Fatalf("admin invitation accept URL = %q, error = %v", invitation.AcceptURL, err)
	}
	var admin identity.Tokens
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/invitations/"+path.Base(acceptURL.Path)+"/accept", "", map[string]any{
		"display_name": "Admin", "handle": "admin", "password": "admin correct password", "timezone": "UTC",
	}, standardhttp.StatusCreated, &admin)
	var updatedAdmin workspace.Member
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/organization/members/"+admin.User.ActorID, owner.AccessToken, map[string]any{
		"permissions": []string{"audit.read"},
	}, standardhttp.StatusOK, &updatedAdmin)
	if len(updatedAdmin.Permissions) != 1 || updatedAdmin.Permissions[0] != permission.AuditRead {
		t.Fatalf("updated admin permissions = %#v", updatedAdmin.Permissions)
	}
	var adminMe identity.User
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/me", admin.AccessToken, nil, standardhttp.StatusOK, &adminMe)
	if len(adminMe.Permissions) != 1 || adminMe.Permissions[0] != permission.AuditRead {
		t.Fatalf("admin /me permissions = %#v", adminMe.Permissions)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE actors SET org_role='member' WHERE id=$1`, admin.User.ActorID); err == nil {
		t.Fatal("database allowed an administrator with explicit permissions to become a member")
	}

	var organization workspace.Settings
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization", owner.AccessToken, nil, standardhttp.StatusOK, &organization)
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/organization", member.AccessToken, map[string]any{
		"name": "Forbidden", "slug": "forbidden", "expected_version": organization.Version,
		"invitation_default_role": "member", "invitation_ttl_hours": 24,
		"default_timezone": "UTC", "allow_member_invitations": false,
		"allow_public_chat_creation": true, "allow_channel_creation": false, "accent_color": "#174586",
	}, standardhttp.StatusForbidden, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/organization", owner.AccessToken, map[string]any{
		"name": "E2E Team", "slug": "e2e-team", "expected_version": organization.Version,
		"invitation_default_role": "member", "invitation_ttl_hours": 48,
		"default_timezone": "Asia/Yekaterinburg", "allow_member_invitations": true,
		"allow_public_chat_creation": false, "allow_channel_creation": false, "accent_color": "#6D5EF5",
	}, standardhttp.StatusOK, &organization)
	if organization.Name != "E2E Team" || organization.AccentColor != "#6D5EF5" || organization.Version < 2 {
		t.Fatalf("organization settings = %+v", organization)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/me", member.AccessToken, nil, standardhttp.StatusOK, &updatedMember)
	if !updatedMember.CanCreateInvitations {
		t.Fatalf("member invitation capability = %+v", updatedMember)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/invitations", member.AccessToken, map[string]any{
		"email": "forbidden-admin@example.test", "role": "admin",
	}, standardhttp.StatusForbidden, nil)
	var memberInvitation identity.Invitation
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/invitations", member.AccessToken, map[string]any{
		"email": "member-invited@example.test",
	}, standardhttp.StatusCreated, &memberInvitation)
	if memberInvitation.Role != "member" {
		t.Fatalf("member-created invitation = %+v", memberInvitation)
	}
	memberAcceptURL, err := url.Parse(memberInvitation.AcceptURL)
	if err != nil {
		t.Fatal(err)
	}
	var invitedByMember identity.Tokens
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/invitations/"+path.Base(memberAcceptURL.Path)+"/accept", "", map[string]any{
		"display_name": "Invited Member", "handle": "invited-member", "password": "member invitation password",
	}, standardhttp.StatusCreated, &invitedByMember)
	if invitedByMember.User.Timezone != "Asia/Yekaterinburg" {
		t.Fatalf("invitation default timezone = %+v", invitedByMember.User)
	}
	var branding workspace.PublicBranding
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/branding", "", nil, standardhttp.StatusOK, &branding)
	if branding.WorkspaceName != "E2E Team" || branding.AccentColor != "#6D5EF5" {
		t.Fatalf("public branding = %+v", branding)
	}
	e2eBinaryRequest(t, server.Client(), standardhttp.MethodPut, baseURL+"/api/v1/organization/branding/logo", owner.AccessToken, "image/png", []byte{'\x89', 'P', 'N', 'G', '\r', '\n', '\x1a', '\n'}, standardhttp.StatusNoContent)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/branding", "", nil, standardhttp.StatusOK, &branding)
	if branding.LogoURL == "" {
		t.Fatalf("branding logo URL = %+v", branding)
	}
	e2eBinaryRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/branding/logo", "", "", nil, standardhttp.StatusOK)
	var infrastructure workspace.Infrastructure
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/organization/infrastructure", owner.AccessToken, map[string]any{
		"expected_version": 0,
		"s3":               map[string]any{"endpoint": "https://storage.yandexcloud.net", "region": "ru-central1", "bucket": "coma-e2e", "prefix": "uploads", "force_path_style": false, "access_key": "ACCESS-1234", "secret_key": "s3-secret", "clear_credentials": false},
		"smtp":             map[string]any{"host": "smtp.example.test", "port": 587, "username": "coma", "password": "smtp-secret", "from_address": "coma@example.test", "from_name": "Coma", "security": "starttls", "clear_credentials": false},
	}, standardhttp.StatusOK, &infrastructure)
	if !infrastructure.S3.CredentialsConfigured || infrastructure.S3.AccessKeyHint != "••••1234" || !infrastructure.SMTP.CredentialsConfigured {
		t.Fatalf("masked infrastructure = %+v", infrastructure)
	}
	var connection workspace.ConnectionTestResult
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/organization/infrastructure/test", owner.AccessToken, map[string]any{"kind": "s3"}, standardhttp.StatusOK, &connection)
	if !connection.OK {
		t.Fatalf("S3 connection result = %+v", connection)
	}
	var organizationMembers struct {
		Members []workspace.Member `json:"members"`
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization/members", owner.AccessToken, nil, standardhttp.StatusOK, &organizationMembers)
	if len(organizationMembers.Members) != 4 {
		t.Fatalf("organization members = %+v", organizationMembers.Members)
	}
	var audit workspace.AuditPage
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization/audit", owner.AccessToken, nil, standardhttp.StatusOK, &audit)
	if len(audit.Events) < 2 {
		t.Fatalf("audit events = %+v", audit.Events)
	}
	permissionAuditFound := false
	for _, event := range audit.Events {
		if event.Action == "organization.member.permissions.update" {
			permissionAuditFound = true
			break
		}
	}
	if !permissionAuditFound {
		t.Fatalf("permission update audit event is missing: %+v", audit.Events)
	}
	var firstAuditPage, secondAuditPage workspace.AuditPage
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization/audit?limit=1", owner.AccessToken, nil, standardhttp.StatusOK, &firstAuditPage)
	if len(firstAuditPage.Events) != 1 || firstAuditPage.NextAfterID == nil {
		t.Fatalf("first audit page = %+v", firstAuditPage)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization/audit?limit=1&after_id="+url.QueryEscape(*firstAuditPage.NextAfterID), owner.AccessToken, nil, standardhttp.StatusOK, &secondAuditPage)
	if len(secondAuditPage.Events) != 1 || secondAuditPage.Events[0].ID == firstAuditPage.Events[0].ID {
		t.Fatalf("second audit page = %+v", secondAuditPage)
	}
	var organizationAudit workspace.AuditPage
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization/audit?category=organization", owner.AccessToken, nil, standardhttp.StatusOK, &organizationAudit)
	settingsChangesFound := false
	for _, event := range organizationAudit.Events {
		if event.Action == "organization.settings.update" && len(event.Changes) > 0 && event.TargetName != nil && *event.TargetName == "E2E Team" {
			settingsChangesFound = true
		}
	}
	if !settingsChangesFound {
		t.Fatalf("human-readable settings audit data is missing: %+v", organizationAudit.Events)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization/audit", admin.AccessToken, nil, standardhttp.StatusOK, &audit)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization/members", admin.AccessToken, nil, standardhttp.StatusForbidden, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/organization/members/"+admin.User.ActorID, owner.AccessToken, map[string]any{
		"permissions": []string{"branding.manage"},
	}, standardhttp.StatusOK, &updatedAdmin)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization", admin.AccessToken, nil, standardhttp.StatusOK, &organization)
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/organization", admin.AccessToken, map[string]any{
		"name": organization.Name, "slug": organization.Slug, "expected_version": organization.Version,
		"invitation_default_role": organization.InvitationDefaultRole, "invitation_ttl_hours": organization.InvitationTTLHours,
		"default_timezone": organization.DefaultTimezone, "allow_member_invitations": organization.AllowMemberInvitations,
		"allow_public_chat_creation": organization.AllowPublicChatCreation, "allow_channel_creation": organization.AllowChannelCreation, "accent_color": "#2255AA",
	}, standardhttp.StatusOK, &organization)
	if organization.AccentColor != "#2255AA" {
		t.Fatalf("branding administrator accent color = %q", organization.AccentColor)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization/audit", admin.AccessToken, nil, standardhttp.StatusForbidden, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/organization/members/"+admin.User.ActorID, owner.AccessToken, map[string]any{
		"role": "owner",
	}, standardhttp.StatusUnprocessableEntity, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/organization/transfer-ownership", member.AccessToken, map[string]any{
		"target_actor_id": admin.User.ActorID, "current_password": "another correct password",
	}, standardhttp.StatusForbidden, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/organization/transfer-ownership", owner.AccessToken, map[string]any{
		"target_actor_id": owner.User.ActorID, "current_password": "correct horse battery staple",
	}, standardhttp.StatusUnprocessableEntity, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/organization/transfer-ownership", owner.AccessToken, map[string]any{
		"target_actor_id": admin.User.ActorID, "current_password": "incorrect password",
	}, standardhttp.StatusForbidden, nil)
	var previousOwner identity.User
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/organization/transfer-ownership", owner.AccessToken, map[string]any{
		"target_actor_id": admin.User.ActorID, "current_password": "correct horse battery staple",
	}, standardhttp.StatusOK, &previousOwner)
	if previousOwner.OrgRole != "admin" || len(previousOwner.Permissions) != len(permission.All()) {
		t.Fatalf("previous owner after ownership transfer = %+v", previousOwner)
	}
	var newOwner identity.User
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/me", admin.AccessToken, nil, standardhttp.StatusOK, &newOwner)
	if newOwner.OrgRole != "owner" || len(newOwner.Permissions) != len(permission.All()) {
		t.Fatalf("new owner after ownership transfer = %+v", newOwner)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/me", owner.AccessToken, nil, standardhttp.StatusOK, &previousOwner)
	if previousOwner.OrgRole != "admin" || len(previousOwner.Permissions) != len(permission.All()) {
		t.Fatalf("previous owner /me after ownership transfer = %+v", previousOwner)
	}
	var activeOwners, previousOwnerPermissions, newOwnerPermissions int
	if err := pool.QueryRow(context.Background(), `
		SELECT
		  count(*) FILTER (WHERE org_role='owner' AND status='active' AND deleted_at IS NULL),
		  (SELECT count(*) FROM actor_permissions WHERE actor_id=$2),
		  (SELECT count(*) FROM actor_permissions WHERE actor_id=$3)
		FROM actors WHERE org_id=$1`, owner.User.OrgID, owner.User.ActorID, admin.User.ActorID).Scan(
		&activeOwners, &previousOwnerPermissions, &newOwnerPermissions,
	); err != nil {
		t.Fatal(err)
	}
	if activeOwners != 1 || previousOwnerPermissions != len(permission.All()) || newOwnerPermissions != 0 {
		t.Fatalf("ownership database state owners=%d previous_permissions=%d new_permissions=%d", activeOwners, previousOwnerPermissions, newOwnerPermissions)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization/audit", admin.AccessToken, nil, standardhttp.StatusOK, &audit)
	ownershipAuditFound := false
	for _, event := range audit.Events {
		if event.Action == "organization.ownership.transfer" && event.TargetID != nil && *event.TargetID == admin.User.ActorID {
			ownershipAuditFound = true
			break
		}
	}
	if !ownershipAuditFound {
		t.Fatalf("ownership transfer audit event is missing: %+v", audit.Events)
	}

	var group chat.Chat
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/chats", owner.AccessToken, map[string]any{
		"kind": "group", "visibility": "private", "name": "E2E room", "member_ids": []string{member.User.ActorID},
	}, standardhttp.StatusCreated, &group)
	var preferences push.Preferences
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/preferences", owner.AccessToken, nil, standardhttp.StatusOK, &preferences)
	snoozedUntil := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/preferences", owner.AccessToken, map[string]any{
		"locale": "en", "in_app_enabled": false, "push_enabled": true, "push_preview": true, "snoozed_until": snoozedUntil,
		"notify_messages": "direct_and_mentions", "notify_threads": "mentions",
		"notify_reactions": false, "notify_invites": false, "notify_system": false,
		"sound_enabled": false, "sound_id": "default", "email_digest": false,
		"schedule": map[string]any{"days": []int{1, 3, 5}, "from": "09:00", "to": "18:00"},
	}, standardhttp.StatusOK, &preferences)
	if preferences.Locale != "en" || preferences.InAppEnabled || !preferences.PushEnabled || !preferences.PushPreview || preferences.NotifyMessages != "direct_and_mentions" || preferences.NotifyThreads != "mentions" || preferences.NotifyReactions || preferences.NotifyInvites || preferences.NotifySystem || preferences.SoundEnabled || preferences.Schedule == nil || preferences.SnoozedUntil == nil || !preferences.SnoozedUntil.Equal(snoozedUntil) {
		t.Fatalf("partial preferences = %+v", preferences)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/preferences", owner.AccessToken, map[string]any{"snoozed_until": nil}, standardhttp.StatusOK, &preferences)
	if preferences.SnoozedUntil != nil {
		t.Fatalf("snooze was not cleared: %+v", preferences)
	}
	folders := []push.ChatFolder{{ID: "00000000-0000-4000-8000-000000000080", Name: "Work", Icon: "briefcase", Color: "violet", ChatIDs: []string{group.ID}}}
	e2eRequest(t, server.Client(), standardhttp.MethodPut, baseURL+"/api/v1/preferences/chat-folders", owner.AccessToken, folders, standardhttp.StatusOK, &folders)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/preferences/chat-folders", owner.AccessToken, nil, standardhttp.StatusOK, &folders)
	if len(folders) != 1 || folders[0].ChatIDs[0] != group.ID {
		t.Fatalf("chat folders = %+v", folders)
	}
	pinnedChatIDs := []string{group.ID}
	e2eRequest(t, server.Client(), standardhttp.MethodPut, baseURL+"/api/v1/preferences/pinned-chats", owner.AccessToken, pinnedChatIDs, standardhttp.StatusOK, &pinnedChatIDs)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/preferences/pinned-chats", owner.AccessToken, nil, standardhttp.StatusOK, &pinnedChatIDs)
	if len(pinnedChatIDs) != 1 || pinnedChatIDs[0] != group.ID {
		t.Fatalf("pinned chats = %+v", pinnedChatIDs)
	}
	var chatPreferences push.ChatPreferences
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/chats/"+group.ID+"/notification-preferences", owner.AccessToken, nil, standardhttp.StatusOK, &chatPreferences)
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/chats/"+group.ID+"/notification-preferences", owner.AccessToken, map[string]any{"notify_level": "mentions", "muted_until": nil}, standardhttp.StatusOK, &chatPreferences)
	if chatPreferences.NotifyLevel != "mentions" {
		t.Fatalf("chat notification preferences = %+v", chatPreferences)
	}
	var chatWithPreferences chat.Chat
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/chats/"+group.ID, owner.AccessToken, nil, standardhttp.StatusOK, &chatWithPreferences)
	if chatWithPreferences.NotifyLevel != "mentions" || chatWithPreferences.MutedUntil != nil {
		t.Fatalf("chat list notification state = %+v", chatWithPreferences)
	}
	var overrides []push.ChatOverride
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/chats/notification-overrides", owner.AccessToken, nil, standardhttp.StatusOK, &overrides)
	if len(overrides) != 1 || overrides[0].ChatID != group.ID || overrides[0].NotifyLevel != "mentions" {
		t.Fatalf("chat notification overrides = %+v", overrides)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodDelete, baseURL+"/api/v1/chats/"+group.ID+"/notification-preferences", owner.AccessToken, nil, standardhttp.StatusOK, &chatPreferences)
	if chatPreferences.NotifyLevel != "default" {
		t.Fatalf("reset chat notification preferences = %+v", chatPreferences)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/chats/notification-overrides", owner.AccessToken, nil, standardhttp.StatusOK, &overrides)
	if len(overrides) != 0 {
		t.Fatalf("chat notification overrides after reset = %+v", overrides)
	}
	var subscription push.Subscription
	e2eRequest(t, server.Client(), standardhttp.MethodPut, baseURL+"/api/v1/push/subscriptions", owner.AccessToken, map[string]any{"endpoint": "https://push.example.test/subscription/owner", "keys": map[string]string{"p256dh": "0123456789abcdef", "auth": "0123456789abcdef"}}, standardhttp.StatusCreated, &subscription)
	var subscriptions []push.SubscriptionInfo
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/push/subscriptions", owner.AccessToken, nil, standardhttp.StatusOK, &subscriptions)
	if len(subscriptions) != 1 || subscriptions[0].ID != subscription.ID || !subscriptions[0].Current {
		t.Fatalf("push subscriptions = %+v", subscriptions)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/push/test", owner.AccessToken, nil, standardhttp.StatusServiceUnavailable, nil)

	ownerSocket := e2eSocket(t, baseURL, owner.AccessToken, 0)
	memberSocket := e2eSocket(t, baseURL, member.AccessToken, 0)
	t.Cleanup(func() {
		_ = ownerSocket.Close(websocket.StatusNormalClosure, "test complete")
		_ = memberSocket.Close(websocket.StatusNormalClosure, "test complete")
	})
	ownerChatCreated := e2eEvent(t, ownerSocket)
	memberChatCreated := e2eEvent(t, memberSocket)
	if ownerChatCreated.Type != "chat.created" || memberChatCreated.Type != "chat.created" {
		t.Fatalf("initial websocket events owner=%+v member=%+v", ownerChatCreated, memberChatCreated)
	}
	e2eAck(t, ownerSocket, ownerChatCreated.Seq)
	e2eAck(t, memberSocket, memberChatCreated.Seq)

	statusExpiresAt := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	var customStatus identity.CustomStatus
	e2eRequest(t, server.Client(), standardhttp.MethodPut, baseURL+"/api/v1/me/status", owner.AccessToken, map[string]any{
		"emoji": "🏖️", "text": "On vacation", "expires_at": statusExpiresAt,
	}, standardhttp.StatusOK, &customStatus)
	ownerStatus := e2eEvent(t, ownerSocket)
	memberStatus := e2eEvent(t, memberSocket)
	if ownerStatus.Type != "actor.status.updated" || memberStatus.Type != "actor.status.updated" || ownerStatus.SubjectID != owner.User.ActorID {
		t.Fatalf("status websocket events owner=%+v member=%+v", ownerStatus, memberStatus)
	}
	var ownerWithStatus identity.User
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/me", owner.AccessToken, nil, standardhttp.StatusOK, &ownerWithStatus)
	if ownerWithStatus.StatusEmoji != "🏖️" || ownerWithStatus.StatusText != "On vacation" || ownerWithStatus.StatusExpiresAt == nil {
		t.Fatalf("owner custom status = %+v", ownerWithStatus)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodDelete, baseURL+"/api/v1/me/status", owner.AccessToken, nil, standardhttp.StatusOK, &customStatus)
	ownerStatusCleared := e2eEvent(t, ownerSocket)
	memberStatusCleared := e2eEvent(t, memberSocket)
	if ownerStatusCleared.Type != "actor.status.updated" || memberStatusCleared.Type != "actor.status.updated" {
		t.Fatalf("cleared status websocket events owner=%+v member=%+v", ownerStatusCleared, memberStatusCleared)
	}
	e2eAck(t, ownerSocket, ownerStatusCleared.Seq)
	e2eAck(t, memberSocket, memberStatusCleared.Seq)
	if _, err := pool.Exec(context.Background(), `UPDATE actors SET status_emoji='⌛',status_text='Expired',status_expires_at=now()-interval '1 second' WHERE id=$1`, owner.User.ActorID); err != nil {
		t.Fatal(err)
	}
	high, err := identity.NewRepository(pool).ExpireStatuses(context.Background(), time.Now().UTC(), 100)
	if err != nil || high[owner.User.OrgID] == 0 {
		t.Fatalf("expire custom status high=%v error=%v", high, err)
	}
	afterCommit(owner.User.OrgID, high[owner.User.OrgID])
	ownerStatusExpired := e2eEvent(t, ownerSocket)
	memberStatusExpired := e2eEvent(t, memberSocket)
	if ownerStatusExpired.Type != "actor.status.updated" || memberStatusExpired.Type != "actor.status.updated" {
		t.Fatalf("expired status websocket events owner=%+v member=%+v", ownerStatusExpired, memberStatusExpired)
	}
	e2eAck(t, ownerSocket, ownerStatusExpired.Seq)
	e2eAck(t, memberSocket, memberStatusExpired.Seq)

	var first message.Message
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/chats/"+group.ID+"/messages", member.AccessToken, map[string]any{
		"client_msg_id": e2eID(t), "body": "hello owner", "body_format": "plain",
		"mentioned_actor_ids": []string{owner.User.ActorID},
	}, standardhttp.StatusCreated, &first)
	var notificationJobs int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM notification_jobs WHERE org_id=$1 AND event_seq=$2`, owner.User.OrgID, first.CreatedSeq).Scan(&notificationJobs); err != nil || notificationJobs != 1 {
		t.Fatalf("notification job count=%d error=%v", notificationJobs, err)
	}
	ownerFirst := e2eEvent(t, ownerSocket)
	memberFirst := e2eEvent(t, memberSocket)
	if ownerFirst.Seq != first.CreatedSeq || memberFirst.Seq != first.CreatedSeq || ownerFirst.Type != "message.created" {
		t.Fatalf("first websocket events owner=%+v member=%+v message=%+v", ownerFirst, memberFirst, first)
	}
	e2eAck(t, ownerSocket, ownerFirst.Seq)
	e2eAck(t, memberSocket, memberFirst.Seq)

	var second message.Message
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/chats/"+group.ID+"/messages", owner.AccessToken, map[string]any{
		"client_msg_id": e2eID(t), "body": "hello member", "body_format": "plain",
	}, standardhttp.StatusCreated, &second)
	ownerSecond := e2eEvent(t, ownerSocket)
	memberSecond := e2eEvent(t, memberSocket)
	if ownerSecond.Seq != second.CreatedSeq || memberSecond.Seq != second.CreatedSeq || memberSecond.Type != "message.created" {
		t.Fatalf("second websocket events owner=%+v member=%+v message=%+v", ownerSecond, memberSecond, second)
	}
	e2eAck(t, ownerSocket, ownerSecond.Seq)
	e2eAck(t, memberSocket, memberSecond.Seq)

	avatarBuffer := new(bytes.Buffer)
	avatarImage := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			avatarImage.Set(x, y, color.RGBA{R: 30, G: uint8(80 + x), B: uint8(120 + y), A: 255})
		}
	}
	if err := png.Encode(avatarBuffer, avatarImage); err != nil {
		t.Fatal(err)
	}
	e2eBinaryRequest(t, server.Client(), standardhttp.MethodPut, baseURL+"/api/v1/me/avatar", owner.AccessToken, "image/png", avatarBuffer.Bytes(), standardhttp.StatusOK)
	ownerAvatar := e2eEvent(t, ownerSocket)
	memberAvatar := e2eEvent(t, memberSocket)
	if ownerAvatar.Type != "actor.avatar.updated" || memberAvatar.Type != "actor.avatar.updated" {
		t.Fatalf("avatar events owner=%+v member=%+v", ownerAvatar, memberAvatar)
	}
	e2eAck(t, ownerSocket, ownerAvatar.Seq)
	e2eAck(t, memberSocket, memberAvatar.Seq)
	e2eBinaryRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/actors/"+owner.User.ActorID+"/avatar", member.AccessToken, "", nil, standardhttp.StatusOK)

	fileBody := []byte("phasefourtoken searchable attachment")
	var upload files.Upload
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/files/uploads", owner.AccessToken, map[string]any{
		"name": "phase-four.txt", "mime": "text/plain", "size": len(fileBody),
	}, standardhttp.StatusCreated, &upload)
	if upload.UploadURL == nil || upload.File.ID == "" {
		t.Fatalf("file upload handshake = %+v", upload)
	}
	e2eBinaryRequest(t, server.Client(), standardhttp.MethodPut, baseURL+*upload.UploadURL, owner.AccessToken, "text/plain", fileBody, standardhttp.StatusOK)
	if err := fileService.ProcessFile(t.Context(), upload.File.ID); err != nil {
		t.Fatal(err)
	}
	var attachment message.Message
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/chats/"+group.ID+"/messages", owner.AccessToken, map[string]any{
		"client_msg_id": e2eID(t), "body": "attached phasefourtoken document", "body_format": "plain", "file_ids": []string{upload.File.ID},
	}, standardhttp.StatusCreated, &attachment)
	ownerAttachment := e2eEvent(t, ownerSocket)
	memberAttachment := e2eEvent(t, memberSocket)
	if ownerAttachment.Type != "message.created" || memberAttachment.Type != "message.created" {
		t.Fatalf("attachment events owner=%+v member=%+v", ownerAttachment, memberAttachment)
	}
	e2eAck(t, ownerSocket, ownerAttachment.Seq)
	e2eAck(t, memberSocket, memberAttachment.Seq)
	e2eBinaryRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/files/"+upload.File.ID+"/download", member.AccessToken, "", nil, standardhttp.StatusOK)
	var searchPage search.Page
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/search?q=phasefourtoken&chat_id="+url.QueryEscape(group.ID), member.AccessToken, nil, standardhttp.StatusOK, &searchPage)
	if len(searchPage.Results) < 2 {
		t.Fatalf("file/message search results = %+v", searchPage.Results)
	}

	var page message.Page
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/chats/"+group.ID+"/messages", owner.AccessToken, nil, standardhttp.StatusOK, &page)
	if len(page.Messages) != 3 || page.Messages[0].ID != attachment.ID || page.Messages[1].ID != second.ID || page.Messages[2].ID != first.ID {
		t.Fatalf("message history = %+v", page.Messages)
	}

	var createdAgent agent.Agent
	var agentSettings agent.PlatformSettings
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/agents/settings", owner.AccessToken, map[string]any{
		"organization_rate_limit_per_minute": 5000,
	}, standardhttp.StatusOK, &agentSettings)
	if agentSettings.OrganizationRateLimitPerMinute != 5000 {
		t.Fatalf("agent platform settings = %+v", agentSettings)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/agents", owner.AccessToken, map[string]any{
		"display_name": "E2E agent", "handle": "e2e-agent", "kind": "external", "enabled": false, "endpoint_url": "https://agent.example.test/runtime",
		"allowed_scopes": []string{"chats:read", "messages:read", "memory:read", "memory:write", "runtime:execute"}, "chat_ids": []string{group.ID},
	}, standardhttp.StatusCreated, &createdAgent)
	var runtimeKey agent.CreatedAPIKey
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/agents/"+createdAgent.ID+"/keys", owner.AccessToken, map[string]any{
		"name": "e2e runtime", "scopes": []string{"messages:read", "runtime:execute"}, "rate_limit_per_minute": 100,
	}, standardhttp.StatusCreated, &runtimeKey)
	if runtimeKey.Secret == "" {
		t.Fatal("agent runtime key was not returned")
	}
	var dryRun agentrun.Run
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/agents/"+createdAgent.ID+"/invoke", owner.AccessToken, map[string]any{
		"chat_id": group.ID, "client_run_id": e2eID(t), "chain_depth": 0, "timeout_seconds": 60, "max_attempts": 1,
		"dry_run": true, "input": map[string]any{"prompt": "test the draft", "sandbox": true, "publish": false},
	}, standardhttp.StatusAccepted, &dryRun)
	if !dryRun.DryRun || dryRun.AgentVersion == nil || *dryRun.AgentVersion != 1 {
		t.Fatalf("draft dry run = %+v", dryRun)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/agent-runs/"+dryRun.ID+"/cancel", owner.AccessToken, nil, standardhttp.StatusOK, &dryRun)
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/agents/"+createdAgent.ID+"/publish", owner.AccessToken, nil, standardhttp.StatusOK, &createdAgent)
	if createdAgent.PublishedVersion == nil || *createdAgent.PublishedVersion != 1 || createdAgent.OperationalStatus != "active" {
		t.Fatalf("published agent = %+v", createdAgent)
	}
	var productMetrics agent.ProductMetrics
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/agents/product-metrics", owner.AccessToken, nil, standardhttp.StatusOK, &productMetrics)
	if productMetrics.AgentsTotal < 1 || productMetrics.AgentsPublished < 1 || productMetrics.TestRunsTotal < 1 {
		t.Fatalf("agent product metrics = %+v", productMetrics)
	}
	var queuedRun agentrun.Run
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/agents/"+createdAgent.ID+"/invoke", owner.AccessToken, map[string]any{"chat_id": group.ID, "client_run_id": e2eID(t), "chain_depth": 0, "timeout_seconds": 60, "max_attempts": 2, "input": map[string]any{"prompt": "manual e2e"}}, standardhttp.StatusAccepted, &queuedRun)
	if queuedRun.Status != "queued" {
		t.Fatalf("queued agent run = %+v", queuedRun)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/agent-runs/"+queuedRun.ID+"/cancel", owner.AccessToken, nil, standardhttp.StatusOK, &queuedRun)
	if queuedRun.Status != "canceled" {
		t.Fatalf("canceled agent run = %+v", queuedRun)
	}
	for index := 0; index < 2; index++ {
		if _, err := agentRunService.Invoke(t.Context(), owner.User, createdAgent.ID, agentrun.InvokeInput{ChatID: group.ID, ClientRunID: e2eID(t), CorrelationID: e2eID(t), TimeoutSeconds: 60, MaxAttempts: 2, Input: json.RawMessage(`{"source":"concurrency-test"}`)}); err != nil {
			t.Fatal(err)
		}
	}
	workerID := e2eID(t)
	claimed, err := agentRunService.Claim(t.Context(), workerID, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := agentRunService.Claim(t.Context(), workerID, 30*time.Second); !errors.Is(err, agentrun.ErrNotFound) {
		t.Fatalf("per-chat concurrency error = %v", err)
	}
	completed, err := agentRunService.Complete(t.Context(), claimed.ID, *claimed.LeaseToken, agentrun.Completion{Cost: "0.001", Currency: "USD", ResultSummary: json.RawMessage(`{"ok":true}`)})
	if err != nil || completed.Status != "completed" {
		t.Fatalf("completed run = %+v, err=%v", completed, err)
	}
	retrying, err := agentRunService.Claim(t.Context(), workerID, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	retrying, err = agentRunService.Fail(t.Context(), retrying.ID, *retrying.LeaseToken, "provider_unavailable")
	if err != nil || retrying.Status != "queued" || retrying.Attempt != 2 {
		t.Fatalf("retrying run = %+v, err=%v", retrying, err)
	}
	var createdAgentKey agent.CreatedAPIKey
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/agents/"+createdAgent.ID+"/keys", owner.AccessToken, map[string]any{
		"name": "e2e runtime", "scopes": []string{"chats:read", "messages:read", "memory:read", "memory:write", "runtime:execute"}, "rate_limit_per_minute": 8,
	}, standardhttp.StatusCreated, &createdAgentKey)
	var agentMe identity.User
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/me", createdAgentKey.Secret, nil, standardhttp.StatusOK, &agentMe)
	if agentMe.ActorID != createdAgent.ID {
		t.Fatalf("agent /me = %+v", agentMe)
	}
	var runtimeCheckpoint agentrun.RuntimeCheckpoint
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/agent-runtime/checkpoints/e2e-example", createdAgentKey.Secret, nil, standardhttp.StatusOK, &runtimeCheckpoint)
	if runtimeCheckpoint.Consumer != "e2e-example" {
		t.Fatalf("agent runtime checkpoint = %+v", runtimeCheckpoint)
	}
	if _, err := agentRunService.Invoke(t.Context(), owner.User, createdAgent.ID, agentrun.InvokeInput{ChatID: group.ID, ClientRunID: e2eID(t), CorrelationID: e2eID(t), TimeoutSeconds: 60, MaxAttempts: 2, Input: json.RawMessage(`{"source":"runtime-api-test"}`)}); err != nil {
		t.Fatal(err)
	}
	var runtimeRun agentrun.ClaimedRun
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/agent-runtime/runs/claim", createdAgentKey.Secret, map[string]any{"worker_id": e2eID(t), "lease_seconds": 60}, standardhttp.StatusOK, &runtimeRun)
	var confirmation agenttool.Confirmation
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/agent-tools/remember", createdAgentKey.Secret, map[string]any{"run_id": runtimeRun.ID, "lease_token": runtimeRun.LeaseToken, "correlation_id": runtimeRun.CorrelationID, "tool_call_id": e2eID(t), "arguments": map[string]any{"namespace": "e2e", "key": "preference", "value": map[string]any{"theme": "dark"}}}, standardhttp.StatusAccepted, &confirmation)
	if confirmation.Status != "pending" {
		t.Fatalf("pending confirmation = %+v", confirmation)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/agents/tool-confirmations/"+confirmation.ID+"/approve", owner.AccessToken, nil, standardhttp.StatusOK, &confirmation)
	if confirmation.Status != "completed" {
		t.Fatalf("approved confirmation = %+v", confirmation)
	}
	var recalled []agentmemory.Entry
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/agent-tools/recall", createdAgentKey.Secret, map[string]any{"run_id": runtimeRun.ID, "lease_token": runtimeRun.LeaseToken, "correlation_id": runtimeRun.CorrelationID, "tool_call_id": e2eID(t), "arguments": map[string]any{"namespace": "e2e", "keys": []string{"preference"}}}, standardhttp.StatusOK, &recalled)
	if len(recalled) != 1 || recalled[0].Key != "preference" {
		t.Fatalf("recalled memory = %+v", recalled)
	}
	var toolCalls int
	var leakedToolAudit bool
	if err := pool.QueryRow(t.Context(), `SELECT count(*),bool_or(metadata::text LIKE '%dark%' OR metadata::text LIKE '%preference%') FROM audit_log WHERE actor_id=$1 AND action='agent.tool.call'`, createdAgent.ID).Scan(&toolCalls, &leakedToolAudit); err != nil {
		t.Fatal(err)
	}
	if toolCalls != 2 || leakedToolAudit {
		t.Fatalf("tool audit count=%d leaked=%v", toolCalls, leakedToolAudit)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/chats/"+group.ID+"/messages", createdAgentKey.Secret, nil, standardhttp.StatusOK, &page)
	agentSocket := e2eSocket(t, baseURL, createdAgentKey.Secret, 0)
	defer agentSocket.CloseNow()
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/chats/"+group.ID+"/messages", createdAgentKey.Secret, map[string]any{
		"client_msg_id": e2eID(t), "body": "must be blocked", "body_format": "plain",
	}, standardhttp.StatusForbidden, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/chats/"+group.ID+"/messages", createdAgentKey.Secret, nil, standardhttp.StatusTooManyRequests, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodDelete, baseURL+"/api/v1/agents/"+createdAgent.ID+"/keys/"+createdAgentKey.ID, owner.AccessToken, nil, standardhttp.StatusNoContent, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/chats/"+group.ID+"/messages", createdAgentKey.Secret, nil, standardhttp.StatusUnauthorized, nil)
	agentCloseCtx, agentCloseCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer agentCloseCancel()
	for {
		_, _, err := agentSocket.Read(agentCloseCtx)
		if err == nil {
			continue
		}
		if websocket.CloseStatus(err) != 4001 {
			t.Fatalf("agent websocket after key revocation: close status=%d error=%v", websocket.CloseStatus(err), err)
		}
		break
	}

	var unread userstate.UnreadSnapshot
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/unread", owner.AccessToken, nil, standardhttp.StatusOK, &unread)
	if len(unread.Chats) != 1 || unread.Chats[0].UnreadCount != 1 || unread.Chats[0].MentionCount != 1 {
		t.Fatalf("owner unread = %+v", unread)
	}
	var read userstate.ReadMarker
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/chats/"+group.ID+"/read", owner.AccessToken, map[string]any{
		"last_read_seq": second.CreatedSeq,
	}, standardhttp.StatusOK, &read)
	if read.LastReadSeq != second.CreatedSeq {
		t.Fatalf("read marker = %+v", read)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/unread", owner.AccessToken, nil, standardhttp.StatusOK, &unread)
	if len(unread.Chats) != 1 || unread.Chats[0].UnreadCount != 0 || unread.Chats[0].MentionCount != 0 {
		t.Fatalf("owner unread after marker = %+v", unread)
	}

	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/logout", member.AccessToken, nil, standardhttp.StatusNoContent, nil)
	closeCtx, closeCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer closeCancel()
	for {
		_, _, err := memberSocket.Read(closeCtx)
		if err == nil {
			continue
		}
		if websocket.CloseStatus(err) != 4001 {
			t.Fatalf("member websocket after logout: close status=%d error=%v", websocket.CloseStatus(err), err)
		}
		break
	}
}

type e2eConnectionTester struct{}

func (e2eConnectionTester) TestS3(context.Context, workspace.S3Config) error     { return nil }
func (e2eConnectionTester) TestSMTP(context.Context, workspace.SMTPConfig) error { return nil }

func e2eRealtimeConfig() config.RealtimeConfig {
	return config.RealtimeConfig{
		AuthTimeout: 2 * time.Second, MaxFrameBytes: 256 * 1024, MaxConnectionsPerActor: 10,
		MaxQueuedEvents: 64, MaxQueuedBytes: 1024 * 1024, MaxUnackedEvents: 16,
		HeartbeatInterval: time.Minute, PongTimeout: 2 * time.Second,
		AckInterval: 50 * time.Millisecond, AckTimeout: 3 * time.Second, AckBatchSize: 8,
		TypingTTL: 6 * time.Second, PresenceTTL: time.Minute, ActiveSubscriptionTTL: time.Minute,
		EphemeralRateLimit: 30, EphemeralRateWindow: 10 * time.Second,
	}
}

func e2eRequest(t *testing.T, client *standardhttp.Client, method, endpoint, token string, body any, wantStatus int, output any) {
	t.Helper()
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		payload = bytes.NewReader(encoded)
	}
	request, err := standardhttp.NewRequestWithContext(context.Background(), method, endpoint, payload)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != wantStatus {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		t.Fatalf("%s %s status = %d, want %d: %s", method, endpoint, response.StatusCode, wantStatus, data)
	}
	if output != nil {
		if err := json.NewDecoder(response.Body).Decode(output); err != nil {
			t.Fatal(err)
		}
	}
}

func e2eBinaryRequest(t *testing.T, client *standardhttp.Client, method, endpoint, token, contentType string, body []byte, wantStatus int) {
	t.Helper()
	request, err := standardhttp.NewRequestWithContext(context.Background(), method, endpoint, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != wantStatus {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		t.Fatalf("%s %s status = %d, want %d: %s", method, endpoint, response.StatusCode, wantStatus, data)
	}
}

func e2eSocket(t *testing.T, baseURL, token string, lastSeq int64) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	header := standardhttp.Header{"Origin": []string{baseURL}}
	connection, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(baseURL, "http")+"/api/v1/ws", &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		if response != nil {
			t.Fatalf("dial websocket status=%d error=%v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	requestID := e2eID(t)
	if err := connection.Write(ctx, websocket.MessageText, mustJSON(t, map[string]any{
		"op": "auth", "request_id": requestID, "access_token": token, "last_seq": lastSeq,
	})); err != nil {
		t.Fatal(err)
	}
	var hello struct {
		Op        string `json:"op"`
		RequestID string `json:"request_id"`
	}
	e2eReadSocket(t, connection, &hello)
	if hello.Op != "hello" || hello.RequestID != requestID {
		t.Fatalf("hello = %+v", hello)
	}
	return connection
}

func e2ePasswordChangeRequiredSocket(t *testing.T, baseURL, token string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	header := standardhttp.Header{"Origin": []string{baseURL}}
	connection, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(baseURL, "http")+"/api/v1/ws", &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		if response != nil {
			t.Fatalf("dial websocket status=%d error=%v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	defer connection.CloseNow()
	if err := connection.Write(ctx, websocket.MessageText, mustJSON(t, map[string]any{
		"op": "auth", "request_id": e2eID(t), "access_token": token, "last_seq": 0,
	})); err != nil {
		t.Fatal(err)
	}
	var frame struct {
		Op   string `json:"op"`
		Code string `json:"code"`
	}
	e2eReadSocket(t, connection, &frame)
	if frame.Op != "error" || frame.Code != "password_change_required" {
		t.Fatalf("password change websocket frame = %+v", frame)
	}
	_, _, err = connection.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusCode(4001) {
		t.Fatalf("password change websocket close = %v", err)
	}
}

func e2eEvent(t *testing.T, connection *websocket.Conn) eventlog.Frame {
	t.Helper()
	var frame eventlog.Frame
	e2eReadSocket(t, connection, &frame)
	return frame
}

func e2eAck(t *testing.T, connection *websocket.Conn, sequence int64) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := connection.Write(ctx, websocket.MessageText, mustJSON(t, map[string]any{"op": "ack", "seq": sequence})); err != nil {
		t.Fatal(err)
	}
}

func e2eReadSocket(t *testing.T, connection *websocket.Conn, output any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	messageType, payload, err := connection.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("websocket message type = %v", messageType)
	}
	if err := json.Unmarshal(payload, output); err != nil {
		t.Fatalf("decode websocket frame %s: %v", payload, err)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	result, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func e2eID(t *testing.T) string {
	t.Helper()
	value, err := id.New()
	if err != nil {
		t.Fatal(err)
	}
	return value
}

type e2eEmailMessage struct {
	recipient string
	subject   string
	body      string
}

type e2eEmailSender struct {
	configured bool
	messages   []e2eEmailMessage
}

func (s *e2eEmailSender) EmailConfigured(context.Context, string) (bool, error) {
	return s.configured, nil
}

func (s *e2eEmailSender) SendEmail(_ context.Context, _ string, recipient, subject, body string) error {
	s.messages = append(s.messages, e2eEmailMessage{recipient: recipient, subject: subject, body: body})
	return nil
}
