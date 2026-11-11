package realtime

import (
	"io"
	"log/slog"
	"slices"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

// Another agent's streamed reply and run status do not reach an agent that
// only writes to the chat; people and reading agents get them, and the
// streaming agent itself is never left out of its own stream.
func TestStreamingSkipsAgentsThatOnlyWriteToTheChat(t *testing.T) {
	pool := testdb.New(t)
	member, chatID := seedRealtimeFixture(t, pool)
	ctx := t.Context()
	var ownerID string
	if err := pool.QueryRow(ctx, `SELECT id FROM actors WHERE org_id=$1 AND org_role='owner'`, member.OrgID).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	streamerID, writerID, runID, leaseToken := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for index, agentID := range []string{streamerID, writerID} {
		if _, err := pool.Exec(ctx, `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'agent','member','Agent',$3)`, agentID, member.OrgID, []string{"streamer", "writer"}[index]); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes) VALUES($1,$2,$3,'builtin',true,ARRAY['messages:read','runtime:execute'])`, agentID, member.OrgID, ownerID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'member')`, chatID, agentID, member.OrgID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE agents SET write_only_chat_ids=ARRAY[$2::uuid] WHERE actor_id=$1`, writerID, chatID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,status,lease_token,lease_expires_at,started_at) VALUES($1,$2,$3,$4,$5,'running',$6,now()+interval '1 minute',now())`, runID, member.OrgID, streamerID, chatID, uuid.NewString(), leaseToken); err != nil {
		t.Fatal(err)
	}
	hub := NewHub(10)
	sender, _ := hub.Register(member.OrgID, streamerID, "streamer-session", uuid.NewString(), 0)
	defer sender.Close()
	person, _ := hub.Register(member.OrgID, member.ActorID, "member-session", uuid.NewString(), 0)
	defer person.Close()
	writer, _ := hub.Register(member.OrgID, writerID, "writer-session", uuid.NewString(), 0)
	defer writer.Close()
	service, err := NewEphemeral(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, hub, realtimeTestConfig(), config.RedisConfig{Mode: "disabled", Namespace: "coma:test", OperationTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	streamer := identity.User{ActorID: streamerID, OrgID: member.OrgID, Status: "active"}
	authentication := access.Identity{AuthenticationKind: "api_key", ActorID: streamerID, OrgID: member.OrgID, KeyID: uuid.NewString(), Scopes: []string{"messages:read", "runtime:execute"}}

	if err := service.AgentStatus(ctx, streamer, authentication, sender, agentStatusFrame{Op: "agent.status", RunID: runID, LeaseToken: leaseToken, ChatID: chatID, State: "thinking"}); err != nil {
		t.Fatal(err)
	}
	if err := service.MessageStreaming(ctx, streamer, authentication, sender, messageStreamingFrame{Op: "message.streaming", RunID: runID, LeaseToken: leaseToken, ChatID: chatID, StreamID: uuid.NewString(), Index: 1, Delta: "код сейфа"}); err != nil {
		t.Fatal(err)
	}
	var status agentStatusEventFrame
	readEphemeral(t, person, &status)
	var stream messageStreamingEventFrame
	readEphemeral(t, person, &stream)
	if status.State != "thinking" || stream.Delta != "код сейфа" {
		t.Fatalf("person got status=%+v stream=%+v", status, stream)
	}
	select {
	case payload := <-writer.Ephemeral():
		t.Fatalf("write-only agent got %s", payload)
	case <-time.After(200 * time.Millisecond):
	}

	// The streaming agent stays a recipient even where it only writes.
	if _, err := pool.Exec(ctx, `UPDATE agents SET write_only_chat_ids=ARRAY[$2::uuid] WHERE actor_id=$1`, streamerID, chatID); err != nil {
		t.Fatal(err)
	}
	recipients, err := service.recipients(ctx, streamer, chatID, true)
	if err != nil || !slices.Contains(recipients, streamerID) || slices.Contains(recipients, writerID) || !slices.Contains(recipients, member.ActorID) {
		t.Fatalf("recipients = %v, %v", recipients, err)
	}
	// Typing and presence carry no message content and are unchanged.
	everyone, err := service.recipients(ctx, member, chatID, false)
	if err != nil || !slices.Contains(everyone, writerID) {
		t.Fatalf("typing recipients = %v, %v", everyone, err)
	}

	// An agent that reads the chat gets the stream.
	if _, err := pool.Exec(ctx, `UPDATE agents SET write_only_chat_ids='{}'`); err != nil {
		t.Fatal(err)
	}
	if err := service.MessageStreaming(ctx, streamer, authentication, sender, messageStreamingFrame{Op: "message.streaming", RunID: runID, LeaseToken: leaseToken, ChatID: chatID, StreamID: uuid.NewString(), Index: 1, Delta: "привет"}); err != nil {
		t.Fatal(err)
	}
	var readerStream messageStreamingEventFrame
	readEphemeral(t, writer, &readerStream)
	if readerStream.Delta != "привет" {
		t.Fatalf("reading agent stream = %+v", readerStream)
	}
}
