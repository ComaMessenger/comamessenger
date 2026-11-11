package message_test

import (
	"context"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

// The message.saved event reaches only the saver's sessions, live and on
// replay; the chat owner and a workspace admin get nothing. In an external
// package because eventlog imports message.
func TestSavedEventGoesToTheSaverOnly(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	newID := func() string {
		value, err := id.New()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	orgID, chatID := newID(), newID()
	owner := identity.User{ActorID: newID(), OrgID: orgID, OrgRole: "owner", Status: "active"}
	member := identity.User{ActorID: newID(), OrgID: orgID, OrgRole: "member", Status: "active"}
	admin := identity.User{ActorID: newID(), OrgID: orgID, OrgRole: "admin", Status: "active"}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Test', 'test')`, []any{orgID}},
		{`INSERT INTO actors (id, org_id, type, org_role, display_name, handle) VALUES
			($1, $4, 'user', 'owner', 'Owner', 'owner'),
			($2, $4, 'user', 'member', 'Member', 'member'),
			($3, $4, 'user', 'admin', 'Admin', 'admin')`, []any{owner.ActorID, member.ActorID, admin.ActorID, orgID}},
		{`INSERT INTO chats (id, org_id, kind, visibility, name, created_by) VALUES ($1, $2, 'group', 'private', 'group', $3)`, []any{chatID, orgID, owner.ActorID}},
		{`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $4, 'owner'), ($1, $3, $4, 'member')`, []any{chatID, owner.ActorID, member.ActorID, orgID}},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	service := message.NewService(pool, 64*1024, 100, nil)
	target, _, err := service.Create(ctx, owner, chatID, message.CreateInput{ClientMsgID: newID(), Body: "remember me", BodyFormat: "plain"})
	if err != nil {
		t.Fatal(err)
	}
	sequence := func() int64 {
		var value int64
		if err := pool.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id = $1`, orgID).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := sequence()
	if _, created, err := service.SaveMessage(ctx, member, target.ID); err != nil || !created {
		t.Fatalf("SaveMessage() = %v, %v", created, err)
	}
	after := sequence()
	events := eventlog.NewStore(pool)
	live, err := events.Live(ctx, orgID, before, after, 10)
	if err != nil || len(live) != 1 {
		t.Fatalf("Live() = %+v, %v", live, err)
	}
	if got := live[0].RecipientActorIDs; len(got) != 1 || got[0] != member.ActorID {
		t.Fatalf("recipients = %v, want only the saver", got)
	}
	for _, other := range []identity.User{owner, admin} {
		frames, err := events.Replay(ctx, other, "", before, after, 10)
		if err != nil || len(frames) != 0 {
			t.Fatalf("Replay() for another person = %+v, %v; want nothing", frames, err)
		}
	}
	frames, err := events.Replay(ctx, member, "", before, after, 10)
	if err != nil || len(frames) != 1 || frames[0].Type != "message.saved" {
		t.Fatalf("Replay() for the saver = %+v, %v", frames, err)
	}
}
