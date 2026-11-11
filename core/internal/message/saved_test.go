package message

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSavedMessages(t *testing.T) {
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()

	post := func(t *testing.T, chatID, body string) Message {
		t.Helper()
		result, _, err := service.Create(ctx, fixture.owner, chatID, CreateInput{ClientMsgID: mustID(t), Body: body, BodyFormat: "plain"})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	listIDs := func(t *testing.T, user identity.User, chatID *string) []string {
		t.Helper()
		page, err := service.ListSaved(ctx, user, SavedListOptions{ChatID: chatID})
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]string, 0, len(page.Items))
		for _, item := range page.Items {
			ids = append(ids, item.Message.ID)
		}
		return ids
	}

	t.Run("any member saves once, idempotently, with a private event", func(t *testing.T) {
		target := post(t, fixture.groupID, "remember me")
		before := organizationSequence(t, pool, fixture.owner.OrgID)
		first, created, err := service.SaveMessage(ctx, fixture.member, target.ID)
		if err != nil || !created {
			t.Fatalf("SaveMessage() = %+v, %v, %v; want created", first, created, err)
		}
		again, created, err := service.SaveMessage(ctx, fixture.member, target.ID)
		if err != nil || created || !again.SavedAt.Equal(first.SavedAt) || again.ChatID != fixture.groupID {
			t.Fatalf("repeat SaveMessage() = %+v, %v, %v; want the existing save", again, created, err)
		}
		after := organizationSequence(t, pool, fixture.owner.OrgID)
		if after != before+1 {
			t.Fatalf("event sequence moved %d, want 1", after-before)
		}
		assertCount(t, pool, `SELECT count(*) FROM saved_messages WHERE actor_id = $1 AND message_id = $2`, 1, fixture.member.ActorID, target.ID)
		assertCount(t, pool, `SELECT count(*) FROM events WHERE seq = $1 AND type = 'message.saved' AND audience_actor_id = $2 AND chat_id IS NULL`, 1, after, fixture.member.ActorID)

		// Delivery to the saver's sessions only: saved_delivery_test.go
		// (eventlog imports this package, so it is tested from outside).

		if ids := listIDs(t, fixture.member, nil); len(ids) == 0 || ids[0] != target.ID {
			t.Fatalf("saver list = %v, want %s first", ids, target.ID)
		}
		ids, err := service.SavedIDs(ctx, fixture.member, fixture.groupID)
		if err != nil || len(ids) == 0 || ids[0] != target.ID {
			t.Fatalf("SavedIDs() = %v, %v", ids, err)
		}
	})

	t.Run("nobody else sees or can make another person's saves", func(t *testing.T) {
		target := post(t, fixture.groupID, "private")
		if _, _, err := service.SaveMessage(ctx, fixture.member, target.ID); err != nil {
			t.Fatal(err)
		}
		// The chat owner and a workspace moderator see none of it.
		for _, other := range []identity.User{fixture.owner, fixture.moderator} {
			for _, id := range listIDs(t, other, nil) {
				if id == target.ID {
					t.Fatalf("%s sees another person's save", other.OrgRole)
				}
			}
		}
		ownerIDs, err := service.SavedIDs(ctx, fixture.owner, fixture.groupID)
		if err != nil || len(ownerIDs) != 0 {
			t.Fatalf("owner SavedIDs() = %v, %v; want empty", ownerIDs, err)
		}
		// A moderator outside the chat can neither read the stars nor save.
		if _, err := service.SavedIDs(ctx, fixture.moderator, fixture.groupID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("outsider SavedIDs() error = %v, want ErrNotFound", err)
		}
		if _, _, err := service.SaveMessage(ctx, fixture.moderator, target.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("outsider SaveMessage() error = %v, want ErrNotFound", err)
		}
		// Unsaving someone else's save is impossible: it only touches one's own.
		if removed, err := service.UnsaveMessage(ctx, fixture.owner, target.ID); err != nil || removed {
			t.Fatalf("owner UnsaveMessage() = %v, %v; want nothing removed", removed, err)
		}
		assertCount(t, pool, `SELECT count(*) FROM saved_messages WHERE actor_id = $1 AND message_id = $2`, 1, fixture.member.ActorID, target.ID)
		// Unknown and deleted messages are not found.
		if _, _, err := service.SaveMessage(ctx, fixture.member, mustID(t)); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown SaveMessage() error = %v", err)
		}
		if _, _, err := service.SaveMessage(ctx, fixture.member, "nope"); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid SaveMessage() error = %v", err)
		}
	})

	t.Run("access loss hides saves, regaining it shows them, unsave still works", func(t *testing.T) {
		target := post(t, fixture.channelID, "channel news")
		if _, _, err := service.SaveMessage(ctx, fixture.member, target.ID); err != nil {
			t.Fatal(err)
		}
		channel := fixture.channelID
		if ids := listIDs(t, fixture.member, &channel); len(ids) != 1 {
			t.Fatalf("channel saves = %v", ids)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM chat_members WHERE chat_id = $1 AND actor_id = $2`, channel, fixture.member.ActorID); err != nil {
			t.Fatal(err)
		}
		if ids := listIDs(t, fixture.member, nil); contains(ids, target.ID) {
			t.Fatal("a save from a chat the person left is still listed")
		}
		if _, err := service.SavedIDs(ctx, fixture.member, channel); !errors.Is(err, ErrNotFound) {
			t.Fatalf("SavedIDs() after leaving error = %v", err)
		}
		if _, _, err := service.SaveMessage(ctx, fixture.member, target.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("SaveMessage() after leaving error = %v", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`, channel, fixture.member.ActorID, fixture.member.OrgID); err != nil {
			t.Fatal(err)
		}
		if ids := listIDs(t, fixture.member, &channel); !contains(ids, target.ID) {
			t.Fatal("the save did not come back with access")
		}
		// An archived chat hides its saves too.
		if _, err := pool.Exec(ctx, `UPDATE chats SET archived_at = now() WHERE id = $1`, channel); err != nil {
			t.Fatal(err)
		}
		if ids := listIDs(t, fixture.member, nil); contains(ids, target.ID) {
			t.Fatal("a save from an archived chat is still listed")
		}
		if removed, err := service.UnsaveMessage(ctx, fixture.member, target.ID); err != nil || !removed {
			t.Fatalf("UnsaveMessage() without access = %v, %v; want removed", removed, err)
		}
		if removed, err := service.UnsaveMessage(ctx, fixture.member, target.ID); err != nil || removed {
			t.Fatalf("repeat UnsaveMessage() = %v, %v; want idempotent", removed, err)
		}
		if _, err := pool.Exec(ctx, `UPDATE chats SET archived_at = NULL WHERE id = $1`, channel); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("deleting a message drops every save of it", func(t *testing.T) {
		target := post(t, fixture.groupID, "soon gone")
		for _, user := range []identity.User{fixture.member, fixture.owner} {
			if _, _, err := service.SaveMessage(ctx, user, target.ID); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := service.Delete(ctx, fixture.owner, target.ID); err != nil {
			t.Fatal(err)
		}
		assertCount(t, pool, `SELECT count(*) FROM saved_messages WHERE message_id = $1`, 0, target.ID)
		if _, _, err := service.SaveMessage(ctx, fixture.member, target.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("SaveMessage() of a deleted message error = %v", err)
		}
	})

	t.Run("pagination is newest save first", func(t *testing.T) {
		person := addMember(t, pool, fixture, fixture.groupID)
		var saved []string
		for range 3 {
			target := post(t, fixture.groupID, "page")
			if _, _, err := service.SaveMessage(ctx, person, target.ID); err != nil {
				t.Fatal(err)
			}
			saved = append(saved, target.ID)
		}
		first, err := service.ListSaved(ctx, person, SavedListOptions{Limit: 2})
		if err != nil || len(first.Items) != 2 || first.NextCursor == nil {
			t.Fatalf("first page = %+v, %v", first, err)
		}
		if first.Items[0].Message.ID != saved[2] || first.Items[1].Message.ID != saved[1] {
			t.Fatal("first page is not newest first")
		}
		if first.Items[0].Author.ActorID != fixture.owner.ActorID || first.Items[0].Chat.ID != fixture.groupID || first.Items[0].Chat.DisplayName != "group" {
			t.Fatalf("card data = %+v / %+v", first.Items[0].Author, first.Items[0].Chat)
		}
		// The cursor holds only the person's own save time and message id:
		// no shared counter that would reveal how much others save.
		decoded, err := decodeSavedCursor(*first.NextCursor)
		if err != nil || decoded.messageID != saved[1] || !decoded.savedAt.Equal(first.Items[1].SavedAt) {
			t.Fatalf("cursor = %+v, %v", decoded, err)
		}
		other := addMember(t, pool, fixture, fixture.groupID)
		for range 5 {
			if _, _, err := service.SaveMessage(ctx, other, post(t, fixture.groupID, "noise").ID); err != nil {
				t.Fatal(err)
			}
		}
		again, err := service.ListSaved(ctx, person, SavedListOptions{Limit: 2})
		if err != nil || *again.NextCursor != *first.NextCursor {
			t.Fatalf("cursor changed with someone else's saves: %v vs %v (%v)", again.NextCursor, first.NextCursor, err)
		}
		second, err := service.ListSaved(ctx, person, SavedListOptions{Limit: 2, Cursor: first.NextCursor})
		if err != nil || len(second.Items) != 1 || second.Items[0].Message.ID != saved[0] || second.NextCursor != nil {
			t.Fatalf("second page = %+v, %v", second, err)
		}
		bad := "not a cursor"
		if _, err := service.ListSaved(ctx, person, SavedListOptions{Cursor: &bad}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("bad cursor error = %v", err)
		}
		if _, err := service.ListSaved(ctx, person, SavedListOptions{Limit: 101}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("oversized limit error = %v", err)
		}
	})

	t.Run("limit counts readable saves only", func(t *testing.T) {
		limited := NewService(pool, 64*1024, 100, nil)
		limited.savedLimit = 2
		person := addMember(t, pool, fixture, fixture.groupID)
		if _, err := pool.Exec(ctx, `INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`, fixture.channelID, person.ActorID, person.OrgID); err != nil {
			t.Fatal(err)
		}
		hidden := post(t, fixture.channelID, "hidden later")
		first := post(t, fixture.groupID, "one")
		second := post(t, fixture.groupID, "two")
		for _, target := range []Message{hidden, first} {
			if _, _, err := limited.SaveMessage(ctx, person, target.ID); err != nil {
				t.Fatal(err)
			}
		}
		if _, _, err := limited.SaveMessage(ctx, person, second.ID); !errors.Is(err, ErrSavedLimit) {
			t.Fatalf("SaveMessage() over the limit error = %v", err)
		}
		// A repeat of an existing save is not blocked by the limit.
		if _, created, err := limited.SaveMessage(ctx, person, first.ID); err != nil || created {
			t.Fatalf("repeat at the limit = %v, %v", created, err)
		}
		// Losing access hides a save: it stops counting but is not deleted.
		if _, err := pool.Exec(ctx, `DELETE FROM chat_members WHERE chat_id = $1 AND actor_id = $2`, fixture.channelID, person.ActorID); err != nil {
			t.Fatal(err)
		}
		if _, created, err := limited.SaveMessage(ctx, person, second.ID); err != nil || !created {
			t.Fatalf("SaveMessage() after access loss = %v, %v; want room from the hidden save", created, err)
		}
		assertCount(t, pool, `SELECT count(*) FROM saved_messages WHERE actor_id = $1`, 3, person.ActorID)
		// Access comes back: so does the hidden save, nothing was lost. The
		// person is now over the limit and must remove something first.
		if _, err := pool.Exec(ctx, `INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`, fixture.channelID, person.ActorID, person.OrgID); err != nil {
			t.Fatal(err)
		}
		channel := fixture.channelID
		page, err := limited.ListSaved(ctx, person, SavedListOptions{ChatID: &channel})
		if err != nil || len(page.Items) != 1 || page.Items[0].Message.ID != hidden.ID {
			t.Fatalf("hidden save after access returned = %+v, %v", page, err)
		}
		third := post(t, fixture.groupID, "three")
		if _, _, err := limited.SaveMessage(ctx, person, third.ID); !errors.Is(err, ErrSavedLimit) {
			t.Fatalf("SaveMessage() over the limit error = %v", err)
		}
		assertCount(t, pool, `SELECT count(*) FROM saved_messages WHERE actor_id = $1`, 3, person.ActorID)
	})

	t.Run("unsaving nothing takes no organization lock and no event", func(t *testing.T) {
		before := organizationSequence(t, pool, fixture.owner.OrgID)
		// Hold the organization row as a busy writer would.
		holder, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer holder.Rollback(ctx)
		if _, err := holder.Exec(ctx, `SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, fixture.owner.OrgID); err != nil {
			t.Fatal(err)
		}
		quick, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if removed, err := service.UnsaveMessage(quick, fixture.member, mustID(t)); err != nil || removed {
			t.Fatalf("UnsaveMessage() of nothing = %v, %v; want a quick no-op", removed, err)
		}
		if err := holder.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		if after := organizationSequence(t, pool, fixture.owner.OrgID); after != before {
			t.Fatalf("event sequence moved %d", after-before)
		}
	})

	t.Run("chat filters count every readable save, not loaded pages", func(t *testing.T) {
		person := addMember(t, pool, fixture, fixture.groupID)
		if _, err := pool.Exec(ctx, `INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`, fixture.channelID, person.ActorID, person.OrgID); err != nil {
			t.Fatal(err)
		}
		old := post(t, fixture.channelID, "old")
		if _, _, err := service.SaveMessage(ctx, person, old.ID); err != nil {
			t.Fatal(err)
		}
		for range 3 {
			if _, _, err := service.SaveMessage(ctx, person, post(t, fixture.groupID, "new").ID); err != nil {
				t.Fatal(err)
			}
		}
		page, err := service.ListSaved(ctx, person, SavedListOptions{Limit: 2})
		if err != nil || len(page.Items) != 2 || page.Items[0].Chat.ID != fixture.groupID || page.Items[1].Chat.ID != fixture.groupID {
			t.Fatalf("first page = %+v, %v", page, err)
		}
		chats, err := service.SavedChats(ctx, person)
		if err != nil || len(chats) != 2 || chats[0].Chat.ID != fixture.groupID || chats[0].Count != 3 ||
			chats[1].Chat.ID != fixture.channelID || chats[1].Count != 1 {
			t.Fatalf("SavedChats() = %+v, %v", chats, err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM chat_members WHERE chat_id = $1 AND actor_id = $2`, fixture.channelID, person.ActorID); err != nil {
			t.Fatal(err)
		}
		chats, err = service.SavedChats(ctx, person)
		if err != nil || len(chats) != 1 {
			t.Fatalf("SavedChats() after access loss = %+v, %v", chats, err)
		}
		others, err := service.SavedChats(ctx, fixture.owner)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range others {
			if entry.Chat.ID == fixture.channelID {
				t.Fatal("another person's saves are counted")
			}
		}
	})

	t.Run("rows go with the chat, the message and the person", func(t *testing.T) {
		person := addMember(t, pool, fixture, fixture.groupID)
		target := post(t, fixture.groupID, "cascade")
		if _, _, err := service.SaveMessage(ctx, person, target.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM messages WHERE id = $1`, target.ID); err != nil {
			t.Fatal(err)
		}
		assertCount(t, pool, `SELECT count(*) FROM saved_messages WHERE actor_id = $1`, 0, person.ActorID)
		// Every foreign key of the table cascades: person, message and chat.
		assertCount(t, pool, `
			SELECT count(*) FROM pg_constraint
			WHERE conrelid = 'saved_messages'::regclass AND contype = 'f' AND confdeltype = 'c'`, 3)
		// Messages and events keep chats and people from hard deletion, so
		// in practice rows leave through the message (above) or the
		// organization; the constraint check covers the rest.
	})
}

func addMember(t *testing.T, pool *pgxpool.Pool, fixture fixture, chatID string) identity.User {
	t.Helper()
	user := identity.User{ActorID: mustID(t), OrgID: fixture.owner.OrgID, OrgRole: "member", Status: "active"}
	handle := "p" + user.ActorID[len(user.ActorID)-12:]
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO actors (id, org_id, type, org_role, display_name, handle) VALUES ($1, $2, 'user', 'member', $3, $4)`,
		user.ActorID, user.OrgID, handle, handle); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`,
		chatID, user.ActorID, user.OrgID); err != nil {
		t.Fatal(err)
	}
	return user
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// Lock order of saves against message deletion: every path takes the
// organization row before the message and the save rows, as Delete does.
// The reversed order of UnsaveMessage deadlocked (40P01) under load.
func TestSavedLockOrder(t *testing.T) {
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	post := func(t *testing.T) Message {
		t.Helper()
		result, _, err := service.Create(ctx, fixture.owner, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: "x", BodyFormat: "plain"})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	const rounds = 40

	t.Run("unsave races delete without deadlock", func(t *testing.T) {
		for round := range rounds {
			target := post(t)
			if _, _, err := service.SaveMessage(ctx, fixture.member, target.ID); err != nil {
				t.Fatal(err)
			}
			var wait sync.WaitGroup
			var unsaveErr, deleteErr error
			wait.Add(2)
			go func() { defer wait.Done(); _, unsaveErr = service.UnsaveMessage(ctx, fixture.member, target.ID) }()
			go func() { defer wait.Done(); _, deleteErr = service.Delete(ctx, fixture.owner, target.ID) }()
			wait.Wait()
			if unsaveErr != nil || deleteErr != nil {
				t.Fatalf("round %d: unsave=%v delete=%v", round, unsaveErr, deleteErr)
			}
			assertCount(t, pool, `SELECT count(*) FROM saved_messages WHERE message_id = $1`, 0, target.ID)
		}
	})

	t.Run("save races delete without deadlock", func(t *testing.T) {
		for round := range rounds {
			target := post(t)
			var wait sync.WaitGroup
			var saveErr, deleteErr error
			wait.Add(2)
			go func() { defer wait.Done(); _, _, saveErr = service.SaveMessage(ctx, fixture.member, target.ID) }()
			go func() { defer wait.Done(); _, deleteErr = service.Delete(ctx, fixture.owner, target.ID) }()
			wait.Wait()
			// Saving a message deleted first is «not found», never an error.
			if (saveErr != nil && !errors.Is(saveErr, ErrNotFound)) || deleteErr != nil {
				t.Fatalf("round %d: save=%v delete=%v", round, saveErr, deleteErr)
			}
			// Whichever won, a deleted message keeps no save.
			assertCount(t, pool, `SELECT count(*) FROM saved_messages WHERE message_id = $1`, 0, target.ID)
		}
	})

	t.Run("saving while writing in the same chat does not deadlock", func(t *testing.T) {
		for round := range rounds {
			target := post(t)
			var wait sync.WaitGroup
			var saveErr, createErr error
			wait.Add(2)
			go func() { defer wait.Done(); _, _, saveErr = service.SaveMessage(ctx, fixture.member, target.ID) }()
			go func() {
				defer wait.Done()
				_, _, createErr = service.Create(ctx, fixture.member, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: "y", BodyFormat: "plain"})
			}()
			wait.Wait()
			if saveErr != nil || createErr != nil {
				t.Fatalf("round %d: save=%v create=%v", round, saveErr, createErr)
			}
		}
	})

	t.Run("parallel saves of one person respect the limit exactly", func(t *testing.T) {
		limited := NewService(pool, 64*1024, 100, nil)
		limited.savedLimit = 5
		person := addMember(t, pool, fixture, fixture.groupID)
		var wait sync.WaitGroup
		var mutex sync.Mutex
		saved, refused := 0, 0
		for range 20 {
			target := post(t)
			wait.Add(1)
			go func() {
				defer wait.Done()
				_, _, err := limited.SaveMessage(ctx, person, target.ID)
				mutex.Lock()
				defer mutex.Unlock()
				switch {
				case err == nil:
					saved++
				case errors.Is(err, ErrSavedLimit):
					refused++
				default:
					t.Errorf("SaveMessage() error = %v", err)
				}
			}()
		}
		wait.Wait()
		if saved != 5 || refused != 15 {
			t.Fatalf("saved=%d refused=%d, want 5 and 15", saved, refused)
		}
	})
}

func TestSavedRowsCap(t *testing.T) {
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	service.savedLimit = 2
	ctx := context.Background()
	person := addMember(t, pool, fixture, fixture.groupID)
	// A fresh group with the owner and the person in it.
	newChat := func() string {
		t.Helper()
		chatID := mustID(t)
		if _, err := pool.Exec(ctx, `
			WITH chat AS (
				INSERT INTO chats (id, org_id, kind, visibility, name, created_by) VALUES ($1, $2, 'group', 'private', 'cap', $3)
				RETURNING id, org_id
			)
			INSERT INTO chat_members (chat_id, actor_id, org_id, role)
			SELECT chat.id, $3, chat.org_id, 'owner' FROM chat UNION ALL SELECT chat.id, $4, chat.org_id, 'member' FROM chat`,
			chatID, fixture.owner.OrgID, fixture.owner.ActorID, person.ActorID); err != nil {
			t.Fatal(err)
		}
		return chatID
	}
	saveIn := func(chatID string) error {
		t.Helper()
		target, _, err := service.Create(ctx, fixture.owner, chatID, CreateInput{ClientMsgID: mustID(t), Body: "x", BodyFormat: "plain"})
		if err != nil {
			t.Fatal(err)
		}
		_, _, err = service.SaveMessage(ctx, person, target.ID)
		return err
	}
	// Three times: fill the limit in a chat, then lose access to it. The
	// saves stay (hidden) and stop counting against the limit of 2.
	var hidden []string
	for range 3 {
		chatID := newChat()
		for range 2 {
			if err := saveIn(chatID); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := pool.Exec(ctx, `DELETE FROM chat_members WHERE chat_id = $1 AND actor_id = $2`, chatID, person.ActorID); err != nil {
			t.Fatal(err)
		}
		hidden = append(hidden, chatID)
	}
	assertCount(t, pool, `SELECT count(*) FROM saved_messages WHERE actor_id = $1`, 6, person.ActorID)
	// Six rows = 3 × limit: even with no readable saves, no more rows.
	last := newChat()
	if err := saveIn(last); !errors.Is(err, ErrSavedStorageFull) {
		t.Fatalf("SaveMessage() over the row cap error = %v, want ErrSavedStorageFull", err)
	}
	// Removing one hidden save (allowed without access) makes room again.
	var hiddenMessage string
	if err := pool.QueryRow(ctx, `SELECT message_id FROM saved_messages WHERE actor_id = $1 AND chat_id = $2 LIMIT 1`, person.ActorID, hidden[0]).Scan(&hiddenMessage); err != nil {
		t.Fatal(err)
	}
	if removed, err := service.UnsaveMessage(ctx, person, hiddenMessage); err != nil || !removed {
		t.Fatalf("UnsaveMessage() of a hidden save = %v, %v", removed, err)
	}
	if err := saveIn(last); err != nil {
		t.Fatalf("SaveMessage() after making room = %v", err)
	}
}
