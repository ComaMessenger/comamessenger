package http

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	standardhttp "net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"strings"
	"sync"
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
	"github.com/comamessenger/comamessenger/core/internal/poll"
	"github.com/comamessenger/comamessenger/core/internal/realtime"
	"github.com/comamessenger/comamessenger/core/internal/request"
	"github.com/comamessenger/comamessenger/core/internal/task"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/comamessenger/comamessenger/core/internal/userstate"
	"github.com/google/uuid"
)

// lockedBuffer collects the server log of a test.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// TestPollsE2E runs polls through the HTTP API with the real River client
// and checks the replies against the contract, what each person gets over
// realtime, and that neither the replies, the frames nor the server log tie
// a voter of an anonymous poll to an option.
func TestPollsE2E(t *testing.T) {
	pool := testdb.New(t)
	logs := &lockedBuffer{}
	logger := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
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
	messageService.SetTasks(task.NewService(pool, afterCommit))
	pollService := poll.NewService(pool, afterCommit)
	messageService.SetPolls(pollService)
	riverClient, err := poll.NewClient(pool, pollService, logger)
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
	voter, observer, stranger := invite("voter"), invite("observer"), invite("stranger")
	var group chat.Chat
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/chats", owner.AccessToken, map[string]any{
		"kind": "group", "visibility": "private", "name": "Plans", "member_ids": []string{voter.User.ActorID, observer.User.ActorID},
	}, standardhttp.StatusCreated, &group)
	observerSocket := e2eSocket(t, baseURL, observer.AccessToken, 0)
	defer observerSocket.CloseNow()
	voterSocket := e2eSocket(t, baseURL, voter.AccessToken, 0)
	defer voterSocket.CloseNow()

	endpoint := baseURL + "/api/v1/chats/" + group.ID + "/polls"
	pollBody := func(extra map[string]any) map[string]any {
		body := map[string]any{"client_msg_id": uuid.NewString(), "question": "Когда субботник?", "options": []string{"Среда", "Четверг", "Суббота"},
			"multiple": false, "anonymous": true}
		for key, value := range extra {
			body[key] = value
		}
		return body
	}
	expectError := func(method, target, token string, body any, status int, code api.ErrorCode, field string) {
		t.Helper()
		var failure api.Error
		e2eRequest(t, client, method, target, token, body, status, &failure)
		if failure.Code != code || (field != "" && (failure.Details == nil || (*failure.Details)["field"] != field)) {
			t.Fatalf("error = %+v, want %s %s", failure, code, field)
		}
	}
	expectError(standardhttp.MethodPost, endpoint, owner.AccessToken, pollBody(map[string]any{"options": []string{"Да", "да"}}), standardhttp.StatusUnprocessableEntity, "poll_invalid", "options")
	expectError(standardhttp.MethodPost, endpoint, owner.AccessToken, pollBody(map[string]any{"question": ""}), standardhttp.StatusUnprocessableEntity, "poll_invalid", "question")
	expectError(standardhttp.MethodPost, endpoint, owner.AccessToken, pollBody(map[string]any{"due_at": time.Now().Add(time.Minute)}), standardhttp.StatusUnprocessableEntity, "poll_invalid", "due_at")

	due := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	var raw json.RawMessage
	e2eRequest(t, client, standardhttp.MethodPost, endpoint, owner.AccessToken, pollBody(map[string]any{"due_at": due}), standardhttp.StatusCreated, &raw)
	var created api.Message
	strictInto(t, "createPoll", raw, &created)
	if created.Type != "poll" || created.Poll == nil || created.PollViewer == nil || created.Body != "Опрос: Когда субботник?\n\n— Среда\n— Четверг\n— Суббота" {
		t.Fatalf("created = %s", raw)
	}
	messageID := created.Id.String()
	var jobs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind='message_poll.close' AND args->>'message_id'=$1`, messageID).Scan(&jobs); err != nil || jobs != 1 {
		t.Fatalf("river jobs = %d, %v", jobs, err)
	}
	// The card reaches the chat with the poll, without a viewer or counts.
	for _, socket := range []string{"observer", "voter"} {
		connection := observerSocket
		if socket == "voter" {
			connection = voterSocket
		}
		frames := framesUntil(t, connection, "message.created")
		frame := frames[len(frames)-1]
		var data api.Message
		strictInto(t, "message.created", frame.Data, &data)
		if data.Poll == nil || data.PollViewer != nil || data.Poll.FinalCounts != nil {
			t.Fatalf("%s frame = %s", socket, frame.Data)
		}
	}

	// Before the vote: no results.
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/polls/"+messageID, voter.AccessToken, nil, standardhttp.StatusOK, &raw)
	var state api.PollState
	strictInto(t, "getPoll", raw, &state)
	if state.Viewer.CanViewResults || state.Viewer.Counts != nil || !state.Viewer.CanVote {
		t.Fatalf("before vote = %s", raw)
	}
	expectError(standardhttp.MethodGet, baseURL+"/api/v1/polls/"+messageID, stranger.AccessToken, nil, standardhttp.StatusNotFound, "poll_not_found", "")
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/inbox/waiting?kind=polls", voter.AccessToken, nil, standardhttp.StatusOK, &raw)
	var waiting api.WaitingInboxPage
	strictInto(t, "listWaitingInbox", raw, &waiting)
	if len(waiting.Items) != 1 || waiting.Items[0].Kind != "poll" {
		t.Fatalf("waiting = %s", raw)
	}
	var unread struct {
		PollsWaitingTotal *int64 `json:"polls_waiting_total"`
		PollsHotTotal     *int64 `json:"polls_hot_total"`
	}
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/unread", voter.AccessToken, nil, standardhttp.StatusOK, &unread)
	if unread.PollsWaitingTotal == nil || *unread.PollsWaitingTotal != 1 || unread.PollsHotTotal == nil || *unread.PollsHotTotal != 0 {
		t.Fatalf("unread = %+v", unread)
	}

	// The anonymous vote.
	expectError(standardhttp.MethodPut, baseURL+"/api/v1/polls/"+messageID+"/vote", voter.AccessToken, map[string]any{"options": []int{0, 1}}, standardhttp.StatusUnprocessableEntity, "poll_invalid", "options")
	expectError(standardhttp.MethodPut, baseURL+"/api/v1/polls/"+messageID+"/vote", voter.AccessToken, map[string]any{"options": []int{2}, "expected_version": 9}, standardhttp.StatusConflict, "version_conflict", "")
	before := logs.String()
	e2eRequest(t, client, standardhttp.MethodPut, baseURL+"/api/v1/polls/"+messageID+"/vote", voter.AccessToken, map[string]any{"options": []int{2}, "expected_version": 1}, standardhttp.StatusOK, &raw)
	strictInto(t, "votePoll", raw, &state)
	if !state.Viewer.Voted || state.Viewer.MyOptions != nil || state.Viewer.CanVote || state.Viewer.CanChange || state.Viewer.Counts == nil || (*state.Viewer.Counts)[2] != 1 {
		t.Fatalf("after vote = %s", raw)
	}
	expectError(standardhttp.MethodPut, baseURL+"/api/v1/polls/"+messageID+"/vote", voter.AccessToken, map[string]any{"options": []int{1}}, standardhttp.StatusConflict, "poll_vote_final", "")
	expectError(standardhttp.MethodDelete, baseURL+"/api/v1/polls/"+messageID+"/vote", voter.AccessToken, nil, standardhttp.StatusConflict, "poll_vote_final", "")
	expectError(standardhttp.MethodGet, baseURL+"/api/v1/polls/"+messageID+"/voters?filter=option:2", owner.AccessToken, nil, standardhttp.StatusForbidden, "forbidden", "")
	expectError(standardhttp.MethodGet, baseURL+"/api/v1/polls/"+messageID+"/voters?filter=waiting", owner.AccessToken, nil, standardhttp.StatusForbidden, "forbidden", "")
	// The log of the vote names the route, never the choice.
	voteLog := strings.TrimPrefix(logs.String(), before)
	if !strings.Contains(voteLog, "/polls/{messageID}/vote") || strings.Contains(voteLog, "options") || strings.Contains(voteLog, "[2]") {
		t.Fatalf("vote log = %s", voteLog)
	}
	// The voter's frames: poll.vote.updated says only «voted»; poll.updated
	// has no actor and no counts.
	frames := framesUntil(t, voterSocket, "poll.vote.updated")
	var vote api.RealtimePollVoteUpdatedEventV1
	strictInto(t, "poll.vote.updated", frames[len(frames)-1].Data, &vote)
	if strings.Contains(string(frames[len(frames)-1].Data), "options") {
		t.Fatalf("anonymous poll.vote.updated = %s", frames[len(frames)-1].Data)
	}
	observerFrames := framesUntil(t, observerSocket, "poll.updated")
	for _, frame := range observerFrames {
		if frame.Type == "poll.vote.updated" {
			t.Fatalf("observer got someone's vote: %s", frame.Data)
		}
		if frame.Type == "poll.updated" {
			var updated api.RealtimePollUpdatedEventV1
			strictInto(t, "poll.updated", frame.Data, &updated)
			if frame.ActorID != nil || updated.FinalCounts != nil {
				t.Fatalf("poll.updated = %+v %s", frame.ActorID, frame.Data)
			}
		}
	}

	// The author edits the question; others cannot; updateMessage refuses.
	expectError(standardhttp.MethodPatch, baseURL+"/api/v1/polls/"+messageID, voter.AccessToken, map[string]any{"question": "x", "expected_version": 2}, standardhttp.StatusForbidden, "forbidden", "")
	expectError(standardhttp.MethodPatch, baseURL+"/api/v1/polls/"+messageID, owner.AccessToken, map[string]any{"question": "x", "expected_version": 1}, standardhttp.StatusConflict, "version_conflict", "")
	e2eRequest(t, client, standardhttp.MethodPatch, baseURL+"/api/v1/polls/"+messageID, owner.AccessToken, map[string]any{"question": "Когда удобнее?", "expected_version": 2}, standardhttp.StatusOK, &raw)
	var edited api.Message
	strictInto(t, "updatePoll", raw, &edited)
	if edited.EditedAt == nil || edited.Poll == nil || edited.Poll.Question != "Когда удобнее?" || edited.Poll.Version != 3 || edited.PollViewer == nil ||
		!strings.HasPrefix(edited.Body, "Опрос: Когда удобнее?\n\n— Среда") {
		t.Fatalf("edited = %s", raw)
	}
	expectError(standardhttp.MethodPatch, baseURL+"/api/v1/messages/"+messageID, owner.AccessToken, map[string]any{"body": "x", "expected_version": int(edited.Version)}, standardhttp.StatusUnprocessableEntity, "validation_failed", "")

	// Remind, close, voters of an ordinary poll.
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/polls/"+messageID+"/remind", owner.AccessToken, nil, standardhttp.StatusOK, &raw)
	var remind api.PollRemindResult
	strictInto(t, "remindPoll", raw, &remind)
	if remind.Reminded != 1 {
		t.Fatalf("remind = %s", raw)
	}
	request, _ := standardhttp.NewRequest(standardhttp.MethodPost, baseURL+"/api/v1/polls/"+messageID+"/remind", nil)
	request.Header.Set("Authorization", "Bearer "+owner.AccessToken)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != standardhttp.StatusTooManyRequests || response.Header.Get("Retry-After") == "" {
		t.Fatalf("second remind = %d %q", response.StatusCode, response.Header.Get("Retry-After"))
	}
	expectError(standardhttp.MethodPost, baseURL+"/api/v1/polls/"+messageID+"/close", voter.AccessToken, nil, standardhttp.StatusForbidden, "forbidden", "")
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/polls/"+messageID+"/close", owner.AccessToken, nil, standardhttp.StatusOK, &raw)
	strictInto(t, "closePoll", raw, &state)
	if state.Poll.Status != "closed" || state.Poll.FinalCounts == nil {
		t.Fatalf("closed = %s", raw)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE args->>'message_id'=$1 AND state='cancelled'`, messageID).Scan(&jobs); err != nil || jobs != 1 {
		t.Fatalf("cancelled jobs = %d, %v", jobs, err)
	}

	e2eRequest(t, client, standardhttp.MethodPost, endpoint, voter.AccessToken, pollBody(map[string]any{"anonymous": false, "multiple": true}), standardhttp.StatusCreated, &created)
	open := created.Id.String()
	e2eRequest(t, client, standardhttp.MethodPut, baseURL+"/api/v1/polls/"+open+"/vote", observer.AccessToken, map[string]any{"options": []int{0, 2}}, standardhttp.StatusOK, &raw)
	strictInto(t, "votePoll", raw, &state)
	if state.Viewer.MyOptions == nil || len(*state.Viewer.MyOptions) != 2 {
		t.Fatalf("ordinary vote = %s", raw)
	}
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/polls/"+open+"/voters?filter=option:2", observer.AccessToken, nil, standardhttp.StatusOK, &raw)
	var voters api.PollVoterPage
	strictInto(t, "listPollVoters", raw, &voters)
	if len(voters.Items) != 1 || voters.Items[0].ActorId.String() != observer.User.ActorID {
		t.Fatalf("voters = %s", raw)
	}
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/polls/"+open+"/voters?filter=waiting", voter.AccessToken, nil, standardhttp.StatusOK, &raw)
	strictInto(t, "listPollVoters waiting", raw, &voters)
	if len(voters.Items) != 2 {
		t.Fatalf("waiting voters = %s", raw)
	}
	expectError(standardhttp.MethodGet, baseURL+"/api/v1/polls/"+open+"/voters?filter=waiting", observer.AccessToken, nil, standardhttp.StatusForbidden, "forbidden", "")
	expectError(standardhttp.MethodGet, baseURL+"/api/v1/polls/"+open+"/voters?filter=nope", observer.AccessToken, nil, standardhttp.StatusUnprocessableEntity, "poll_invalid", "filter")
	e2eRequest(t, client, standardhttp.MethodDelete, baseURL+"/api/v1/polls/"+open+"/vote", observer.AccessToken, nil, standardhttp.StatusNoContent, nil)
	// The feed carries poll_viewer.
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/chats/"+group.ID+"/messages", observer.AccessToken, nil, standardhttp.StatusOK, &raw)
	var page api.MessagePage
	strictInto(t, "listMessages", raw, &page)
	for _, item := range page.Messages {
		if item.Type == "poll" && (item.Poll == nil || item.PollViewer == nil) {
			t.Fatalf("feed item without the poll: %s", raw)
		}
	}

	// Deleting the message closes the poll.
	e2eRequest(t, client, standardhttp.MethodDelete, baseURL+"/api/v1/messages/"+open, voter.AccessToken, nil, standardhttp.StatusOK, nil)
	expectError(standardhttp.MethodGet, baseURL+"/api/v1/polls/"+open, voter.AccessToken, nil, standardhttp.StatusNotFound, "poll_not_found", "")
	var status string
	if err := pool.QueryRow(ctx, `SELECT closed_reason FROM message_polls WHERE message_id=$1`, open).Scan(&status); err != nil || status != "message_deleted" {
		t.Fatalf("deleted poll = %q %v", status, err)
	}
}
