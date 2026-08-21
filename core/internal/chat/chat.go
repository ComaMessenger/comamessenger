package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/authz"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrForbidden = errors.New("chat action forbidden")
	ErrNotFound  = errors.New("chat not found")
	ErrInvalid   = errors.New("invalid chat input")
	ErrConflict  = errors.New("chat state conflict")
)

type Chat struct {
	ID              string     `json:"id"`
	Kind            string     `json:"kind"`
	Visibility      string     `json:"visibility"`
	Name            *string    `json:"name"`
	Topic           string     `json:"topic"`
	Role            string     `json:"role"`
	CreatedAt       time.Time  `json:"created_at"`
	ArchivedAt      *time.Time `json:"archived_at,omitempty"`
	DisplayName     string     `json:"display_name"`
	AvatarSeed      string     `json:"avatar_seed"`
	AvatarVersion   int64      `json:"avatar_version"`
	NotifyLevel     string     `json:"notify_level"`
	MutedUntil      *time.Time `json:"muted_until"`
	DirectPeer      *Actor     `json:"direct_peer,omitempty"`
	LastMessage     *Preview   `json:"last_message,omitempty"`
	LastActivitySeq int64      `json:"last_activity_seq"`
	LastMessageAt   *time.Time `json:"last_message_at,omitempty"`
}

type Actor struct {
	ID              string     `json:"actor_id"`
	DisplayName     string     `json:"display_name"`
	Handle          string     `json:"handle"`
	Title           string     `json:"title"`
	About           string     `json:"about"`
	Type            string     `json:"type"`
	StatusEmoji     string     `json:"status_emoji"`
	StatusText      string     `json:"status_text"`
	StatusExpiresAt *time.Time `json:"status_expires_at"`
	AvatarVersion   int64      `json:"avatar_version"`
}
type ActorPage struct {
	Actors      []Actor `json:"actors"`
	NextAfterID *string `json:"next_after_id"`
}
type Preview struct {
	ID               string    `json:"id"`
	ActorID          string    `json:"actor_id"`
	ActorDisplayName string    `json:"actor_display_name"`
	Body             string    `json:"body"`
	CreatedSeq       int64     `json:"created_seq"`
	CreatedAt        time.Time `json:"created_at"`
	Deleted          bool      `json:"deleted"`
}

type CreateInput struct {
	Kind       string   `json:"kind"`
	Visibility string   `json:"visibility"`
	Name       string   `json:"name"`
	Topic      string   `json:"topic"`
	MemberIDs  []string `json:"member_ids"`
}

type UpdateInput struct {
	Name       *string `json:"name"`
	Topic      *string `json:"topic"`
	Visibility *string `json:"visibility"`
}

type MemberInput struct {
	ActorID string `json:"actor_id"`
	Role    string `json:"role"`
}

type UpdateMemberInput struct {
	Role string `json:"role"`
}

type Member struct {
	ActorID         string     `json:"actor_id"`
	Type            string     `json:"type"`
	DisplayName     string     `json:"display_name"`
	Handle          string     `json:"handle"`
	Title           string     `json:"title"`
	Role            string     `json:"role"`
	JoinedAt        time.Time  `json:"joined_at"`
	StatusEmoji     string     `json:"status_emoji"`
	StatusText      string     `json:"status_text"`
	StatusExpiresAt *time.Time `json:"status_expires_at"`
	AvatarVersion   int64      `json:"avatar_version"`
}

type DirectoryChat struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Name      string    `json:"name"`
	Topic     string    `json:"topic"`
	CreatedAt time.Time `json:"created_at"`
}

type Service struct {
	pool        *pgxpool.Pool
	afterCommit func(string, int64)
}

func NewService(pool *pgxpool.Pool, callbacks ...func(string, int64)) *Service {
	var callback func(string, int64)
	if len(callbacks) > 0 {
		callback = callbacks[0]
	}
	return &Service{pool: pool, afterCommit: callback}
}

func (s *Service) List(ctx context.Context, user identity.User) ([]Chat, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.kind, c.visibility, c.name, c.topic, cm.role, c.created_at, c.archived_at,
			COALESCE(c.name, peer.display_name, 'Direct chat'), COALESCE(peer.id::text, c.id::text), COALESCE(peer.avatar_version, 0), cm.notify_level, cm.muted_until,
			peer.id, peer.display_name, peer.handle::text, peer.title, peer.about, peer.type, peer.status_emoji, peer.status_text, peer.status_expires_at, peer.avatar_version,
			last.id, last.actor_id, last.actor_name, left(last.body, 280), last.created_seq, last.created_at, last.deleted,
			COALESCE(last.created_seq, 0), c.last_message_at
		FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
		LEFT JOIN LATERAL (SELECT a.id,a.display_name,a.handle,a.title,a.about,a.type,a.avatar_version,
			CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_emoji ELSE '' END status_emoji,
			CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_text ELSE '' END status_text,
			CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_expires_at END status_expires_at
			FROM chat_members other JOIN actors a ON a.id=other.actor_id WHERE other.chat_id=c.id AND other.actor_id<>$1 LIMIT 1) peer ON c.kind='direct'
		LEFT JOIN LATERAL (SELECT m.id,m.actor_id,a.display_name actor_name,m.body,m.created_seq,m.created_at,false deleted FROM messages m JOIN actors a ON a.id=m.actor_id WHERE m.chat_id=c.id AND m.deleted_at IS NULL ORDER BY m.created_seq DESC LIMIT 1) last ON true
		WHERE cm.actor_id = $1 AND c.org_id = $2 AND c.archived_at IS NULL
		ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`, user.ActorID, user.OrgID)
	if err != nil {
		return nil, fmt.Errorf("list chats: %w", err)
	}
	defer rows.Close()
	chats := make([]Chat, 0)
	for rows.Next() {
		chat, err := scanChat(rows)
		if err != nil {
			return nil, fmt.Errorf("scan chat: %w", err)
		}
		chats = append(chats, chat)
	}
	return chats, rows.Err()
}

func (s *Service) Get(ctx context.Context, user identity.User, chatID string) (Chat, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT c.id, c.kind, c.visibility, c.name, c.topic, cm.role, c.created_at, c.archived_at,
			COALESCE(c.name, peer.display_name, 'Direct chat'), COALESCE(peer.id::text, c.id::text), COALESCE(peer.avatar_version, 0), cm.notify_level, cm.muted_until,
			peer.id, peer.display_name, peer.handle::text, peer.title, peer.about, peer.type, peer.status_emoji, peer.status_text, peer.status_expires_at, peer.avatar_version,
			last.id, last.actor_id, last.actor_name, left(last.body, 280), last.created_seq, last.created_at, last.deleted,
			COALESCE(last.created_seq, 0), c.last_message_at
		FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
		LEFT JOIN LATERAL (SELECT a.id,a.display_name,a.handle,a.title,a.about,a.type,a.avatar_version,
			CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_emoji ELSE '' END status_emoji,
			CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_text ELSE '' END status_text,
			CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_expires_at END status_expires_at
			FROM chat_members other JOIN actors a ON a.id=other.actor_id WHERE other.chat_id=c.id AND other.actor_id<>$1 LIMIT 1) peer ON c.kind='direct'
		LEFT JOIN LATERAL (SELECT m.id,m.actor_id,a.display_name actor_name,m.body,m.created_seq,m.created_at,false deleted FROM messages m JOIN actors a ON a.id=m.actor_id WHERE m.chat_id=c.id AND m.deleted_at IS NULL ORDER BY m.created_seq DESC LIMIT 1) last ON true
		WHERE cm.actor_id = $1 AND c.org_id = $2 AND c.id = $3 AND c.archived_at IS NULL`, user.ActorID, user.OrgID, chatID)
	result, err := scanChat(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Chat{}, ErrNotFound
	}
	if err != nil {
		return Chat{}, fmt.Errorf("get chat: %w", err)
	}
	return result, nil
}

type rowScanner interface{ Scan(...any) error }

func scanChat(row rowScanner) (Chat, error) {
	var chat Chat
	var peerID, peerName, peerHandle, peerTitle, peerAbout, peerType, peerStatusEmoji, peerStatusText, lastID, lastActorID, lastActorName, lastBody *string
	var peerStatusExpiresAt *time.Time
	var peerAvatarVersion *int64
	var lastSeq *int64
	var lastAt *time.Time
	var deleted *bool
	if err := row.Scan(&chat.ID, &chat.Kind, &chat.Visibility, &chat.Name, &chat.Topic,
		&chat.Role, &chat.CreatedAt, &chat.ArchivedAt, &chat.DisplayName, &chat.AvatarSeed, &chat.AvatarVersion, &chat.NotifyLevel, &chat.MutedUntil,
		&peerID, &peerName, &peerHandle, &peerTitle, &peerAbout, &peerType, &peerStatusEmoji, &peerStatusText, &peerStatusExpiresAt, &peerAvatarVersion, &lastID, &lastActorID, &lastActorName, &lastBody, &lastSeq, &lastAt, &deleted, &chat.LastActivitySeq, &chat.LastMessageAt); err != nil {
		return Chat{}, err
	}
	if peerID != nil {
		chat.DirectPeer = &Actor{ID: *peerID, DisplayName: *peerName, Handle: *peerHandle, Title: *peerTitle, About: *peerAbout, Type: *peerType, StatusEmoji: *peerStatusEmoji, StatusText: *peerStatusText, StatusExpiresAt: peerStatusExpiresAt, AvatarVersion: *peerAvatarVersion}
	}
	if lastID != nil {
		chat.LastMessage = &Preview{ID: *lastID, ActorID: *lastActorID, ActorDisplayName: *lastActorName, Body: *lastBody, CreatedSeq: *lastSeq, CreatedAt: *lastAt, Deleted: *deleted}
	}
	return chat, nil
}

func (s *Service) ListActors(ctx context.Context, user identity.User, query, afterID string, limit int) (ActorPage, error) {
	query = strings.TrimSpace(query)
	if limit == 0 {
		limit = 30
	}
	if limit < 1 || limit > 100 {
		return ActorPage{}, fmt.Errorf("%w: limit must be between 1 and 100", ErrInvalid)
	}
	rows, err := s.pool.Query(ctx, `SELECT id,display_name,handle::text,title,about,type,
		CASE WHEN status_expires_at IS NULL OR status_expires_at>now() THEN status_emoji ELSE '' END,
		CASE WHEN status_expires_at IS NULL OR status_expires_at>now() THEN status_text ELSE '' END,
		CASE WHEN status_expires_at IS NULL OR status_expires_at>now() THEN status_expires_at END,
		avatar_version
		FROM actors WHERE org_id=$1 AND status='active' AND deleted_at IS NULL AND ($2='' OR display_name ILIKE '%'||$2||'%' OR handle::text ILIKE '%'||$2||'%' OR title ILIKE '%'||$2||'%') AND (NULLIF($3,'') IS NULL OR id>NULLIF($3,'')::uuid) ORDER BY id LIMIT $4`, user.OrgID, query, afterID, limit+1)
	if err != nil {
		return ActorPage{}, fmt.Errorf("list actors: %w", err)
	}
	defer rows.Close()
	result := ActorPage{Actors: make([]Actor, 0, limit)}
	for rows.Next() {
		var actor Actor
		if err := rows.Scan(&actor.ID, &actor.DisplayName, &actor.Handle, &actor.Title, &actor.About, &actor.Type, &actor.StatusEmoji, &actor.StatusText, &actor.StatusExpiresAt, &actor.AvatarVersion); err != nil {
			return ActorPage{}, err
		}
		result.Actors = append(result.Actors, actor)
	}
	if len(result.Actors) > limit {
		result.Actors = result.Actors[:limit]
		next := result.Actors[len(result.Actors)-1].ID
		result.NextAfterID = &next
	}
	return result, rows.Err()
}

func (s *Service) Discover(ctx context.Context, user identity.User) ([]DirectoryChat, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.kind, c.name, c.topic, c.created_at
		FROM chats c
		WHERE c.org_id = $1 AND c.visibility = 'public' AND c.archived_at IS NULL
		  AND c.kind IN ('group', 'channel')
		  AND NOT EXISTS (
			SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.actor_id = $2
		  )
		ORDER BY c.created_at DESC`, user.OrgID, user.ActorID)
	if err != nil {
		return nil, fmt.Errorf("discover chats: %w", err)
	}
	defer rows.Close()
	result := make([]DirectoryChat, 0)
	for rows.Next() {
		var chat DirectoryChat
		if err := rows.Scan(&chat.ID, &chat.Kind, &chat.Name, &chat.Topic, &chat.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan discoverable chat: %w", err)
		}
		result = append(result, chat)
	}
	return result, rows.Err()
}

func (s *Service) Create(ctx context.Context, user identity.User, input CreateInput) (Chat, error) {
	input.Kind = strings.ToLower(strings.TrimSpace(input.Kind))
	input.Visibility = strings.ToLower(strings.TrimSpace(input.Visibility))
	input.Name = strings.TrimSpace(input.Name)
	input.Topic = strings.TrimSpace(input.Topic)
	if input.Visibility == "" {
		input.Visibility = "private"
	}
	if input.Kind == "direct" {
		return s.createDirect(ctx, user, input)
	}
	if input.Kind != "group" && input.Kind != "channel" {
		return Chat{}, fmt.Errorf("%w: kind must be direct, group or channel", ErrInvalid)
	}
	if input.Visibility != "private" && input.Visibility != "public" {
		return Chat{}, fmt.Errorf("%w: visibility must be private or public", ErrInvalid)
	}
	if user.OrgRole == "member" {
		allowPublicChat, allowChannel, err := s.creationPolicy(ctx, user.OrgID)
		if err != nil {
			return Chat{}, err
		}
		if input.Kind == "channel" && !allowChannel {
			return Chat{}, ErrForbidden
		}
		if input.Kind == "group" && input.Visibility == "public" && !allowPublicChat {
			return Chat{}, ErrForbidden
		}
	} else if input.Kind == "channel" && !authz.Can(authz.Context{Active: true, OrgRole: authz.Role(user.OrgRole)}, authz.ChannelCreate) {
		return Chat{}, ErrForbidden
	}
	if len(input.Name) < 1 || len(input.Name) > 120 || len(input.Topic) > 500 {
		return Chat{}, fmt.Errorf("%w: invalid name or topic", ErrInvalid)
	}
	chatID, auditID, err := twoIDs()
	if err != nil {
		return Chat{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Chat{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Chat{}, err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO chats (id, org_id, kind, visibility, name, topic, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`, chatID, user.OrgID, input.Kind, input.Visibility, input.Name, input.Topic, user.ActorID)
	if err != nil {
		return Chat{}, fmt.Errorf("insert chat: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'owner')`,
		chatID, user.ActorID, user.OrgID)
	if err != nil {
		return Chat{}, fmt.Errorf("insert chat owner: %w", err)
	}
	seen := map[string]struct{}{user.ActorID: {}}
	for _, actorID := range input.MemberIDs {
		if _, exists := seen[actorID]; exists {
			continue
		}
		seen[actorID] = struct{}{}
		command, err := tx.Exec(ctx, `
			INSERT INTO chat_members (chat_id, actor_id, org_id, role)
			SELECT $1, id, org_id, 'member' FROM actors
			WHERE id = $2 AND org_id = $3 AND status = 'active' AND deleted_at IS NULL`, chatID, actorID, user.OrgID)
		if err != nil || command.RowsAffected() != 1 {
			return Chat{}, fmt.Errorf("%w: member does not exist", ErrInvalid)
		}
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id, metadata)
		VALUES ($1, $2, $3, 'chat.create', 'chat', $4, jsonb_build_object('kind', $5::text))`,
		auditID, user.OrgID, user.ActorID, chatID, input.Kind)
	if err != nil {
		return Chat{}, fmt.Errorf("audit chat creation: %w", err)
	}
	seq, err := appendDurableEvent(ctx, tx, user, chatID, "chat.created", nil, map[string]any{"chat_id": chatID, "kind": input.Kind})
	if err != nil {
		return Chat{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Chat{}, fmt.Errorf("commit chat creation: %w", err)
	}
	s.notify(user.OrgID, seq)
	return s.Get(ctx, user, chatID)
}

func (s *Service) creationPolicy(ctx context.Context, orgID string) (bool, bool, error) {
	var allowPublicChat, allowChannel bool
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE((settings->>'allow_public_chat_creation')::boolean, true),
		       COALESCE((settings->>'allow_channel_creation')::boolean, false)
		FROM organizations WHERE id = $1`, orgID).Scan(&allowPublicChat, &allowChannel)
	if err != nil {
		return false, false, fmt.Errorf("query chat creation policy: %w", err)
	}
	return allowPublicChat, allowChannel, nil
}

func (s *Service) Update(ctx context.Context, user identity.User, chatID string, input UpdateInput) (Chat, error) {
	current, err := s.Get(ctx, user, chatID)
	if err != nil {
		return Chat{}, err
	}
	if current.Kind == "direct" || !canManage(user, current) {
		return Chat{}, ErrForbidden
	}
	name := valueOr(input.Name, dereference(current.Name))
	topic := valueOr(input.Topic, current.Topic)
	visibility := strings.ToLower(valueOr(input.Visibility, current.Visibility))
	name = strings.TrimSpace(name)
	topic = strings.TrimSpace(topic)
	if len(name) < 1 || len(name) > 120 || len(topic) > 500 {
		return Chat{}, fmt.Errorf("%w: invalid name or topic", ErrInvalid)
	}
	if visibility != "private" && visibility != "public" {
		return Chat{}, fmt.Errorf("%w: visibility must be private or public", ErrInvalid)
	}
	auditID, err := id.New()
	if err != nil {
		return Chat{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Chat{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Chat{}, err
	}
	command, err := tx.Exec(ctx, `
		UPDATE chats SET name = $4, topic = $5, visibility = $6
		WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
		  AND EXISTS (
			SELECT 1 FROM chat_members WHERE chat_id = $1 AND actor_id = $3 AND role IN ('owner', 'admin')
		  )`, chatID, user.OrgID, user.ActorID, name, topic, visibility)
	if err != nil {
		return Chat{}, fmt.Errorf("update chat: %w", err)
	}
	if command.RowsAffected() != 1 {
		return Chat{}, ErrConflict
	}
	if err := audit(ctx, tx, auditID, user, "chat.update", "chat", chatID); err != nil {
		return Chat{}, err
	}
	seq, err := appendDurableEvent(ctx, tx, user, chatID, "chat.updated", nil, map[string]any{"name": name, "topic": topic, "visibility": visibility})
	if err != nil {
		return Chat{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Chat{}, fmt.Errorf("commit chat update: %w", err)
	}
	s.notify(user.OrgID, seq)
	return s.Get(ctx, user, chatID)
}

func (s *Service) Archive(ctx context.Context, user identity.User, chatID string) error {
	kind, role, err := s.managementContext(ctx, user, chatID)
	if err != nil {
		return err
	}
	moderator := canModerate(user)
	if role == "" && (!moderator || kind == "direct") {
		return ErrNotFound
	}
	if kind == "direct" || !canManageContext(kind, role, moderator) {
		return ErrForbidden
	}
	auditID, err := id.New()
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `
		UPDATE chats SET archived_at = now()
		WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
		  AND ($4::boolean OR EXISTS (
			SELECT 1 FROM chat_members WHERE chat_id = $1 AND actor_id = $3 AND role IN ('owner', 'admin')
		  ))`, chatID, user.OrgID, user.ActorID, moderator)
	if err != nil {
		return fmt.Errorf("archive chat: %w", err)
	}
	if command.RowsAffected() != 1 {
		return ErrConflict
	}
	if err := audit(ctx, tx, auditID, user, "chat.archive", "chat", chatID); err != nil {
		return err
	}
	seq, err := appendDurableEvent(ctx, tx, user, chatID, "chat.archived", nil, map[string]any{"chat_id": chatID})
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit chat archive: %w", err)
	}
	s.notify(user.OrgID, seq)
	return nil
}

func (s *Service) Join(ctx context.Context, user identity.User, chatID string) (Chat, error) {
	auditID, err := id.New()
	if err != nil {
		return Chat{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Chat{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Chat{}, err
	}
	command, err := tx.Exec(ctx, `
		INSERT INTO chat_members (chat_id, actor_id, org_id, role)
		SELECT id, $2, org_id, 'member' FROM chats
		WHERE id = $1 AND org_id = $3 AND visibility = 'public'
		  AND kind IN ('group', 'channel') AND archived_at IS NULL
		ON CONFLICT (chat_id, actor_id) DO NOTHING`, chatID, user.ActorID, user.OrgID)
	if err != nil {
		return Chat{}, fmt.Errorf("join chat: %w", err)
	}
	if command.RowsAffected() == 0 {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM chat_members WHERE chat_id = $1 AND actor_id = $2)`, chatID, user.ActorID).Scan(&exists); err != nil {
			return Chat{}, fmt.Errorf("check chat membership: %w", err)
		}
		if !exists {
			return Chat{}, ErrNotFound
		}
	} else if err := audit(ctx, tx, auditID, user, "chat.join", "chat", chatID); err != nil {
		return Chat{}, err
	}
	seq := int64(0)
	if command.RowsAffected() == 1 {
		seq, err = appendDurableEvent(ctx, tx, user, chatID, "member.joined", nil, map[string]any{"actor_id": user.ActorID, "role": "member"})
		if err != nil {
			return Chat{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Chat{}, fmt.Errorf("commit chat join: %w", err)
	}
	if seq > 0 {
		s.notify(user.OrgID, seq)
	}
	return s.Get(ctx, user, chatID)
}

func (s *Service) ListMembers(ctx context.Context, user identity.User, chatID string) ([]Member, error) {
	kind, role, err := s.managementContext(ctx, user, chatID)
	if err != nil {
		return nil, err
	}
	if role == "" && (kind == "direct" || !canModerate(user)) {
		return nil, ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT a.id, a.type, a.display_name, a.handle::text, a.title, cm.role, cm.joined_at,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_emoji ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_text ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_expires_at END,
		       a.avatar_version
		FROM chat_members cm JOIN actors a ON a.id = cm.actor_id
		WHERE cm.chat_id = $1 AND cm.org_id = $2 AND a.status = 'active' AND a.deleted_at IS NULL
		ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, a.display_name`, chatID, user.OrgID)
	if err != nil {
		return nil, fmt.Errorf("list chat members: %w", err)
	}
	defer rows.Close()
	result := make([]Member, 0)
	for rows.Next() {
		var member Member
		if err := rows.Scan(&member.ActorID, &member.Type, &member.DisplayName, &member.Handle, &member.Title, &member.Role, &member.JoinedAt, &member.StatusEmoji, &member.StatusText, &member.StatusExpiresAt, &member.AvatarVersion); err != nil {
			return nil, fmt.Errorf("scan chat member: %w", err)
		}
		result = append(result, member)
	}
	return result, rows.Err()
}

func (s *Service) AddMember(ctx context.Context, user identity.User, chatID string, input MemberInput) (Member, error) {
	kind, role, err := s.managementContext(ctx, user, chatID)
	if err != nil {
		return Member{}, err
	}
	input.ActorID = strings.TrimSpace(input.ActorID)
	input.Role = normalizedRole(input.Role)
	moderator := canModerate(user)
	if role == "" && (!moderator || kind == "direct") {
		return Member{}, ErrNotFound
	}
	if kind == "direct" || !canManageContext(kind, role, moderator) {
		return Member{}, ErrForbidden
	}
	if input.ActorID == "" || !validRole(input.Role) {
		return Member{}, fmt.Errorf("%w: actor_id and a valid role are required", ErrInvalid)
	}
	if input.Role == "owner" && role != "owner" {
		return Member{}, ErrForbidden
	}
	auditID, err := id.New()
	if err != nil {
		return Member{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Member{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Member{}, err
	}
	command, err := tx.Exec(ctx, `
		INSERT INTO chat_members (chat_id, actor_id, org_id, role)
		SELECT $1, target.id, target.org_id, $4 FROM actors target
		WHERE target.id = $2 AND target.org_id = $3 AND target.status = 'active' AND target.deleted_at IS NULL
		  AND (EXISTS (
			SELECT 1 FROM chat_members manager JOIN chats c ON c.id = manager.chat_id
			WHERE manager.chat_id = $1 AND manager.actor_id = $5 AND manager.role IN ('owner', 'admin')
			  AND c.kind IN ('group', 'channel') AND c.archived_at IS NULL
			  AND ($4::text <> 'owner' OR manager.role = 'owner')
		  ) OR ($6::boolean AND $4::text <> 'owner'))
		ON CONFLICT (chat_id, actor_id) DO NOTHING`, chatID, input.ActorID, user.OrgID, input.Role, user.ActorID, moderator)
	if err != nil {
		return Member{}, fmt.Errorf("add chat member: %w", err)
	}
	if command.RowsAffected() != 1 {
		return Member{}, ErrConflict
	}
	if err := audit(ctx, tx, auditID, user, "chat.member.add", "actor", input.ActorID); err != nil {
		return Member{}, err
	}
	seq, err := appendDurableEvent(ctx, tx, user, chatID, "member.joined", nil, map[string]any{"actor_id": input.ActorID, "role": input.Role})
	if err != nil {
		return Member{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Member{}, fmt.Errorf("commit chat member addition: %w", err)
	}
	s.notify(user.OrgID, seq)
	return s.member(ctx, chatID, input.ActorID)
}

func (s *Service) UpdateMember(ctx context.Context, user identity.User, chatID, actorID string, input UpdateMemberInput) (Member, error) {
	kind, role, err := s.managementContext(ctx, user, chatID)
	if err != nil {
		return Member{}, err
	}
	input.Role = normalizedRole(input.Role)
	moderator := canModerate(user)
	if role == "" && (!moderator || kind == "direct") {
		return Member{}, ErrNotFound
	}
	if kind == "direct" || !canManageContext(kind, role, moderator) {
		return Member{}, ErrForbidden
	}
	if !validRole(input.Role) {
		return Member{}, fmt.Errorf("%w: role must be owner, admin or member", ErrInvalid)
	}
	target, err := s.member(ctx, chatID, actorID)
	if err != nil {
		return Member{}, err
	}
	if (target.Role == "owner" || input.Role == "owner") && role != "owner" {
		return Member{}, ErrForbidden
	}
	if target.Role == "owner" && input.Role != "owner" {
		owners, err := s.ownerCount(ctx, chatID)
		if err != nil {
			return Member{}, err
		}
		if owners <= 1 {
			return Member{}, ErrConflict
		}
	}
	auditID, err := id.New()
	if err != nil {
		return Member{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Member{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Member{}, err
	}
	command, err := tx.Exec(ctx, `
		UPDATE chat_members target SET role = $3
		WHERE target.chat_id = $1 AND target.actor_id = $2
		  AND (EXISTS (
			SELECT 1 FROM chat_members manager JOIN chats c ON c.id = manager.chat_id
			WHERE manager.chat_id = $1 AND manager.actor_id = $4 AND manager.role IN ('owner', 'admin')
			  AND c.kind IN ('group', 'channel') AND c.archived_at IS NULL
			  AND (target.role <> 'owner' OR manager.role = 'owner')
			  AND ($3::text <> 'owner' OR manager.role = 'owner')
		  ) OR ($5::boolean AND target.role <> 'owner' AND $3::text <> 'owner'))`, chatID, actorID, input.Role, user.ActorID, moderator)
	if err != nil {
		return Member{}, fmt.Errorf("update chat member: %w", err)
	}
	if command.RowsAffected() != 1 {
		return Member{}, ErrNotFound
	}
	if err := audit(ctx, tx, auditID, user, "chat.member.update", "actor", actorID); err != nil {
		return Member{}, err
	}
	seq, err := appendDurableEvent(ctx, tx, user, chatID, "member.updated", nil, map[string]any{"actor_id": actorID, "role": input.Role})
	if err != nil {
		return Member{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Member{}, fmt.Errorf("commit chat member update: %w", err)
	}
	s.notify(user.OrgID, seq)
	return s.member(ctx, chatID, actorID)
}

func (s *Service) RemoveMember(ctx context.Context, user identity.User, chatID, actorID string) error {
	kind, role, err := s.managementContext(ctx, user, chatID)
	if err != nil {
		return err
	}
	selfLeave := actorID == user.ActorID
	moderator := canModerate(user)
	if role == "" && (!moderator || kind == "direct") {
		return ErrNotFound
	}
	if kind == "direct" || (!selfLeave && !canManageContext(kind, role, moderator)) {
		return ErrForbidden
	}
	target, err := s.member(ctx, chatID, actorID)
	if err != nil {
		return err
	}
	if !selfLeave && target.Role == "owner" && role != "owner" {
		return ErrForbidden
	}
	if target.Role == "owner" {
		owners, err := s.ownerCount(ctx, chatID)
		if err != nil {
			return err
		}
		if owners <= 1 {
			return ErrConflict
		}
	}
	auditID, err := id.New()
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `
		DELETE FROM chat_members target
		WHERE target.chat_id = $1 AND target.actor_id = $2
		  AND (EXISTS (
			SELECT 1 FROM chat_members manager JOIN chats c ON c.id = manager.chat_id
			WHERE manager.chat_id = $1 AND manager.actor_id = $3
			  AND c.kind IN ('group', 'channel') AND c.archived_at IS NULL
			  AND (target.actor_id = manager.actor_id OR manager.role IN ('owner', 'admin'))
			  AND (target.actor_id = manager.actor_id OR target.role <> 'owner' OR manager.role = 'owner')
		  ) OR ($4::boolean AND target.role <> 'owner'))`, chatID, actorID, user.ActorID, moderator)
	if err != nil {
		return fmt.Errorf("remove chat member: %w", err)
	}
	if command.RowsAffected() != 1 {
		return ErrNotFound
	}
	if err := audit(ctx, tx, auditID, user, "chat.member.remove", "actor", actorID); err != nil {
		return err
	}
	seq, err := appendDurableEvent(ctx, tx, user, chatID, "member.removed", nil, map[string]any{"actor_id": actorID})
	if err != nil {
		return err
	}
	seq, err = appendDurableEvent(ctx, tx, user, "", "member.removed", &actorID, map[string]any{"chat_id": chatID, "actor_id": actorID})
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit chat member removal: %w", err)
	}
	s.notify(user.OrgID, seq)
	return nil
}

func (s *Service) createDirect(ctx context.Context, user identity.User, input CreateInput) (Chat, error) {
	if input.Visibility != "private" || len(input.MemberIDs) != 1 || input.MemberIDs[0] == user.ActorID {
		return Chat{}, fmt.Errorf("%w: direct chat requires one other member and private visibility", ErrInvalid)
	}
	participants := []string{user.ActorID, input.MemberIDs[0]}
	sort.Strings(participants)
	pairKey := participants[0] + ":" + participants[1]
	chatID, auditID, err := twoIDs()
	if err != nil {
		return Chat{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return Chat{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Chat{}, err
	}
	var actualID string
	var created bool
	err = tx.QueryRow(ctx, `
		INSERT INTO chats (id, org_id, kind, visibility, direct_pair_key, created_by)
		SELECT $1, $2, 'direct', 'private', $3, $4
		WHERE EXISTS (SELECT 1 FROM actors WHERE id = $5 AND org_id = $2 AND status = 'active' AND deleted_at IS NULL)
		ON CONFLICT (org_id, direct_pair_key) WHERE kind = 'direct'
		DO UPDATE SET direct_pair_key = EXCLUDED.direct_pair_key
		RETURNING id, xmax = 0`, chatID, user.OrgID, pairKey, user.ActorID, input.MemberIDs[0]).Scan(&actualID, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return Chat{}, fmt.Errorf("%w: member does not exist", ErrInvalid)
	}
	if err != nil {
		return Chat{}, fmt.Errorf("upsert direct chat: %w", err)
	}
	for _, actorID := range participants {
		_, err = tx.Exec(ctx, `
			INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')
			ON CONFLICT (chat_id, actor_id) DO NOTHING`, actualID, actorID, user.OrgID)
		if err != nil {
			return Chat{}, fmt.Errorf("insert direct member: %w", err)
		}
	}
	if created {
		_, err = tx.Exec(ctx, `
			INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id)
			VALUES ($1, $2, $3, 'chat.create', 'chat', $4)`, auditID, user.OrgID, user.ActorID, actualID)
		if err != nil {
			return Chat{}, fmt.Errorf("audit direct creation: %w", err)
		}
	}
	seq := int64(0)
	if created {
		seq, err = appendDurableEvent(ctx, tx, user, actualID, "chat.created", nil, map[string]any{"chat_id": actualID, "kind": "direct"})
		if err != nil {
			return Chat{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Chat{}, fmt.Errorf("commit direct chat: %w", err)
	}
	if seq > 0 {
		s.notify(user.OrgID, seq)
	}
	return s.Get(ctx, user, actualID)
}

func lockOrganization(ctx context.Context, tx pgx.Tx, orgID string) error {
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq=event_seq WHERE id=$1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
		return fmt.Errorf("lock organization: %w", err)
	}
	return nil
}
func appendDurableEvent(ctx context.Context, tx pgx.Tx, user identity.User, chatID, eventType string, audience *string, data any) (int64, error) {
	encoded, err := json.Marshal(data)
	if err != nil {
		return 0, err
	}
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq=event_seq+1 WHERE id=$1 RETURNING event_seq`, user.OrgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("advance sequence: %w", err)
	}
	var chat *string
	if chatID != "" {
		chat = &chatID
	}
	_, err = tx.Exec(ctx, `INSERT INTO events(org_id,seq,type,actor_id,chat_id,subject_id,audience_actor_id,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, user.OrgID, seq, eventType, user.ActorID, chat, func() string {
		if audience != nil {
			return *audience
		}
		if chat != nil {
			return *chat
		}
		return user.ActorID
	}(), audience, encoded)
	if err != nil {
		return 0, fmt.Errorf("append chat event: %w", err)
	}
	if chat != nil && (eventType == "member.joined" || eventType == "member.updated" || eventType == "member.removed") {
		if _, err := tx.Exec(ctx, `INSERT INTO notification_jobs(org_id,event_seq) VALUES($1,$2) ON CONFLICT DO NOTHING`, user.OrgID, seq); err != nil {
			return 0, fmt.Errorf("enqueue notification job: %w", err)
		}
	}
	return seq, nil
}
func (s *Service) notify(orgID string, seq int64) {
	if s.afterCommit != nil {
		s.afterCommit(orgID, seq)
	}
}

func twoIDs() (string, string, error) {
	first, err := id.New()
	if err != nil {
		return "", "", err
	}
	second, err := id.New()
	return first, second, err
}

func (s *Service) member(ctx context.Context, chatID, actorID string) (Member, error) {
	var member Member
	err := s.pool.QueryRow(ctx, `
		SELECT a.id, a.type, a.display_name, a.handle::text, a.title, cm.role, cm.joined_at,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_emoji ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_text ELSE '' END,
		       CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at>now() THEN a.status_expires_at END,
		       a.avatar_version
		FROM chat_members cm JOIN actors a ON a.id = cm.actor_id
		WHERE cm.chat_id = $1 AND cm.actor_id = $2`, chatID, actorID).Scan(
		&member.ActorID, &member.Type, &member.DisplayName, &member.Handle, &member.Title, &member.Role, &member.JoinedAt,
		&member.StatusEmoji, &member.StatusText, &member.StatusExpiresAt, &member.AvatarVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return Member{}, ErrNotFound
	}
	if err != nil {
		return Member{}, fmt.Errorf("get chat member: %w", err)
	}
	return member, nil
}

func (s *Service) ownerCount(ctx context.Context, chatID string) (int, error) {
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM chat_members WHERE chat_id = $1 AND role = 'owner'`, chatID).Scan(&count); err != nil {
		return 0, fmt.Errorf("count chat owners: %w", err)
	}
	return count, nil
}

func (s *Service) managementContext(ctx context.Context, user identity.User, chatID string) (string, string, error) {
	var kind, role string
	err := s.pool.QueryRow(ctx, `
		SELECT c.kind, COALESCE(cm.role, '')
		FROM chats c
		LEFT JOIN chat_members cm
		  ON cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id = $3
		WHERE c.org_id = $1 AND c.id = $2 AND c.archived_at IS NULL`,
		user.OrgID, chatID, user.ActorID).Scan(&kind, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", fmt.Errorf("load chat management context: %w", err)
	}
	return kind, role, nil
}

func canManageContext(kind, role string, moderator bool) bool {
	if moderator {
		return kind == "group" || kind == "channel"
	}
	return role == "owner" || role == "admin"
}

func canModerate(user identity.User) bool {
	return permission.Allows(user.OrgRole, user.Permissions, permission.ChatsModerate)
}

func canManage(user identity.User, chat Chat) bool {
	return authz.Can(authz.Context{
		Active: true, OrgRole: authz.Role(user.OrgRole), ChatKind: authz.ChatKind(chat.Kind),
		ChatMember: true, ChatRole: authz.Role(chat.Role),
	}, authz.ChatManage)
}

func normalizedRole(role string) string {
	role = strings.ToLower(strings.TrimSpace(role))
	if role == "" {
		return "member"
	}
	return role
}

func validRole(role string) bool {
	return role == "owner" || role == "admin" || role == "member"
}

func valueOr(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func dereference(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func audit(ctx context.Context, tx pgx.Tx, auditID string, user identity.User, action, targetType, targetID string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id)
		VALUES ($1, $2, $3, $4, $5, $6)`, auditID, user.OrgID, user.ActorID, action, targetType, targetID)
	if err != nil {
		return fmt.Errorf("write audit event: %w", err)
	}
	return nil
}
