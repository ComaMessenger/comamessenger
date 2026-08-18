package chat

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/authz"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrForbidden = errors.New("chat action forbidden")
	ErrNotFound  = errors.New("chat not found")
	ErrInvalid   = errors.New("invalid chat input")
)

type Chat struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"`
	Visibility string     `json:"visibility"`
	Name       *string    `json:"name"`
	Topic      string     `json:"topic"`
	Role       string     `json:"role"`
	CreatedAt  time.Time  `json:"created_at"`
	ArchivedAt *time.Time `json:"archived_at,omitempty"`
}

type CreateInput struct {
	Kind       string   `json:"kind"`
	Visibility string   `json:"visibility"`
	Name       string   `json:"name"`
	Topic      string   `json:"topic"`
	MemberIDs  []string `json:"member_ids"`
}

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) List(ctx context.Context, user identity.User) ([]Chat, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.kind, c.visibility, c.name, c.topic, cm.role, c.created_at, c.archived_at
		FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
		WHERE cm.actor_id = $1 AND c.org_id = $2
		ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`, user.ActorID, user.OrgID)
	if err != nil {
		return nil, fmt.Errorf("list chats: %w", err)
	}
	defer rows.Close()
	chats := make([]Chat, 0)
	for rows.Next() {
		var chat Chat
		if err := rows.Scan(&chat.ID, &chat.Kind, &chat.Visibility, &chat.Name, &chat.Topic,
			&chat.Role, &chat.CreatedAt, &chat.ArchivedAt); err != nil {
			return nil, fmt.Errorf("scan chat: %w", err)
		}
		chats = append(chats, chat)
	}
	return chats, rows.Err()
}

func (s *Service) Get(ctx context.Context, user identity.User, chatID string) (Chat, error) {
	var chat Chat
	err := s.pool.QueryRow(ctx, `
		SELECT c.id, c.kind, c.visibility, c.name, c.topic, cm.role, c.created_at, c.archived_at
		FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.actor_id = $2
		WHERE c.id = $1 AND c.org_id = $3`, chatID, user.ActorID, user.OrgID).Scan(
		&chat.ID, &chat.Kind, &chat.Visibility, &chat.Name, &chat.Topic,
		&chat.Role, &chat.CreatedAt, &chat.ArchivedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Chat{}, ErrNotFound
	}
	if err != nil {
		return Chat{}, fmt.Errorf("get chat: %w", err)
	}
	return chat, nil
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
	if input.Kind == "channel" && !authz.Can(authz.Context{Active: true, OrgRole: authz.Role(user.OrgRole)}, authz.ChannelCreate) {
		return Chat{}, ErrForbidden
	}
	if input.Visibility != "private" && input.Visibility != "public" {
		return Chat{}, fmt.Errorf("%w: visibility must be private or public", ErrInvalid)
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
	if err := tx.Commit(ctx); err != nil {
		return Chat{}, fmt.Errorf("commit chat creation: %w", err)
	}
	return s.Get(ctx, user, chatID)
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
	if err := tx.Commit(ctx); err != nil {
		return Chat{}, fmt.Errorf("commit direct chat: %w", err)
	}
	return s.Get(ctx, user, actualID)
}

func twoIDs() (string, string, error) {
	first, err := id.New()
	if err != nil {
		return "", "", err
	}
	second, err := id.New()
	return first, second, err
}
