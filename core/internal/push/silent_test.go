package push

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

// A silent message reaches the chat but no device: even a notification job
// queued for it by mistake materializes no delivery.
func TestSilentMessagesAreNotPushed(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	orgID, senderID, recipientID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	chatID, sessionID := uuid.NewString(), uuid.NewString()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Silent','silent')`, []any{orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES ($2,$1,'user','owner','Sender','sender'),($3,$1,'user','member','Recipient','recipient')`, []any{orgID, senderID, recipientID}},
		{`INSERT INTO users(actor_id,org_id,email,password_hash) VALUES ($2,$1,'sender@example.test','hash'),($3,$1,'recipient@example.test','hash')`, []any{orgID, senderID, recipientID}},
		{`INSERT INTO sessions(id,org_id,actor_id,family_id,refresh_hash,expires_at) VALUES($3,$1,$2,$3,decode(repeat('01',32),'hex'),now()+interval '1 day')`, []any{orgID, recipientID, sessionID}},
		{`WITH c AS (INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($3,$1,'group','private','Quiet',$2) RETURNING id)
		  INSERT INTO chat_members(chat_id,actor_id,org_id,role) SELECT id,$2,$1,'owner' FROM c UNION ALL SELECT id,$4,$1,'member' FROM c`, []any{orgID, senderID, chatID, recipientID}},
		{`INSERT INTO web_push_subscriptions(id,org_id,actor_id,session_id,endpoint,p256dh,auth) VALUES($4,$1,$2,$3,'https://push.example.test/r','0123456789abcdef','0123456789abcdef')`, []any{orgID, recipientID, sessionID, uuid.NewString()}},
	} {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	messages := message.NewService(pool, 1024, 100, nil)
	sender := identity.User{ActorID: senderID, OrgID: orgID, OrgRole: "owner", Status: "active"}
	worker := NewWorker(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, config.PushConfig{}, nil)
	deliveries := func() int {
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM notification_deliveries`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}

	_, _, err = messages.Create(ctx, sender, chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.materialize(ctx); err != nil {
		t.Fatal(err)
	}
	if got := deliveries(); got != 1 {
		t.Fatalf("ordinary message deliveries = %d, want 1", got)
	}

	quiet, _, err := messages.Create(ctx, sender, chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "psst", Silent: true})
	if err != nil {
		t.Fatal(err)
	}
	var seq int64
	if err := pool.QueryRow(ctx, `SELECT seq FROM events WHERE subject_id=$1 AND type='message.created'`, quiet.ID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO notification_jobs(org_id,event_seq) VALUES($1,$2) ON CONFLICT DO NOTHING`, orgID, seq); err != nil {
		t.Fatal(err)
	}
	if err := worker.materialize(ctx); err != nil {
		t.Fatal(err)
	}
	if got := deliveries(); got != 1 {
		t.Fatalf("silent message produced a push delivery (total %d)", got)
	}
}
