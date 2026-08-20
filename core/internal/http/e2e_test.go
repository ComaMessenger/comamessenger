package http

import (
	"bytes"
	"context"
	"encoding/json"
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
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/password"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/push"
	"github.com/comamessenger/comamessenger/core/internal/realtime"
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
	realtimeServer := realtime.NewServer(logger, baseURL, eventStore, hub, identityService.Authenticate, realtimeConfig, ephemeral)
	workspaceService, err := workspace.NewService(workspace.NewRepository(pool), "e2e-encryption-secret", e2eConnectionTester{})
	if err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = NewHandler(logger, baseURL, pool.Ping, Dependencies{
		Identity: identityService, Chats: chat.NewService(pool),
		Messages:  message.NewService(pool, 64*1024, 100, afterCommit),
		UserState: userstate.NewService(pool, 64*1024, afterCommit), Realtime: realtimeServer,
		Push:            push.NewService(pool, config.PushConfig{}),
		Workspace:       workspaceService,
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

	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/invitations", owner.AccessToken, map[string]any{
		"email": "admin@example.test", "role": "admin",
	}, standardhttp.StatusCreated, &invitation)
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
		"allow_public_chat_creation": true, "allow_channel_creation": false, "accent_color": "#174586",
	}, standardhttp.StatusForbidden, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/organization", owner.AccessToken, map[string]any{
		"name": "E2E Team", "slug": "e2e-team", "expected_version": organization.Version,
		"invitation_default_role": "member", "invitation_ttl_hours": 48,
		"allow_public_chat_creation": false, "allow_channel_creation": false, "accent_color": "#6D5EF5",
	}, standardhttp.StatusOK, &organization)
	if organization.Name != "E2E Team" || organization.AccentColor != "#6D5EF5" || organization.Version < 2 {
		t.Fatalf("organization settings = %+v", organization)
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
	if len(organizationMembers.Members) != 3 {
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
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization/audit", admin.AccessToken, nil, standardhttp.StatusOK, &audit)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization/members", admin.AccessToken, nil, standardhttp.StatusForbidden, nil)
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/organization/members/"+admin.User.ActorID, owner.AccessToken, map[string]any{
		"permissions": []string{"branding.manage"},
	}, standardhttp.StatusOK, &updatedAdmin)
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/organization", admin.AccessToken, nil, standardhttp.StatusOK, &organization)
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/organization", admin.AccessToken, map[string]any{
		"name": organization.Name, "slug": organization.Slug, "expected_version": organization.Version,
		"invitation_default_role": organization.InvitationDefaultRole, "invitation_ttl_hours": organization.InvitationTTLHours,
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
	preferences.Theme, preferences.Locale, preferences.PushEnabled, preferences.PushPreview = "light", "en", true, true
	preferences.ChatFolders = []push.ChatFolder{{ID: "00000000-0000-4000-8000-000000000080", Name: "Work", Icon: "briefcase", Color: "violet", ChatIDs: []string{group.ID}}}
	preferences.PinnedChatIDs = []string{group.ID}
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/preferences", owner.AccessToken, preferences, standardhttp.StatusOK, &preferences)
	if len(preferences.ChatFolders) != 1 || preferences.ChatFolders[0].ChatIDs[0] != group.ID || preferences.PinnedChatIDs[0] != group.ID {
		t.Fatalf("chat folders = %+v", preferences.ChatFolders)
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
	var subscription push.Subscription
	e2eRequest(t, server.Client(), standardhttp.MethodPut, baseURL+"/api/v1/push/subscriptions", owner.AccessToken, map[string]any{"endpoint": "https://push.example.test/subscription/owner", "keys": map[string]string{"p256dh": "0123456789abcdef", "auth": "0123456789abcdef"}}, standardhttp.StatusCreated, &subscription)

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

	var page message.Page
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/chats/"+group.ID+"/messages", owner.AccessToken, nil, standardhttp.StatusOK, &page)
	if len(page.Messages) != 2 || page.Messages[0].ID != second.ID || page.Messages[1].ID != first.ID {
		t.Fatalf("message history = %+v", page.Messages)
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
