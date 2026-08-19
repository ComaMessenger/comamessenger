package message

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestValidation(t *testing.T) {
	service := NewService(nil, 8, 100, nil)
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
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()

	t.Run("concurrent idempotent create has one write and one event", func(t *testing.T) {
		clientID := mustID(t)
		input := CreateInput{
			ClientMsgID:       clientID,
			Body:              "hello",
			BodyFormat:        "plain",
			MentionedActorIDs: []string{fixture.owner.ActorID},
		}
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

		emptyMentions := []string{}
		updated, err := service.Update(ctx, fixture.member, first.ID, UpdateInput{
			Body: "hello, edited", BodyFormat: "markdown", ExpectedVersion: 1,
			MentionedActorIDs: &emptyMentions,
		})
		if err != nil {
			t.Fatalf("Update() error = %v", err)
		}
		if updated.Version != 2 || updated.EditedAt == nil || len(updated.MentionedActorIDs) != 0 {
			t.Fatalf("updated message = %+v", updated)
		}
		if _, err := service.Update(ctx, fixture.member, first.ID, UpdateInput{
			Body: "stale", BodyFormat: "plain", ExpectedVersion: 1,
		}); !errors.Is(err, ErrVersionConflict) {
			t.Fatalf("stale Update() error = %v, want ErrVersionConflict", err)
		}
		assertCount(t, pool, `SELECT count(*) FROM message_revisions WHERE message_id = $1`, 1, first.ID)
		var revisionMentions []string
		if err := pool.QueryRow(ctx, `SELECT mentioned_actor_ids FROM message_revisions WHERE message_id = $1`, first.ID).Scan(&revisionMentions); err != nil {
			t.Fatal(err)
		}
		if len(revisionMentions) != 1 || revisionMentions[0] != fixture.owner.ActorID {
			t.Fatalf("revision mentioned_actor_ids = %v, want original mention", revisionMentions)
		}

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
			if item.ID == root.ID && item.ThreadReplyCount != 1 {
				t.Fatalf("root thread_reply_count = %d, want 1", item.ThreadReplyCount)
			}
		}
		threadPage, err := service.List(ctx, fixture.member, fixture.groupID, ListOptions{Limit: 1, ThreadRootID: &root.ID})
		if err != nil {
			t.Fatalf("list thread: %v", err)
		}
		if len(threadPage.Messages) != 1 || threadPage.Messages[0].ID != reply.ID {
			t.Fatalf("thread page = %+v", threadPage)
		}
		if _, err := service.Delete(ctx, fixture.member, reply.ID); err != nil {
			t.Fatalf("delete thread reply: %v", err)
		}
		mainPage, err = service.List(ctx, fixture.member, fixture.groupID, ListOptions{Limit: 100})
		if err != nil {
			t.Fatalf("list main feed after reply deletion: %v", err)
		}
		for _, item := range mainPage.Messages {
			if item.ID == root.ID && item.ThreadReplyCount != 0 {
				t.Fatalf("root thread_reply_count after deletion = %d, want 0", item.ThreadReplyCount)
			}
		}
	})

	t.Run("thread replies auto-follow root author and replier", func(t *testing.T) {
		root, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{
			ClientMsgID: mustID(t), Body: "followed root", BodyFormat: "plain",
		})
		if err != nil {
			t.Fatal(err)
		}
		replyTo := root.ID
		if _, _, err := service.Create(ctx, fixture.owner, fixture.groupID, CreateInput{
			ClientMsgID: mustID(t), Body: "owner reply", BodyFormat: "plain",
			ReplyToID: &replyTo, ThreadRootID: &root.ID,
		}); err != nil {
			t.Fatal(err)
		}
		assertCount(t, pool, `SELECT count(*) FROM thread_followers WHERE thread_root_id = $1`, 2, root.ID)
		assertCount(t, pool, `SELECT count(*) FROM events WHERE subject_id = $1 AND type = 'thread.followed'`, 2, root.ID)

		page, err := service.ListFollowedThreads(ctx, fixture.owner, nil, 50)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, thread := range page.Threads {
			if thread.Root.ID == root.ID {
				found = true
				if thread.ReplyCount != 1 || thread.LastReplySeq == nil {
					t.Fatalf("thread summary = %+v", thread)
				}
			}
		}
		if !found {
			t.Fatal("auto-followed thread is absent from followed list")
		}
		if removed, err := service.UnfollowThread(ctx, fixture.owner, root.ID); err != nil || !removed {
			t.Fatalf("UnfollowThread() removed=%v error=%v", removed, err)
		}
		if removed, err := service.UnfollowThread(ctx, fixture.owner, root.ID); err != nil || removed {
			t.Fatalf("idempotent UnfollowThread() removed=%v error=%v", removed, err)
		}
		if _, created, err := service.FollowThread(ctx, fixture.owner, root.ID); err != nil || !created {
			t.Fatalf("FollowThread() created=%v error=%v", created, err)
		}
		if _, created, err := service.FollowThread(ctx, fixture.owner, root.ID); err != nil || created {
			t.Fatalf("idempotent FollowThread() created=%v error=%v", created, err)
		}
	})

	t.Run("concurrent reaction is one row and one durable event", func(t *testing.T) {
		item, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{
			ClientMsgID: mustID(t), Body: "react here", BodyFormat: "plain",
		})
		if err != nil {
			t.Fatal(err)
		}
		const workers = 50
		results := make(chan error, workers)
		var wait sync.WaitGroup
		for range workers {
			wait.Add(1)
			go func() {
				defer wait.Done()
				_, _, err := service.PutReaction(ctx, fixture.member, item.ID, "👍")
				results <- err
			}()
		}
		wait.Wait()
		close(results)
		for err := range results {
			if err != nil {
				t.Fatalf("PutReaction() error = %v", err)
			}
		}
		assertCount(t, pool, `SELECT count(*) FROM reactions WHERE message_id = $1 AND emoji = '👍'`, 1, item.ID)
		assertCount(t, pool, `SELECT count(*) FROM events WHERE subject_id = $1 AND type = 'reaction.added'`, 1, item.ID)
		reactions, err := service.ListReactions(ctx, fixture.owner, item.ID)
		if err != nil || len(reactions) != 1 || reactions[0].Emoji != "👍" {
			t.Fatalf("ListReactions() reactions=%+v error=%v", reactions, err)
		}
		if removed, err := service.DeleteReaction(ctx, fixture.member, item.ID, "👍"); err != nil || !removed {
			t.Fatalf("DeleteReaction() removed=%v error=%v", removed, err)
		}
		if removed, err := service.DeleteReaction(ctx, fixture.member, item.ID, "👍"); err != nil || removed {
			t.Fatalf("idempotent DeleteReaction() removed=%v error=%v", removed, err)
		}
		var emoji string
		if err := pool.QueryRow(ctx, `SELECT data->>'emoji' FROM events WHERE subject_id = $1 AND type = 'reaction.removed'`, item.ID).Scan(&emoji); err != nil {
			t.Fatal(err)
		}
		if emoji != "👍" {
			t.Fatalf("reaction removal payload emoji = %q", emoji)
		}
	})

	t.Run("message receipts derive from read markers and exclude the author", func(t *testing.T) {
		item, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{
			ClientMsgID: mustID(t), Body: "read this", BodyFormat: "plain",
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO chat_reads (org_id, chat_id, actor_id, last_read_seq)
			VALUES ($1, $2, $3, $4), ($1, $2, $5, $4)
			ON CONFLICT (chat_id, actor_id) DO UPDATE
			SET last_read_seq = EXCLUDED.last_read_seq, last_read_at = now()`,
			fixture.owner.OrgID, fixture.groupID, fixture.owner.ActorID, item.CreatedSeq, fixture.member.ActorID); err != nil {
			t.Fatal(err)
		}
		receipts, err := service.ListReceipts(ctx, fixture.member, item.ID)
		if err != nil || len(receipts) != 1 || receipts[0].ActorID != fixture.owner.ActorID {
			t.Fatalf("ListReceipts() receipts=%+v error=%v", receipts, err)
		}

		root, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{
			ClientMsgID: mustID(t), Body: "receipt thread", BodyFormat: "plain",
		})
		if err != nil {
			t.Fatal(err)
		}
		reply, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{
			ClientMsgID: mustID(t), Body: "thread receipt", BodyFormat: "plain",
			ReplyToID: &root.ID, ThreadRootID: &root.ID,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO thread_reads (org_id, thread_root_id, actor_id, last_read_seq)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (thread_root_id, actor_id) DO UPDATE
			SET last_read_seq = EXCLUDED.last_read_seq, last_read_at = now()`,
			fixture.owner.OrgID, root.ID, fixture.owner.ActorID, reply.CreatedSeq); err != nil {
			t.Fatal(err)
		}
		receipts, err = service.ListReceipts(ctx, fixture.member, reply.ID)
		if err != nil || len(receipts) != 1 || receipts[0].ActorID != fixture.owner.ActorID {
			t.Fatalf("ListReceipts(thread) receipts=%+v error=%v", receipts, err)
		}
	})

	t.Run("pins require chat management and remain idempotent", func(t *testing.T) {
		item, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{
			ClientMsgID: mustID(t), Body: "pin me", BodyFormat: "plain",
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := service.PutPin(ctx, fixture.member, item.ID); !errors.Is(err, ErrForbidden) {
			t.Fatalf("member PutPin() error = %v, want ErrForbidden", err)
		}
		pin, created, err := service.PutPin(ctx, fixture.owner, item.ID)
		if err != nil || !created || pin.PinnedBy != fixture.owner.ActorID {
			t.Fatalf("PutPin() pin=%+v created=%v error=%v", pin, created, err)
		}
		if replay, created, err := service.PutPin(ctx, fixture.owner, item.ID); err != nil || created || replay.PinnedAt != pin.PinnedAt {
			t.Fatalf("idempotent PutPin() pin=%+v created=%v error=%v", replay, created, err)
		}
		pins, err := service.ListPins(ctx, fixture.member, fixture.groupID)
		if err != nil || len(pins) != 1 || pins[0].MessageID != item.ID {
			t.Fatalf("ListPins() pins=%+v error=%v", pins, err)
		}
		if removed, err := service.DeletePin(ctx, fixture.owner, item.ID); err != nil || !removed {
			t.Fatalf("DeletePin() removed=%v error=%v", removed, err)
		}
		if removed, err := service.DeletePin(ctx, fixture.owner, item.ID); err != nil || removed {
			t.Fatalf("idempotent DeletePin() removed=%v error=%v", removed, err)
		}
	})

	t.Run("forward is an immutable idempotent snapshot", func(t *testing.T) {
		source, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{
			ClientMsgID: mustID(t), Body: "original snapshot", BodyFormat: "markdown",
		})
		if err != nil {
			t.Fatal(err)
		}
		clientID := mustID(t)
		forwarded, created, err := service.Forward(ctx, fixture.owner, source.ID, ForwardInput{ChatID: fixture.groupID, ClientMsgID: clientID})
		if err != nil || !created {
			t.Fatalf("Forward() created=%v error=%v", created, err)
		}
		if forwarded.Body != source.Body || forwarded.ForwardedFrom == nil || forwarded.ForwardedFrom.AuthorHandle != fixture.member.OrgRole {
			t.Fatalf("forwarded message = %+v", forwarded)
		}
		if _, err := service.Update(ctx, fixture.member, source.ID, UpdateInput{Body: "changed later", BodyFormat: "plain", ExpectedVersion: 1}); err != nil {
			t.Fatal(err)
		}
		replayed, created, err := service.Forward(ctx, fixture.owner, source.ID, ForwardInput{ChatID: fixture.groupID, ClientMsgID: clientID})
		if err != nil || created || replayed.ID != forwarded.ID || replayed.Body != "original snapshot" {
			t.Fatalf("idempotent Forward() message=%+v created=%v error=%v", replayed, created, err)
		}
		if _, err := service.Delete(ctx, fixture.member, source.ID); err != nil {
			t.Fatal(err)
		}
		replayed, created, err = service.Forward(ctx, fixture.owner, source.ID, ForwardInput{ChatID: fixture.groupID, ClientMsgID: clientID})
		if err != nil || created || replayed.ID != forwarded.ID {
			t.Fatalf("Forward() replay after source deletion message=%+v created=%v error=%v", replayed, created, err)
		}
		if _, _, err := service.Forward(ctx, fixture.member, source.ID, ForwardInput{ChatID: fixture.channelID, ClientMsgID: mustID(t)}); !errors.Is(err, ErrForbidden) {
			t.Fatalf("member forward to channel error = %v, want ErrForbidden", err)
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
