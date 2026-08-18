package message

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/database"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestValidation(t *testing.T) {
	service := NewService(nil, 8, 100)
	body := "123456789"
	format := "plain"
	if err := service.validateBody(&body, &format); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("validateBody() error = %v, want ErrTooLarge", err)
	}
	body = "   "
	if err := service.validateBody(&body, &format); !errors.Is(err, ErrInvalid) {
		t.Fatalf("validateBody() error = %v, want ErrInvalid", err)
	}
}

func TestMessageCoreIntegration(t *testing.T) {
	pool := temporaryDatabase(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100)
	ctx := context.Background()

	t.Run("concurrent idempotent create has one write and one event", func(t *testing.T) {
		clientID := mustID(t)
		input := CreateInput{ClientMsgID: clientID, Body: "hello", BodyFormat: "plain"}
		const workers = 100
		type outcome struct {
			message Message
			created bool
			err     error
		}
		outcomes := make(chan outcome, workers)
		var wait sync.WaitGroup
		for range workers {
			wait.Add(1)
			go func() {
				defer wait.Done()
				result, created, err := service.Create(ctx, fixture.member, fixture.groupID, input)
				outcomes <- outcome{result, created, err}
			}()
		}
		wait.Wait()
		close(outcomes)

		var first Message
		createdCount := 0
		for result := range outcomes {
			if result.err != nil {
				t.Fatalf("Create() error = %v", result.err)
			}
			if first.ID == "" {
				first = result.message
			}
			if result.message.ID != first.ID || result.message.CreatedSeq != first.CreatedSeq {
				t.Fatalf("idempotent results differ: first=%+v current=%+v", first, result.message)
			}
			if result.created {
				createdCount++
			}
		}
		if createdCount != 1 {
			t.Fatalf("created responses = %d, want 1", createdCount)
		}
		assertCount(t, pool, `SELECT count(*) FROM messages WHERE actor_id = $1 AND client_msg_id = $2`, 1, fixture.member.ActorID, clientID)
		assertCount(t, pool, `SELECT count(*) FROM events WHERE subject_id = $1`, 1, first.ID)
		var eventSeq int64
		if err := pool.QueryRow(ctx, `SELECT seq FROM events WHERE subject_id = $1`, first.ID).Scan(&eventSeq); err != nil {
			t.Fatal(err)
		}
		if eventSeq != first.CreatedSeq {
			t.Fatalf("message created_seq = %d, event seq = %d", first.CreatedSeq, eventSeq)
		}

		_, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{
			ClientMsgID: clientID, Body: "different", BodyFormat: "plain",
		})
		if !errors.Is(err, ErrIdempotencyConflict) {
			t.Fatalf("conflicting Create() error = %v, want ErrIdempotencyConflict", err)
		}

		updated, err := service.Update(ctx, fixture.member, first.ID, UpdateInput{
			Body: "hello, edited", BodyFormat: "markdown", ExpectedVersion: 1,
		})
		if err != nil {
			t.Fatalf("Update() error = %v", err)
		}
		if updated.Version != 2 || updated.EditedAt == nil {
			t.Fatalf("updated message = %+v", updated)
		}
		if _, err := service.Update(ctx, fixture.member, first.ID, UpdateInput{
			Body: "stale", BodyFormat: "plain", ExpectedVersion: 1,
		}); !errors.Is(err, ErrVersionConflict) {
			t.Fatalf("stale Update() error = %v, want ErrVersionConflict", err)
		}
		assertCount(t, pool, `SELECT count(*) FROM message_revisions WHERE message_id = $1`, 1, first.ID)

		replayed, created, err := service.Create(ctx, fixture.member, fixture.groupID, input)
		if err != nil || created || replayed.Version != 2 || replayed.Body != "hello, edited" {
			t.Fatalf("Create() after edit = %+v, %v, %v", replayed, created, err)
		}

		deleted, err := service.Delete(ctx, fixture.owner, first.ID)
		if err != nil {
			t.Fatalf("moderator Delete() error = %v", err)
		}
		if deleted.DeletedAt == nil || deleted.Body != "" || deleted.Version != 3 {
			t.Fatalf("deleted message = %+v", deleted)
		}
		replayedDelete, err := service.Delete(ctx, fixture.owner, first.ID)
		if err != nil || replayedDelete.Version != deleted.Version {
			t.Fatalf("replayed Delete() = %+v, %v", replayedDelete, err)
		}
		assertCount(t, pool, `SELECT count(*) FROM events WHERE subject_id = $1`, 3, first.ID)
	})

	t.Run("channel is read only for members and rollback does not consume sequence", func(t *testing.T) {
		before := organizationSequence(t, pool, fixture.owner.OrgID)
		_, _, err := service.Create(ctx, fixture.member, fixture.channelID, CreateInput{
			ClientMsgID: mustID(t), Body: "not allowed", BodyFormat: "plain",
		})
		if !errors.Is(err, ErrForbidden) {
			t.Fatalf("member channel Create() error = %v, want ErrForbidden", err)
		}
		if after := organizationSequence(t, pool, fixture.owner.OrgID); after != before {
			t.Fatalf("event_seq = %d after rejected command, want %d", after, before)
		}
		if _, created, err := service.Create(ctx, fixture.owner, fixture.channelID, CreateInput{
			ClientMsgID: mustID(t), Body: "announcement", BodyFormat: "plain",
		}); err != nil || !created {
			t.Fatalf("owner channel Create() created=%v error=%v", created, err)
		}
	})

	t.Run("event is invisible before commit and rollback restores sequence", func(t *testing.T) {
		before := organizationSequence(t, pool, fixture.owner.OrgID)
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := lockOrganization(ctx, tx, fixture.owner.OrgID); err != nil {
			t.Fatal(err)
		}
		seq, err := nextSequence(ctx, tx, fixture.owner.OrgID)
		if err != nil {
			t.Fatal(err)
		}
		subjectID := mustID(t)
		if err := insertEvent(ctx, tx, fixture.owner, fixture.groupID, subjectID, seq, "message.created"); err != nil {
			t.Fatal(err)
		}
		assertCount(t, pool, `SELECT count(*) FROM events WHERE subject_id = $1`, 0, subjectID)
		if err := tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		if after := organizationSequence(t, pool, fixture.owner.OrgID); after != before {
			t.Fatalf("event_seq = %d after rollback, want %d", after, before)
		}
	})

	t.Run("main feed and thread pagination are separate", func(t *testing.T) {
		root, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{
			ClientMsgID: mustID(t), Body: "root", BodyFormat: "plain",
		})
		if err != nil {
			t.Fatalf("create root: %v", err)
		}
		replyID := root.ID
		reply, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{
			ClientMsgID: mustID(t), Body: "thread reply", BodyFormat: "plain",
			ReplyToID: &replyID, ThreadRootID: &root.ID,
		})
		if err != nil {
			t.Fatalf("create thread reply: %v", err)
		}
		mainPage, err := service.List(ctx, fixture.member, fixture.groupID, ListOptions{Limit: 100})
		if err != nil {
			t.Fatalf("list main feed: %v", err)
		}
		for _, item := range mainPage.Messages {
			if item.ID == reply.ID {
				t.Fatal("thread reply leaked into main feed")
			}
		}
		threadPage, err := service.List(ctx, fixture.member, fixture.groupID, ListOptions{Limit: 1, ThreadRootID: &root.ID})
		if err != nil {
			t.Fatalf("list thread: %v", err)
		}
		if len(threadPage.Messages) != 1 || threadPage.Messages[0].ID != reply.ID {
			t.Fatalf("thread page = %+v", threadPage)
		}
	})
}

type fixture struct {
	owner     identity.User
	member    identity.User
	groupID   string
	channelID string
}

func seedFixture(t *testing.T, pool *pgxpool.Pool) fixture {
	t.Helper()
	result := fixture{
		owner:   identity.User{ActorID: mustID(t), OrgID: mustID(t), OrgRole: "owner", Status: "active"},
		member:  identity.User{ActorID: mustID(t), OrgRole: "member", Status: "active"},
		groupID: mustID(t), channelID: mustID(t),
	}
	result.member.OrgID = result.owner.OrgID
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(context.Background(), `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Test', 'test')`, result.owner.OrgID); err != nil {
		t.Fatal(err)
	}
	for _, actor := range []identity.User{result.owner, result.member} {
		if _, err := tx.Exec(context.Background(), `
			INSERT INTO actors (id, org_id, type, org_role, display_name, handle)
			VALUES ($1, $2, 'user', $3, $4, $5)`, actor.ActorID, actor.OrgID, actor.OrgRole,
			actor.OrgRole, actor.OrgRole); err != nil {
			t.Fatal(err)
		}
	}
	for _, chat := range []struct{ id, kind string }{{result.groupID, "group"}, {result.channelID, "channel"}} {
		if _, err := tx.Exec(context.Background(), `
			INSERT INTO chats (id, org_id, kind, visibility, name, created_by)
			VALUES ($1, $2, $3, 'private', $4, $5)`, chat.id, result.owner.OrgID, chat.kind, chat.kind, result.owner.ActorID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(context.Background(), `
			INSERT INTO chat_members (chat_id, actor_id, org_id, role)
			VALUES ($1, $2, $3, 'owner'), ($1, $4, $3, 'member')`, chat.id, result.owner.ActorID,
			result.owner.OrgID, result.member.ActorID); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	return result
}

func temporaryDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	rawURL := os.Getenv("TEST_DATABASE_URL")
	if rawURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, rawURL)
	if err != nil {
		t.Fatalf("connect to test database server: %v", err)
	}
	databaseName := fmt.Sprintf("coma_message_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		admin.Close(ctx)
		t.Fatalf("create temporary database: %v", err)
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + databaseName
	testURL := parsed.String()
	if err := database.Migrate(ctx, testURL); err != nil {
		admin.Exec(ctx, `DROP DATABASE `+databaseName+` WITH (FORCE)`)
		admin.Close(ctx)
		t.Fatalf("migrate temporary database: %v", err)
	}
	pool, err := database.NewPool(ctx, testURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupCtx, `DROP DATABASE `+databaseName+` WITH (FORCE)`); err != nil {
			t.Errorf("drop temporary database: %v", err)
		}
		admin.Close(cleanupCtx)
	})
	return pool
}

func mustID(t *testing.T) string {
	t.Helper()
	value, err := id.New()
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func assertCount(t *testing.T, pool *pgxpool.Pool, query string, want int, args ...any) {
	t.Helper()
	var got int
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("count = %d, want %d", got, want)
	}
}

func organizationSequence(t *testing.T, pool *pgxpool.Pool, orgID string) int64 {
	t.Helper()
	var result int64
	if err := pool.QueryRow(context.Background(), `SELECT event_seq FROM organizations WHERE id = $1`, orgID).Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}
