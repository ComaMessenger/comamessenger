package eventlog

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestStoreReplayHydratesAndFiltersCurrentMembership(t *testing.T) {
	pool := testdb.New(t)
	owner, member, outsider, chatID := seedEventFixture(t, pool)
	service := message.NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	first, _, err := service.Create(ctx, member, chatID, message.CreateInput{
		ClientMsgID: testID(t), Body: "first", BodyFormat: "plain",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := service.Create(ctx, owner, chatID, message.CreateInput{
		ClientMsgID: testID(t), Body: "second", BodyFormat: "plain",
	})
	if err != nil {
		t.Fatal(err)
	}

	store := NewStore(pool)
	bounds, err := store.Bounds(ctx, owner.OrgID)
	if err != nil {
		t.Fatal(err)
	}
	if bounds.CurrentSeq != second.CreatedSeq || bounds.MinRetainedSeq != 0 {
		t.Fatalf("Bounds() = %+v", bounds)
	}
	frames, err := store.Replay(ctx, member, 0, bounds.CurrentSeq, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 2 || frames[0].Seq != first.CreatedSeq || frames[1].Seq != second.CreatedSeq {
		t.Fatalf("Replay() = %+v", frames)
	}
	limited, err := store.Replay(ctx, member, 0, bounds.CurrentSeq, 1)
	if err != nil || len(limited) != 1 || limited[0].Seq != first.CreatedSeq {
		t.Fatalf("bounded Replay() = %+v, %v", limited, err)
	}
	var hydrated message.Message
	if err := json.Unmarshal(frames[0].Data, &hydrated); err != nil {
		t.Fatal(err)
	}
	if hydrated.ID != first.ID || hydrated.Body != first.Body || hydrated.ClientMsgID != first.ClientMsgID {
		t.Fatalf("hydrated message = %+v", hydrated)
	}
	if frames, err := store.Replay(ctx, outsider, 0, bounds.CurrentSeq, 10); err != nil || len(frames) != 0 {
		t.Fatalf("outsider Replay() = %+v, %v", frames, err)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM chat_members WHERE chat_id = $1 AND actor_id = $2`, chatID, member.ActorID); err != nil {
		t.Fatal(err)
	}
	if frames, err := store.Replay(ctx, member, 0, bounds.CurrentSeq, 10); err != nil || len(frames) != 0 {
		t.Fatalf("revoked member Replay() = %+v, %v", frames, err)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM events WHERE org_id = $1 AND seq = $2`, owner.OrgID, first.CreatedSeq); err != nil {
		t.Fatal(err)
	}
	bounds, err = store.Bounds(ctx, owner.OrgID)
	if err != nil {
		t.Fatal(err)
	}
	if bounds.MinRetainedSeq != second.CreatedSeq-1 {
		t.Fatalf("MinRetainedSeq = %d, want %d", bounds.MinRetainedSeq, second.CreatedSeq-1)
	}
}

func seedEventFixture(t *testing.T, pool *pgxpool.Pool) (identity.User, identity.User, identity.User, string) {
	t.Helper()
	orgID := testID(t)
	owner := identity.User{ActorID: testID(t), OrgID: orgID, OrgRole: "owner", Status: "active"}
	member := identity.User{ActorID: testID(t), OrgID: orgID, OrgRole: "member", Status: "active"}
	outsider := identity.User{ActorID: testID(t), OrgID: orgID, OrgRole: "member", Status: "active"}
	chatID := testID(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Test', 'event-test')`, orgID); err != nil {
		t.Fatal(err)
	}
	for index, actor := range []identity.User{owner, member, outsider} {
		if _, err := tx.Exec(ctx, `
			INSERT INTO actors (id, org_id, type, org_role, display_name, handle)
			VALUES ($1, $2, 'user', $3, $4, $5)`, actor.ActorID, orgID, actor.OrgRole, actor.OrgRole, "event_actor_"+string(rune('a'+index))); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO chats (id, org_id, kind, visibility, name, created_by)
		VALUES ($1, $2, 'group', 'private', 'Event test', $3)`, chatID, orgID, owner.ActorID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO chat_members (chat_id, actor_id, org_id, role)
		VALUES ($1, $2, $3, 'owner'), ($1, $4, $3, 'member')`, chatID, owner.ActorID, orgID, member.ActorID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return owner, member, outsider, chatID
}

func testID(t *testing.T) string {
	t.Helper()
	value, err := id.New()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
