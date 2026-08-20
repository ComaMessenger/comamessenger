package identity

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
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
		Timezone: record.Timezone, Status: "active", CreatedAt: time.Now().UTC(),
	}, nil
}

func (r *Repository) FindUserByEmail(ctx context.Context, email string) (User, error) {
	var user User
	err := r.pool.QueryRow(ctx, `
		SELECT a.id, a.org_id, o.name, a.org_role, u.email::text, a.display_name, a.handle::text,
		       a.timezone, a.status, a.created_at, u.password_hash
		FROM users u
		JOIN actors a ON a.id = u.actor_id
		JOIN organizations o ON o.id = a.org_id
		WHERE u.email = $1`, email).Scan(
		&user.ActorID, &user.OrgID, &user.OrganizationName, &user.OrgRole, &user.Email, &user.DisplayName,
		&user.Handle, &user.Timezone, &user.Status, &user.CreatedAt, &user.PasswordHash,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrInvalidCredentials
	}
	if err != nil {
		return User{}, fmt.Errorf("find user by email: %w", err)
	}
	return user, nil
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
		       a.timezone, a.status, a.created_at
		FROM sessions s
		JOIN actors a ON a.id = s.actor_id
		JOIN users u ON u.actor_id = a.id
		JOIN organizations o ON o.id = a.org_id
		WHERE s.refresh_hash = $1
		FOR UPDATE OF s`, refreshHash).Scan(
		&sessionID, &familyID, &expiresAt, &revokedAt, &replacedBy,
		&user.ActorID, &user.OrgID, &user.OrganizationName, &user.OrgRole, &user.Email, &user.DisplayName,
		&user.Handle, &user.Timezone, &user.Status, &user.CreatedAt,
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
	if err := tx.Commit(ctx); err != nil {
		return User{}, fmt.Errorf("commit refresh rotation: %w", err)
	}
	return user, nil
}

func (r *Repository) ResolveSession(ctx context.Context, sessionID, actorID string, now time.Time) (User, error) {
	var user User
	err := r.pool.QueryRow(ctx, `
		SELECT a.id, a.org_id, o.name, a.org_role, u.email::text, a.display_name, a.handle::text,
		       a.timezone, a.status, a.created_at
		FROM sessions s
		JOIN actors a ON a.id = s.actor_id
		JOIN users u ON u.actor_id = a.id
		JOIN organizations o ON o.id = a.org_id
		WHERE s.id = $1 AND s.actor_id = $2 AND s.revoked_at IS NULL
		  AND s.expires_at > $3 AND a.status = 'active' AND a.deleted_at IS NULL`,
		sessionID, actorID, now).Scan(
		&user.ActorID, &user.OrgID, &user.OrganizationName, &user.OrgRole, &user.Email, &user.DisplayName,
		&user.Handle, &user.Timezone, &user.Status, &user.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUnauthorized
	}
	if err != nil {
		return User{}, fmt.Errorf("resolve session: %w", err)
	}
	return user, nil
}

func (r *Repository) UpdateProfile(ctx context.Context, actorID, displayName, handle, timezone string) (User, error) {
	var user User
	err := r.pool.QueryRow(ctx, `
		WITH updated AS (
			UPDATE actors
			SET display_name = $2, handle = $3, timezone = $4
			WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
			RETURNING id, org_id, org_role, display_name, handle, timezone, status, created_at
		)
		SELECT updated.id, updated.org_id, o.name, updated.org_role, u.email::text, updated.display_name,
		       updated.handle::text, updated.timezone, updated.status, updated.created_at
		FROM updated JOIN users u ON u.actor_id = updated.id
		JOIN organizations o ON o.id = updated.org_id`,
		actorID, displayName, handle, timezone).Scan(
		&user.ActorID, &user.OrgID, &user.OrganizationName, &user.OrgRole, &user.Email, &user.DisplayName,
		&user.Handle, &user.Timezone, &user.Status, &user.CreatedAt,
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
	return user, nil
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
		Status: "active", CreatedAt: now}, nil
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
