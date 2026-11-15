package http

import (
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

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/password"
	"github.com/comamessenger/comamessenger/core/internal/realtime"
	"github.com/comamessenger/comamessenger/core/internal/request"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/comamessenger/comamessenger/core/internal/userstate"
	"github.com/google/uuid"
)

// TestRequestsE2E asks a question through the HTTP API with the real River
// client and checks what each person learns over REST and realtime: the
// observer sees «N из M» and never who answered or the comment.
func TestRequestsE2E(t *testing.T) {
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
	identityService, err := identity.NewService(identity.NewRepository(pool), hasher, tokenManager, 24*time.Hour, 24*time.Hour, baseURL, true, &e2eEmailSender{})
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
	messageService := message.NewService(pool, 64*1024, 100, afterCommit)
	requestService := request.NewService(pool, afterCommit)
	messageService.SetRequests(requestService)
	riverClient, err := request.NewClient(pool, requestService, logger)
	if err != nil {
		t.Fatal(err)
	}
	if err := riverClient.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stopCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = riverClient.Stop(stopCtx)
	})
	server.Config.Handler = NewHandler(logger, baseURL, pool.Ping, Dependencies{
		Identity: identityService, Agents: agentService, Chats: chat.NewService(pool, afterCommit),
		Messages: messageService, Requests: requestService, UserState: userstate.NewService(pool, 64*1024, afterCommit), Realtime: realtimeServer,
		RefreshTokenTTL: 24 * time.Hour, RevokeRealtimeSession: realtimeServer.RevokeSession,
	})
	server.Start()
	t.Cleanup(server.Close)
	client := server.Client()

	var owner identity.Tokens
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/bootstrap", "", map[string]any{
		"organization_name": "E2E", "organization_slug": "e2e", "display_name": "Owner",
		"handle": "owner", "email": "owner@example.test", "password": "correct horse battery staple", "timezone": "UTC",
	}, standardhttp.StatusCreated, &owner)
	invite := func(handle string) identity.Tokens {
		var invitation identity.Invitation
		e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/invitations", owner.AccessToken, map[string]any{
			"email": handle + "@example.test", "role": "member",
		}, standardhttp.StatusCreated, &invitation)
		acceptURL, err := url.Parse(invitation.AcceptURL)
		if err != nil {
			t.Fatal(err)
		}
		var tokens identity.Tokens
		e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/invitations/"+path.Base(acceptURL.Path)+"/accept", "", map[string]any{
			"display_name": handle, "handle": handle, "password": "another correct password", "timezone": "UTC",
		}, standardhttp.StatusCreated, &tokens)
		return tokens
	}
	member, observer := invite("member"), invite("observer")
	var group chat.Chat
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/chats", owner.AccessToken, map[string]any{
		"kind": "group", "visibility": "private", "name": "Plans", "member_ids": []string{member.User.ActorID, observer.User.ActorID},
	}, standardhttp.StatusCreated, &group)
	observerSocket := e2eSocket(t, baseURL, observer.AccessToken, 0)
	defer observerSocket.CloseNow()
	memberSocket := e2eSocket(t, baseURL, member.AccessToken, 0)
	defer memberSocket.CloseNow()

	endpoint := baseURL + "/api/v1/chats/" + group.ID + "/requests"
	expectError := func(body map[string]any, status int, code api.ErrorCode, field string) {
		t.Helper()
		var failure api.Error
		e2eRequest(t, client, standardhttp.MethodPost, endpoint, owner.AccessToken, body, status, &failure)
		if failure.Code != code || (field != "" && (failure.Details == nil || (*failure.Details)["field"] != field)) {
			t.Fatalf("error = %+v, want %s %s", failure, code, field)
		}
	}
	question := func(extra map[string]any) map[string]any {
		body := map[string]any{"client_msg_id": uuid.NewString(), "body": "Будете на планёрке?", "audience": map[string]any{"kind": "people", "actor_ids": []string{member.User.ActorID}}, "answer": map[string]any{"preset": "attend"}}
		for key, value := range extra {
			body[key] = value
		}
		return body
	}
	expectError(question(map[string]any{"audience": map[string]any{"kind": "department", "department_id": uuid.NewString()}}), standardhttp.StatusUnprocessableEntity, "request_audience_unavailable", "")
	expectError(question(map[string]any{"answer": map[string]any{"preset": "custom", "options": []string{"один"}}}), standardhttp.StatusUnprocessableEntity, "request_invalid", "answer.options")
	expectError(question(map[string]any{"auto_remind": true}), standardhttp.StatusUnprocessableEntity, "request_invalid", "auto_remind")

	due := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	var created message.Message
	e2eRequest(t, client, standardhttp.MethodPost, endpoint, owner.AccessToken, question(map[string]any{"due_at": due, "auto_remind": true}), standardhttp.StatusCreated, &created)
	if created.Type != "request" || created.Request == nil || created.RequestViewer == nil || created.RequestViewer.Role != "author" || created.Request.Audience.Label != "member" {
		t.Fatalf("created = %+v", created)
	}
	var jobs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind IN ('message_request.auto_remind','message_request.expire') AND args->>'message_id'=$1`, created.ID).Scan(&jobs); err != nil || jobs != 2 {
		t.Fatalf("river jobs = %d, %v", jobs, err)
	}

	// The recipient learns «this is for me» before the card.
	memberFrames := framesUntil(t, memberSocket, "message.created")
	if len(memberFrames) < 2 || memberFrames[len(memberFrames)-2].Type != "request.assigned" {
		t.Fatalf("member frames = %v", frameTypes(memberFrames))
	}

	const secret = "приду с опозданием"
	var answered request.State
	e2eRequest(t, client, standardhttp.MethodPut, baseURL+"/api/v1/requests/"+created.ID+"/answer", member.AccessToken, map[string]any{"option": 0, "comment": secret}, standardhttp.StatusOK, &answered)
	if answered.Viewer.Answer == nil || answered.Viewer.Answer.Comment != secret || answered.Request.AnsweredCount != 1 {
		t.Fatalf("answered = %+v", answered)
	}
	framesUntil(t, memberSocket, "request.answer.updated")
	e2eRequest(t, client, standardhttp.MethodPut, baseURL+"/api/v1/requests/"+created.ID+"/answer", observer.AccessToken, map[string]any{"option": 0}, standardhttp.StatusForbidden, nil)
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/requests/"+created.ID+"/answers", observer.AccessToken, nil, standardhttp.StatusForbidden, nil)
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/requests/"+created.ID+"/answers", member.AccessToken, nil, standardhttp.StatusForbidden, nil)
	var answers request.AnswerPage
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/requests/"+created.ID+"/answers?filter=option:0", owner.AccessToken, nil, standardhttp.StatusOK, &answers)
	if len(answers.Items) != 1 || answers.Items[0].Comment != secret || answers.Items[0].ActorID != member.User.ActorID {
		t.Fatalf("answers = %+v", answers)
	}
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/requests/"+created.ID+"/answers?filter=bogus", owner.AccessToken, nil, standardhttp.StatusUnprocessableEntity, nil)

	// The observer's frames: the card and the counters, nothing else.
	observerFrames := framesUntil(t, observerSocket, "request.updated")
	for _, frame := range observerFrames {
		raw, _ := json.Marshal(frame)
		if strings.Contains(string(raw), secret) || strings.Contains(string(raw), member.User.ActorID) || strings.Contains(string(raw), "request_viewer") {
			t.Fatalf("observer frame %s leaks: %s", frame.Type, raw)
		}
		if strings.HasPrefix(frame.Type, "request.") && frame.Type != "request.updated" {
			t.Fatalf("observer got %s", frame.Type)
		}
	}
	var observed request.State
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/requests/"+created.ID, observer.AccessToken, nil, standardhttp.StatusOK, &observed)
	if observed.Viewer.Role != "observer" || observed.Viewer.Tally != nil || observed.Request.AnsweredCount != 1 || observed.Request.Audience.Count != 1 {
		t.Fatalf("observed = %+v", observed)
	}

	var inbox message.RequestInboxPage
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/requests/inbox?state=answered", member.AccessToken, nil, standardhttp.StatusOK, &inbox)
	if len(inbox.Items) != 1 || inbox.Items[0].Author.DisplayName != "Owner" || inbox.Items[0].Chat.DisplayName != "Plans" {
		t.Fatalf("inbox = %+v", inbox)
	}

	var reminded request.RemindResult
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/requests/"+created.ID+"/remind", owner.AccessToken, nil, standardhttp.StatusOK, &reminded)
	if reminded.Reminded != 0 {
		t.Fatalf("reminded = %+v; everyone answered", reminded)
	}
	var closed request.State
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/requests/"+created.ID+"/close", owner.AccessToken, nil, standardhttp.StatusOK, &closed)
	if closed.Request.Status != "closed" || closed.Viewer.CanClose {
		t.Fatalf("closed = %+v", closed)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE args->>'message_id'=$1 AND state='cancelled'`, created.ID).Scan(&jobs); err != nil || jobs != 2 {
		t.Fatalf("cancelled jobs = %d, %v", jobs, err)
	}
	var unread struct {
		RequestsWaitingTotal *int64 `json:"requests_waiting_total"`
	}
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/unread", member.AccessToken, nil, standardhttp.StatusOK, &unread)
	if unread.RequestsWaitingTotal == nil || *unread.RequestsWaitingTotal != 0 {
		t.Fatalf("unread = %+v", unread)
	}
}

func frameTypes(frames []eventlog.Frame) []string {
	types := make([]string, len(frames))
	for index, frame := range frames {
		types[index] = frame.Type
	}
	return types
}
