package userstate

import (
	"context"
	"errors"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestUserStateIntegration(t *testing.T) {
	pool := testdb.New(t)
	owner, member, chatID := seed(t, pool)
	messages := message.NewService(pool, 64*1024, 100, nil)
	service := NewService(pool, 64*1024, nil)
	ctx := context.Background()
	first, _, err := messages.Create(ctx, owner, chatID, message.CreateInput{ClientMsgID: uid(t), Body: "hello", BodyFormat: "plain", MentionedActorIDs: []string{member.ActorID}})
	if err != nil {
		t.Fatal(err)
	}
	root, _, err := messages.Create(ctx, owner, chatID, message.CreateInput{ClientMsgID: uid(t), Body: "root", BodyFormat: "plain"})
	if err != nil {
		t.Fatal(err)
	}
	replyTo := root.ID
	reply, _, err := messages.Create(ctx, owner, chatID, message.CreateInput{ClientMsgID: uid(t), Body: "thread mention", BodyFormat: "plain", ReplyToID: &replyTo, ThreadRootID: &root.ID, MentionedActorIDs: []string{member.ActorID}})
	if err != nil {
		t.Fatal(err)
	}

	snapshot, err := service.Unread(ctx, member)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Chats) != 1 || snapshot.Chats[0].UnreadCount != 2 || snapshot.Chats[0].MentionCount != 1 {
		t.Fatalf("chat unread = %+v", snapshot.Chats)
	}
	if len(snapshot.Threads) != 1 || snapshot.Threads[0].UnreadCount != 1 || snapshot.Threads[0].MentionCount != 1 {
		t.Fatalf("thread unread = %+v", snapshot.Threads)
	}

	sourceSession := uid(t)
	otherSession := uid(t)
	marker, advanced, err := service.MarkChatRead(ctx, member, sourceSession, chatID, root.CreatedSeq)
	if err != nil || !advanced || marker.LastReadSeq != root.CreatedSeq {
		t.Fatalf("MarkChatRead() = %+v %v %v", marker, advanced, err)
	}
	marker, advanced, err = service.MarkChatRead(ctx, member, sourceSession, chatID, first.CreatedSeq)
	if err != nil || advanced || marker.LastReadSeq != root.CreatedSeq {
		t.Fatalf("regressing MarkChatRead() = %+v %v %v", marker, advanced, err)
	}
	if _, _, err := service.MarkChatRead(ctx, member, sourceSession, chatID, reply.CreatedSeq); !errors.Is(err, ErrInvalid) {
		t.Fatalf("thread seq accepted as chat marker: %v", err)
	}

	var readEventSeq int64
	if err := pool.QueryRow(ctx, `SELECT seq FROM events WHERE type='read.marked' AND subject_id=$1`, chatID).Scan(&readEventSeq); err != nil {
		t.Fatal(err)
	}
	store := eventlog.NewStore(pool)
	frames, err := store.Replay(ctx, member, sourceSession, readEventSeq-1, readEventSeq, 10)
	if err != nil || len(frames) != 0 {
		t.Fatalf("source session replay = %+v %v", frames, err)
	}
	frames, err = store.Replay(ctx, member, otherSession, readEventSeq-1, readEventSeq, 10)
	if err != nil || len(frames) != 1 {
		t.Fatalf("other session replay = %+v %v", frames, err)
	}

	threadMarker, advanced, err := service.MarkThreadRead(ctx, member, sourceSession, root.ID, reply.CreatedSeq)
	if err != nil || !advanced || threadMarker.LastReadSeq != reply.CreatedSeq {
		t.Fatalf("MarkThreadRead() = %+v %v %v", threadMarker, advanced, err)
	}
	snapshot, err = service.Unread(ctx, member)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Chats[0].UnreadCount != 0 || snapshot.Threads[0].UnreadCount != 0 {
		t.Fatalf("read snapshot = %+v", snapshot)
	}

	draft, created, err := service.PutDraft(ctx, member, sourceSession, chatID, PutDraftInput{Body: "draft", BodyFormat: "plain", ExpectedVersion: 0})
	if err != nil || !created || draft.Version != 1 {
		t.Fatalf("PutDraft create = %+v %v %v", draft, created, err)
	}
	replay, created, err := service.PutDraft(ctx, member, sourceSession, chatID, PutDraftInput{Body: "draft", BodyFormat: "plain", ExpectedVersion: 0})
	if err != nil || created || replay.Version != 1 {
		t.Fatalf("PutDraft replay = %+v %v %v", replay, created, err)
	}
	if _, _, err := service.PutDraft(ctx, member, sourceSession, chatID, PutDraftInput{Body: "stale", BodyFormat: "plain", ExpectedVersion: 0}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale draft error = %v", err)
	}
	draft, created, err = service.PutDraft(ctx, member, sourceSession, chatID, PutDraftInput{Body: "updated", BodyFormat: "markdown", ExpectedVersion: 1})
	if err != nil || created || draft.Version != 2 {
		t.Fatalf("PutDraft update = %+v %v %v", draft, created, err)
	}
	drafts, err := service.ListDrafts(ctx, member)
	if err != nil || len(drafts) != 1 || drafts[0].Version != 2 {
		t.Fatalf("ListDrafts = %+v %v", drafts, err)
	}
	removed, err := service.DeleteDraft(ctx, member, sourceSession, chatID, nil)
	if err != nil || !removed {
		t.Fatalf("DeleteDraft = %v %v", removed, err)
	}
	removed, err = service.DeleteDraft(ctx, member, sourceSession, chatID, nil)
	if err != nil || removed {
		t.Fatalf("idempotent DeleteDraft = %v %v", removed, err)
	}
}

func seed(t *testing.T, pool *pgxpool.Pool) (identity.User, identity.User, string) {
	t.Helper()
	orgID := uid(t)
	owner := identity.User{ActorID: uid(t), OrgID: orgID, OrgRole: "owner", Status: "active"}
	member := identity.User{ActorID: uid(t), OrgID: orgID, OrgRole: "member", Status: "active"}
	chatID := uid(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO organizations(id,name,slug)VALUES($1,'User State','user-state')`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO actors(id,org_id,type,org_role,display_name,handle)VALUES($1,$3,'user','owner','Owner','state_owner'),($2,$3,'user','member','Member','state_member')`, owner.ActorID, member.ActorID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO chats(id,org_id,kind,visibility,name,created_by)VALUES($1,$2,'group','private','State',$3)`, chatID, orgID, owner.ActorID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO chat_members(chat_id,actor_id,org_id,role)VALUES($1,$2,$3,'owner'),($1,$4,$3,'member')`, chatID, owner.ActorID, orgID, member.ActorID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return owner, member, chatID
}
func uid(t *testing.T) string {
	t.Helper()
	value, err := id.New()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
