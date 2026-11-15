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
	"github.com/comamessenger/comamessenger/core/internal/task"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/comamessenger/comamessenger/core/internal/userstate"
	"github.com/google/uuid"
)

// strictInto decodes raw into a generated contract type and fails on any
// field the contract does not have.
func strictInto(t *testing.T, name string, raw []byte, into any) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		t.Fatalf("%s does not match the contract: %v\n%s", name, err, raw)
	}
}

// TestTasksE2E sets a task through the HTTP API with the real River client
// and checks the replies against the contract and what each person gets
// over realtime: the responsible person learns «this is for me» before the
// card, the observer never gets task.notified, and no frame of
// task.notified carries the title.
func TestTasksE2E(t *testing.T) {
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
	taskService := task.NewService(pool, afterCommit)
	messageService.SetTasks(taskService)
	riverClient, err := task.NewClient(pool, taskService, logger)
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
	member, observer, stranger := invite("member"), invite("observer"), invite("stranger")
	var group chat.Chat
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/chats", owner.AccessToken, map[string]any{
		"kind": "group", "visibility": "private", "name": "Plans", "member_ids": []string{member.User.ActorID, observer.User.ActorID},
	}, standardhttp.StatusCreated, &group)
	observerSocket := e2eSocket(t, baseURL, observer.AccessToken, 0)
	defer observerSocket.CloseNow()
	memberSocket := e2eSocket(t, baseURL, member.AccessToken, 0)
	defer memberSocket.CloseNow()

	const secret = "Секретное поручение"
	endpoint := baseURL + "/api/v1/chats/" + group.ID + "/tasks"
	taskBody := func(extra map[string]any) map[string]any {
		body := map[string]any{"client_msg_id": uuid.NewString(), "title": secret, "remind_before_due": false,
			"assignee": map[string]any{"kind": "person", "actor_id": member.User.ActorID}}
		for key, value := range extra {
			body[key] = value
		}
		return body
	}
	expectError := func(method, target, token string, body any, status int, code api.ErrorCode, field string) api.Error {
		t.Helper()
		var failure api.Error
		e2eRequest(t, client, method, target, token, body, status, &failure)
		if failure.Code != code || (field != "" && (failure.Details == nil || (*failure.Details)["field"] != field)) {
			t.Fatalf("error = %+v, want %s %s", failure, code, field)
		}
		return failure
	}
	expectError(standardhttp.MethodPost, endpoint, owner.AccessToken, taskBody(map[string]any{"assignee": map[string]any{"kind": "person", "actor_id": stranger.User.ActorID}}), standardhttp.StatusUnprocessableEntity, "task_assignee_invalid", "")
	expectError(standardhttp.MethodPost, endpoint, owner.AccessToken, taskBody(map[string]any{"remind_before_due": true}), standardhttp.StatusUnprocessableEntity, "task_invalid", "remind_before_due")
	expectError(standardhttp.MethodPost, endpoint, member.AccessToken, taskBody(map[string]any{"assignee": map[string]any{"kind": "department", "department_id": uuid.NewString()}}), standardhttp.StatusForbidden, "task_audience_forbidden", "")
	expectError(standardhttp.MethodPost, endpoint, owner.AccessToken, taskBody(map[string]any{"assignee": map[string]any{"kind": "department", "department_id": uuid.NewString()}}), standardhttp.StatusNotFound, "department_not_found", "")

	due := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	var raw json.RawMessage
	e2eRequest(t, client, standardhttp.MethodPost, endpoint, owner.AccessToken, taskBody(map[string]any{
		"due_at": due, "remind_before_due": true, "description": "Подробности",
		"items": []map[string]any{{"text": "Первый пункт", "assignee_id": observer.User.ActorID}},
	}), standardhttp.StatusCreated, &raw)
	var created api.Message
	strictInto(t, "createTask", raw, &created)
	if created.Type != "task" || created.Task == nil || created.Body != secret+"\n\nПодробности" {
		t.Fatalf("created = %s", raw)
	}
	messageID := created.Id.String()
	var jobs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind IN ('message_task.due_soon','message_task.overdue') AND args->>'message_id'=$1`, messageID).Scan(&jobs); err != nil || jobs != 2 {
		t.Fatalf("river jobs = %d, %v", jobs, err)
	}
	// The responsible person learns «this is for me» before the card.
	memberFrames := framesUntil(t, memberSocket, "message.created")
	if len(memberFrames) < 2 || memberFrames[len(memberFrames)-2].Type != "task.notified" {
		t.Fatalf("member frames = %v", frameTypes(memberFrames))
	}
	notified := memberFrames[len(memberFrames)-2]
	var notice api.RealtimeTaskNotifiedEventV1
	strictInto(t, "task.notified", notified.Data, &notice)
	if notice.Kind != "assigned" || strings.Contains(string(notified.Data), secret) {
		t.Fatalf("notice = %s", notified.Data)
	}

	// Reads.
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/tasks/"+messageID, observer.AccessToken, nil, standardhttp.StatusOK, &raw)
	strictInto(t, "getTask", raw, &api.Message{})
	expectError(standardhttp.MethodGet, baseURL+"/api/v1/tasks/"+messageID, stranger.AccessToken, nil, standardhttp.StatusNotFound, "task_not_found", "")
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/chats/"+group.ID+"/tasks", member.AccessToken, nil, standardhttp.StatusOK, &raw)
	var chatPage api.ChatTaskPage
	strictInto(t, "listChatTasks", raw, &chatPage)
	if len(chatPage.Items) != 1 || chatPage.Counts.Mine != 1 {
		t.Fatalf("chat page = %s", raw)
	}
	expectError(standardhttp.MethodGet, baseURL+"/api/v1/chats/"+group.ID+"/tasks", stranger.AccessToken, nil, standardhttp.StatusForbidden, "not_member", "")
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/tasks/mine?role=assigned", member.AccessToken, nil, standardhttp.StatusOK, &raw)
	strictInto(t, "listMyTasks", raw, &api.MyTaskPage{})
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/inbox/waiting", member.AccessToken, nil, standardhttp.StatusOK, &raw)
	var waiting api.WaitingInboxPage
	strictInto(t, "listWaitingInbox", raw, &waiting)
	if len(waiting.Items) != 1 || waiting.Items[0].Kind != "task" {
		t.Fatalf("waiting = %s", raw)
	}
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/inbox/waiting", stranger.AccessToken, nil, standardhttp.StatusOK, &raw)
	if strings.Contains(string(raw), messageID) {
		t.Fatalf("stranger waiting = %s", raw)
	}
	var unread struct {
		TasksMineOpenTotal *int64 `json:"tasks_mine_open_total"`
		TasksMineHotTotal  *int64 `json:"tasks_mine_hot_total"`
	}
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/unread", member.AccessToken, nil, standardhttp.StatusOK, &unread)
	if unread.TasksMineOpenTotal == nil || *unread.TasksMineOpenTotal != 1 || unread.TasksMineHotTotal == nil || *unread.TasksMineHotTotal != 0 {
		t.Fatalf("unread = %+v", unread)
	}

	// Actions and their errors.
	expectError(standardhttp.MethodPut, baseURL+"/api/v1/tasks/"+messageID+"/status", observer.AccessToken, map[string]any{"status": "done"}, standardhttp.StatusForbidden, "task_forbidden", "")
	conflict := expectError(standardhttp.MethodPatch, baseURL+"/api/v1/tasks/"+messageID, owner.AccessToken, map[string]any{"expected_version": 7, "title": "x"}, standardhttp.StatusConflict, "task_version_conflict", "")
	details, _ := json.Marshal((*conflict.Details)["task"])
	strictInto(t, "details.task", details, &api.MessageTask{})
	expectError(standardhttp.MethodPost, baseURL+"/api/v1/tasks/"+messageID+"/take", member.AccessToken, nil, standardhttp.StatusForbidden, "task_forbidden", "")
	e2eRequest(t, client, standardhttp.MethodPut, baseURL+"/api/v1/tasks/"+messageID+"/status", member.AccessToken, map[string]any{"status": "in_progress"}, standardhttp.StatusOK, &raw)
	strictInto(t, "setTaskStatus", raw, &api.Message{})
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/tasks/"+messageID+"/items", member.AccessToken, map[string]any{"text": "Второй"}, standardhttp.StatusCreated, &raw)
	var withItem api.MessageTask
	strictInto(t, "addTaskItem", raw, &withItem)
	itemID := withItem.Items[1].Id.String()
	e2eRequest(t, client, standardhttp.MethodPatch, baseURL+"/api/v1/tasks/"+messageID+"/items/"+withItem.Items[0].Id.String(), observer.AccessToken, map[string]any{"done": true}, standardhttp.StatusOK, &raw)
	strictInto(t, "updateTaskItem", raw, &api.MessageTask{})
	expectError(standardhttp.MethodPatch, baseURL+"/api/v1/tasks/"+messageID+"/items/"+itemID, observer.AccessToken, map[string]any{"done": true}, standardhttp.StatusForbidden, "task_forbidden", "")
	expectError(standardhttp.MethodPatch, baseURL+"/api/v1/tasks/"+messageID+"/items/"+itemID, member.AccessToken, map[string]any{}, standardhttp.StatusUnprocessableEntity, "task_invalid", "item")
	e2eRequest(t, client, standardhttp.MethodDelete, baseURL+"/api/v1/tasks/"+messageID+"/items/"+itemID, member.AccessToken, nil, standardhttp.StatusNoContent, nil)
	e2eRequest(t, client, standardhttp.MethodDelete, baseURL+"/api/v1/tasks/"+messageID+"/items/"+itemID, member.AccessToken, nil, standardhttp.StatusNoContent, nil)
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/tasks/"+messageID+"/nudge", owner.AccessToken, nil, standardhttp.StatusOK, &raw)
	strictInto(t, "nudgeTask", raw, &api.TaskNudgeResult{})
	request, _ := standardhttp.NewRequest(standardhttp.MethodPost, baseURL+"/api/v1/tasks/"+messageID+"/nudge", nil)
	request.Header.Set("Authorization", "Bearer "+owner.AccessToken)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != standardhttp.StatusTooManyRequests || response.Header.Get("Retry-After") == "" {
		t.Fatalf("second nudge = %d %q", response.StatusCode, response.Header.Get("Retry-After"))
	}

	// The observer's frames: the card and task.updated with the task; never
	// task.notified about other people.
	observerFrames := framesUntil(t, observerSocket, "task.updated")
	for _, frame := range observerFrames {
		if frame.Type == "task.notified" {
			var data map[string]any
			_ = json.Unmarshal(frame.Data, &data)
			if strings.Contains(string(frame.Data), secret) {
				t.Fatalf("observer task.notified leaks: %s", frame.Data)
			}
		}
		if frame.Type == "task.updated" {
			strictInto(t, "task.updated", frame.Data, &api.TaskUpdatedEvent{})
		}
	}

	// Deleting the message cancels the task and its jobs.
	e2eRequest(t, client, standardhttp.MethodDelete, baseURL+"/api/v1/messages/"+messageID, owner.AccessToken, nil, standardhttp.StatusOK, nil)
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE args->>'message_id'=$1 AND state='cancelled'`, messageID).Scan(&jobs); err != nil || jobs != 2 {
		t.Fatalf("cancelled jobs = %d, %v", jobs, err)
	}
	expectError(standardhttp.MethodGet, baseURL+"/api/v1/tasks/"+messageID, member.AccessToken, nil, standardhttp.StatusNotFound, "task_not_found", "")
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/inbox/waiting", member.AccessToken, nil, standardhttp.StatusOK, &raw)
	strictInto(t, "listWaitingInbox", raw, &waiting)
	if len(waiting.Items) != 0 {
		t.Fatalf("waiting after deletion = %s", raw)
	}
}
