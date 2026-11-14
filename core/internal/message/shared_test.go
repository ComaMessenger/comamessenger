package message

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSharedMediaKindsPagesAndCounts(t *testing.T) {
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	send := func(t *testing.T, body string, fileIDs ...string) Message {
		t.Helper()
		result, _, err := service.Create(ctx, fixture.owner, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: body, BodyFormat: "plain", FileIDs: fileIDs})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	photo := insertReadyFile(t, pool, fixture.owner, "a.jpg", "image/jpeg", 0)
	video := insertReadyFile(t, pool, fixture.owner, "b.mp4", "video/mp4", 0)
	album := send(t, "", photo, video)
	pdf := insertReadyFile(t, pool, fixture.owner, "c.pdf", "application/pdf", 0)
	plainAudio := insertReadyFile(t, pool, fixture.owner, "song.mp3", "audio/mpeg", 0)
	document := send(t, "docs", pdf, plainAudio)
	voice := send(t, "", insertReadyFile(t, pool, fixture.owner, "voice.m4a", "audio/mp4", 2000))
	third := send(t, "", insertReadyFile(t, pool, fixture.owner, "c.png", "image/png", 0))
	send(t, "text only")

	counts, err := service.SharedCounts(ctx, fixture.member, fixture.groupID)
	if err != nil || counts != (SharedCounts{Media: 3, Files: 2, Voice: 1}) {
		t.Fatalf("SharedCounts() = %+v, %v", counts, err)
	}

	// Media newest first: the last photo, then the album from its end.
	var seen []string
	var cursor *string
	for page := 0; ; page++ {
		result, err := service.SharedAttachments(ctx, fixture.member, fixture.groupID, SharedMedia, SharedListOptions{Cursor: cursor, Limit: 2})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range result.Items {
			seen = append(seen, item.File.ID)
			if item.Author.ActorID != fixture.owner.ActorID || item.Author.DisplayName == "" || item.CreatedAt.IsZero() {
				t.Fatalf("item without author or time: %+v", item)
			}
		}
		if result.NextCursor == nil {
			break
		}
		if page > 3 {
			t.Fatal("pages never end")
		}
		cursor = result.NextCursor
	}
	if strings.Join(seen, ",") != strings.Join([]string{third.Files[0].ID, video, photo}, ",") {
		t.Fatalf("media order = %v", seen)
	}
	files, err := service.SharedAttachments(ctx, fixture.member, fixture.groupID, SharedFiles, SharedListOptions{})
	if err != nil || len(files.Items) != 2 || files.Items[0].MessageID != document.ID || files.Items[0].File.Name != "song.mp3" {
		t.Fatalf("files = %+v, %v", files, err)
	}
	voices, err := service.SharedAttachments(ctx, fixture.member, fixture.groupID, SharedVoice, SharedListOptions{})
	if err != nil || len(voices.Items) != 1 || voices.Items[0].MessageID != voice.ID || voices.Items[0].File.Voice == nil {
		t.Fatalf("voice = %+v, %v", voices, err)
	}

	// A cursor belongs to its tab, and input is checked.
	first, err := service.SharedAttachments(ctx, fixture.member, fixture.groupID, SharedMedia, SharedListOptions{Limit: 1})
	if err != nil || first.NextCursor == nil {
		t.Fatalf("first page = %+v, %v", first, err)
	}
	if _, err := service.SharedAttachments(ctx, fixture.member, fixture.groupID, SharedFiles, SharedListOptions{Cursor: first.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("media cursor on files tab error = %v", err)
	}
	if _, err := service.SharedLinks(ctx, fixture.member, fixture.groupID, SharedListOptions{Cursor: first.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("media cursor on links tab error = %v", err)
	}
	for _, bad := range []struct {
		kind    string
		options SharedListOptions
	}{{"photos", SharedListOptions{}}, {SharedMedia, SharedListOptions{Limit: 101}}, {SharedMedia, SharedListOptions{Cursor: ptr("@@@")}}} {
		if _, err := service.SharedAttachments(ctx, fixture.member, fixture.groupID, bad.kind, bad.options); !errors.Is(err, ErrInvalid) {
			t.Fatalf("SharedAttachments(%q, %+v) error = %v, want ErrInvalid", bad.kind, bad.options, err)
		}
	}
	if _, err := service.SharedCounts(ctx, fixture.member, "not-a-uuid"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid chat id error = %v", err)
	}

	// Deleting a message takes its files out of every tab and count.
	if _, err := service.Delete(ctx, fixture.owner, album.ID); err != nil {
		t.Fatal(err)
	}
	counts, err = service.SharedCounts(ctx, fixture.member, fixture.groupID)
	if err != nil || counts.Media != 1 {
		t.Fatalf("counts after delete = %+v, %v", counts, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM chat_attachments WHERE message_id = $1`, 0, album.ID)
	media, err := service.SharedAttachments(ctx, fixture.member, fixture.groupID, SharedMedia, SharedListOptions{})
	if err != nil || len(media.Items) != 1 || media.Items[0].MessageID != third.ID {
		t.Fatalf("media after delete = %+v, %v", media, err)
	}
}

func TestSharedLinksFollowEditsAndDeletes(t *testing.T) {
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	original, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{ClientMsgID: mustID(t),
		Body: "Отчёт: https://пример.рф/отчёт и [доска](https://board.example.com/x).", BodyFormat: "markdown"})
	if err != nil {
		t.Fatal(err)
	}
	page, err := service.SharedLinks(ctx, fixture.owner, fixture.groupID, SharedListOptions{})
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("links = %+v, %v", page, err)
	}
	board, report := page.Items[0], page.Items[1]
	if board.URL != "https://board.example.com/x" || board.Label == nil || *board.Label != "доска" || board.Domain != "board.example.com" ||
		report.URL != "https://пример.рф/отчёт" || report.Domain != "пример.рф" || report.MessageID != original.ID ||
		report.Author.ActorID != fixture.member.ActorID || !strings.Contains(report.Snippet, "Отчёт:") {
		t.Fatalf("links = %+v / %+v", board, report)
	}

	// An edit replaces the links: the removed one goes, a new one comes.
	edited, err := service.Update(ctx, fixture.member, original.ID, UpdateInput{Body: "Теперь только https://new.example.org", BodyFormat: "plain", ExpectedVersion: original.Version})
	if err != nil {
		t.Fatal(err)
	}
	page, err = service.SharedLinks(ctx, fixture.owner, fixture.groupID, SharedListOptions{})
	if err != nil || len(page.Items) != 1 || page.Items[0].URL != "https://new.example.org" || page.Items[0].Label != nil {
		t.Fatalf("links after edit = %+v, %v", page, err)
	}
	// A forward carries the links into the other chat.
	if _, _, err := service.Forward(ctx, fixture.owner, edited.ID, ForwardInput{ChatID: fixture.channelID, ClientMsgID: mustID(t)}); err != nil {
		t.Fatal(err)
	}
	if counts, err := service.SharedCounts(ctx, fixture.member, fixture.channelID); err != nil || counts.Links != 1 {
		t.Fatalf("forwarded links = %+v, %v", counts, err)
	}
	// Deleting drops them.
	if _, err := service.Delete(ctx, fixture.member, edited.ID); err != nil {
		t.Fatal(err)
	}
	if counts, err := service.SharedCounts(ctx, fixture.owner, fixture.groupID); err != nil || counts.Links != 0 {
		t.Fatalf("links after delete = %+v, %v", counts, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM message_links WHERE message_id = $1`, 0, edited.ID)

	// Long text is cut around the link.
	long := strings.Repeat("слово ", 100) + "https://deep.example.com/page " + strings.Repeat("хвост ", 100)
	if _, _, err := service.Create(ctx, fixture.owner, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: long, BodyFormat: "plain"}); err != nil {
		t.Fatal(err)
	}
	page, err = service.SharedLinks(ctx, fixture.owner, fixture.groupID, SharedListOptions{Limit: 1})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("long link page = %+v, %v", page, err)
	}
	snippet := page.Items[0].Snippet
	if !strings.HasPrefix(snippet, "…слово") || !strings.HasSuffix(snippet, "хвост…") || !strings.Contains(snippet, "https://deep.example.com/page") || len([]rune(snippet)) > 260 {
		t.Fatalf("snippet = %q", snippet)
	}
}

func TestSharedMediaAccess(t *testing.T) {
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	agent := identity.User{ActorID: mustID(t), OrgID: fixture.owner.OrgID, OrgRole: "member", Status: "active"}
	if _, err := pool.Exec(ctx, `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'agent','member','Agent','writer')`, agent.ActorID, agent.OrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,write_only_chat_ids) VALUES($1,$2,$3,'builtin',true,ARRAY['messages:read'],ARRAY[$4::uuid])`, agent.ActorID, agent.OrgID, fixture.owner.ActorID, fixture.groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'member')`, fixture.groupID, agent.ActorID, agent.OrgID); err != nil {
		t.Fatal(err)
	}
	post := func(user identity.User, body string, fileIDs ...string) {
		t.Helper()
		if _, _, err := service.Create(ctx, user, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: body, BodyFormat: "plain", FileIDs: fileIDs}); err != nil {
			t.Fatal(err)
		}
	}
	post(fixture.owner, "people https://people.example.com", insertReadyFile(t, pool, fixture.owner, "p.png", "image/png", 0))
	post(agent, "agent https://agent.example.com", insertReadyFile(t, pool, agent, "a.png", "image/png", 0))

	// A write-only agent sees its own messages only, as in Get.
	counts, err := service.SharedCounts(ctx, agent, fixture.groupID)
	if err != nil || counts != (SharedCounts{Media: 1, Links: 1}) {
		t.Fatalf("agent counts = %+v, %v", counts, err)
	}
	media, err := service.SharedAttachments(ctx, agent, fixture.groupID, SharedMedia, SharedListOptions{})
	if err != nil || len(media.Items) != 1 || media.Items[0].Author.ActorID != agent.ActorID {
		t.Fatalf("agent media = %+v, %v", media, err)
	}
	links, err := service.SharedLinks(ctx, agent, fixture.groupID, SharedListOptions{})
	if err != nil || len(links.Items) != 1 || links.Items[0].URL != "https://agent.example.com" {
		t.Fatalf("agent links = %+v, %v", links, err)
	}
	// People see everything.
	if counts, err := service.SharedCounts(ctx, fixture.member, fixture.groupID); err != nil || counts != (SharedCounts{Media: 2, Links: 2}) {
		t.Fatalf("member counts = %+v, %v", counts, err)
	}

	denied := func(t *testing.T, user identity.User, chatID string) {
		t.Helper()
		if _, err := service.SharedCounts(ctx, user, chatID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("SharedCounts error = %v, want ErrNotFound", err)
		}
		if _, err := service.SharedAttachments(ctx, user, chatID, SharedMedia, SharedListOptions{}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("SharedAttachments error = %v, want ErrNotFound", err)
		}
		if _, err := service.SharedLinks(ctx, user, chatID, SharedListOptions{}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("SharedLinks error = %v, want ErrNotFound", err)
		}
	}
	t.Run("a workspace moderator outside the chat", func(t *testing.T) { denied(t, fixture.moderator, fixture.groupID) })
	t.Run("an unknown chat", func(t *testing.T) { denied(t, fixture.member, mustID(t)) })
	t.Run("a former member", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `DELETE FROM chat_members WHERE chat_id = $1 AND actor_id = $2`, fixture.groupID, fixture.member.ActorID); err != nil {
			t.Fatal(err)
		}
		denied(t, fixture.member, fixture.groupID)
	})
	t.Run("an archived chat, even for its owner", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE chats SET archived_at = now() WHERE id = $1`, fixture.groupID); err != nil {
			t.Fatal(err)
		}
		denied(t, fixture.owner, fixture.groupID)
	})
}

// Messages written before the migration get their rows from the backfill;
// a message edited after it keeps the edit's links.
func TestSharedBackfill(t *testing.T) {
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	photo := insertReadyFile(t, pool, fixture.owner, "old.jpg", "image/jpeg", 0)
	var ids []string
	for index := 0; index < 3; index++ {
		created, _, err := service.Create(ctx, fixture.owner, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: "old https://old.example.com/" + string(rune('a'+index)), BodyFormat: "plain"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, created.ID)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO message_files(message_id,file_id,org_id,ordinal) VALUES($1,$2,$3,0)`, ids[0], photo, fixture.owner.OrgID); err != nil {
		t.Fatal(err)
	}
	// As before the migration: no rows, a deleted message among the old ones.
	if _, err := service.Delete(ctx, fixture.owner, ids[2]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM message_links; DELETE FROM chat_attachments; UPDATE shared_backfill SET last_message_id = NULL, done_at = NULL`); err != nil {
		t.Fatal(err)
	}
	edited, err := service.Update(ctx, fixture.owner, ids[1], UpdateInput{Body: "edited https://edited.example.com", BodyFormat: "plain", ExpectedVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	done, err := service.BackfillSharedBatch(ctx)
	if err != nil || !done {
		t.Fatalf("BackfillSharedBatch() = %v, %v", done, err)
	}
	links, err := service.SharedLinks(ctx, fixture.member, fixture.groupID, SharedListOptions{})
	if err != nil || len(links.Items) != 2 || links.Items[0].URL != "https://edited.example.com" || links.Items[0].MessageID != edited.ID || links.Items[1].URL != "https://old.example.com/a" {
		t.Fatalf("links after backfill = %+v, %v", links, err)
	}
	counts, err := service.SharedCounts(ctx, fixture.member, fixture.groupID)
	if err != nil || counts != (SharedCounts{Media: 1, Links: 2}) {
		t.Fatalf("counts after backfill = %+v, %v", counts, err)
	}
	// Done is done: another run touches nothing.
	if done, err := service.BackfillSharedBatch(ctx); err != nil || !done {
		t.Fatalf("second BackfillSharedBatch() = %v, %v", done, err)
	}
}

// One page reads the same few index entries and rows whatever the size of
// the chat: 20 000 messages, of which one in four has a photo and every
// second one a link.
func TestSharedCostOnLargeChat(t *testing.T) {
	if testing.Short() {
		t.Skip("large chat")
	}
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	const total = 20000
	if _, err := pool.Exec(ctx, `
		INSERT INTO messages (id, org_id, chat_id, actor_id, client_msg_id, create_fingerprint, body, created_seq)
		SELECT gen_random_uuid(), $1, $2, $3, gen_random_uuid(), decode(repeat('00', 32), 'hex'),
			CASE WHEN g % 2 = 0 THEN 'see https://site' || g || '.example.com/page' ELSE 'message ' || g END,
			1000000 + g
		FROM generate_series(1, $4) g`, fixture.owner.OrgID, fixture.groupID, fixture.owner.ActorID, total); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		WITH chosen AS (
			SELECT id AS message_id, gen_random_uuid() AS file_id FROM messages WHERE chat_id = $2 AND created_seq % 4 = 0
		), made AS (
			INSERT INTO files (id, org_id, uploader_id, storage_driver, storage_key, name, mime, size, status)
			SELECT file_id, $1, $3, 'local', 'objects/' || file_id, 'p.jpg', 'image/jpeg', 10, 'ready' FROM chosen
		)
		INSERT INTO message_files (message_id, file_id, org_id, ordinal) SELECT message_id, file_id, $1, 0 FROM chosen`,
		fixture.owner.OrgID, fixture.groupID, fixture.owner.ActorID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ANALYZE messages; ANALYZE message_files; ANALYZE files`); err != nil {
		t.Fatal(err)
	}
	// The backfill fills both tables for the whole chat, batch by batch.
	for batches := 0; ; batches++ {
		done, err := service.BackfillSharedBatch(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if done {
			break
		}
		if batches > total/sharedBackfillBatch+2 {
			t.Fatal("backfill does not finish")
		}
	}
	counts, err := service.SharedCounts(ctx, fixture.member, fixture.groupID)
	if err != nil || counts != (SharedCounts{Media: total / 4, Links: total / 2}) {
		t.Fatalf("counts = %+v, %v", counts, err)
	}
	if _, err := pool.Exec(ctx, `VACUUM ANALYZE messages`); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"chat_attachments", "message_links", "files", "actors"} {
		if _, err := pool.Exec(ctx, `VACUUM ANALYZE `+table); err != nil {
			t.Fatal(err)
		}
	}
	// A deep page: the cursor of the 150th photo.
	var deepSeq int64
	if err := pool.QueryRow(ctx, `SELECT created_seq FROM chat_attachments WHERE chat_id = $1 ORDER BY created_seq DESC OFFSET 150 LIMIT 1`, fixture.groupID).Scan(&deepSeq); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		query string
		args  []any
	}{
		{"first media page", sharedAttachmentsSQL, []any{fixture.groupID, fixture.owner.OrgID, SharedMedia, nil, nil, nil, 51}},
		{"deep media page", sharedAttachmentsSQL, []any{fixture.groupID, fixture.owner.OrgID, SharedMedia, nil, deepSeq, 0, 51}},
		{"write-only agent page", sharedAttachmentsSQL, []any{fixture.groupID, fixture.owner.OrgID, SharedMedia, mustID(t), nil, nil, 51}},
		{"first links page", sharedLinksSQL, []any{fixture.groupID, fixture.owner.OrgID, nil, nil, nil, 51, snippetContext}},
	}
	for _, test := range cases {
		buffers, plan := explainBuffers(t, pool, test.query, test.args...)
		t.Logf("%s: %d buffers", test.name, buffers)
		// 51 rows × a key lookup in messages, files and actors is ~400
		// buffers; scanning the chat's messages would be several thousand.
		if buffers > 1000 || seqScanOfLargeTable(plan) {
			t.Fatalf("%s reads %d buffers, plan:\n%s", test.name, buffers, plan)
		}
	}
	// Counts grow with the attachments of the chat, never with its messages:
	// they read chat_attachments alone (here the whole table is this chat).
	buffers, plan := explainBuffers(t, pool, `SELECT kind, count(*) FROM chat_attachments WHERE chat_id = $1 AND org_id = $2 AND ($3::uuid IS NULL OR actor_id = $3) GROUP BY kind`, fixture.groupID, fixture.owner.OrgID, nil)
	t.Logf("counts: %d buffers", buffers)
	if buffers > 200 || strings.Contains(plan, `"Relation Name": "messages"`) {
		t.Fatalf("counts read %d buffers, plan:\n%s", buffers, plan)
	}
	// And the service agrees with the plan: full pages.
	page, err := service.SharedAttachments(ctx, fixture.member, fixture.groupID, SharedMedia, SharedListOptions{Limit: 100})
	if err != nil || len(page.Items) != 100 || page.NextCursor == nil {
		t.Fatalf("large page = %d items, %v", len(page.Items), err)
	}
}

func explainBuffers(t *testing.T, pool *pgxpool.Pool, query string, args ...any) (int64, string) {
	t.Helper()
	var raw []byte
	if err := pool.QueryRow(context.Background(), `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) `+query, args...).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var plans []struct {
		Plan map[string]any `json:"Plan"`
	}
	if err := json.Unmarshal(raw, &plans); err != nil || len(plans) != 1 {
		t.Fatalf("explain output: %v %s", err, raw)
	}
	hit, _ := plans[0].Plan["Shared Hit Blocks"].(float64)
	read, _ := plans[0].Plan["Shared Read Blocks"].(float64)
	return int64(hit + read), string(raw)
}

// seqScanOfLargeTable reports a sequential scan of a table that grows with
// chats; the three-row actors table of the fixture may be read whole.
func seqScanOfLargeTable(plan string) bool {
	var walk func(node any) bool
	walk = func(node any) bool {
		switch value := node.(type) {
		case map[string]any:
			if value["Node Type"] == "Seq Scan" && value["Relation Name"] != "actors" {
				return true
			}
			for _, child := range value {
				if walk(child) {
					return true
				}
			}
		case []any:
			for _, child := range value {
				if walk(child) {
					return true
				}
			}
		}
		return false
	}
	var parsed any
	if err := json.Unmarshal([]byte(plan), &parsed); err != nil {
		return true
	}
	return walk(parsed)
}

func ptr(value string) *string { return &value }

// A message of junk costs its own send milliseconds and holds nobody else
// up: links are extracted before the organization lock, in linear time. The
// review measured a stranger's «hi» waiting 6 s behind such a body.
func TestPathologicalBodiesDoNotStallTheOrganization(t *testing.T) {
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	hi := func() time.Duration {
		started := time.Now()
		if _, _, err := service.Create(ctx, fixture.member, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: "hi", BodyFormat: "plain"}); err != nil {
			t.Error(err)
		}
		return time.Since(started)
	}
	for name, body := range pathologicalBodies(4) {
		if len(body) > 64*1024-1 {
			body = body[:64*1024-1]
		}
		for _, format := range []string{"plain", "markdown"} {
			started := time.Now()
			done := make(chan time.Duration, 1)
			go func() {
				// Overlaps the junk send; it waits at most for the junk's
				// inserts under the lock, never for its parsing.
				time.Sleep(time.Millisecond)
				done <- hi()
			}()
			created, _, err := service.Create(ctx, fixture.owner, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: body, BodyFormat: format})
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			sent := time.Since(started)
			waited := <-done
			edited := time.Now()
			if _, err := service.Update(ctx, fixture.owner, created.ID, UpdateInput{Body: body + " ", BodyFormat: format, ExpectedVersion: created.Version}); err != nil {
				t.Fatalf("%s: edit: %v", name, err)
			}
			t.Logf("%s (%s): send %v, edit %v, a stranger's hi %v", name, format, sent, time.Since(edited), waited)
			if sent > time.Second || waited > time.Second || time.Since(edited) > time.Second {
				t.Errorf("%s (%s): send %v, edit %v, hi %v — junk holds the organization", name, format, sent, time.Since(edited), waited)
			}
		}
	}
}

func TestPreparedLinksFollowTheText(t *testing.T) {
	prepared := PrepareLinks("see https://a.example.com", "plain")
	if got := linksOf(prepared, "see https://a.example.com", "plain"); len(got) != 1 || got[0].URL != "https://a.example.com" {
		t.Fatalf("prepared links not used: %+v", got)
	}
	// Another text (a scheduled message edited meanwhile): extract anew.
	if got := linksOf(prepared, "now https://b.example.com", "plain"); len(got) != 1 || got[0].URL != "https://b.example.com" {
		t.Fatalf("stale prepared links used: %+v", got)
	}
	if got := linksOf(nil, "x https://c.example.com", "markdown"); len(got) != 1 {
		t.Fatalf("no prepared links: %+v", got)
	}
}

// The backfill holds no lock while it reads and parses a batch: an edit or a
// deletion of a message in it goes through at once, and the batch then
// writes nothing over it.
func TestSharedBackfillHoldsNoLockWhileParsing(t *testing.T) {
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	post := func(body string, fileIDs ...string) Message {
		t.Helper()
		created, _, err := service.Create(ctx, fixture.owner, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: body, BodyFormat: "plain", FileIDs: fileIDs})
		if err != nil {
			t.Fatal(err)
		}
		return created
	}
	kept := post("kept https://kept.example.com")
	edited := post("old https://old.example.com")
	deleted := post("gone https://gone.example.com", insertReadyFile(t, pool, fixture.owner, "gone.jpg", "image/jpeg", 0))
	photo := post("", insertReadyFile(t, pool, fixture.owner, "kept.jpg", "image/jpeg", 0))
	// As before the migration.
	if _, err := pool.Exec(ctx, `DELETE FROM message_links; DELETE FROM chat_attachments; UPDATE shared_backfill SET last_message_id = NULL, done_at = NULL`); err != nil {
		t.Fatal(err)
	}
	service.betweenBackfillSteps = func() {
		// The batch is read and parsed; nothing may be locked now.
		quick, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if _, err := service.Update(quick, fixture.owner, edited.ID, UpdateInput{Body: "new https://new.example.com", BodyFormat: "plain", ExpectedVersion: edited.Version}); err != nil {
			t.Errorf("edit during the backfill: %v", err)
		}
		if _, err := service.Delete(quick, fixture.owner, deleted.ID); err != nil {
			t.Errorf("delete during the backfill: %v", err)
		}
		var locks int
		if err := pool.QueryRow(quick, `SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'messages' AND l.mode = 'RowShareLock' AND l.pid <> pg_backend_pid()`).Scan(&locks); err != nil {
			t.Error(err)
		} else if locks != 0 {
			t.Errorf("%d row locks on messages while the batch is parsed", locks)
		}
	}
	done, err := service.BackfillSharedBatch(ctx)
	if err != nil || !done {
		t.Fatalf("BackfillSharedBatch() = %v, %v", done, err)
	}
	links, err := service.SharedLinks(ctx, fixture.member, fixture.groupID, SharedListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, item := range links.Items {
		got[item.URL] = item.MessageID
	}
	if len(got) != 2 || got["https://kept.example.com"] != kept.ID || got["https://new.example.com"] != edited.ID {
		t.Fatalf("links after the backfill = %v; want the kept one and the edit's, not the old text's or the deleted message's", got)
	}
	assertCount(t, pool, `SELECT count(*) FROM chat_attachments WHERE message_id = $1`, 0, deleted.ID)
	assertCount(t, pool, `SELECT count(*) FROM chat_attachments WHERE message_id = $1`, 1, photo.ID)
}

// A change that leaves the text alone — a pressed button — bumps the version
// between the backfill's read and write; the batch must still write the
// card's links (it compares texts, not versions), or the card would never
// get them. An edit of the text in the same window is still not overwritten.
func TestSharedBackfillComparesTextNotVersion(t *testing.T) {
	pool := testdb.New(t)
	fixture := seedFixture(t, pool)
	service := NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	agent := identity.User{ActorID: mustID(t), OrgID: fixture.owner.OrgID, OrgRole: "member", Status: "active"}
	runID := mustID(t)
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'agent','member','Agent','cards')`, []any{agent.ActorID, agent.OrgID}},
		{`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes) VALUES($1,$2,$3,'builtin',true,ARRAY['messages:read'])`, []any{agent.ActorID, agent.OrgID, fixture.owner.ActorID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'member')`, []any{fixture.groupID, agent.ActorID, agent.OrgID}},
		{`INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,status,lease_token,lease_expires_at,started_at) VALUES($1,$2,$3,$4,$5,'running',$6,now()+interval '5 minutes',now())`, []any{runID, agent.OrgID, agent.ActorID, fixture.groupID, mustID(t), mustID(t)}},
	} {
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	card, _, err := service.CreateForAgentRun(ctx, agent, fixture.groupID, CreateInput{
		ClientMsgID: mustID(t),
		Blocks: &Blocks{
			Version: 1,
			Card:    &Card{Title: "Брифинг", Fields: []CardField{{Label: "Документ", Value: "https://brief.example.com/v2"}}},
			Actions: []Action{{ID: "ok", Label: "Прочитал", Style: "primary", Limit: "per_actor"}},
		},
	}, AgentProvenance{RunID: runID})
	if err != nil {
		t.Fatal(err)
	}
	edited, _, err := service.Create(ctx, fixture.owner, fixture.groupID, CreateInput{ClientMsgID: mustID(t), Body: "old https://old.example.com", BodyFormat: "plain"})
	if err != nil {
		t.Fatal(err)
	}
	// As before the migration.
	if _, err := pool.Exec(ctx, `DELETE FROM message_links; DELETE FROM chat_attachments; UPDATE shared_backfill SET last_message_id = NULL, done_at = NULL`); err != nil {
		t.Fatal(err)
	}
	service.betweenBackfillSteps = func() {
		if _, err := service.PressAction(ctx, fixture.member, card.ID, "ok"); err != nil {
			t.Errorf("press during the backfill: %v", err)
		}
		if _, err := service.Update(ctx, fixture.owner, edited.ID, UpdateInput{Body: "new https://new.example.com", BodyFormat: "plain", ExpectedVersion: edited.Version}); err != nil {
			t.Errorf("edit during the backfill: %v", err)
		}
	}
	if done, err := service.BackfillSharedBatch(ctx); err != nil || !done {
		t.Fatalf("BackfillSharedBatch() = %v, %v", done, err)
	}
	var version int
	if err := pool.QueryRow(ctx, `SELECT version FROM messages WHERE id = $1`, card.ID).Scan(&version); err != nil || version <= card.Version {
		t.Fatalf("the press did not bump the card's version: %d, %v", version, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM message_links WHERE message_id = $1 AND url = 'https://brief.example.com/v2'`, 1, card.ID)
	assertCount(t, pool, `SELECT count(*) FROM message_links WHERE message_id = $1`, 1, edited.ID)
	assertCount(t, pool, `SELECT count(*) FROM message_links WHERE message_id = $1 AND url = 'https://new.example.com'`, 1, edited.ID)
}
