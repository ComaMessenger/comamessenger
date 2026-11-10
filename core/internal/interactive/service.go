// Package interactive implements the server side of agents that ask people
// and wait: waking an agent when its card is pressed, response collections
// with reminders, and agent follow-ups scheduled for a later moment.
//
// Everything is persisted in PostgreSQL and driven by a polling worker, so a
// Core restart only delays work. Each item is processed in its own
// transaction under a row lock, which keeps several Core replicas from
// sending a reminder or starting a follow-up twice.
package interactive

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid   = errors.New("invalid interactive request")
	ErrNotFound  = errors.New("interactive object not found")
	ErrForbidden = errors.New("interactive request forbidden")
	ErrLimit     = errors.New("interactive limit reached")
	// ErrQuietHours refuses a private delivery during the recipient's quiet
	// hours; it is a limit, and its message says when the window ends.
	ErrQuietHours = fmt.Errorf("%w: the person is in quiet hours", ErrLimit)
)

// Limits are server-side guard rails against agents that nag people. They are
// deliberately not configurable by the agent itself.
type Limits struct {
	// QuietStartMinute and QuietEndMinute bound the nightly window in the
	// recipient's own timezone (minutes after midnight). Reminders are moved
	// to the end of the window. Equal values disable quiet hours.
	QuietStartMinute int
	QuietEndMinute   int
	// MaxRemindersPerPersonPerDay caps reminders one person receives from all
	// agents in a rolling 24 hours.
	MaxRemindersPerPersonPerDay int
	// MaxDirectMessagesPerPersonPerDay caps private deliveries (messages,
	// cards, card edits, direct reminders) to one person from one agent in a
	// rolling 24 hours.
	MaxDirectMessagesPerPersonPerDay int
	// MaxAgentDirectPerPersonPerDay caps private deliveries (direct messages,
	// direct cards and their edits, direct reminders) one person receives
	// from all agents together in a rolling 24 hours.
	MaxAgentDirectPerPersonPerDay int
	MaxOpenCollectionsPerAgent    int
	MaxPendingFollowupsPerAgent   int
	MaxFollowupDelay              time.Duration
	MinFollowupDelay              time.Duration
	MaxCollectionDuration         time.Duration
}

func DefaultLimits() Limits {
	return Limits{
		QuietStartMinute:                 21 * 60,
		QuietEndMinute:                   8 * 60,
		MaxRemindersPerPersonPerDay:      6,
		MaxDirectMessagesPerPersonPerDay: 10,
		MaxAgentDirectPerPersonPerDay:    15,
		MaxOpenCollectionsPerAgent:       20,
		MaxPendingFollowupsPerAgent:      50,
		MaxFollowupDelay:                 30 * 24 * time.Hour,
		MinFollowupDelay:                 time.Minute,
		MaxCollectionDuration:            30 * 24 * time.Hour,
	}
}

type Service struct {
	pool     *pgxpool.Pool
	messages *message.Service
	chats    *chat.Service
	logger   *slog.Logger
	limits   Limits
	now      func() time.Time
}

func NewService(pool *pgxpool.Pool, messages *message.Service, chats *chat.Service, logger *slog.Logger, limits Limits) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{pool: pool, messages: messages, chats: chats, logger: logger, limits: limits, now: time.Now}
}

// SetClock replaces the time source; tests use it to move past deadlines.
func (s *Service) SetClock(now func() time.Time) { s.now = now }

func (s *Service) Limits() Limits { return s.limits }

func stableID(parts ...string) string {
	name := "coma/interactive"
	for _, part := range parts {
		name += "/" + part
	}
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(name)).String()
}

type runRequest struct {
	OrgID        string
	AgentID      string
	ChatID       string
	ThreadRootID *string
	RequestedBy  *string
	ClientRunID  string
	ChainDepth   int
	Input        map[string]any
}

// enqueueRun queues a published-agent run in the caller's transaction. The
// client_run_id makes the wake idempotent; nothing is queued for a paused,
// deleted or chat-less agent.
func enqueueRun(ctx context.Context, tx pgx.Tx, request runRequest) (string, bool, error) {
	runID := uuid.Must(uuid.NewV7()).String()
	correlationID := uuid.Must(uuid.NewV7()).String()
	payload, err := json.Marshal(request.Input)
	if err != nil {
		return "", false, err
	}
	command, err := tx.Exec(ctx, `INSERT INTO agent_runs(id,org_id,agent_id,agent_version,agent_config,chat_id,thread_root_id,requested_by,client_run_id,
			correlation_id,chain_depth,provider,model,input,timeout_at)
		SELECT $1,agent.org_id,agent.actor_id,agent.published_version,
			jsonb_build_object('id',agent.actor_id,'handle',actor.handle,'description',agent.description,'allowed_scopes',to_jsonb(agent.allowed_scopes),
				'llm_connection_id',agent.llm_connection_id,'endpoint_url',COALESCE(connection.endpoint_url,agent.endpoint_url),
				'external_data_sharing_approved',agent.external_data_sharing_approved,'max_output_tokens',agent.max_output_tokens,'max_tool_iterations',agent.max_tool_iterations),
			$2,$3,$4,$5,$6,LEAST($7::int,agent.max_chain_depth),COALESCE(connection.provider,agent.provider),COALESCE(NULLIF(agent.model,''),connection.default_model,''),$8,
			now()+make_interval(secs=>agent.execution_timeout_seconds)
		FROM agents agent
		JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id AND actor.status='active' AND actor.deleted_at IS NULL
		LEFT JOIN agent_llm_connections connection ON connection.org_id=agent.org_id AND connection.id=agent.llm_connection_id AND connection.enabled
		JOIN chat_members member ON member.org_id=agent.org_id AND member.actor_id=agent.actor_id AND member.chat_id=$2
		JOIN chats chat ON chat.org_id=member.org_id AND chat.id=member.chat_id AND chat.archived_at IS NULL
		WHERE agent.org_id=$9 AND agent.actor_id=$10 AND agent.enabled AND agent.deleted_at IS NULL
			AND (agent.llm_connection_id IS NULL OR connection.id IS NOT NULL)
		ON CONFLICT(agent_id,client_run_id) DO NOTHING`,
		runID, request.ChatID, request.ThreadRootID, request.RequestedBy, request.ClientRunID, correlationID, request.ChainDepth, payload, request.OrgID, request.AgentID)
	if err != nil {
		return "", false, fmt.Errorf("enqueue interactive agent run: %w", err)
	}
	if command.RowsAffected() == 1 {
		return runID, true, nil
	}
	var existing string
	err = tx.QueryRow(ctx, `SELECT id FROM agent_runs WHERE agent_id=$1 AND client_run_id=$2`, request.AgentID, request.ClientRunID).Scan(&existing)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	return existing, false, err
}

// ActionHook wakes the agent that authored a pressed card. It runs inside the
// press transaction, so the press and the wake commit together.
func (s *Service) ActionHook() message.ActionHook {
	return func(ctx context.Context, tx pgx.Tx, press message.ActionPress) error {
		var isAgent bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agents WHERE org_id=$1 AND actor_id=$2)`, press.OrgID, press.AuthorID).Scan(&isAgent); err != nil {
			return err
		}
		if !isAgent {
			return nil
		}
		input := map[string]any{
			"trigger_type": "message_action", "message_id": press.MessageID, "action_id": press.ActionID,
			"actor_id": press.ActorID, "chat_id": press.ChatID, "thread_root_id": press.ThreadRootID,
			"responded_at": press.RespondedAt,
		}
		if press.Blocks != nil && press.Blocks.Card != nil {
			input["card_title"] = press.Blocks.Card.Title
		}
		actor := press.ActorID
		_, _, err := enqueueRun(ctx, tx, runRequest{
			OrgID: press.OrgID, AgentID: press.AuthorID, ChatID: press.ChatID, ThreadRootID: press.ThreadRootID,
			RequestedBy: &actor, ClientRunID: press.ResponseID, Input: input,
		})
		return err
	}
}

// runContext returns the facts of an active agent run that interactive tools
// bind their objects to.
type runContext struct {
	ChatID       *string
	ThreadRootID *string
	AgentVersion *int
	ChainDepth   int
}

func loadRun(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, agent identity.User, runID string) (runContext, error) {
	var result runContext
	err := q.QueryRow(ctx, `SELECT chat_id, thread_root_id, agent_version, chain_depth FROM agent_runs WHERE org_id=$1 AND agent_id=$2 AND id=$3`,
		agent.OrgID, agent.ActorID, runID).Scan(&result.ChatID, &result.ThreadRootID, &result.AgentVersion, &result.ChainDepth)
	if errors.Is(err, pgx.ErrNoRows) {
		return runContext{}, ErrForbidden
	}
	return result, err
}

func agentMember(ctx context.Context, tx pgx.Tx, orgID, agentID, chatID string) (bool, error) {
	var member bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM chat_members cm JOIN chats c ON c.org_id=cm.org_id AND c.id=cm.chat_id AND c.archived_at IS NULL
		WHERE cm.org_id=$1 AND cm.chat_id=$2 AND cm.actor_id=$3)`, orgID, chatID, agentID).Scan(&member)
	return member, err
}

func audit(ctx context.Context, tx pgx.Tx, orgID, actorID, action, targetType, targetID string, metadata map[string]any) error {
	encoded, _ := json.Marshal(metadata)
	_, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)`,
		uuid.Must(uuid.NewV7()).String(), orgID, actorID, action, targetType, targetID, encoded)
	return err
}

// inQuietHours reports whether local time falls inside the nightly window and
// when that window ends.
func (s *Service) inQuietHours(now time.Time, timezone string) (bool, time.Time) {
	start, end := s.limits.QuietStartMinute, s.limits.QuietEndMinute
	if start == end {
		return false, now
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		location = time.UTC
	}
	local := now.In(location)
	minute := local.Hour()*60 + local.Minute()
	quiet := (start < end && minute >= start && minute < end) || (start > end && (minute >= start || minute < end))
	if !quiet {
		return false, now
	}
	midnight := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
	ends := midnight.Add(time.Duration(end) * time.Minute)
	if !ends.After(local) {
		ends = ends.AddDate(0, 0, 1)
	}
	return true, ends.UTC()
}

// Run polls due follow-ups and open collections until ctx is canceled.
func (s *Service) Run(ctx context.Context, interval time.Duration) {
	if interval < 100*time.Millisecond {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.Tick(ctx); err != nil && !errors.Is(err, context.Canceled) {
				s.logger.Error("interactive worker tick failed", "error", err)
			}
		}
	}
}

// Tick processes one batch of due follow-ups and open collections.
func (s *Service) Tick(ctx context.Context) error {
	if err := s.DispatchFollowups(ctx); err != nil {
		return err
	}
	return s.ProcessCollections(ctx)
}
