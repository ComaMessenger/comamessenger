package message

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	filemodel "github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
)

// Shared media of a chat: the «Медиа», «Файлы», «Голосовые» and «Ссылки»
// tabs of chat info. They read two pointer tables, chat_attachments and
// message_links, written in the same transaction as the message itself (see
// attachFiles and syncMessageLinks), so a page is an index range scan of one
// chat whatever its size.
//
// Access is the feed's: an active member of a live chat. An agent that only
// writes to the chat sees its own messages only, as in Get. Deleted messages
// lose their rows when deleted and are filtered again on read.

const (
	SharedMedia = "media"
	SharedFiles = "files"
	SharedVoice = "voice"
	sharedLinks = "links"
)

// sharedKindSQL classifies a file `f` once, when it is attached: the MIME
// type and the voice columns of a ready file never change.
const sharedKindSQL = `CASE
	WHEN f.voice_duration_ms IS NOT NULL THEN 'voice'
	WHEN f.mime LIKE 'image/%' OR f.mime LIKE 'video/%' THEN 'media'
	ELSE 'files' END`

type SharedAuthor struct {
	ActorID       string `json:"actor_id"`
	DisplayName   string `json:"display_name"`
	Type          string `json:"type"`
	AvatarVersion int64  `json:"avatar_version"`
}

type SharedAttachment struct {
	File         filemodel.File `json:"file"`
	MessageID    string         `json:"message_id"`
	ThreadRootID *string        `json:"thread_root_id"`
	Author       SharedAuthor   `json:"author"`
	CreatedAt    time.Time      `json:"created_at"`
	seq          int64
	ordinal      int
}

type SharedAttachmentPage struct {
	Items      []SharedAttachment `json:"items"`
	NextCursor *string            `json:"next_cursor"`
}

type SharedLink struct {
	URL          string       `json:"url"`
	Domain       string       `json:"domain"`
	Label        *string      `json:"label"`
	MessageID    string       `json:"message_id"`
	ThreadRootID *string      `json:"thread_root_id"`
	Author       SharedAuthor `json:"author"`
	CreatedAt    time.Time    `json:"created_at"`
	// Snippet is the message text around the link, at most ~200 characters.
	Snippet  string `json:"snippet"`
	seq      int64
	position int
}

type SharedLinkPage struct {
	Items      []SharedLink `json:"items"`
	NextCursor *string      `json:"next_cursor"`
}

type SharedCounts struct {
	Media int64 `json:"media"`
	Files int64 `json:"files"`
	Voice int64 `json:"voice"`
	Links int64 `json:"links"`
}

type SharedListOptions struct {
	// Cursor is an opaque position from a previous page's next_cursor.
	Cursor *string
	Limit  int
}

// sharedCursor is a position in one tab of one chat, newest first. The kind
// is part of it, so a cursor of the media tab is refused by the links tab.
type sharedCursor struct {
	seq   int64
	index int
}

func encodeSharedCursor(kind string, seq int64, index int) string {
	raw := kind + "." + strconv.FormatInt(seq, 10) + "." + strconv.Itoa(index)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeSharedCursor(kind, value string) (*sharedCursor, error) {
	malformed := fmt.Errorf("%w: cursor is malformed", ErrInvalid)
	if len(value) > 200 {
		return nil, malformed
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, malformed
	}
	parts := strings.Split(string(raw), ".")
	if len(parts) != 3 || parts[0] != kind {
		return nil, malformed
	}
	seq, seqErr := strconv.ParseInt(parts[1], 10, 64)
	index, indexErr := strconv.Atoi(parts[2])
	if seqErr != nil || indexErr != nil || seq < 1 || index < 0 || index > 100 {
		return nil, malformed
	}
	return &sharedCursor{seq: seq, index: index}, nil
}

func sharedLimit(limit int) (int, error) {
	if limit == 0 {
		return 50, nil
	}
	if limit < 1 || limit > 100 {
		return 0, fmt.Errorf("%w: limit must be between 1 and 100", ErrInvalid)
	}
	return limit, nil
}

// sharedAttachmentsSQL reads one page of a tab: $1 chat, $2 organization,
// $3 kind, $4 only this author (a write-only agent) or NULL, $5/$6 the
// cursor or NULL, $7 the page size plus one. An index range scan of
// chat_attachments_feed_idx and a key lookup per row in messages, files and
// actors: the cost does not grow with the chat (TestSharedCostOnLargeChat).
const sharedAttachmentsSQL = `
		SELECT ca.created_seq, ca.ordinal, m.id, m.thread_root_id, m.created_at,
			author.id, author.display_name, author.type, author.avatar_version,
			f.id, f.name, f.mime, f.size, f.sha256, f.status, f.processing_status,
			f.preview_file_id, f.created_at, f.ready_at, f.uploader_id, f.voice_duration_ms, f.voice_waveform
		FROM chat_attachments ca
		JOIN messages m ON m.org_id = ca.org_id AND m.id = ca.message_id AND m.deleted_at IS NULL
		JOIN files f ON f.org_id = ca.org_id AND f.id = ca.file_id AND f.status <> 'deleted'
		JOIN actors author ON author.org_id = m.org_id AND author.id = m.actor_id
		WHERE ca.chat_id = $1 AND ca.org_id = $2 AND ca.kind = $3
		  AND ($4::uuid IS NULL OR ca.actor_id = $4)
		  AND ($5::bigint IS NULL OR (ca.created_seq, ca.ordinal) < ($5, $6::smallint))
		ORDER BY ca.created_seq DESC, ca.ordinal DESC
		LIMIT $7`

// sharedLinksSQL reads one page of links, as sharedAttachmentsSQL; $7 is the
// number of characters of text kept on each side of a link.
const sharedLinksSQL = `
		SELECT ml.created_seq, ml.position, ml.url, ml.domain, ml.label,
			m.id, m.thread_root_id, m.created_at,
			author.id, author.display_name, author.type, author.avatar_version,
			greatest(ml.text_offset - $7, 0) > 0,
			substr(m.body, greatest(ml.text_offset - $7, 0) + 1,
				least(ml.text_offset, $7) + least(char_length(ml.url), 200) + $7),
			char_length(m.body) > ml.text_offset + least(char_length(ml.url), 200) + $7
		FROM message_links ml
		JOIN messages m ON m.org_id = ml.org_id AND m.id = ml.message_id AND m.deleted_at IS NULL
		JOIN actors author ON author.org_id = m.org_id AND author.id = m.actor_id
		WHERE ml.chat_id = $1 AND ml.org_id = $2
		  AND ($3::uuid IS NULL OR ml.actor_id = $3)
		  AND ($4::bigint IS NULL OR (ml.created_seq, ml.position) < ($4, $5::smallint))
		ORDER BY ml.created_seq DESC, ml.position DESC
		LIMIT $6`

// sharedReader opens a read transaction and checks the reader may see the
// chat's shared media. onlyActor is the reader's own actor id when it is an
// agent that only writes to the chat (its own messages only), else nil.
func (s *Service) sharedReader(ctx context.Context, user identity.User, chatID string) (pgx.Tx, *string, error) {
	if err := validateUUID("chat_id", chatID); err != nil {
		return nil, nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("begin read shared media: %w", err)
	}
	if _, _, err := requireMembership(ctx, tx, user, chatID); err != nil {
		tx.Rollback(ctx)
		return nil, nil, err
	}
	_, writeOnly, err := agentChatRole(ctx, tx, user.OrgID, user.ActorID, chatID)
	if err != nil {
		tx.Rollback(ctx)
		return nil, nil, fmt.Errorf("check agent chat role: %w", err)
	}
	if writeOnly {
		own := user.ActorID
		return tx, &own, nil
	}
	return tx, nil, nil
}

// SharedCounts returns how many attachments of each kind and links the reader
// sees in the chat: the numbers on the tabs.
func (s *Service) SharedCounts(ctx context.Context, user identity.User, chatID string) (SharedCounts, error) {
	tx, onlyActor, err := s.sharedReader(ctx, user, chatID)
	if err != nil {
		return SharedCounts{}, err
	}
	defer tx.Rollback(ctx)
	var result SharedCounts
	rows, err := tx.Query(ctx, `
		SELECT kind, count(*) FROM chat_attachments
		WHERE chat_id = $1 AND org_id = $2 AND ($3::uuid IS NULL OR actor_id = $3)
		GROUP BY kind`, chatID, user.OrgID, onlyActor)
	if err != nil {
		return SharedCounts{}, fmt.Errorf("count shared attachments: %w", err)
	}
	for rows.Next() {
		var kind string
		var count int64
		if err := rows.Scan(&kind, &count); err != nil {
			rows.Close()
			return SharedCounts{}, fmt.Errorf("scan shared attachment count: %w", err)
		}
		switch kind {
		case SharedMedia:
			result.Media = count
		case SharedFiles:
			result.Files = count
		case SharedVoice:
			result.Voice = count
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return SharedCounts{}, fmt.Errorf("iterate shared attachment counts: %w", err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM message_links
		WHERE chat_id = $1 AND org_id = $2 AND ($3::uuid IS NULL OR actor_id = $3)`,
		chatID, user.OrgID, onlyActor).Scan(&result.Links); err != nil {
		return SharedCounts{}, fmt.Errorf("count shared links: %w", err)
	}
	return result, tx.Commit(ctx)
}

// SharedAttachments returns one page of the chat's attachments of a kind
// (media, files or voice), newest first.
func (s *Service) SharedAttachments(ctx context.Context, user identity.User, chatID, kind string, options SharedListOptions) (SharedAttachmentPage, error) {
	if kind != SharedMedia && kind != SharedFiles && kind != SharedVoice {
		return SharedAttachmentPage{}, fmt.Errorf("%w: kind must be media, files or voice", ErrInvalid)
	}
	limit, err := sharedLimit(options.Limit)
	if err != nil {
		return SharedAttachmentPage{}, err
	}
	var cursor *sharedCursor
	if options.Cursor != nil {
		if cursor, err = decodeSharedCursor(kind, *options.Cursor); err != nil {
			return SharedAttachmentPage{}, err
		}
	}
	tx, onlyActor, err := s.sharedReader(ctx, user, chatID)
	if err != nil {
		return SharedAttachmentPage{}, err
	}
	defer tx.Rollback(ctx)
	var afterSeq, afterOrdinal any
	if cursor != nil {
		afterSeq, afterOrdinal = cursor.seq, cursor.index
	}
	rows, err := tx.Query(ctx, sharedAttachmentsSQL, chatID, user.OrgID, kind, onlyActor, afterSeq, afterOrdinal, limit+1)
	if err != nil {
		return SharedAttachmentPage{}, fmt.Errorf("list shared attachments: %w", err)
	}
	defer rows.Close()
	items := make([]SharedAttachment, 0, limit+1)
	for rows.Next() {
		var item SharedAttachment
		var checksum, waveform []byte
		var voiceDuration *int32
		file := &item.File
		if err := rows.Scan(&item.seq, &item.ordinal, &item.MessageID, &item.ThreadRootID, &item.CreatedAt,
			&item.Author.ActorID, &item.Author.DisplayName, &item.Author.Type, &item.Author.AvatarVersion,
			&file.ID, &file.Name, &file.MIME, &file.Size, &checksum, &file.Status, &file.ProcessingStatus,
			&file.PreviewFileID, &file.CreatedAt, &file.ReadyAt, &file.UploaderID, &voiceDuration, &waveform); err != nil {
			return SharedAttachmentPage{}, fmt.Errorf("scan shared attachment: %w", err)
		}
		file.Voice = filemodel.VoiceFromColumns(voiceDuration, waveform)
		if len(checksum) == sha256.Size {
			value := hex.EncodeToString(checksum)
			file.SHA256 = &value
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return SharedAttachmentPage{}, fmt.Errorf("iterate shared attachments: %w", err)
	}
	rows.Close()
	page := SharedAttachmentPage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		last := page.Items[limit-1]
		next := encodeSharedCursor(kind, last.seq, last.ordinal)
		page.NextCursor = &next
	}
	return page, tx.Commit(ctx)
}

// snippetContext is how many characters of text are kept on each side of a
// link in its snippet.
const snippetContext = 80

// SharedLinks returns one page of links from the chat's messages, newest
// first, each with the text around it.
func (s *Service) SharedLinks(ctx context.Context, user identity.User, chatID string, options SharedListOptions) (SharedLinkPage, error) {
	limit, err := sharedLimit(options.Limit)
	if err != nil {
		return SharedLinkPage{}, err
	}
	var cursor *sharedCursor
	if options.Cursor != nil {
		if cursor, err = decodeSharedCursor(sharedLinks, *options.Cursor); err != nil {
			return SharedLinkPage{}, err
		}
	}
	tx, onlyActor, err := s.sharedReader(ctx, user, chatID)
	if err != nil {
		return SharedLinkPage{}, err
	}
	defer tx.Rollback(ctx)
	var afterSeq, afterPosition any
	if cursor != nil {
		afterSeq, afterPosition = cursor.seq, cursor.index
	}
	// The snippet is cut in SQL: a body may be up to 1 MiB, the reply never
	// carries more than a few hundred characters of it.
	rows, err := tx.Query(ctx, sharedLinksSQL, chatID, user.OrgID, onlyActor, afterSeq, afterPosition, limit+1, snippetContext)
	if err != nil {
		return SharedLinkPage{}, fmt.Errorf("list shared links: %w", err)
	}
	defer rows.Close()
	items := make([]SharedLink, 0, limit+1)
	for rows.Next() {
		var item SharedLink
		var cutBefore, cutAfter bool
		var snippet string
		if err := rows.Scan(&item.seq, &item.position, &item.URL, &item.Domain, &item.Label,
			&item.MessageID, &item.ThreadRootID, &item.CreatedAt,
			&item.Author.ActorID, &item.Author.DisplayName, &item.Author.Type, &item.Author.AvatarVersion,
			&cutBefore, &snippet, &cutAfter); err != nil {
			return SharedLinkPage{}, fmt.Errorf("scan shared link: %w", err)
		}
		item.Snippet = linkSnippet(snippet, cutBefore, cutAfter)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return SharedLinkPage{}, fmt.Errorf("iterate shared links: %w", err)
	}
	rows.Close()
	page := SharedLinkPage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		last := page.Items[limit-1]
		next := encodeSharedCursor(sharedLinks, last.seq, last.position)
		page.NextCursor = &next
	}
	return page, tx.Commit(ctx)
}

// linkSnippet folds whitespace and marks text cut on either side. A word cut
// in half at an edge is dropped.
func linkSnippet(text string, cutBefore, cutAfter bool) string {
	words := strings.Fields(text)
	if cutBefore && len(words) > 1 && !strings.HasPrefix(text, " ") {
		words = words[1:]
	}
	if cutAfter && len(words) > 1 && !strings.HasSuffix(text, " ") {
		words = words[:len(words)-1]
	}
	result := strings.Join(words, " ")
	if cutBefore {
		result = "…" + result
	}
	if cutAfter {
		result += "…"
	}
	return result
}

// syncMessageLinks writes the links of a message's current text. replace
// drops the old ones first (an edit, a deletion, a new card text); a deleted
// message keeps none.
func syncMessageLinks(ctx context.Context, tx pgx.Tx, orgID string, message Message, replace bool) error {
	if replace {
		if _, err := tx.Exec(ctx, `DELETE FROM message_links WHERE message_id = $1`, message.ID); err != nil {
			return fmt.Errorf("drop message links: %w", err)
		}
	}
	if message.DeletedAt != nil {
		return nil
	}
	return insertMessageLinks(ctx, tx, orgID, message.ID, message.ChatID, message.ActorID, message.CreatedSeq, message.Body, message.BodyFormat)
}

func insertMessageLinks(ctx context.Context, tx pgx.Tx, orgID, messageID, chatID, actorID string, seq int64, body, format string) error {
	links := ExtractLinks(body, format)
	if len(links) == 0 {
		return nil
	}
	urls := make([]string, len(links))
	domains := make([]string, len(links))
	labels := make([]*string, len(links))
	offsets := make([]int32, len(links))
	for index, link := range links {
		urls[index], domains[index], labels[index], offsets[index] = link.URL, link.Domain, link.Label, int32(link.Offset)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_links (org_id, chat_id, message_id, position, actor_id, created_seq, url, domain, label, text_offset)
		SELECT $1, $2, $3, ordinal - 1, $4, $5, url, domain, label, text_offset
		FROM unnest($6::text[], $7::text[], $8::text[], $9::int[]) WITH ORDINALITY AS l(url, domain, label, text_offset, ordinal)
		ON CONFLICT (message_id, position) DO NOTHING`,
		orgID, chatID, messageID, actorID, seq, urls, domains, labels, offsets); err != nil {
		return fmt.Errorf("insert message links: %w", err)
	}
	return nil
}

// indexAttachments records the files of messages in chat_attachments. It
// starts from the given ids and follows primary keys only, so the plan does
// not depend on statistics of the (possibly huge) organization.
func indexAttachments(ctx context.Context, tx pgx.Tx, messageIDs []string) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO chat_attachments (org_id, chat_id, message_id, file_id, ordinal, actor_id, created_seq, kind)
		SELECT m.org_id, m.chat_id, m.id, mf.file_id, mf.ordinal, m.actor_id, m.created_seq, `+sharedKindSQL+`
		FROM unnest($1::uuid[]) AS batch(id)
		JOIN messages m ON m.id = batch.id AND m.deleted_at IS NULL
		JOIN message_files mf ON mf.message_id = m.id AND mf.org_id = m.org_id
		JOIN files f ON f.id = mf.file_id AND f.org_id = mf.org_id
		ON CONFLICT (message_id, file_id) DO NOTHING`, messageIDs); err != nil {
		return fmt.Errorf("index chat attachments: %w", err)
	}
	return nil
}

// dropShared removes a deleted message from the shared media of its chat.
func dropShared(ctx context.Context, tx pgx.Tx, messageID string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM chat_attachments WHERE message_id = $1`, messageID); err != nil {
		return fmt.Errorf("drop chat attachments: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM message_links WHERE message_id = $1`, messageID); err != nil {
		return fmt.Errorf("drop message links: %w", err)
	}
	return nil
}

// Backfill of messages written before chat_attachments and message_links
// existed. It walks messages in id order, sharedBackfillBatch at a time, each
// batch in its own short transaction that gives up on a lock after 5 s; the
// last id done is stored, so a restart continues where it stopped. Messages
// of a batch are read FOR SHARE: an edit of one of them waits for the batch
// and then rewrites the links itself, so no old link survives an edit.
// Several servers may run it at once: a batch runs only under a transaction
// advisory lock, the others skip their turn.

const sharedBackfillBatch = 500

// ErrBackfillBusy: another server holds the backfill lock; try again later.
var ErrBackfillBusy = errors.New("shared media backfill is running elsewhere")

// BackfillSharedBatch handles one batch and reports whether the backfill is
// complete.
func (s *Service) BackfillSharedBatch(ctx context.Context) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin shared backfill: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'`); err != nil {
		return false, fmt.Errorf("limit shared backfill: %w", err)
	}
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended('shared_backfill', 0))`).Scan(&locked); err != nil {
		return false, fmt.Errorf("lock shared backfill: %w", err)
	}
	if !locked {
		return false, ErrBackfillBusy
	}
	var last *string
	var done *time.Time
	err = tx.QueryRow(ctx, `SELECT last_message_id, done_at FROM shared_backfill WHERE name = 'chat_shared'`).Scan(&last, &done)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("read shared backfill progress: %w", err)
	}
	if done != nil {
		return true, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT id, org_id, chat_id, actor_id, created_seq, body, body_format, deleted_at IS NOT NULL
		FROM messages
		WHERE $1::uuid IS NULL OR id > $1
		ORDER BY id
		LIMIT $2
		FOR SHARE`, last, sharedBackfillBatch)
	if err != nil {
		return false, fmt.Errorf("read messages to backfill: %w", err)
	}
	type pending struct {
		id, org, chat, actor, body, format string
		seq                                int64
		deleted                            bool
	}
	batch := make([]pending, 0, sharedBackfillBatch)
	for rows.Next() {
		var item pending
		if err := rows.Scan(&item.id, &item.org, &item.chat, &item.actor, &item.seq, &item.body, &item.format, &item.deleted); err != nil {
			rows.Close()
			return false, fmt.Errorf("scan message to backfill: %w", err)
		}
		batch = append(batch, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("iterate messages to backfill: %w", err)
	}
	live := make([]string, 0, len(batch))
	for _, item := range batch {
		if item.deleted {
			continue
		}
		live = append(live, item.id)
		// Live writes replace links whole; the backfill only fills messages
		// that have none yet, so it never undoes an edit made meanwhile.
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM message_links WHERE message_id = $1)`, item.id).Scan(&exists); err != nil {
			return false, fmt.Errorf("check backfilled links: %w", err)
		}
		if !exists {
			if err := insertMessageLinks(ctx, tx, item.org, item.id, item.chat, item.actor, item.seq, item.body, item.format); err != nil {
				return false, err
			}
		}
	}
	if err := indexAttachments(ctx, tx, live); err != nil {
		return false, err
	}
	finished := len(batch) < sharedBackfillBatch
	var lastID any
	if len(batch) > 0 {
		lastID = batch[len(batch)-1].id
	} else {
		lastID = last
	}
	if _, err := tx.Exec(ctx, `
		UPDATE shared_backfill SET last_message_id = $1, updated_at = now(),
			done_at = CASE WHEN $2 THEN now() END
		WHERE name = 'chat_shared'`, lastID, finished); err != nil {
		return false, fmt.Errorf("save shared backfill progress: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit shared backfill: %w", err)
	}
	return finished, nil
}

// BackfillShared runs batches until the backfill is complete or ctx ends,
// pausing between batches so live traffic keeps the database. Errors (a lock
// timeout, a restart of the database) are logged by the caller's report and
// retried after a longer pause.
func (s *Service) BackfillShared(ctx context.Context, pause time.Duration, report func(error)) {
	for {
		done, err := s.BackfillSharedBatch(ctx)
		if done {
			return
		}
		wait := pause
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if !errors.Is(err, ErrBackfillBusy) && report != nil {
				report(err)
			}
			wait = 30 * time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}
