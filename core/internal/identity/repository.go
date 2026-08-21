package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/comamessenger/comamessenger/core/internal/permission"
)

type Repository struct {
	pool *pgxpool.Pool
}

func (r *Repository) InvitationPolicy(ctx context.Context, orgID string) (string, time.Duration, error) {
	var role string
	var ttlHours int
	err := r.pool.QueryRow(ctx, `
		SELECT COALESCE(settings->>'invitation_default_role', 'member'),
		       COALESCE((settings->>'invitation_ttl_hours')::int, 168)
		FROM organizations WHERE id = $1`, orgID).Scan(&role, &ttlHours)
	if err != nil {
		return "", 0, fmt.Errorf("query invitation policy: %w", err)
	}
	return role, time.Duration(ttlHours) * time.Hour, nil
}

func NewRepository(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

func (r *Repository) BootstrapStatus(ctx context.Context) (bool, error) {
	var exists bool
	if err := r.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM organizations)`).Scan(&exists); err != nil {
		return false, fmt.Errorf("query bootstrap status: %w", err)
	}
	return exists, nil
}

func (r *Repository) Bootstrap(ctx context.Context, record BootstrapRecord) (User, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return User{}, fmt.Errorf("begin bootstrap: %w", err)
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `
		INSERT INTO organizations (id, name, slug)
		VALUES ($1, $2, $3)`, record.OrganizationID, record.OrganizationName, record.OrganizationSlug)
	if isUniqueViolation(err) {
		return User{}, ErrAlreadyBootstrapped
	}
	if err != nil {
		return User{}, fmt.Errorf("insert organization: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO actors (id, org_id, type, org_role, display_name, handle, timezone)
		VALUES ($1, $2, 'user', 'owner', $3, $4, $5)`,
		record.ActorID, record.OrganizationID, record.DisplayName, record.Handle, record.Timezone)
	if err != nil {
		return User{}, fmt.Errorf("insert owner actor: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO users (actor_id, org_id, email, password_hash, email_verified_at)
		VALUES ($1, $2, $3, $4, now())`,
		record.ActorID, record.OrganizationID, record.Email, record.PasswordHash)
	if err != nil {
		return User{}, fmt.Errorf("insert owner user: %w", err)
	}
	if err := insertSession(ctx, tx, record.OrganizationID, record.ActorID, NewSession{
		ID: record.SessionID, FamilyID: record.FamilyID, RefreshHash: record.RefreshHash,
		ExpiresAt: record.SessionExpiresAt, Device: record.Device,
	}); err != nil {
		return User{}, err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id)
		VALUES ($1, $2, $3, 'organization.bootstrap', 'organization', $2)`,
		record.AuditID, record.OrganizationID, record.ActorID)
	if err != nil {
		return User{}, fmt.Errorf("insert bootstrap audit event: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		if isUniqueViolation(err) {
			return User{}, ErrAlreadyBootstrapped
		}
		return User{}, fmt.Errorf("commit bootstrap: %w", err)
	}
	return User{
		ActorID: record.ActorID, OrgID: record.OrganizationID, OrganizationName: record.OrganizationName, OrgRole: "owner",
		Email: record.Email, DisplayName: record.DisplayName, Handle: record.Handle,
		Timezone: record.Timezone, Status: "active", Permissions: permission.All(), CreatedAt: time.Now().UTC(),
	}, nil
}

func (r *Repository) FindUserByEmail(ctx context.Context, email string) (User, error) {
	var user User
	err := r.pool.QueryRow(ctx, `
		SELECT a.id, a.org_id, o.name, a.org_role, u.email::text, a.display_name, a.handle::text,
		       a.title, a.about, a.timezone, a.status, a.created_at, u.password_hash,
		       u.must_change_password_at IS NOT NULL,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_emoji ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_text ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_expires_at END
		FROM users u
		JOIN actors a ON a.id = u.actor_id
		JOIN organizations o ON o.id = a.org_id
		WHERE u.email = $1`, email).Scan(
		&user.ActorID, &user.OrgID, &user.OrganizationName, &user.OrgRole, &user.Email, &user.DisplayName,
		&user.Handle, &user.Title, &user.About, &user.Timezone, &user.Status, &user.CreatedAt, &user.PasswordHash, &user.MustChangePassword,
		&user.StatusEmoji, &user.StatusText, &user.StatusExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrInvalidCredentials
	}
	if err != nil {
		return User{}, fmt.Errorf("find user by email: %w", err)
	}
	if err := loadPermissions(ctx, r.pool, &user); err != nil {
		return User{}, err
	}
	return user, nil
}

func (r *Repository) PasswordHash(ctx context.Context, orgID, actorID string) (string, error) {
	var passwordHash string
	err := r.pool.QueryRow(ctx, `
		SELECT u.password_hash
		FROM users u
		JOIN actors a ON a.id = u.actor_id AND a.org_id = u.org_id
		WHERE u.org_id = $1 AND u.actor_id = $2
		  AND a.status = 'active' AND a.deleted_at IS NULL`, orgID, actorID).Scan(&passwordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("load password hash: %w", err)
	}
	return passwordHash, nil
}

func (r *Repository) ChangePassword(ctx context.Context, orgID, actorID, currentSessionID, passwordHash, auditID string, now time.Time) ([]string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin password change: %w", err)
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `
		UPDATE users SET password_hash=$3,must_change_password_at=NULL
		WHERE org_id=$1 AND actor_id=$2`, orgID, actorID, passwordHash)
	if err != nil {
		return nil, fmt.Errorf("update password: %w", err)
	}
	if command.RowsAffected() != 1 {
		return nil, ErrNotFound
	}
	rows, err := tx.Query(ctx, `
		UPDATE sessions SET revoked_at=COALESCE(revoked_at,$4)
		WHERE org_id=$1 AND actor_id=$2 AND id<>$3 AND revoked_at IS NULL
		RETURNING id`, orgID, actorID, currentSessionID, now)
	if err != nil {
		return nil, fmt.Errorf("revoke sessions after password change: %w", err)
	}
	var revoked []string
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan revoked session: %w", err)
		}
		revoked = append(revoked, sessionID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate revoked sessions: %w", err)
	}
	rows.Close()
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'member.password.change','actor',$3,
		       jsonb_build_object('revoked_sessions',$4::int))`, auditID, orgID, actorID, len(revoked))
	if err != nil {
		return nil, fmt.Errorf("audit password change: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit password change: %w", err)
	}
	return revoked, nil
}

func (r *Repository) ChangeEmailImmediate(ctx context.Context, orgID, actorID, currentSessionID, newEmail, auditID string, now time.Time) (User, []string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return User{}, nil, fmt.Errorf("begin email change: %w", err)
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `
		UPDATE users SET email=$3,email_verified_at=NULL
		WHERE org_id=$1 AND actor_id=$2`, orgID, actorID, newEmail)
	if isUniqueViolation(err) {
		return User{}, nil, ErrEmailTaken
	}
	if err != nil {
		return User{}, nil, fmt.Errorf("change email: %w", err)
	}
	if command.RowsAffected() != 1 {
		return User{}, nil, ErrNotFound
	}
	revoked, err := revokeOtherSessionsTx(ctx, tx, orgID, actorID, currentSessionID, now)
	if err != nil {
		return User{}, nil, err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'member.email.change','actor',$3,
		       jsonb_build_object('delivery','immediate','new_email',$4::text,'revoked_sessions',$5::int))`,
		auditID, orgID, actorID, newEmail, len(revoked))
	if err != nil {
		return User{}, nil, fmt.Errorf("audit email change: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, nil, fmt.Errorf("commit email change: %w", err)
	}
	user, err := r.ResolveSession(ctx, currentSessionID, actorID, now)
	return user, revoked, err
}

func (r *Repository) CreateEmailChange(ctx context.Context, record EmailChangeRecord, now time.Time) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin email change request: %w", err)
	}
	defer tx.Rollback(ctx)
	var taken bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE org_id=$1 AND email=$2 AND actor_id<>$3)`, record.OrgID, record.NewEmail, record.ActorID).Scan(&taken); err != nil {
		return fmt.Errorf("check email availability: %w", err)
	}
	if taken {
		return ErrEmailTaken
	}
	if _, err := tx.Exec(ctx, `UPDATE email_change_tokens SET used_at=$3 WHERE org_id=$1 AND actor_id=$2 AND used_at IS NULL`, record.OrgID, record.ActorID, now); err != nil {
		return fmt.Errorf("expire previous email change: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO email_change_tokens(id,org_id,actor_id,new_email,token_hash,expires_at)
		VALUES($1,$2,$3,$4,$5,$6)`, record.ID, record.OrgID, record.ActorID, record.NewEmail, record.TokenHash, record.ExpiresAt)
	if err != nil {
		return fmt.Errorf("store email change token: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'member.email.change.request','actor',$3,
		       jsonb_build_object('delivery','email','new_email',$4::text))`, record.AuditID, record.OrgID, record.ActorID, record.NewEmail)
	if err != nil {
		return fmt.Errorf("audit email change request: %w", err)
	}
	return tx.Commit(ctx)
}

func (r *Repository) CancelEmailChange(ctx context.Context, tokenID, actorID string, now time.Time) error {
	_, err := r.pool.Exec(ctx, `UPDATE email_change_tokens SET used_at=$3 WHERE id=$1 AND actor_id=$2 AND used_at IS NULL`, tokenID, actorID, now)
	return err
}

func (r *Repository) ConfirmEmailChange(ctx context.Context, orgID, actorID, currentSessionID string, tokenHash []byte, auditID string, now time.Time) (User, []string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return User{}, nil, fmt.Errorf("begin email confirmation: %w", err)
	}
	defer tx.Rollback(ctx)
	var tokenID, newEmail string
	err = tx.QueryRow(ctx, `
		SELECT id,new_email::text FROM email_change_tokens
		WHERE org_id=$1 AND actor_id=$2 AND token_hash=$3 AND used_at IS NULL AND expires_at>$4
		FOR UPDATE`, orgID, actorID, tokenHash, now).Scan(&tokenID, &newEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, nil, ErrTokenInvalid
	}
	if err != nil {
		return User{}, nil, fmt.Errorf("load email change token: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET email=$3,email_verified_at=$4 WHERE org_id=$1 AND actor_id=$2`, orgID, actorID, newEmail, now); err != nil {
		if isUniqueViolation(err) {
			return User{}, nil, ErrEmailTaken
		}
		return User{}, nil, fmt.Errorf("confirm email change: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE email_change_tokens SET used_at=$2 WHERE id=$1`, tokenID, now); err != nil {
		return User{}, nil, fmt.Errorf("consume email change token: %w", err)
	}
	revoked, err := revokeOtherSessionsTx(ctx, tx, orgID, actorID, currentSessionID, now)
	if err != nil {
		return User{}, nil, err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'member.email.change','actor',$3,
		       jsonb_build_object('delivery','email','new_email',$4::text,'revoked_sessions',$5::int))`, auditID, orgID, actorID, newEmail, len(revoked))
	if err != nil {
		return User{}, nil, fmt.Errorf("audit email confirmation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, nil, fmt.Errorf("commit email confirmation: %w", err)
	}
	user, err := r.ResolveSession(ctx, currentSessionID, actorID, now)
	return user, revoked, err
}

func (r *Repository) PasswordResetTargetByEmail(ctx context.Context, email string) (PasswordResetTarget, error) {
	var target PasswordResetTarget
	err := r.pool.QueryRow(ctx, `
		SELECT a.org_id,a.id,u.email::text,a.org_role,a.status
		FROM users u JOIN actors a ON a.id=u.actor_id AND a.org_id=u.org_id
		WHERE u.email=$1 AND a.deleted_at IS NULL`, email).Scan(
		&target.OrgID, &target.ActorID, &target.Email, &target.Role, &target.Status,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return PasswordResetTarget{}, ErrNotFound
	}
	if err != nil {
		return PasswordResetTarget{}, fmt.Errorf("find password reset target: %w", err)
	}
	return target, nil
}

func (r *Repository) PasswordResetTargetByActor(ctx context.Context, orgID, actorID string) (PasswordResetTarget, error) {
	var target PasswordResetTarget
	err := r.pool.QueryRow(ctx, `
		SELECT a.org_id,a.id,u.email::text,a.org_role,a.status
		FROM actors a JOIN users u ON u.actor_id=a.id AND u.org_id=a.org_id
		WHERE a.org_id=$1 AND a.id=$2 AND a.deleted_at IS NULL`, orgID, actorID).Scan(
		&target.OrgID, &target.ActorID, &target.Email, &target.Role, &target.Status,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return PasswordResetTarget{}, ErrNotFound
	}
	if err != nil {
		return PasswordResetTarget{}, fmt.Errorf("find password reset target: %w", err)
	}
	return target, nil
}

func (r *Repository) CreatePasswordReset(ctx context.Context, record PasswordResetRecord, now time.Time) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin password reset issue: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`, record.ActorID); err != nil {
		return fmt.Errorf("lock password reset issuance: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE password_reset_tokens SET used_at=$3 WHERE org_id=$1 AND actor_id=$2 AND used_at IS NULL`, record.OrgID, record.ActorID, now); err != nil {
		return fmt.Errorf("expire previous password resets: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO password_reset_tokens(id,org_id,actor_id,token_hash,delivery,issued_by,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,$7)`, record.ID, record.OrgID, record.ActorID, record.TokenHash, record.Delivery, record.IssuedBy, record.ExpiresAt)
	if err != nil {
		return fmt.Errorf("store password reset token: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'member.password_reset.issue','actor',$4,
		       jsonb_build_object('delivery',$5::text))`, record.AuditID, record.OrgID, record.IssuedBy, record.ActorID, record.Delivery)
	if err != nil {
		return fmt.Errorf("audit password reset issue: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit password reset issue: %w", err)
	}
	return nil
}

func (r *Repository) CancelPasswordReset(ctx context.Context, tokenID, actorID string, now time.Time) error {
	_, err := r.pool.Exec(ctx, `UPDATE password_reset_tokens SET used_at=$3 WHERE id=$1 AND actor_id=$2 AND used_at IS NULL`, tokenID, actorID, now)
	return err
}

func (r *Repository) ResetPassword(ctx context.Context, tokenHash []byte, passwordHash, auditID string, now time.Time) ([]string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin password reset: %w", err)
	}
	defer tx.Rollback(ctx)
	var tokenID, orgID, actorID, delivery string
	err = tx.QueryRow(ctx, `
		SELECT p.id,p.org_id,p.actor_id,p.delivery
		FROM password_reset_tokens p
		JOIN actors a ON a.id=p.actor_id AND a.org_id=p.org_id
		WHERE p.token_hash=$1 AND p.used_at IS NULL AND p.expires_at>$2
		  AND a.status='active' AND a.deleted_at IS NULL
		FOR UPDATE OF p`, tokenHash, now).Scan(&tokenID, &orgID, &actorID, &delivery)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTokenInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("load password reset token: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET password_hash=$3,must_change_password_at=NULL WHERE org_id=$1 AND actor_id=$2`, orgID, actorID, passwordHash); err != nil {
		return nil, fmt.Errorf("reset password: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE password_reset_tokens SET used_at=$2 WHERE id=$1`, tokenID, now); err != nil {
		return nil, fmt.Errorf("consume password reset token: %w", err)
	}
	rows, err := tx.Query(ctx, `UPDATE sessions SET revoked_at=COALESCE(revoked_at,$3) WHERE org_id=$1 AND actor_id=$2 AND revoked_at IS NULL RETURNING id`, orgID, actorID, now)
	if err != nil {
		return nil, fmt.Errorf("revoke sessions after password reset: %w", err)
	}
	var revoked []string
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan revoked reset session: %w", err)
		}
		revoked = append(revoked, sessionID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate revoked reset sessions: %w", err)
	}
	rows.Close()
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'member.password_reset.complete','actor',$3,
		       jsonb_build_object('delivery',$4::text,'revoked_sessions',$5::int))`, auditID, orgID, actorID, delivery, len(revoked))
	if err != nil {
		return nil, fmt.Errorf("audit password reset: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit password reset: %w", err)
	}
	return revoked, nil
}

func revokeOtherSessionsTx(ctx context.Context, tx pgx.Tx, orgID, actorID, currentSessionID string, now time.Time) ([]string, error) {
	rows, err := tx.Query(ctx, `
		UPDATE sessions SET revoked_at=COALESCE(revoked_at,$4)
		WHERE org_id=$1 AND actor_id=$2 AND id<>$3 AND revoked_at IS NULL RETURNING id`, orgID, actorID, currentSessionID, now)
	if err != nil {
		return nil, fmt.Errorf("revoke other sessions: %w", err)
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			return nil, err
		}
		result = append(result, sessionID)
	}
	return result, rows.Err()
}

func (r *Repository) TransferOwnership(ctx context.Context, transfer OwnershipTransfer) (User, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return User{}, fmt.Errorf("begin ownership transfer: %w", err)
	}
	defer tx.Rollback(ctx)

	var currentRole, currentStatus string
	err = tx.QueryRow(ctx, `
		SELECT org_role, status
		FROM actors
		WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL
		FOR UPDATE`, transfer.OrgID, transfer.CurrentActorID).Scan(&currentRole, &currentStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrForbidden
	}
	if err != nil {
		if isSerializationFailure(err) {
			return User{}, ErrConflict
		}
		return User{}, fmt.Errorf("lock current owner: %w", err)
	}
	if currentRole != "owner" || currentStatus != "active" {
		return User{}, ErrForbidden
	}

	var targetRole, targetStatus string
	err = tx.QueryRow(ctx, `
		SELECT a.org_role, a.status
		FROM actors a
		JOIN users u ON u.org_id = a.org_id AND u.actor_id = a.id
		WHERE a.org_id = $1 AND a.id = $2 AND a.deleted_at IS NULL
		FOR UPDATE OF a`, transfer.OrgID, transfer.TargetActorID).Scan(&targetRole, &targetStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		if isSerializationFailure(err) {
			return User{}, ErrConflict
		}
		return User{}, fmt.Errorf("lock ownership target: %w", err)
	}
	if targetStatus != "active" || targetRole == "owner" {
		return User{}, validationErrorf("target_actor_id must identify another active non-owner user")
	}

	if _, err := tx.Exec(ctx, `DELETE FROM actor_permissions WHERE org_id=$1 AND actor_id=$2`, transfer.OrgID, transfer.TargetActorID); err != nil {
		return User{}, fmt.Errorf("clear new owner permissions: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE actors SET org_role='admin' WHERE org_id=$1 AND id=$2`, transfer.OrgID, transfer.CurrentActorID); err != nil {
		if isSerializationFailure(err) {
			return User{}, ErrConflict
		}
		return User{}, fmt.Errorf("demote previous owner: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE actors SET org_role='owner' WHERE org_id=$1 AND id=$2`, transfer.OrgID, transfer.TargetActorID); err != nil {
		if isSerializationFailure(err) || isUniqueViolation(err) {
			return User{}, ErrConflict
		}
		return User{}, fmt.Errorf("promote new owner: %w", err)
	}
	for _, code := range permission.All() {
		if _, err := tx.Exec(ctx, `
			INSERT INTO actor_permissions(org_id,actor_id,permission,granted_by)
			VALUES($1,$2,$3,$4)`, transfer.OrgID, transfer.CurrentActorID, code, transfer.TargetActorID); err != nil {
			return User{}, fmt.Errorf("grant previous owner administrator permissions: %w", err)
		}
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'organization.ownership.transfer','actor',$4,
		       jsonb_build_object('from_actor_id',$3::uuid,'to_actor_id',$4::uuid,
		                          'previous_target_role',$5::text))`,
		transfer.AuditID, transfer.OrgID, transfer.CurrentActorID, transfer.TargetActorID, targetRole)
	if err != nil {
		return User{}, fmt.Errorf("audit ownership transfer: %w", err)
	}

	var user User
	err = tx.QueryRow(ctx, `
		SELECT a.id, a.org_id, o.name, a.org_role, u.email::text, a.display_name, a.handle::text,
		       a.title, a.about, a.timezone, a.status, a.created_at,
		       u.must_change_password_at IS NOT NULL,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_emoji ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_text ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_expires_at END
		FROM actors a
		JOIN users u ON u.actor_id = a.id
		JOIN organizations o ON o.id = a.org_id
		WHERE a.org_id = $1 AND a.id = $2`, transfer.OrgID, transfer.CurrentActorID).Scan(
		&user.ActorID, &user.OrgID, &user.OrganizationName, &user.OrgRole, &user.Email, &user.DisplayName,
		&user.Handle, &user.Title, &user.About, &user.Timezone, &user.Status, &user.CreatedAt, &user.MustChangePassword,
		&user.StatusEmoji, &user.StatusText, &user.StatusExpiresAt,
	)
	if err != nil {
		return User{}, fmt.Errorf("load previous owner after transfer: %w", err)
	}
	if err := loadPermissions(ctx, tx, &user); err != nil {
		return User{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		if isSerializationFailure(err) || isUniqueViolation(err) {
			return User{}, ErrConflict
		}
		return User{}, fmt.Errorf("commit ownership transfer: %w", err)
	}
	return user, nil
}

func isSerializationFailure(err error) bool {
	var databaseError *pgconn.PgError
	return errors.As(err, &databaseError) && databaseError.Code == "40001"
}

func (r *Repository) CreateSession(ctx context.Context, orgID, actorID string, session NewSession) error {
	return insertSession(ctx, r.pool, orgID, actorID, session)
}

type execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func insertSession(ctx context.Context, db execer, orgID, actorID string, session NewSession) error {
	var ip any
	if session.Device.IPAddress != "" {
		ip = session.Device.IPAddress
	}
	_, err := db.Exec(ctx, `
		INSERT INTO sessions (id, org_id, actor_id, family_id, refresh_hash, user_agent, ip_address, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		session.ID, orgID, actorID, session.FamilyID, session.RefreshHash,
		session.Device.UserAgent, ip, session.ExpiresAt)
	if err != nil {
		return fmt.Errorf("insert session: %w", err)
	}
	return nil
}

func (r *Repository) RotateSession(ctx context.Context, refreshHash []byte, replacement NewSession, now time.Time) (User, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return User{}, fmt.Errorf("begin refresh rotation: %w", err)
	}
	defer tx.Rollback(ctx)

	var user User
	var sessionID, familyID string
	var expiresAt time.Time
	var revokedAt *time.Time
	var replacedBy *string
	err = tx.QueryRow(ctx, `
		SELECT s.id, s.family_id, s.expires_at, s.revoked_at, s.replaced_by,
		       a.id, a.org_id, o.name, a.org_role, u.email::text, a.display_name, a.handle::text,
		       a.title, a.about, a.timezone, a.status, a.created_at,
		       u.must_change_password_at IS NOT NULL,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_emoji ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_text ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_expires_at END
		FROM sessions s
		JOIN actors a ON a.id = s.actor_id
		JOIN users u ON u.actor_id = a.id
		JOIN organizations o ON o.id = a.org_id
		WHERE s.refresh_hash = $1
		FOR UPDATE OF s`, refreshHash).Scan(
		&sessionID, &familyID, &expiresAt, &revokedAt, &replacedBy,
		&user.ActorID, &user.OrgID, &user.OrganizationName, &user.OrgRole, &user.Email, &user.DisplayName,
		&user.Handle, &user.Title, &user.About, &user.Timezone, &user.Status, &user.CreatedAt, &user.MustChangePassword,
		&user.StatusEmoji, &user.StatusText, &user.StatusExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrInvalidRefreshToken
	}
	if err != nil {
		return User{}, fmt.Errorf("find refresh session: %w", err)
	}

	if revokedAt != nil || replacedBy != nil {
		if _, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE family_id = $1`, familyID, now); err != nil {
			return User{}, fmt.Errorf("revoke reused session family: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return User{}, fmt.Errorf("commit refresh reuse revocation: %w", err)
		}
		return User{}, ErrRefreshReuse
	}
	if !expiresAt.After(now) || user.Status != "active" {
		if _, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE family_id = $1`, familyID, now); err != nil {
			return User{}, fmt.Errorf("revoke expired session family: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return User{}, fmt.Errorf("commit expired session revocation: %w", err)
		}
		return User{}, ErrInvalidRefreshToken
	}

	replacement.FamilyID = familyID
	if err := insertSession(ctx, tx, user.OrgID, user.ActorID, replacement); err != nil {
		return User{}, err
	}
	command, err := tx.Exec(ctx, `
		UPDATE sessions SET revoked_at = $2, replaced_by = $3, last_seen_at = $2
		WHERE id = $1 AND revoked_at IS NULL AND replaced_by IS NULL`, sessionID, now, replacement.ID)
	if err != nil {
		return User{}, fmt.Errorf("replace refresh session: %w", err)
	}
	if command.RowsAffected() != 1 {
		return User{}, ErrInvalidRefreshToken
	}
	if err := loadPermissions(ctx, tx, &user); err != nil {
		return User{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, fmt.Errorf("commit refresh rotation: %w", err)
	}
	return user, nil
}

func (r *Repository) ResolveSession(ctx context.Context, sessionID, actorID string, now time.Time) (User, error) {
	var user User
	err := r.pool.QueryRow(ctx, `
		SELECT a.id, a.org_id, o.name, a.org_role, u.email::text, a.display_name, a.handle::text,
		       a.title, a.about, a.timezone, a.status, a.created_at,
		       u.must_change_password_at IS NOT NULL,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>$3 THEN a.status_emoji ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>$3 THEN a.status_text ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>$3 THEN a.status_expires_at END
		FROM sessions s
		JOIN actors a ON a.id = s.actor_id
		JOIN users u ON u.actor_id = a.id
		JOIN organizations o ON o.id = a.org_id
		WHERE s.id = $1 AND s.actor_id = $2 AND s.revoked_at IS NULL
		  AND s.expires_at > $3 AND a.status = 'active' AND a.deleted_at IS NULL`,
		sessionID, actorID, now).Scan(
		&user.ActorID, &user.OrgID, &user.OrganizationName, &user.OrgRole, &user.Email, &user.DisplayName,
		&user.Handle, &user.Title, &user.About, &user.Timezone, &user.Status, &user.CreatedAt, &user.MustChangePassword,
		&user.StatusEmoji, &user.StatusText, &user.StatusExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUnauthorized
	}
	if err != nil {
		return User{}, fmt.Errorf("resolve session: %w", err)
	}
	if err := loadPermissions(ctx, r.pool, &user); err != nil {
		return User{}, err
	}
	return user, nil
}

func (r *Repository) UpdateProfile(ctx context.Context, actorID, displayName, handle, title, about, timezone string) (User, error) {
	var user User
	err := r.pool.QueryRow(ctx, `
		WITH updated AS (
			UPDATE actors
			SET display_name = $2, handle = $3, title = $4, about = $5, timezone = $6
			WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
			RETURNING id, org_id, org_role, display_name, handle, title, about, timezone, status, created_at,
			          status_emoji,status_text,status_expires_at
		)
		SELECT updated.id, updated.org_id, o.name, updated.org_role, u.email::text, updated.display_name,
		       updated.handle::text, updated.title, updated.about, updated.timezone, updated.status, updated.created_at,
		       u.must_change_password_at IS NOT NULL,
		       CASE WHEN updated.status_expires_at IS NULL OR updated.status_expires_at>now() THEN updated.status_emoji ELSE '' END,
		       CASE WHEN updated.status_expires_at IS NULL OR updated.status_expires_at>now() THEN updated.status_text ELSE '' END,
		       CASE WHEN updated.status_expires_at IS NULL OR updated.status_expires_at>now() THEN updated.status_expires_at END
		FROM updated JOIN users u ON u.actor_id = updated.id
		JOIN organizations o ON o.id = updated.org_id`,
		actorID, displayName, handle, title, about, timezone).Scan(
		&user.ActorID, &user.OrgID, &user.OrganizationName, &user.OrgRole, &user.Email, &user.DisplayName,
		&user.Handle, &user.Title, &user.About, &user.Timezone, &user.Status, &user.CreatedAt, &user.MustChangePassword,
		&user.StatusEmoji, &user.StatusText, &user.StatusExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if isUniqueViolation(err) {
		return User{}, validationErrorf("handle is already in use")
	}
	if err != nil {
		return User{}, fmt.Errorf("update profile: %w", err)
	}
	if err := loadPermissions(ctx, r.pool, &user); err != nil {
		return User{}, err
	}
	return user, nil
}

func (r *Repository) UpdateStatus(ctx context.Context, user User, status CustomStatus) (CustomStatus, int64, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return CustomStatus{}, 0, fmt.Errorf("begin status update: %w", err)
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `
		UPDATE actors SET status_emoji=$3,status_text=$4,status_expires_at=$5
		WHERE org_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL`,
		user.OrgID, user.ActorID, status.Emoji, status.Text, status.ExpiresAt)
	if err != nil {
		return CustomStatus{}, 0, fmt.Errorf("update actor status: %w", err)
	}
	if command.RowsAffected() != 1 {
		return CustomStatus{}, 0, ErrNotFound
	}
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq=event_seq+1 WHERE id=$1 RETURNING event_seq`, user.OrgID).Scan(&seq); err != nil {
		return CustomStatus{}, 0, fmt.Errorf("allocate status event sequence: %w", err)
	}
	payload, err := json.Marshal(status)
	if err != nil {
		return CustomStatus{}, 0, fmt.Errorf("marshal actor status: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO events(org_id,seq,type,actor_id,subject_id,data)
		VALUES($1,$2,'actor.status.updated',$3,$3,$4::jsonb)`, user.OrgID, seq, user.ActorID, string(payload))
	if err != nil {
		return CustomStatus{}, 0, fmt.Errorf("insert actor status event: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return CustomStatus{}, 0, fmt.Errorf("commit status update: %w", err)
	}
	return status, seq, nil
}

func (r *Repository) ExpireStatuses(ctx context.Context, now time.Time, limit int) (map[string]int64, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin status expiry: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT org_id,id FROM actors
		WHERE status_expires_at IS NOT NULL AND status_expires_at<=$1
		ORDER BY status_expires_at,id FOR UPDATE SKIP LOCKED LIMIT $2`, now, limit)
	if err != nil {
		return nil, fmt.Errorf("select expired statuses: %w", err)
	}
	type expiredActor struct{ orgID, actorID string }
	targets := make([]expiredActor, 0)
	for rows.Next() {
		var target expiredActor
		if err := rows.Scan(&target.orgID, &target.actorID); err != nil {
			rows.Close()
			return nil, err
		}
		targets = append(targets, target)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	high := make(map[string]int64)
	emptyPayload := `{"emoji":"","text":"","expires_at":null}`
	for _, target := range targets {
		if _, err := tx.Exec(ctx, `UPDATE actors SET status_emoji='',status_text='',status_expires_at=NULL WHERE org_id=$1 AND id=$2`, target.orgID, target.actorID); err != nil {
			return nil, fmt.Errorf("clear expired status: %w", err)
		}
		var seq int64
		if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq=event_seq+1 WHERE id=$1 RETURNING event_seq`, target.orgID).Scan(&seq); err != nil {
			return nil, fmt.Errorf("allocate expired status event: %w", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO events(org_id,seq,type,actor_id,subject_id,data) VALUES($1,$2,'actor.status.updated',$3,$3,$4::jsonb)`, target.orgID, seq, target.actorID, emptyPayload); err != nil {
			return nil, fmt.Errorf("insert expired status event: %w", err)
		}
		high[target.orgID] = seq
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit status expiry: %w", err)
	}
	return high, nil
}

func (r *Repository) CreateInvitation(ctx context.Context, record InvitationRecord) (Invitation, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Invitation{}, fmt.Errorf("begin invitation creation: %w", err)
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `
		UPDATE invitations SET revoked_at = now()
		WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, record.OrgID, record.Email)
	if err != nil {
		return Invitation{}, fmt.Errorf("revoke previous invitations: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO invitations (id, org_id, email, org_role, token_hash, created_by, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		record.ID, record.OrgID, record.Email, record.Role, record.TokenHash, record.CreatedBy, record.ExpiresAt)
	if err != nil {
		return Invitation{}, fmt.Errorf("insert invitation: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id, metadata)
		VALUES ($1, $2, $3, 'invitation.create', 'invitation', $4, jsonb_build_object('role', $5::text))`,
		record.AuditID, record.OrgID, record.CreatedBy, record.ID, record.Role)
	if err != nil {
		return Invitation{}, fmt.Errorf("audit invitation creation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Invitation{}, fmt.Errorf("commit invitation creation: %w", err)
	}
	return Invitation{ID: record.ID, Email: record.Email, Role: record.Role, ExpiresAt: record.ExpiresAt}, nil
}

func (r *Repository) Invitations(ctx context.Context, orgID string, now time.Time) ([]InvitationSummary, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT i.id,i.email,i.org_role,i.created_by,a.display_name,i.created_at,i.expires_at,i.email_sent_at,
		       CASE WHEN i.expires_at<=$2 THEN 'expired' ELSE 'active' END
		FROM invitations i JOIN actors a ON a.org_id=i.org_id AND a.id=i.created_by
		WHERE i.org_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
		ORDER BY i.created_at DESC,i.id DESC`, orgID, now)
	if err != nil {
		return nil, fmt.Errorf("list invitations: %w", err)
	}
	defer rows.Close()
	result := []InvitationSummary{}
	for rows.Next() {
		var item InvitationSummary
		if err := rows.Scan(&item.ID, &item.Email, &item.Role, &item.CreatedByID, &item.CreatedByName, &item.CreatedAt, &item.ExpiresAt, &item.EmailSentAt, &item.Status); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *Repository) RevokeInvitation(ctx context.Context, orgID, actorID, invitationID, auditID string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `UPDATE invitations SET revoked_at=now() WHERE id=$1 AND org_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL`, invitationID, orgID)
	if err != nil {
		return fmt.Errorf("revoke invitation: %w", err)
	}
	if command.RowsAffected() != 1 {
		return ErrNotFound
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'invitation.revoke','invitation',$4,'{}')`, auditID, orgID, actorID, invitationID); err != nil {
		return fmt.Errorf("audit invitation revocation: %w", err)
	}
	return tx.Commit(ctx)
}

func (r *Repository) RotateInvitation(ctx context.Context, oldID string, record InvitationRecord) (Invitation, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Invitation{}, err
	}
	defer tx.Rollback(ctx)
	var email, role string
	if err := tx.QueryRow(ctx, `SELECT email,org_role FROM invitations WHERE id=$1 AND org_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE`, oldID, record.OrgID).Scan(&email, &role); errors.Is(err, pgx.ErrNoRows) {
		return Invitation{}, ErrNotFound
	} else if err != nil {
		return Invitation{}, fmt.Errorf("lock invitation for rotation: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE invitations SET revoked_at=now() WHERE id=$1`, oldID); err != nil {
		return Invitation{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO invitations(id,org_id,email,org_role,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, record.ID, record.OrgID, email, role, record.TokenHash, record.CreatedBy, record.ExpiresAt); err != nil {
		return Invitation{}, fmt.Errorf("insert rotated invitation: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'invitation.rotate','invitation',$4,jsonb_build_object('previous_id',$5::text,'role',$6::text))`, record.AuditID, record.OrgID, record.CreatedBy, record.ID, oldID, role); err != nil {
		return Invitation{}, fmt.Errorf("audit invitation rotation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Invitation{}, err
	}
	return Invitation{ID: record.ID, Email: email, Role: role, ExpiresAt: record.ExpiresAt}, nil
}

func (r *Repository) MarkInvitationEmailSent(ctx context.Context, orgID, invitationID string, sentAt time.Time) error {
	_, err := r.pool.Exec(ctx, `UPDATE invitations SET email_sent_at=$3 WHERE org_id=$1 AND id=$2`, orgID, invitationID, sentAt)
	return err
}

func (r *Repository) AcceptInvitation(ctx context.Context, acceptance InvitationAcceptance, now time.Time) (User, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return User{}, fmt.Errorf("begin invitation acceptance: %w", err)
	}
	defer tx.Rollback(ctx)
	var invitationID, orgID, organizationName, email, role string
	var expiresAt time.Time
	var acceptedAt, revokedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT i.id, i.org_id, o.name, i.email::text, i.org_role, i.expires_at, i.accepted_at, i.revoked_at
		FROM invitations i JOIN organizations o ON o.id = i.org_id
		WHERE i.token_hash = $1 FOR UPDATE OF i`, acceptance.TokenHash).Scan(
		&invitationID, &orgID, &organizationName, &email, &role, &expiresAt, &acceptedAt, &revokedAt)
	if errors.Is(err, pgx.ErrNoRows) || acceptedAt != nil || revokedAt != nil || !expiresAt.After(now) {
		return User{}, ErrInvitationInvalid
	}
	if err != nil {
		return User{}, fmt.Errorf("find invitation: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO actors (id, org_id, type, org_role, display_name, handle, timezone)
		VALUES ($1, $2, 'user', $3, $4, $5, $6)`,
		acceptance.ActorID, orgID, role, acceptance.DisplayName, acceptance.Handle, acceptance.Timezone)
	if isUniqueViolation(err) {
		return User{}, validationErrorf("handle is already in use")
	}
	if err != nil {
		return User{}, fmt.Errorf("insert invited actor: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO users (actor_id, org_id, email, password_hash, email_verified_at)
		VALUES ($1, $2, $3, $4, now())`, acceptance.ActorID, orgID, email, acceptance.PasswordHash)
	if isUniqueViolation(err) {
		return User{}, ErrInvitationInvalid
	}
	if err != nil {
		return User{}, fmt.Errorf("insert invited user: %w", err)
	}
	if err := insertSession(ctx, tx, orgID, acceptance.ActorID, NewSession{
		ID: acceptance.SessionID, FamilyID: acceptance.FamilyID, RefreshHash: acceptance.RefreshHash,
		ExpiresAt: acceptance.SessionExpires, Device: acceptance.Device,
	}); err != nil {
		return User{}, err
	}
	command, err := tx.Exec(ctx, `
		UPDATE invitations SET accepted_at = $2, accepted_by = $3
		WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, invitationID, now, acceptance.ActorID)
	if err != nil || command.RowsAffected() != 1 {
		return User{}, ErrInvitationInvalid
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id)
		VALUES ($1, $2, $3, 'invitation.accept', 'invitation', $4)`,
		acceptance.AuditID, orgID, acceptance.ActorID, invitationID)
	if err != nil {
		return User{}, fmt.Errorf("audit invitation acceptance: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, fmt.Errorf("commit invitation acceptance: %w", err)
	}
	return User{ActorID: acceptance.ActorID, OrgID: orgID, OrganizationName: organizationName, OrgRole: role, Email: email,
		DisplayName: acceptance.DisplayName, Handle: acceptance.Handle, Timezone: acceptance.Timezone,
		Status: "active", Permissions: permission.Effective(role, nil), CreatedAt: now}, nil
}

type permissionQueryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func loadPermissions(ctx context.Context, db permissionQueryRower, user *User) error {
	if user.OrgRole != "admin" {
		user.Permissions = permission.Effective(user.OrgRole, nil)
		return nil
	}
	var stored []string
	if err := db.QueryRow(ctx, `
		SELECT COALESCE(array_agg(permission ORDER BY permission), ARRAY[]::text[])
		FROM actor_permissions
		WHERE org_id = $1 AND actor_id = $2`, user.OrgID, user.ActorID).Scan(&stored); err != nil {
		return fmt.Errorf("load actor permissions: %w", err)
	}
	granted := make([]permission.Code, len(stored))
	for index, code := range stored {
		granted[index] = permission.Code(code)
	}
	user.Permissions = permission.Effective(user.OrgRole, granted)
	return nil
}

func (r *Repository) RevokeSession(ctx context.Context, actorID, sessionID string, now time.Time) error {
	command, err := r.pool.Exec(ctx, `
		UPDATE sessions SET revoked_at = COALESCE(revoked_at, $3)
		WHERE id = $1 AND actor_id = $2`, sessionID, actorID, now)
	if err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	if command.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *Repository) InvitationValid(ctx context.Context, tokenHash []byte, now time.Time) (bool, error) {
	var valid bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM invitations
			WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2
		)`, tokenHash, now).Scan(&valid)
	if err != nil {
		return false, fmt.Errorf("validate invitation token: %w", err)
	}
	return valid, nil
}

func (r *Repository) ListSessions(ctx context.Context, actorID, currentSessionID string) ([]Session, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, actor_id, user_agent, COALESCE(host(ip_address), ''), created_at,
		       last_seen_at, expires_at, revoked_at, id = $2
		FROM sessions
		WHERE actor_id = $1
		ORDER BY created_at DESC`, actorID, currentSessionID)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()
	var sessions []Session
	for rows.Next() {
		var session Session
		if err := rows.Scan(&session.ID, &session.ActorID, &session.UserAgent, &session.IPAddress,
			&session.CreatedAt, &session.LastSeenAt, &session.ExpiresAt, &session.RevokedAt, &session.Current); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate sessions: %w", err)
	}
	return sessions, nil
}

func (r *Repository) RevokeOtherSessions(ctx context.Context, actorID, currentSessionID string, now time.Time) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		UPDATE sessions SET revoked_at=COALESCE(revoked_at,$3)
		WHERE actor_id=$1 AND id<>$2 AND revoked_at IS NULL RETURNING id`, actorID, currentSessionID, now)
	if err != nil {
		return nil, fmt.Errorf("revoke other sessions: %w", err)
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			return nil, err
		}
		result = append(result, sessionID)
	}
	return result, rows.Err()
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
