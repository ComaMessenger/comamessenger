package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/jackc/pgx/v5"
)

// ErrDirectChat rejects avatar changes for direct chats: they show the peer.
var ErrDirectChat = fmt.Errorf("%w: direct chats use the peer avatar", ErrInvalid)

// ChatAvatarUpdate reports the effective avatar version of a chat: zero means
// the chat has no image and clients render initials.
type ChatAvatarUpdate struct {
	ChatID        string `json:"chat_id"`
	AvatarVersion int64  `json:"avatar_version"`
}

type chatAvatarState struct {
	kind, role string
	version    int64
	old        avatarFile
}

// lockChatAvatar loads the chat row for update and checks who may change it:
// chat owners and admins, or workspace members with chats.moderate (the
// workspace owner always has it), the same rule as archiving a chat.
func lockChatAvatar(ctx context.Context, tx pgx.Tx, current identity.User, chatID string) (chatAvatarState, error) {
	var state chatAvatarState
	var oldID, oldKey *string
	var oldSize *int64
	err := tx.QueryRow(ctx, `
		SELECT c.kind, COALESCE(cm.role, ''), c.avatar_version, f.id, f.storage_key, f.size
		FROM chats c
		LEFT JOIN chat_members cm ON cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id = $3
		LEFT JOIN files f ON f.id = c.avatar_file_id AND f.org_id = c.org_id
		WHERE c.org_id = $1 AND c.id = $2 AND c.archived_at IS NULL
		FOR UPDATE OF c`, current.OrgID, chatID, current.ActorID).Scan(&state.kind, &state.role, &state.version, &oldID, &oldKey, &oldSize)
	if errors.Is(err, pgx.ErrNoRows) {
		return state, ErrNotFound
	}
	if err != nil {
		return state, err
	}
	moderator := permission.Allows(current.OrgRole, current.Permissions, permission.ChatsModerate)
	if state.role == "" && (!moderator || state.kind == "direct") {
		return state, ErrNotFound
	}
	if state.kind == "direct" {
		return state, ErrDirectChat
	}
	if !moderator && state.role != "owner" && state.role != "admin" {
		return state, ErrForbidden
	}
	if oldID != nil && oldKey != nil && oldSize != nil {
		state.old = avatarFile{ID: *oldID, Key: *oldKey, Size: *oldSize}
	}
	return state, nil
}

func (s *Service) PutChatAvatar(ctx context.Context, current identity.User, chatID, declaredContentType string, body io.Reader) (ChatAvatarUpdate, error) {
	data, err := readBounded(body, maxAvatarBytes)
	if err != nil || len(data) == 0 {
		return ChatAvatarUpdate{}, fmt.Errorf("%w: avatar must be between 1 byte and 10 MB", ErrInvalid)
	}
	detected := http.DetectContentType(data)
	declared, _, parseErr := mime.ParseMediaType(strings.TrimSpace(declaredContentType))
	if parseErr != nil || declared != detected || (detected != "image/png" && detected != "image/jpeg") {
		return ChatAvatarUpdate{}, fmt.Errorf("%w: chat avatar must be a PNG or JPEG image", ErrInvalid)
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > maxImagePixels {
		return ChatAvatarUpdate{}, fmt.Errorf("%w: invalid or oversized avatar image", ErrInvalid)
	}

	// Check access before touching storage, then lock again inside the write.
	if err := s.checkChatAvatarAccess(ctx, current, chatID); err != nil {
		return ChatAvatarUpdate{}, err
	}
	fileID, err := id.New()
	if err != nil {
		return ChatAvatarUpdate{}, err
	}
	compact := strings.ReplaceAll(fileID, "-", "")
	extension := map[string]string{"image/png": ".png", "image/jpeg": ".jpg"}[detected]
	key := "avatars/" + compact[:2] + "/" + fileID + extension
	checksum := sha256.Sum256(data)
	if _, err := s.store.Put(ctx, storage.PutRequest{Key: key, ContentType: detected, Size: int64(len(data)), ExpectedSHA256: &checksum, Body: bytes.NewReader(data)}); err != nil {
		if errors.Is(err, storage.ErrStorageFull) {
			return ChatAvatarUpdate{}, ErrStorageFull
		}
		return ChatAvatarUpdate{}, err
	}
	stored := false
	defer func() {
		if !stored {
			_ = s.store.Delete(context.Background(), key)
		}
	}()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ChatAvatarUpdate{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, current.OrgID); err != nil {
		return ChatAvatarUpdate{}, err
	}
	state, err := lockChatAvatar(ctx, tx, current, chatID)
	if err != nil {
		return ChatAvatarUpdate{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO organization_storage_usage (org_id) VALUES ($1) ON CONFLICT DO NOTHING`, current.OrgID); err != nil {
		return ChatAvatarUpdate{}, err
	}
	result, err := tx.Exec(ctx, `
		UPDATE organization_storage_usage
		SET used_bytes = used_bytes - $2 + $3, updated_at = now()
		WHERE org_id = $1 AND used_bytes - $2 + reserved_bytes + $3 <= COALESCE(quota_bytes, $4)`,
		current.OrgID, state.old.Size, len(data), s.quotaBytes)
	if err != nil {
		return ChatAvatarUpdate{}, err
	}
	if result.RowsAffected() != 1 {
		return ChatAvatarUpdate{}, ErrStorageFull
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO files (id, org_id, uploader_id, storage_driver, bucket, storage_key, name, mime, size, sha256, status, processing_status, ready_at)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8, $9, $10, 'ready', 'skipped', now())`,
		fileID, current.OrgID, current.ActorID, s.store.Driver(), s.bucket, key, "chat-avatar"+extension, detected, len(data), checksum[:]); err != nil {
		return ChatAvatarUpdate{}, err
	}
	version := state.version + 1
	if _, err := tx.Exec(ctx, `UPDATE chats SET avatar_file_id = $3, avatar_version = $4 WHERE org_id = $1 AND id = $2`, current.OrgID, chatID, fileID, version); err != nil {
		return ChatAvatarUpdate{}, err
	}
	if state.old.ID != "" {
		if _, err := tx.Exec(ctx, `UPDATE files SET status = 'deleted', deleted_at = now() WHERE org_id = $1 AND id = $2`, current.OrgID, state.old.ID); err != nil {
			return ChatAvatarUpdate{}, err
		}
	}
	update := ChatAvatarUpdate{ChatID: chatID, AvatarVersion: version}
	seq, err := appendChatAvatarEvent(ctx, tx, current, update)
	if err != nil {
		return ChatAvatarUpdate{}, err
	}
	// A failed COMMIT may still have been applied (its answer lost), so the
	// new object is kept from here on; reconciliation removes it if no row
	// points at it.
	stored = true
	if err := tx.Commit(ctx); err != nil {
		return ChatAvatarUpdate{}, err
	}
	if state.old.Key != "" {
		_ = s.store.Delete(context.Background(), state.old.Key)
	}
	if s.afterCommit != nil {
		s.afterCommit(current.OrgID, seq)
	}
	return update, nil
}

func (s *Service) DeleteChatAvatar(ctx context.Context, current identity.User, chatID string) (ChatAvatarUpdate, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ChatAvatarUpdate{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, current.OrgID); err != nil {
		return ChatAvatarUpdate{}, err
	}
	state, err := lockChatAvatar(ctx, tx, current, chatID)
	if err != nil {
		return ChatAvatarUpdate{}, err
	}
	if state.old.ID == "" {
		return ChatAvatarUpdate{}, ErrNotFound
	}
	if _, err := tx.Exec(ctx, `UPDATE chats SET avatar_file_id = NULL, avatar_version = $3 WHERE org_id = $1 AND id = $2`, current.OrgID, chatID, state.version+1); err != nil {
		return ChatAvatarUpdate{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET status = 'deleted', deleted_at = now() WHERE org_id = $1 AND id = $2`, current.OrgID, state.old.ID); err != nil {
		return ChatAvatarUpdate{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE organization_storage_usage SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = now() WHERE org_id = $1`, current.OrgID, state.old.Size); err != nil {
		return ChatAvatarUpdate{}, err
	}
	// Without an image the effective version is zero: clients show initials.
	update := ChatAvatarUpdate{ChatID: chatID, AvatarVersion: 0}
	seq, err := appendChatAvatarEvent(ctx, tx, current, update)
	if err != nil {
		return ChatAvatarUpdate{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ChatAvatarUpdate{}, err
	}
	_ = s.store.Delete(context.Background(), state.old.Key)
	if s.afterCommit != nil {
		s.afterCommit(current.OrgID, seq)
	}
	return update, nil
}

// ChatAvatar returns the image to chat members and to moderators of group
// chats and channels; everyone else gets ErrNotFound.
func (s *Service) ChatAvatar(ctx context.Context, current identity.User, chatID string) (Download, error) {
	moderator := permission.Allows(current.OrgRole, current.Permissions, permission.ChatsModerate)
	var file File
	err := s.pool.QueryRow(ctx, `
		SELECT f.id, f.name, f.mime, f.size, f.status, f.processing_status, f.created_at, f.ready_at,
		       f.uploader_id, f.storage_key, f.storage_driver
		FROM chats c JOIN files f ON f.id = c.avatar_file_id AND f.org_id = c.org_id AND f.status = 'ready'
		WHERE c.org_id = $1 AND c.id = $2 AND c.archived_at IS NULL AND c.kind IN ('group', 'channel')
		  AND ($4::boolean OR EXISTS (
			SELECT 1 FROM chat_members cm WHERE cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id = $3
		  ))`, current.OrgID, chatID, current.ActorID, moderator).Scan(
		&file.ID, &file.Name, &file.MIME, &file.Size, &file.Status, &file.ProcessingStatus, &file.CreatedAt, &file.ReadyAt,
		&file.UploaderID, &file.storageKey, &file.storageDriver)
	if errors.Is(err, pgx.ErrNoRows) {
		return Download{}, ErrNotFound
	}
	if err != nil {
		return Download{}, err
	}
	if s.store.Capabilities().PresignedUpload {
		signed, err := s.store.PresignDownload(ctx, file.storageKey, s.presignTTL)
		if err != nil {
			return Download{}, err
		}
		return Download{File: file, URL: signed.String()}, nil
	}
	reader, _, err := s.store.Open(ctx, file.storageKey)
	if err != nil {
		return Download{}, err
	}
	return Download{File: file, Reader: reader}, nil
}

func (s *Service) checkChatAvatarAccess(ctx context.Context, current identity.User, chatID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = lockChatAvatar(ctx, tx, current, chatID)
	return err
}

func appendChatAvatarEvent(ctx context.Context, tx pgx.Tx, current identity.User, update ChatAvatarUpdate) (int64, error) {
	data, err := json.Marshal(update)
	if err != nil {
		return 0, err
	}
	auditID, err := id.New()
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id)
		VALUES ($1, $2, $3, 'chat.avatar.update', 'chat', $4)`, auditID, current.OrgID, current.ActorID, update.ChatID); err != nil {
		return 0, fmt.Errorf("write chat avatar audit: %w", err)
	}
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`, current.OrgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("advance chat avatar event sequence: %w", err)
	}
	// chat.updated with chat_id reaches every member; clients reload the chat list.
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, data)
		VALUES ($1, $2, 'chat.updated', $3, $4, $4, $5)`, current.OrgID, seq, current.ActorID, update.ChatID, data); err != nil {
		return 0, fmt.Errorf("append chat avatar event: %w", err)
	}
	return seq, nil
}
