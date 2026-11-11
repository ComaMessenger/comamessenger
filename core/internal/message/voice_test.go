package message

import (
	"context"
	"errors"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

func insertReadyFile(t *testing.T, pool *pgxpool.Pool, user identity.User, name, mime string, voiceMs int) string {
	t.Helper()
	fileID := mustID(t)
	var duration *int
	var waveform []byte
	if voiceMs > 0 {
		duration = &voiceMs
		waveform = make([]byte, 64)
		waveform[0] = 255
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO files (id, org_id, uploader_id, storage_driver, storage_key, name, mime, size, status, voice_duration_ms, voice_waveform)
		VALUES ($1, $2, $3, 'local', $4, $5, $6, 10, 'ready', $7, $8)`,
		fileID, user.OrgID, user.ActorID, "objects/"+fileID, name, mime, duration, waveform); err != nil {
		t.Fatal(err)
	}
	return fileID
}

func TestVoiceMessageIsAloneAndNamedInChatPreview(t *testing.T) {
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()

	voiceID := insertReadyFile(t, pool, fixture.member, "voice.m4a", "audio/mp4", 14_200)
	otherID := insertReadyFile(t, pool, fixture.member, "notes.txt", "text/plain", 0)
	if _, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{
		ClientMsgID: mustID(t), BodyFormat: "plain", FileIDs: []string{voiceID, otherID},
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("voice with another file error = %v, want ErrInvalid", err)
	}

	created, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{
		ClientMsgID: mustID(t), BodyFormat: "plain", FileIDs: []string{voiceID},
	})
	if err != nil {
		t.Fatalf("voice message: %v", err)
	}
	if len(created.Files) != 1 || created.Files[0].Voice == nil || created.Files[0].Voice.DurationMs != 14_200 || created.Files[0].Voice.Waveform[0] != 255 {
		t.Fatalf("voice message files = %+v", created.Files)
	}

	chats := chat.NewService(pool)
	list, err := chats.List(ctx, fixture.owner)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range list {
		if item.ID != fixture.groupID {
			continue
		}
		found = true
		preview := item.LastMessage
		if preview == nil || preview.Body != "" || preview.VoiceDurationMs == nil || *preview.VoiceDurationMs != 14_200 {
			t.Fatalf("voice chat preview = %+v", preview)
		}
	}
	if !found {
		t.Fatal("group chat missing from the list")
	}

	// A later text message clears the voice marker.
	if _, _, err := service.Create(ctx, fixture.owner, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: "ok", BodyFormat: "plain"}); err != nil {
		t.Fatal(err)
	}
	got, err := chats.Get(ctx, fixture.owner, fixture.groupID)
	if err != nil || got.LastMessage == nil || got.LastMessage.VoiceDurationMs != nil || got.LastMessage.Body != "ok" {
		t.Fatalf("text preview after voice = %+v, err = %v", got.LastMessage, err)
	}
}
