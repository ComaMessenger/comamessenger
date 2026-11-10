package agenttool

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/interactive"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/search"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/google/uuid"
)

// TestChatRolesHoldOutsideTheExecutor covers review finding 3: an external
// agent with an API key reaches the message, search, reaction and file
// services directly; they apply the same chat roles as the tools.
func TestChatRolesHoldOutsideTheExecutor(t *testing.T) {
	w := newDirectWorld(t, interactive.DefaultLimits(), time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC))
	ctx := t.Context()
	if _, err := w.pool.Exec(ctx, `UPDATE agents SET write_only_chat_ids=ARRAY[$2::uuid], read_only_chat_ids=ARRAY[$3::uuid] WHERE actor_id=$1`, w.agentID, w.groupChat, w.otherChat); err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: w.ownerID, OrgID: w.orgID, OrgRole: "owner", Permissions: permission.Effective("owner", nil)}

	// Reading the chat it only writes to.
	if _, err := w.messages.List(ctx, w.agentUser, w.groupChat, message.ListOptions{}); !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("list of a write-only chat error = %v", err)
	}
	if _, err := w.messages.Get(ctx, w.agentUser, w.groupMessage); !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("get of a person's message in a write-only chat error = %v", err)
	}
	if _, err := w.messages.ListReactions(ctx, w.agentUser, w.groupMessage); !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("reactions of a person's message in a write-only chat error = %v", err)
	}
	runID, _, _ := w.run(t, w.groupChat, "")
	own, _, err := w.messages.CreateForAgentRun(ctx, w.agentUser, w.groupChat, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "Отметьтесь под этим", BodyFormat: "plain"}, message.AgentProvenance{RunID: runID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.messages.Get(ctx, w.agentUser, own.ID); err != nil {
		t.Fatalf("own message in a write-only chat: %v", err)
	}
	if _, err := w.messages.ListReactions(ctx, w.agentUser, own.ID); err != nil {
		t.Fatalf("reactions to its own card: %v", err)
	}

	// Writing to the chat it only reads.
	posted, _, err := w.messages.Create(ctx, owner, w.otherChat, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "Итоги дня", BodyFormat: "plain"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.messages.PutReaction(ctx, w.agentUser, posted.ID, "👍"); !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("reaction in a read-only chat error = %v", err)
	}

	// Search covers the chats it reads.
	if _, _, err := w.messages.Create(ctx, owner, w.groupChat, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "пароль сейфа четыре семь", BodyFormat: "plain"}); err != nil {
		t.Fatal(err)
	}
	searcher := search.NewService(w.pool)
	found, err := searcher.Search(ctx, owner, search.Input{Query: "сейфа", Type: "message"})
	if err != nil || len(found.Results) == 0 {
		t.Fatalf("owner search = %+v err=%v", found, err)
	}
	hidden, err := searcher.Search(ctx, w.agentUser, search.Input{Query: "сейфа", Type: "message"})
	if err != nil || len(hidden.Results) != 0 {
		t.Fatalf("agent search of a write-only chat = %+v err=%v", hidden, err)
	}

	// Files shared only in a write-only chat.
	store, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	fileService, err := files.NewService(w.pool, store, "", 16<<20, 8<<20, 4<<20, time.Hour, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	upload, err := fileService.CreateUpload(ctx, owner, files.CreateUploadInput{Name: "list.txt", MIME: "text/plain", Size: 5})
	if err != nil {
		t.Fatal(err)
	}
	file, err := fileService.PutContent(ctx, owner, upload.ID, bytes.NewReader([]byte("hello")))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.messages.Create(ctx, owner, w.groupChat, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "файл", BodyFormat: "plain", FileIDs: []string{file.ID}}); err != nil {
		t.Fatal(err)
	}
	if _, err := fileService.Get(ctx, owner, file.ID); err != nil {
		t.Fatalf("owner file: %v", err)
	}
	if _, err := fileService.Get(ctx, w.agentUser, file.ID); !errors.Is(err, files.ErrNotFound) {
		t.Fatalf("file shared only in a write-only chat error = %v", err)
	}
}
