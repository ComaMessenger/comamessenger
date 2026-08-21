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

const maxAvatarBytes = 512 << 10

type AvatarUpdate struct {
	ActorID       string `json:"actor_id"`
	AvatarVersion int64  `json:"avatar_version"`
}

type avatarFile struct {
	ID, Key, MIME, Name string
	Size                int64
}

func (s *Service) PutAvatar(ctx context.Context, current identity.User, targetActorID, declaredContentType string, body io.Reader) (AvatarUpdate, error) {
	if !canManageAvatar(current, targetActorID) {
		return AvatarUpdate{}, ErrForbidden
	}
	data, err := readBounded(body, maxAvatarBytes)
	if err != nil || len(data) == 0 {
		return AvatarUpdate{}, fmt.Errorf("%w: avatar must be between 1 and 512 KiB", ErrInvalid)
	}
	detected := http.DetectContentType(data)
	declared, _, parseErr := mime.ParseMediaType(strings.TrimSpace(declaredContentType))
	if parseErr != nil || declared != detected || !allowedAvatarMIME(detected) {
		return AvatarUpdate{}, fmt.Errorf("%w: avatar must be a PNG, JPEG, or WebP image", ErrInvalid)
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > maxImagePixels {
		return AvatarUpdate{}, fmt.Errorf("%w: invalid or oversized avatar image", ErrInvalid)
	}
	fileID, err := id.New()
	if err != nil {
		return AvatarUpdate{}, err
	}
	compact := strings.ReplaceAll(fileID, "-", "")
	extension := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[detected]
	key := "avatars/" + compact[:2] + "/" + fileID + extension
	checksum := sha256.Sum256(data)
	if _, err := s.store.Put(ctx, storage.PutRequest{Key: key, ContentType: detected, Size: int64(len(data)), ExpectedSHA256: &checksum, Body: bytes.NewReader(data)}); err != nil {
		if errors.Is(err, storage.ErrStorageFull) {
			return AvatarUpdate{}, ErrStorageFull
		}
		return AvatarUpdate{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		_ = s.store.Delete(context.Background(), key)
		return AvatarUpdate{}, err
	}
	defer tx.Rollback(ctx)
	var old avatarFile
	var oldID, oldKey, oldMIME, oldName *string
	var oldSize *int64
	var version int64
	err = tx.QueryRow(ctx, `
		SELECT a.avatar_file_id, f.storage_key, f.mime, f.name, f.size, a.avatar_version
		FROM actors a LEFT JOIN files f ON f.id = a.avatar_file_id AND f.org_id = a.org_id
		WHERE a.org_id = $1 AND a.id = $2 AND a.status = 'active' AND a.deleted_at IS NULL
		FOR UPDATE OF a`, current.OrgID, targetActorID).Scan(&oldID, &oldKey, &oldMIME, &oldName, &oldSize, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = s.store.Delete(context.Background(), key)
		return AvatarUpdate{}, ErrNotFound
	}
	if err != nil {
		_ = s.store.Delete(context.Background(), key)
		return AvatarUpdate{}, err
	}
	if oldID != nil && oldKey != nil && oldSize != nil {
		old = avatarFile{ID: *oldID, Key: *oldKey, Size: *oldSize}
		if oldMIME != nil {
			old.MIME = *oldMIME
		}
		if oldName != nil {
			old.Name = *oldName
		}
	}
	oldBytes := old.Size
	if _, err := tx.Exec(ctx, `INSERT INTO organization_storage_usage (org_id) VALUES ($1) ON CONFLICT DO NOTHING`, current.OrgID); err != nil {
		_ = s.store.Delete(context.Background(), key)
		return AvatarUpdate{}, err
	}
	result, err := tx.Exec(ctx, `
		UPDATE organization_storage_usage
		SET used_bytes = used_bytes - $2 + $3, updated_at = now()
		WHERE org_id = $1 AND used_bytes - $2 + reserved_bytes + $3 <= COALESCE(quota_bytes, $4)`,
		current.OrgID, oldBytes, len(data), s.quotaBytes)
	if err != nil || result.RowsAffected() != 1 {
		_ = s.store.Delete(context.Background(), key)
		if err != nil {
			return AvatarUpdate{}, err
		}
		return AvatarUpdate{}, ErrStorageFull
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO files (id, org_id, uploader_id, storage_driver, bucket, storage_key, name, mime, size, sha256, status, processing_status, ready_at)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8, $9, $10, 'ready', 'skipped', now())`,
		fileID, current.OrgID, current.ActorID, s.store.Driver(), s.bucket, key, "avatar"+extension, detected, len(data), checksum[:]); err != nil {
		_ = s.store.Delete(context.Background(), key)
		return AvatarUpdate{}, err
	}
	version++
	if _, err := tx.Exec(ctx, `UPDATE actors SET avatar_file_id = $3, avatar_version = $4 WHERE org_id = $1 AND id = $2`, current.OrgID, targetActorID, fileID, version); err != nil {
		_ = s.store.Delete(context.Background(), key)
		return AvatarUpdate{}, err
	}
	if old.ID != "" {
		if _, err := tx.Exec(ctx, `UPDATE files SET status = 'deleted', deleted_at = now() WHERE org_id = $1 AND id = $2`, current.OrgID, old.ID); err != nil {
			_ = s.store.Delete(context.Background(), key)
			return AvatarUpdate{}, err
		}
	}
	seq, err := appendAvatarEvent(ctx, tx, current, targetActorID, version)
	if err != nil {
		_ = s.store.Delete(context.Background(), key)
		return AvatarUpdate{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		_ = s.store.Delete(context.Background(), key)
		return AvatarUpdate{}, err
	}
	if old.Key != "" {
		_ = s.store.Delete(context.Background(), old.Key)
	}
	if s.afterCommit != nil {
		s.afterCommit(current.OrgID, seq)
	}
	return AvatarUpdate{ActorID: targetActorID, AvatarVersion: version}, nil
}

func (s *Service) DeleteAvatar(ctx context.Context, current identity.User, targetActorID string) (AvatarUpdate, error) {
	if !canManageAvatar(current, targetActorID) {
		return AvatarUpdate{}, ErrForbidden
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AvatarUpdate{}, err
	}
	defer tx.Rollback(ctx)
	var old avatarFile
	var version int64
	err = tx.QueryRow(ctx, `
		SELECT f.id, f.storage_key, f.size, a.avatar_version
		FROM actors a JOIN files f ON f.id = a.avatar_file_id AND f.org_id = a.org_id
		WHERE a.org_id = $1 AND a.id = $2 AND a.status = 'active' AND a.deleted_at IS NULL
		FOR UPDATE OF a`, current.OrgID, targetActorID).Scan(&old.ID, &old.Key, &old.Size, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return AvatarUpdate{}, ErrNotFound
	}
	if err != nil {
		return AvatarUpdate{}, err
	}
	version++
	if _, err := tx.Exec(ctx, `UPDATE actors SET avatar_file_id = NULL, avatar_version = $3 WHERE org_id = $1 AND id = $2`, current.OrgID, targetActorID, version); err != nil {
		return AvatarUpdate{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET status = 'deleted', deleted_at = now() WHERE org_id = $1 AND id = $2`, current.OrgID, old.ID); err != nil {
		return AvatarUpdate{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE organization_storage_usage SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = now() WHERE org_id = $1`, current.OrgID, old.Size); err != nil {
		return AvatarUpdate{}, err
	}
	seq, err := appendAvatarEvent(ctx, tx, current, targetActorID, version)
	if err != nil {
		return AvatarUpdate{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AvatarUpdate{}, err
	}
	_ = s.store.Delete(context.Background(), old.Key)
	if s.afterCommit != nil {
		s.afterCommit(current.OrgID, seq)
	}
	return AvatarUpdate{ActorID: targetActorID, AvatarVersion: version}, nil
}

func (s *Service) Avatar(ctx context.Context, current identity.User, targetActorID string) (Download, error) {
	var file File
	err := s.pool.QueryRow(ctx, `
		SELECT f.id, f.name, f.mime, f.size, f.status, f.processing_status, f.created_at, f.ready_at,
		       f.uploader_id, f.storage_key, f.storage_driver
		FROM actors a JOIN files f ON f.id = a.avatar_file_id AND f.org_id = a.org_id AND f.status = 'ready'
		WHERE a.org_id = $1 AND a.id = $2 AND a.status = 'active' AND a.deleted_at IS NULL`, current.OrgID, targetActorID).Scan(
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

func canManageAvatar(current identity.User, targetActorID string) bool {
	return current.ActorID == targetActorID || permission.Allows(current.OrgRole, current.Permissions, permission.MembersManage)
}

func allowedAvatarMIME(value string) bool {
	return value == "image/png" || value == "image/jpeg" || value == "image/webp"
}

func appendAvatarEvent(ctx context.Context, tx pgx.Tx, current identity.User, targetActorID string, version int64) (int64, error) {
	data, err := json.Marshal(AvatarUpdate{ActorID: targetActorID, AvatarVersion: version})
	if err != nil {
		return 0, err
	}
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`, current.OrgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("advance avatar event sequence: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, subject_id, data)
		VALUES ($1, $2, 'actor.avatar.updated', $3, $4, $5)`, current.OrgID, seq, current.ActorID, targetActorID, data); err != nil {
		return 0, fmt.Errorf("append avatar event: %w", err)
	}
	return seq, nil
}
