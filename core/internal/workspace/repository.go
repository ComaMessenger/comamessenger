package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Repository struct{ pool *pgxpool.Pool }

func NewRepository(pool *pgxpool.Pool) *Repository { return &Repository{pool: pool} }

func (r *Repository) Settings(ctx context.Context, orgID string) (Settings, error) {
	var value Settings
	err := r.pool.QueryRow(ctx, `
		SELECT o.id,o.name,o.slug::text,o.version,
		       COALESCE(o.settings->>'invitation_default_role','member'),
		       COALESCE((o.settings->>'invitation_ttl_hours')::int,168),
		       COALESCE(o.settings->>'default_timezone','UTC'),
		       COALESCE((o.settings->>'allow_member_invitations')::bool,false),
		       COALESCE((o.settings->>'allow_public_chat_creation')::bool,true),
		       COALESCE((o.settings->>'allow_channel_creation')::bool,false),
		       COALESCE(o.settings->>'accent_color','#174586'),
		       EXISTS(SELECT 1 FROM organization_branding_assets a WHERE a.org_id=o.id AND a.kind='logo'),
		       EXISTS(SELECT 1 FROM organization_branding_assets a WHERE a.org_id=o.id AND a.kind='favicon')
		FROM organizations o WHERE o.id=$1`, orgID).Scan(
		&value.ID, &value.Name, &value.Slug, &value.Version, &value.InvitationDefaultRole,
		&value.InvitationTTLHours, &value.DefaultTimezone, &value.AllowMemberInvitations, &value.AllowPublicChatCreation, &value.AllowChannelCreation,
		&value.AccentColor, &value.HasLogo, &value.HasFavicon,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Settings{}, ErrNotFound
	}
	if err != nil {
		return Settings{}, fmt.Errorf("read workspace settings: %w", err)
	}
	return value, nil
}

func (r *Repository) UpdateSettings(ctx context.Context, orgID, actorID string, input UpdateSettingsInput) (Settings, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return Settings{}, err
	}
	defer tx.Rollback(ctx)
	settingsJSON, err := json.Marshal(map[string]any{
		"invitation_default_role":    input.InvitationDefaultRole,
		"invitation_ttl_hours":       input.InvitationTTLHours,
		"default_timezone":           input.DefaultTimezone,
		"allow_member_invitations":   input.AllowMemberInvitations,
		"allow_public_chat_creation": input.AllowPublicChatCreation,
		"allow_channel_creation":     input.AllowChannelCreation,
		"accent_color":               input.AccentColor,
	})
	if err != nil {
		return Settings{}, err
	}
	command, err := tx.Exec(ctx, `UPDATE organizations SET name=$3,slug=$4,settings=settings || $5::jsonb,version=version+1 WHERE id=$1 AND version=$2`, orgID, input.ExpectedVersion, input.Name, input.Slug, settingsJSON)
	if uniqueViolation(err) {
		return Settings{}, fmt.Errorf("%w: workspace slug is already in use", ErrInvalid)
	}
	if err != nil {
		return Settings{}, fmt.Errorf("update workspace settings: %w", err)
	}
	if command.RowsAffected() != 1 {
		return Settings{}, ErrVersionConflict
	}
	if err := insertAudit(ctx, tx, orgID, actorID, "organization.settings.update", "organization", &orgID, map[string]any{"version": input.ExpectedVersion + 1}); err != nil {
		return Settings{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Settings{}, err
	}
	return r.Settings(ctx, orgID)
}

func (r *Repository) PutAsset(ctx context.Context, orgID, actorID, kind, contentType string, content []byte) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO organization_branding_assets(org_id,kind,content_type,content,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_id,kind) DO UPDATE SET content_type=EXCLUDED.content_type,content=EXCLUDED.content,updated_by=EXCLUDED.updated_by,updated_at=now()`, orgID, kind, contentType, content, actorID)
	if err != nil {
		return fmt.Errorf("store branding asset: %w", err)
	}
	_, err = tx.Exec(ctx, `UPDATE organizations SET version=version+1 WHERE id=$1`, orgID)
	if err != nil {
		return err
	}
	if err := insertAudit(ctx, tx, orgID, actorID, "organization.branding.update", "branding_asset", nil, map[string]any{"kind": kind, "content_type": contentType, "size": len(content)}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repository) DeleteAsset(ctx context.Context, orgID, actorID, kind string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `DELETE FROM organization_branding_assets WHERE org_id=$1 AND kind=$2`, orgID, kind)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE organizations SET version=version+1 WHERE id=$1`, orgID)
	if err != nil {
		return err
	}
	if err := insertAudit(ctx, tx, orgID, actorID, "organization.branding.delete", "branding_asset", nil, map[string]any{"kind": kind}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repository) PublicBranding(ctx context.Context) (PublicBranding, error) {
	var value PublicBranding
	var hasLogo, hasFavicon bool
	err := r.pool.QueryRow(ctx, `SELECT id,name,COALESCE(settings->>'accent_color','#174586'),version,EXISTS(SELECT 1 FROM organization_branding_assets a WHERE a.org_id=o.id AND kind='logo'),EXISTS(SELECT 1 FROM organization_branding_assets a WHERE a.org_id=o.id AND kind='favicon') FROM organizations o LIMIT 1`).Scan(&value.OrgID, &value.WorkspaceName, &value.AccentColor, &value.Version, &hasLogo, &hasFavicon)
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicBranding{WorkspaceName: "Coma", AccentColor: "#174586", Version: 0}, nil
	}
	if err != nil {
		return PublicBranding{}, err
	}
	if hasLogo {
		value.LogoURL = fmt.Sprintf("/api/v1/branding/logo?v=%d", value.Version)
	}
	if hasFavicon {
		value.FaviconURL = fmt.Sprintf("/api/v1/branding/favicon?v=%d", value.Version)
	}
	return value, nil
}

func (r *Repository) Asset(ctx context.Context, kind string) (Asset, error) {
	var value Asset
	err := r.pool.QueryRow(ctx, `SELECT content_type,content,updated_at FROM organization_branding_assets WHERE kind=$1 LIMIT 1`, kind).Scan(&value.ContentType, &value.Content, &value.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Asset{}, ErrNotFound
	}
	if err != nil {
		return Asset{}, err
	}
	return value, nil
}

func (r *Repository) Integration(ctx context.Context, orgID string) (int64, []byte, error) {
	var version int64
	var encrypted []byte
	err := r.pool.QueryRow(ctx, `SELECT version,encrypted_config FROM organization_integrations WHERE org_id=$1`, orgID).Scan(&version, &encrypted)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, nil
	}
	if err != nil {
		return 0, nil, err
	}
	return version, encrypted, nil
}

func (r *Repository) PutIntegration(ctx context.Context, orgID, actorID string, expectedVersion int64, encrypted []byte) (int64, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var next int64
	if expectedVersion == 0 {
		err = tx.QueryRow(ctx, `INSERT INTO organization_integrations(org_id,encrypted_config,updated_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING version`, orgID, encrypted, actorID).Scan(&next)
	} else {
		err = tx.QueryRow(ctx, `UPDATE organization_integrations SET encrypted_config=$3,updated_by=$4,updated_at=now(),version=version+1 WHERE org_id=$1 AND version=$2 RETURNING version`, orgID, expectedVersion, encrypted, actorID).Scan(&next)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrVersionConflict
	}
	if err != nil {
		return 0, err
	}
	if err := insertAudit(ctx, tx, orgID, actorID, "organization.infrastructure.update", "organization", &orgID, map[string]any{"version": next}); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return next, nil
}

func (r *Repository) Members(ctx context.Context, orgID string) ([]Member, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT a.id,u.email::text,a.display_name,a.handle::text,a.title,a.org_role,a.status,a.created_at,
		       (SELECT max(s.last_seen_at) FROM sessions s WHERE s.actor_id=a.id),
		       ARRAY(SELECT ap.permission FROM actor_permissions ap WHERE ap.org_id=a.org_id AND ap.actor_id=a.id ORDER BY ap.permission),
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_emoji ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_text ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_expires_at END
		FROM actors a
		JOIN users u ON u.actor_id=a.id
		WHERE a.org_id=$1 AND a.deleted_at IS NULL
		ORDER BY a.display_name,a.id`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Member, 0)
	for rows.Next() {
		var item Member
		var stored []string
		if err := rows.Scan(&item.ActorID, &item.Email, &item.DisplayName, &item.Handle, &item.Title, &item.Role, &item.Status, &item.CreatedAt, &item.LastSeenAt, &stored, &item.StatusEmoji, &item.StatusText, &item.StatusExpiresAt); err != nil {
			return nil, err
		}
		item.Permissions = effectivePermissions(item.Role, stored)
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *Repository) UpdateMember(ctx context.Context, orgID, currentActorID, targetActorID string, input UpdateMemberInput) (Member, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return Member{}, err
	}
	defer tx.Rollback(ctx)
	var currentRole, targetRole, targetStatus string
	if err := tx.QueryRow(ctx, `SELECT org_role FROM actors WHERE id=$1 AND org_id=$2 AND status='active'`, currentActorID, orgID).Scan(&currentRole); err != nil {
		return Member{}, ErrForbidden
	}
	if err := tx.QueryRow(ctx, `SELECT org_role,status FROM actors WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`, targetActorID, orgID).Scan(&targetRole, &targetStatus); errors.Is(err, pgx.ErrNoRows) {
		return Member{}, ErrNotFound
	} else if err != nil {
		return Member{}, err
	}
	var previousPermissions []string
	if err := tx.QueryRow(ctx, `SELECT ARRAY(SELECT permission FROM actor_permissions WHERE org_id=$1 AND actor_id=$2 ORDER BY permission)`, orgID, targetActorID).Scan(&previousPermissions); err != nil {
		return Member{}, fmt.Errorf("load previous actor permissions: %w", err)
	}
	if currentRole != "owner" && (targetRole != "member" || input.Role != nil && *input.Role != "member") {
		return Member{}, ErrForbidden
	}
	if targetRole == "owner" {
		return Member{}, fmt.Errorf("%w: use the ownership transfer operation to change the owner", ErrInvalid)
	}
	role, status := targetRole, targetStatus
	if input.Role != nil {
		role = *input.Role
	}
	if input.Status != nil {
		status = *input.Status
	}
	if targetActorID == currentActorID && status != "active" {
		return Member{}, fmt.Errorf("%w: current user cannot deactivate themselves", ErrInvalid)
	}
	if input.Permissions != nil && (role != "admin" || status != "active") {
		return Member{}, fmt.Errorf("%w: only active administrators may have explicit permissions", ErrInvalid)
	}
	_, err = tx.Exec(ctx, `UPDATE actors SET org_role=$3,status=$4 WHERE id=$1 AND org_id=$2`, targetActorID, orgID, role, status)
	if err != nil {
		return Member{}, fmt.Errorf("update organization member: %w", err)
	}
	if role != "admin" || status != "active" || input.Permissions != nil {
		if _, err := tx.Exec(ctx, `DELETE FROM actor_permissions WHERE org_id=$1 AND actor_id=$2`, orgID, targetActorID); err != nil {
			return Member{}, fmt.Errorf("clear actor permissions: %w", err)
		}
	}
	if role == "admin" && status == "active" && input.Permissions != nil {
		for _, code := range *input.Permissions {
			if _, err := tx.Exec(ctx, `INSERT INTO actor_permissions(org_id,actor_id,permission,granted_by) VALUES($1,$2,$3,$4)`, orgID, targetActorID, code, currentActorID); err != nil {
				return Member{}, fmt.Errorf("grant actor permission: %w", err)
			}
		}
	}
	auditAction := "organization.member.update"
	auditMetadata := map[string]any{"role": role, "status": status}
	if input.Permissions != nil {
		auditAction = "organization.member.permissions.update"
		auditMetadata["changes"] = map[string]any{
			"permissions": map[string]any{
				"from": effectivePermissions(targetRole, previousPermissions),
				"to":   *input.Permissions,
			},
		}
	}
	if err := insertAudit(ctx, tx, orgID, currentActorID, auditAction, "actor", &targetActorID, auditMetadata); err != nil {
		return Member{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23514" {
			return Member{}, fmt.Errorf("%w: an organization must keep at least one active owner", ErrInvalid)
		}
		return Member{}, fmt.Errorf("commit member update: %w", err)
	}
	var result Member
	var stored []string
	err = r.pool.QueryRow(ctx, `
		SELECT a.id,u.email::text,a.display_name,a.handle::text,a.title,a.org_role,a.status,a.created_at,
		       (SELECT max(s.last_seen_at) FROM sessions s WHERE s.actor_id=a.id),
		       ARRAY(SELECT ap.permission FROM actor_permissions ap WHERE ap.org_id=a.org_id AND ap.actor_id=a.id ORDER BY ap.permission),
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_emoji ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_text ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_expires_at END
		FROM actors a
		JOIN users u ON u.actor_id=a.id
		WHERE a.id=$1`, targetActorID).Scan(&result.ActorID, &result.Email, &result.DisplayName, &result.Handle, &result.Title, &result.Role, &result.Status, &result.CreatedAt, &result.LastSeenAt, &stored, &result.StatusEmoji, &result.StatusText, &result.StatusExpiresAt)
	if err != nil {
		return Member{}, err
	}
	result.Permissions = effectivePermissions(result.Role, stored)
	return result, nil
}

func (r *Repository) RequirePasswordChange(ctx context.Context, orgID, currentActorID, targetActorID, currentRole string, now time.Time) ([]string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var targetRole, targetStatus string
	err = tx.QueryRow(ctx, `SELECT org_role,status FROM actors WHERE org_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, orgID, targetActorID).Scan(&targetRole, &targetStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if targetStatus != "active" || targetRole == "owner" || (currentRole != "owner" && targetRole != "member") {
		return nil, ErrForbidden
	}
	command, err := tx.Exec(ctx, `UPDATE users SET must_change_password_at=$3 WHERE org_id=$1 AND actor_id=$2`, orgID, targetActorID, now)
	if err != nil || command.RowsAffected() != 1 {
		return nil, ErrNotFound
	}
	rows, err := tx.Query(ctx, `UPDATE sessions SET revoked_at=COALESCE(revoked_at,$3) WHERE org_id=$1 AND actor_id=$2 AND revoked_at IS NULL RETURNING id`, orgID, targetActorID, now)
	if err != nil {
		return nil, err
	}
	var revoked []string
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			rows.Close()
			return nil, err
		}
		revoked = append(revoked, sessionID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if err := insertAudit(ctx, tx, orgID, currentActorID, "member.password_change.require", "actor", &targetActorID, map[string]any{"revoked_sessions": len(revoked)}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return revoked, nil
}

func effectivePermissions(role string, stored []string) []permission.Code {
	granted := make([]permission.Code, len(stored))
	for index, code := range stored {
		granted[index] = permission.Code(code)
	}
	return permission.Effective(role, granted)
}

func (r *Repository) Audit(ctx context.Context, orgID string, limit int) (AuditPage, error) {
	rows, err := r.pool.Query(ctx, `SELECT l.id,l.actor_id,a.display_name,l.action,l.target_type,l.target_id,l.metadata,l.created_at FROM audit_log l LEFT JOIN actors a ON a.id=l.actor_id WHERE l.org_id=$1 ORDER BY l.created_at DESC,l.id DESC LIMIT $2`, orgID, limit)
	if err != nil {
		return AuditPage{}, err
	}
	defer rows.Close()
	page := AuditPage{Events: make([]AuditEntry, 0)}
	for rows.Next() {
		var item AuditEntry
		var raw []byte
		if err := rows.Scan(&item.ID, &item.ActorID, &item.ActorName, &item.Action, &item.TargetType, &item.TargetID, &raw, &item.CreatedAt); err != nil {
			return AuditPage{}, err
		}
		if err := json.Unmarshal(raw, &item.Metadata); err != nil {
			return AuditPage{}, err
		}
		page.Events = append(page.Events, item)
	}
	return page, rows.Err()
}

type auditExecer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func insertAudit(ctx context.Context, db auditExecer, orgID, actorID, action, targetType string, targetID *string, metadata map[string]any) error {
	auditID, err := id.New()
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = db.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)`, auditID, orgID, actorID, action, targetType, targetID, encoded)
	return err
}

func uniqueViolation(err error) bool {
	var value *pgconn.PgError
	return errors.As(err, &value) && value.Code == "23505"
}
