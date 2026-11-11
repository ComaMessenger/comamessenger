package eventlog

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

// Message frames carry the REST feed's shape: files, thread_reply_count,
// and on a thread reply the root's current count.
func TestMessageFramesCarryTheFeedShape(t *testing.T) {
	pool := testdb.New(t)
	owner, member, outsider, chatID := seedEventFixture(t, pool)
	service := message.NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	store := NewStore(pool)

	fileID := testID(t)
	if _, err := pool.Exec(ctx, `
		INSERT INTO files (id, org_id, uploader_id, storage_driver, storage_key, name, mime, size, status, processing_status, ready_at)
		VALUES ($1, $2, $3, 'local', $4, 'photo.jpg', 'image/jpeg', 2048, 'ready', 'pending', now())`,
		fileID, member.OrgID, member.ActorID, "objects/test/"+fileID); err != nil {
		t.Fatal(err)
	}
	root, _, err := service.Create(ctx, member, chatID, message.CreateInput{
		ClientMsgID: testID(t), Body: "look", BodyFormat: "plain", FileIDs: []string{fileID},
	})
	if err != nil {
		t.Fatal(err)
	}
	reply, _, err := service.Create(ctx, owner, chatID, message.CreateInput{
		ClientMsgID: testID(t), Body: "nice", BodyFormat: "plain", ThreadRootID: &root.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	current, err := store.Current(ctx, owner.OrgID)
	if err != nil {
		t.Fatal(err)
	}

	live, err := store.Live(ctx, owner.OrgID, 0, current, 100)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := store.Replay(ctx, owner, "", 0, current, 100)
	if err != nil {
		t.Fatal(err)
	}
	liveBySeq := map[int64]LiveEvent{}
	for _, item := range live {
		liveBySeq[item.Frame.Seq] = item
	}
	page, err := service.List(ctx, owner, chatID, message.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	feed := map[string]message.Message{}
	for _, item := range page.Messages {
		feed[item.ID] = item
	}

	var sawRoot, sawReply bool
	for _, frame := range replayed {
		if frame.Type != "message.created" {
			continue
		}
		item, ok := liveBySeq[frame.Seq]
		if !ok {
			t.Fatalf("live batch lacks seq %d", frame.Seq)
		}
		// Live and Replay serialize the same message the same way.
		if !jsonEqual(t, item.Frame.Data, frame.Data) {
			t.Fatalf("live %s != replay %s", item.Frame.Data, frame.Data)
		}
		if !contains(item.RecipientActorIDs, owner.ActorID) || !contains(item.RecipientActorIDs, member.ActorID) || contains(item.RecipientActorIDs, outsider.ActorID) {
			t.Fatalf("recipients = %v", item.RecipientActorIDs)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(frame.Data, &fields); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"files", "thread_reply_count", "mentioned_actor_ids"} {
			if _, ok := fields[key]; !ok {
				t.Fatalf("frame %s lacks %q", frame.Data, key)
			}
		}
		var got message.Message
		if err := json.Unmarshal(frame.Data, &got); err != nil {
			t.Fatal(err)
		}
		switch got.ID {
		case root.ID:
			sawRoot = true
			want := feed[root.ID]
			if len(got.Files) != 1 || got.Files[0].ID != fileID || got.Files[0].Name != "photo.jpg" || got.Files[0].Size != 2048 {
				t.Fatalf("root files = %+v", got.Files)
			}
			wantFiles, _ := json.Marshal(want.Files)
			gotFiles, _ := json.Marshal(got.Files)
			if string(wantFiles) != string(gotFiles) {
				t.Fatalf("frame files %s != feed files %s", gotFiles, wantFiles)
			}
			if got.ThreadReplyCount != 1 || want.ThreadReplyCount != 1 {
				t.Fatalf("thread_reply_count frame=%d feed=%d", got.ThreadReplyCount, want.ThreadReplyCount)
			}
			if got.ThreadRootReplyCount != nil {
				t.Fatalf("a root carries thread_root_reply_count %d", *got.ThreadRootReplyCount)
			}
		case reply.ID:
			sawReply = true
			if got.ThreadRootReplyCount == nil || *got.ThreadRootReplyCount != 1 {
				t.Fatalf("reply thread_root_reply_count = %v", got.ThreadRootReplyCount)
			}
			if got.Files == nil || len(got.Files) != 0 {
				t.Fatalf("reply files = %#v, want empty list", got.Files)
			}
		}
	}
	if !sawRoot || !sawReply {
		t.Fatalf("frames lack root=%v reply=%v: %+v", sawRoot, sawReply, replayed)
	}

	// Someone outside the chat gets neither the frame nor its files.
	if frames, err := store.Replay(ctx, outsider, "", 0, current, 100); err != nil || len(frames) != 0 {
		t.Fatalf("outsider Replay() = %+v, %v", frames, err)
	}

	// Deleting the reply: its frame tells the root's new count, zero.
	if _, err := service.Delete(ctx, owner, reply.ID); err != nil {
		t.Fatal(err)
	}
	after, err := store.Current(ctx, owner.OrgID)
	if err != nil {
		t.Fatal(err)
	}
	deleted, err := store.Live(ctx, owner.OrgID, current, after, 10)
	if err != nil || len(deleted) != 1 || deleted[0].Frame.Type != "message.deleted" {
		t.Fatalf("deleted Live() = %+v, %v", deleted, err)
	}
	var gone message.Message
	if err := json.Unmarshal(deleted[0].Frame.Data, &gone); err != nil {
		t.Fatal(err)
	}
	if gone.DeletedAt == nil || gone.Body != "" || gone.ThreadRootReplyCount == nil || *gone.ThreadRootReplyCount != 0 {
		t.Fatalf("deleted reply frame = %s", deleted[0].Frame.Data)
	}
	// The root, replayed now, shows the count of the feed: zero.
	replayed, err = store.Replay(ctx, member, "", 0, after, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, frame := range replayed {
		if frame.SubjectID == root.ID && frame.Type == "message.created" {
			var got message.Message
			if err := json.Unmarshal(frame.Data, &got); err != nil {
				t.Fatal(err)
			}
			if got.ThreadReplyCount != 0 || len(got.Files) != 1 {
				t.Fatalf("root after reply deletion = %s", frame.Data)
			}
		}
	}

	// A deleted message keeps the REST shape: files as the feed lists them.
	if _, err := service.Delete(ctx, member, root.ID); err != nil {
		t.Fatal(err)
	}
	final, err := store.Current(ctx, owner.OrgID)
	if err != nil {
		t.Fatal(err)
	}
	rootDeleted, err := store.Replay(ctx, member, "", after, final, 10)
	if err != nil || len(rootDeleted) != 1 {
		t.Fatalf("root deletion Replay() = %+v, %v", rootDeleted, err)
	}
	page, err = service.List(ctx, member, chatID, message.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range page.Messages {
		if item.ID != root.ID {
			continue
		}
		var got message.Message
		if err := json.Unmarshal(rootDeleted[0].Data, &got); err != nil {
			t.Fatal(err)
		}
		if len(got.Files) != len(item.Files) || got.ThreadReplyCount != item.ThreadReplyCount || got.DeletedAt == nil {
			t.Fatalf("deleted root frame %s, feed %+v", rootDeleted[0].Data, item)
		}
	}
}

func jsonEqual(t *testing.T, left, right json.RawMessage) bool {
	t.Helper()
	var a, b any
	if err := json.Unmarshal(left, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(right, &b); err != nil {
		t.Fatal(err)
	}
	encodedA, _ := json.Marshal(a)
	encodedB, _ := json.Marshal(b)
	return string(encodedA) == string(encodedB)
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}
