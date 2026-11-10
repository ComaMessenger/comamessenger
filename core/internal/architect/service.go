// Package architect is the agent Architect: a server-side conversation that
// turns a task described in words into a DRAFT of an agent.
//
// It is not an agent run. The runtime acts as an agent with its own key and
// scopes; the Architect acts as the person talking to it, so every tool runs
// with that person's rights (agents.build, their chats, their knowledge
// collections) and only over the session's draft. Publishing, pausing,
// deleting and connection or secret changes are simply not tools.
package architect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agentauthz"
	"github.com/comamessenger/comamessenger/core/internal/agentconfig"
	"github.com/comamessenger/comamessenger/core/internal/agentprovider"
	"github.com/comamessenger/comamessenger/core/internal/agentrun"
	"github.com/comamessenger/comamessenger/core/internal/agenttrigger"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/knowledge"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrForbidden          = errors.New("architect forbidden")
	ErrNotFound           = errors.New("architect session not found")
	ErrInvalid            = errors.New("invalid architect request")
	ErrExpired            = errors.New("architect session expired")
	ErrBusy               = errors.New("architect is still answering")
	ErrConnectionRequired = errors.New("a workspace model connection is required")
	ErrBudget             = errors.New("architect budget exceeded")
)

const (
	// MaxQuestions bounds the clarifying questions of one conversation.
	MaxQuestions = 4
	// SessionTTL is how long an idle conversation survives.
	SessionTTL = 24 * time.Hour
	// purgeAfter keeps expired sessions readable as «expired» for a while.
	purgeAfter = 7 * 24 * time.Hour

	maxMessageRunes        = 4000
	maxModelCallsPerTurn   = 10
	maxModelCallsPerSesson = 80
	maxTokensPerSession    = 400_000
	maxTranscriptBytes     = 768 << 10
	maxOutputTokens        = 2048
	turnLease              = 5 * time.Minute
	// modelCallTimeout keeps every model call well inside the turn lease,
	// which is renewed before each call.
	modelCallTimeout = 2 * time.Minute
)

// Limits bound what the Architect may spend. Cost limits are set on the
// workspace's hidden architect agent (the per-agent budget model); the rest
// are counted in agent_architect_calls, which no conversation can reset.
type Limits struct {
	// DailyCostLimit and MonthlyCostLimit are USD amounts for the whole
	// workspace, applied to the architect system agent.
	DailyCostLimit   string
	MonthlyCostLimit string
	// CallsPerMinute bounds model calls of the workspace, failed ones too.
	CallsPerMinute int
	// UserDailyCalls and UserDailyTokens bound one person over 24 hours
	// across all their conversations, closed and deleted ones included.
	UserDailyCalls  int
	UserDailyTokens int64
}

// DefaultLimits are deliberately modest: a conversation takes 5-20 calls.
func DefaultLimits() Limits {
	return Limits{DailyCostLimit: "5", MonthlyCostLimit: "50", CallsPerMinute: 30, UserDailyCalls: 150, UserDailyTokens: 1_500_000}
}

type Services struct {
	Agents    *agent.Service
	Triggers  *agenttrigger.Service
	Runs      *agentrun.Service
	Chats     *chat.Service
	Knowledge *knowledge.Service
	Config    *agentconfig.Service
}

type Service struct {
	pool     *pgxpool.Pool
	services Services
	model    Model
	limits   Limits
	now      func() time.Time
}

func NewService(pool *pgxpool.Pool, services Services, model Model) *Service {
	return &Service{pool: pool, services: services, model: model, limits: DefaultLimits(), now: time.Now}
}

// SetLimits replaces the spending limits (from the deployment environment).
func (service *Service) SetLimits(limits Limits) { service.limits = limits }

type Session struct {
	ID             string            `json:"id"`
	AgentID        *string           `json:"agent_id"`
	Status         string            `json:"status"`
	Locale         string            `json:"locale"`
	QuestionsAsked int               `json:"questions_asked"`
	MaxQuestions   int               `json:"max_questions"`
	Messages       []VisibleMessage  `json:"messages"`
	TestExamples   []TestExample     `json:"test_examples"`
	Assumptions    []string          `json:"assumptions"`
	Connection     SessionConnection `json:"connection"`
	Usage          SessionUsage      `json:"usage"`
	Thinking       bool              `json:"thinking"`
	CreatedAt      time.Time         `json:"created_at"`
	UpdatedAt      time.Time         `json:"updated_at"`
	ExpiresAt      time.Time         `json:"expires_at"`
}

type SessionConnection struct {
	ID        *string `json:"id"`
	Name      string  `json:"name"`
	Model     string  `json:"model"`
	Available bool    `json:"available"`
}

type SessionUsage struct {
	InputTokens  int64  `json:"input_tokens"`
	OutputTokens int64  `json:"output_tokens"`
	Cost         string `json:"cost"`
	Currency     string `json:"currency"`
}

// VisibleMessage is what the person sees. Kind is "text", "question"
// (with answer options), "done" (the draft is assembled) or "notice".
type VisibleMessage struct {
	ID          string    `json:"id"`
	Role        string    `json:"role"`
	Kind        string    `json:"kind"`
	Text        string    `json:"text"`
	Options     []string  `json:"options"`
	Assumptions []string  `json:"assumptions"`
	CreatedAt   time.Time `json:"created_at"`
}

type TestExample struct {
	Prompt      string  `json:"prompt"`
	Expectation string  `json:"expectation"`
	ChatID      *string `json:"chat_id"`
}

type StartInput struct {
	AgentID         *string `json:"agent_id"`
	LLMConnectionID *string `json:"llm_connection_id"`
	Locale          string  `json:"locale"`
}

type SendInput struct {
	Text string `json:"text"`
}

func canBuild(current identity.User) bool { return agentauthz.New().CanBuild(current) }

// Start returns the person's active conversation for the agent (or for a new
// agent) or opens one. created reports whether a new one was opened.
func (service *Service) Start(ctx context.Context, current identity.User, input StartInput) (Session, bool, error) {
	if !canBuild(current) {
		return Session{}, false, ErrForbidden
	}
	locale := normalizeLocale(input.Locale)
	var agentID *string
	if input.AgentID != nil && strings.TrimSpace(*input.AgentID) != "" {
		value := strings.TrimSpace(*input.AgentID)
		if uuid.Validate(value) != nil {
			return Session{}, false, ErrNotFound
		}
		if _, err := service.services.Agents.Get(ctx, current, value); err != nil {
			if errors.Is(err, agent.ErrNotFound) {
				return Session{}, false, ErrNotFound
			}
			return Session{}, false, err
		}
		agentID = &value
	}
	var existing string
	err := service.pool.QueryRow(ctx, `SELECT id FROM agent_architect_sessions
		WHERE org_id=$1 AND user_id=$2 AND agent_id IS NOT DISTINCT FROM $3::uuid AND status='active' AND expires_at>$4
		ORDER BY updated_at DESC LIMIT 1`, current.OrgID, current.ActorID, agentID, service.now()).Scan(&existing)
	if err == nil {
		session, err := service.Get(ctx, current, existing)
		return session, false, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Session{}, false, err
	}
	connectionID := ""
	if input.LLMConnectionID != nil && strings.TrimSpace(*input.LLMConnectionID) != "" {
		connectionID = strings.TrimSpace(*input.LLMConnectionID)
		if _, err := service.services.Config.ChatConnection(ctx, current.OrgID, connectionID); err != nil {
			return Session{}, false, ErrConnectionRequired
		}
	} else {
		connectionID, err = service.services.Config.DefaultChatConnectionID(ctx, current.OrgID)
		if errors.Is(err, agentconfig.ErrChatConnectionUnavailable) {
			return Session{}, false, ErrConnectionRequired
		}
		if err != nil {
			return Session{}, false, err
		}
	}
	sessionID, err := id.New()
	if err != nil {
		return Session{}, false, err
	}
	greeting, options := greetingFor(locale, agentID != nil)
	now := service.now().UTC()
	visible := []VisibleMessage{{ID: newMessageID(), Role: "assistant", Kind: "question", Text: greeting, Options: options, CreatedAt: now}}
	if len(options) == 0 {
		visible[0].Kind = "text"
	}
	transcript := []Message{{Role: "assistant", Text: greeting}}
	visibleJSON, _ := json.Marshal(visible)
	transcriptJSON, _ := json.Marshal(transcript)
	// One conversation per person and draft: older ones (expired too) end.
	if _, err := service.pool.Exec(ctx, `UPDATE agent_architect_sessions SET status='closed',updated_at=now()
		WHERE org_id=$1 AND user_id=$2 AND agent_id IS NOT DISTINCT FROM $3::uuid AND status='active'`, current.OrgID, current.ActorID, agentID); err != nil {
		return Session{}, false, err
	}
	if _, err := service.pool.Exec(ctx, `INSERT INTO agent_architect_sessions(id,org_id,user_id,agent_id,llm_connection_id,locale,messages,transcript,created_at,updated_at,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)`, sessionID, current.OrgID, current.ActorID, agentID, connectionID, locale, visibleJSON, transcriptJSON, now, now.Add(SessionTTL)); err != nil {
		return Session{}, false, err
	}
	session, err := service.Get(ctx, current, sessionID)
	return session, true, err
}

type sessionRow struct {
	session    Session
	connection *string
	transcript []Message
}

func (service *Service) load(ctx context.Context, current identity.User, sessionID string) (sessionRow, error) {
	if uuid.Validate(sessionID) != nil {
		return sessionRow{}, ErrNotFound
	}
	var row sessionRow
	var messages, transcript, examples, assumptions []byte
	var turnStarted *time.Time
	session := &row.session
	err := service.pool.QueryRow(ctx, `SELECT session.id,session.agent_id::text,session.status,session.locale,session.questions_asked,
		session.messages,session.transcript,session.test_examples,session.assumptions,session.llm_connection_id::text,
		COALESCE(connection.name,''),COALESCE(connection.default_model,''),COALESCE(connection.enabled AND connection.default_model<>'',false),
		session.input_tokens,session.output_tokens,session.cost::text,session.turn_started_at,session.created_at,session.updated_at,session.expires_at
		FROM agent_architect_sessions session
		LEFT JOIN agent_llm_connections connection ON connection.org_id=session.org_id AND connection.id=session.llm_connection_id
		WHERE session.org_id=$1 AND session.id=$2 AND session.user_id=$3`, current.OrgID, sessionID, current.ActorID).Scan(
		&session.ID, &session.AgentID, &session.Status, &session.Locale, &session.QuestionsAsked, &messages, &transcript, &examples, &assumptions,
		&row.connection, &session.Connection.Name, &session.Connection.Model, &session.Connection.Available,
		&session.Usage.InputTokens, &session.Usage.OutputTokens, &session.Usage.Cost, &turnStarted, &session.CreatedAt, &session.UpdatedAt, &session.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return sessionRow{}, ErrNotFound
	}
	if err != nil {
		return sessionRow{}, err
	}
	session.Connection.ID = row.connection
	session.MaxQuestions = MaxQuestions
	session.Usage.Currency = "USD"
	session.Thinking = turnStarted != nil && service.now().Sub(*turnStarted) < turnLease
	if session.Status == "active" && !session.ExpiresAt.After(service.now()) {
		session.Status = "expired"
	}
	session.Messages = []VisibleMessage{}
	session.TestExamples = []TestExample{}
	session.Assumptions = []string{}
	if err := json.Unmarshal(messages, &session.Messages); err != nil {
		return sessionRow{}, err
	}
	if err := json.Unmarshal(examples, &session.TestExamples); err != nil {
		return sessionRow{}, err
	}
	if err := json.Unmarshal(assumptions, &session.Assumptions); err != nil {
		return sessionRow{}, err
	}
	if err := json.Unmarshal(transcript, &row.transcript); err != nil {
		return sessionRow{}, err
	}
	return row, nil
}

// Get returns a conversation of the current person. Other people's sessions
// do not exist for them.
func (service *Service) Get(ctx context.Context, current identity.User, sessionID string) (Session, error) {
	if !canBuild(current) {
		return Session{}, ErrForbidden
	}
	row, err := service.load(ctx, current, sessionID)
	return row.session, err
}

// Close ends a conversation; the draft it built stays.
func (service *Service) Close(ctx context.Context, current identity.User, sessionID string) error {
	if !canBuild(current) {
		return ErrForbidden
	}
	if uuid.Validate(sessionID) != nil {
		return ErrNotFound
	}
	result, err := service.pool.Exec(ctx, `UPDATE agent_architect_sessions SET status='closed',updated_at=now() WHERE org_id=$1 AND id=$2 AND user_id=$3`, current.OrgID, sessionID, current.ActorID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

// Send adds the person's message and lets the Architect answer: it may call
// tools over the draft and ends with a question, a summary or plain text.
func (service *Service) Send(ctx context.Context, current identity.User, sessionID string, input SendInput) (Session, error) {
	if !canBuild(current) {
		return Session{}, ErrForbidden
	}
	text := strings.TrimSpace(input.Text)
	if text == "" || utf8.RuneCountInString(text) > maxMessageRunes {
		return Session{}, ErrInvalid
	}
	if uuid.Validate(sessionID) != nil {
		return Session{}, ErrNotFound
	}
	token, err := id.New()
	if err != nil {
		return Session{}, err
	}
	claimed, err := service.pool.Exec(ctx, `UPDATE agent_architect_sessions SET turn_started_at=$4,turn_token=$6
		WHERE org_id=$1 AND id=$2 AND user_id=$3 AND status='active' AND expires_at>$4 AND (turn_started_at IS NULL OR turn_started_at<$5)`,
		current.OrgID, sessionID, current.ActorID, service.now(), service.now().Add(-turnLease), token)
	if err != nil {
		return Session{}, err
	}
	if claimed.RowsAffected() != 1 {
		row, err := service.load(ctx, current, sessionID)
		if err != nil {
			return Session{}, err
		}
		switch {
		case row.session.Status != "active":
			return Session{}, ErrExpired
		default:
			return Session{}, ErrBusy
		}
	}
	defer func() {
		_, _ = service.pool.Exec(context.WithoutCancel(ctx), `UPDATE agent_architect_sessions SET turn_started_at=NULL,turn_token=NULL WHERE org_id=$1 AND id=$2 AND turn_token=$3`, current.OrgID, sessionID, token)
	}()
	row, err := service.load(ctx, current, sessionID)
	if err != nil {
		return Session{}, err
	}
	if row.connection == nil {
		return Session{}, ErrConnectionRequired
	}
	connection, err := service.services.Config.ChatConnection(ctx, current.OrgID, *row.connection)
	if errors.Is(err, agentconfig.ErrChatConnectionUnavailable) {
		return Session{}, ErrConnectionRequired
	}
	if err != nil {
		return Session{}, err
	}
	architectID, err := service.ensureArchitectAgent(ctx, current)
	if err != nil {
		return Session{}, err
	}
	turn := &turn{service: service, current: current, row: &row, connection: connection, architectID: architectID, token: token}
	turn.row.transcript = append(turn.row.transcript, Message{Role: "user", Text: text})
	turn.visible(VisibleMessage{Role: "user", Kind: "text", Text: text})
	runErr := turn.run(ctx)
	if runErr != nil && !turn.changed || errors.Is(runErr, ErrBusy) {
		// Nothing happened, or another request owns the conversation now:
		// the person keeps the message and can retry.
		return Session{}, runErr
	}
	if err := service.save(ctx, current, turn.row, token); err != nil {
		return Session{}, err
	}
	if runErr != nil {
		return Session{}, runErr
	}
	return service.Get(ctx, current, sessionID)
}

// renew extends the turn lease before a model call. A turn that lost its
// lease (it ran longer than the lease and another request took over) stops.
func (service *Service) renew(ctx context.Context, current identity.User, sessionID, token string) error {
	result, err := service.pool.Exec(ctx, `UPDATE agent_architect_sessions SET turn_started_at=$4 WHERE org_id=$1 AND id=$2 AND turn_token=$3`,
		current.OrgID, sessionID, token, service.now())
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrBusy
	}
	return nil
}

func (service *Service) save(ctx context.Context, current identity.User, row *sessionRow, token string) error {
	messages, _ := json.Marshal(row.session.Messages)
	transcript, _ := json.Marshal(row.transcript)
	examples, _ := json.Marshal(row.session.TestExamples)
	assumptions, _ := json.Marshal(row.session.Assumptions)
	if len(transcript) > maxTranscriptBytes {
		return fmt.Errorf("%w: the conversation is too long, start a new one", ErrInvalid)
	}
	now := service.now().UTC()
	result, err := service.pool.Exec(context.WithoutCancel(ctx), `UPDATE agent_architect_sessions SET agent_id=$4,questions_asked=$5,messages=$6,transcript=$7,
		test_examples=$8,assumptions=$9,updated_at=$10,expires_at=$11 WHERE org_id=$1 AND id=$2 AND user_id=$3 AND turn_token=$12`,
		current.OrgID, row.session.ID, current.ActorID, row.session.AgentID, row.session.QuestionsAsked, messages, transcript, examples, assumptions, now, now.Add(SessionTTL), token)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrBusy
	}
	return nil
}

// Cleanup runs across all workspaces. Conversations that can no longer
// continue (expired or closed) lose their model transcript at once (it may
// hold chat names and check answers); they stay readable as «expired» for
// purgeAfter and are then deleted. The call ledger keeps 35 days.
func (service *Service) Cleanup(ctx context.Context) (cleared, deleted int64, err error) {
	now := service.now()
	result, err := service.pool.Exec(ctx, `UPDATE agent_architect_sessions SET transcript='[]'::jsonb,turn_started_at=NULL,turn_token=NULL
		WHERE (status='closed' OR expires_at<$1) AND transcript<>'[]'::jsonb`, now)
	if err != nil {
		return 0, 0, err
	}
	cleared = result.RowsAffected()
	result, err = service.pool.Exec(ctx, `DELETE FROM agent_architect_sessions WHERE expires_at<$1 OR status='closed' AND updated_at<$1`, now.Add(-purgeAfter))
	if err != nil {
		return cleared, 0, err
	}
	deleted = result.RowsAffected()
	if _, err := service.pool.Exec(ctx, `DELETE FROM agent_architect_calls WHERE created_at<$1`, now.Add(-35*24*time.Hour)); err != nil {
		return cleared, deleted, err
	}
	return cleared, deleted, nil
}

// RunCleanup calls Cleanup every interval until ctx ends.
func (service *Service) RunCleanup(ctx context.Context, interval time.Duration, logger *slog.Logger) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if _, _, err := service.Cleanup(ctx); err != nil && ctx.Err() == nil && logger != nil {
			logger.Warn("architect session cleanup failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// ensureArchitectAgent provisions the hidden system agent that owns the
// Architect's usage records and cost limits in this workspace, and keeps
// those limits equal to the deployment's configuration.
func (service *Service) ensureArchitectAgent(ctx context.Context, current identity.User) (string, error) {
	daily, monthly := nullableLimit(service.limits.DailyCostLimit), nullableLimit(service.limits.MonthlyCostLimit)
	var agentID string
	err := service.pool.QueryRow(ctx, `SELECT actor_id FROM agents WHERE org_id=$1 AND system_role='architect' AND deleted_at IS NULL`, current.OrgID).Scan(&agentID)
	if err == nil {
		_, err = service.pool.Exec(ctx, `UPDATE agents SET daily_cost_limit=$3::numeric,monthly_cost_limit=$4::numeric,updated_at=now()
			WHERE org_id=$1 AND actor_id=$2 AND (daily_cost_limit IS DISTINCT FROM $3::numeric OR monthly_cost_limit IS DISTINCT FROM $4::numeric)`, current.OrgID, agentID, daily, monthly)
		return agentID, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "architect/"+current.OrgID); err != nil {
		return "", err
	}
	err = tx.QueryRow(ctx, `SELECT actor_id FROM agents WHERE org_id=$1 AND system_role='architect' AND deleted_at IS NULL`, current.OrgID).Scan(&agentID)
	if err == nil {
		return agentID, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	agentID, err = id.New()
	if err != nil {
		return "", err
	}
	ownerID := current.ActorID
	_ = tx.QueryRow(ctx, `SELECT id FROM actors WHERE org_id=$1 AND type='user' AND org_role='owner' AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1`, current.OrgID).Scan(&ownerID)
	handle := "coma_architect"
	var taken bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM actors WHERE org_id=$1 AND handle=$2)`, current.OrgID, handle).Scan(&taken); err != nil {
		return "", err
	}
	if taken {
		handle = "coma_architect_" + strings.ReplaceAll(agentID, "-", "")[:8]
	}
	if _, err := tx.Exec(ctx, `INSERT INTO actors(id,org_id,type,org_role,display_name,handle,status) VALUES($1,$2,'agent','member','Architect',$3,'active')`, agentID, current.OrgID, handle); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,operational_status,system_role,daily_cost_limit,monthly_cost_limit)
		VALUES($1,$2,$3,'builtin',false,ARRAY[]::text[],'draft','architect',$4::numeric,$5::numeric)`, agentID, current.OrgID, ownerID, daily, monthly); err != nil {
		return "", err
	}
	return agentID, tx.Commit(ctx)
}

func nullableLimit(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

// reserve admits one model call or refuses it with ErrBudget. Under a
// per-workspace lock it checks, in order: the conversation cap, the
// person's 24-hour allowance over all their conversations, the workspace
// per-minute rate and the system agent's daily and monthly cost, then
// records the call as started, so concurrent requests cannot all pass the
// same check and a failed call still counts.
func (service *Service) reserve(ctx context.Context, current identity.User, architectID string, sessionID string) (string, error) {
	callID, err := id.New()
	if err != nil {
		return "", err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "architect-budget/"+current.OrgID); err != nil {
		return "", err
	}
	now := service.now()
	var sessionCalls, userCalls, minuteCalls int
	var sessionTokens, userTokens int64
	var daily, monthly bool
	err = tx.QueryRow(ctx, `SELECT
		(SELECT model_calls FROM agent_architect_sessions WHERE org_id=$1 AND id=$2),
		(SELECT input_tokens+output_tokens FROM agent_architect_sessions WHERE org_id=$1 AND id=$2),
		(SELECT count(*) FROM agent_architect_calls WHERE org_id=$1 AND user_id=$3 AND created_at>$5),
		(SELECT COALESCE(sum(input_tokens+output_tokens),0) FROM agent_architect_calls WHERE org_id=$1 AND user_id=$3 AND created_at>$5),
		(SELECT count(*) FROM agent_architect_calls WHERE org_id=$1 AND created_at>$6),
		(SELECT agent.daily_cost_limit IS NULL OR COALESCE((SELECT sum(usage.cost) FROM agent_usage usage WHERE usage.agent_id=agent.actor_id AND usage.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) < agent.daily_cost_limit
			FROM agents agent WHERE agent.org_id=$1 AND agent.actor_id=$4),
		(SELECT agent.monthly_cost_limit IS NULL OR COALESCE((SELECT sum(usage.cost) FROM agent_usage usage WHERE usage.agent_id=agent.actor_id AND usage.created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) < agent.monthly_cost_limit
			FROM agents agent WHERE agent.org_id=$1 AND agent.actor_id=$4)`,
		current.OrgID, sessionID, current.ActorID, architectID, now.Add(-24*time.Hour), now.Add(-time.Minute)).Scan(
		&sessionCalls, &sessionTokens, &userCalls, &userTokens, &minuteCalls, &daily, &monthly)
	if err != nil {
		return "", err
	}
	limits := service.limits
	if sessionCalls >= maxModelCallsPerSesson || sessionTokens >= maxTokensPerSession ||
		limits.UserDailyCalls > 0 && userCalls >= limits.UserDailyCalls || limits.UserDailyTokens > 0 && userTokens >= limits.UserDailyTokens ||
		limits.CallsPerMinute > 0 && minuteCalls >= limits.CallsPerMinute || !daily || !monthly {
		return "", ErrBudget
	}
	if _, err := tx.Exec(ctx, `INSERT INTO agent_architect_calls(id,org_id,user_id,session_id,created_at) VALUES($1,$2,$3,$4,$5)`,
		callID, current.OrgID, current.ActorID, sessionID, now); err != nil {
		return "", err
	}
	return callID, tx.Commit(ctx)
}

// account settles one model call: the call ledger, agent_usage (the ledger
// every agent cost goes to) and the conversation counters.
func (service *Service) account(ctx context.Context, current identity.User, architectID, sessionID, callID string, connection agentconfig.ChatConnection, response ModelResponse, failed bool) error {
	ctx = context.WithoutCancel(ctx)
	status := "completed"
	if failed {
		status = "failed"
	}
	cost, source := "0", "unknown"
	if response.InputTokens > 0 || response.OutputTokens > 0 || !failed {
		cost, source = agentprovider.EstimateCost(connection.Provider, connection.Model, response.InputTokens, response.OutputTokens)
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE agent_architect_calls SET status=$3,input_tokens=$4,output_tokens=$5,cost=$6::numeric,finished_at=$7 WHERE org_id=$1 AND id=$2`,
		current.OrgID, callID, status, response.InputTokens, response.OutputTokens, cost, service.now()); err != nil {
		return err
	}
	if source != "unknown" {
		usageID, err := id.New()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_usage(id,org_id,agent_id,correlation_id,provider,model,input_tokens,output_tokens,cost,currency,price_source)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'USD',$10)`, usageID, current.OrgID, architectID, sessionID, connection.Provider, connection.Model,
			response.InputTokens, response.OutputTokens, cost, source); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_architect_sessions SET model_calls=model_calls+1,input_tokens=input_tokens+$3,output_tokens=output_tokens+$4,cost=cost+$5::numeric
		WHERE org_id=$1 AND id=$2`, current.OrgID, sessionID, response.InputTokens, response.OutputTokens, cost); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type turn struct {
	service     *Service
	current     identity.User
	row         *sessionRow
	connection  agentconfig.ChatConnection
	architectID string
	token       string
	changed     bool
}

func (turn *turn) visible(message VisibleMessage) {
	message.ID = newMessageID()
	message.CreatedAt = turn.service.now().UTC()
	if message.Options == nil {
		message.Options = []string{}
	}
	if message.Assumptions == nil {
		message.Assumptions = []string{}
	}
	turn.row.session.Messages = append(turn.row.session.Messages, message)
}

func (turn *turn) run(ctx context.Context) error {
	session := &turn.row.session
	for range maxModelCallsPerTurn {
		if err := turn.service.renew(ctx, turn.current, session.ID, turn.token); err != nil {
			return err
		}
		callID, err := turn.service.reserve(ctx, turn.current, turn.architectID, session.ID)
		if err != nil {
			return err
		}
		tools := toolSpecs(session.QuestionsAsked < MaxQuestions)
		callCtx, cancel := context.WithTimeout(ctx, modelCallTimeout)
		response, err := turn.service.model.Complete(callCtx, ModelRequest{
			Provider: turn.connection.Provider, EndpointURL: turn.connection.EndpointURL, APIKey: turn.connection.APIKey, Model: turn.connection.Model,
			System: systemPrompt(session.Locale, session.QuestionsAsked, session.AgentID != nil), Messages: turn.row.transcript, Tools: tools, MaxOutputTokens: maxOutputTokens,
		})
		cancel()
		if accountErr := turn.service.account(ctx, turn.current, turn.architectID, session.ID, callID, turn.connection, response, err != nil); accountErr != nil {
			return accountErr
		}
		if err != nil {
			if errors.Is(err, ErrModel) {
				return err
			}
			return fmt.Errorf("%w: %v", ErrModel, err)
		}
		turn.changed = true
		for index := range response.ToolCalls {
			if response.ToolCalls[index].ID == "" {
				response.ToolCalls[index].ID = "call_" + newMessageID()
			}
		}
		turn.row.transcript = append(turn.row.transcript, Message{Role: "assistant", Text: response.Text, ToolCalls: response.ToolCalls})
		if len(response.ToolCalls) == 0 {
			text := strings.TrimSpace(response.Text)
			if text == "" {
				text = localized(session.Locale, "empty_answer")
			}
			turn.visible(VisibleMessage{Role: "assistant", Kind: "text", Text: text})
			return nil
		}
		var stop *VisibleMessage
		for _, call := range response.ToolCalls {
			result, message := turn.execute(ctx, call)
			encoded, _ := json.Marshal(result)
			turn.row.transcript = append(turn.row.transcript, Message{Role: "tool", ToolCallID: call.ID, Text: string(encoded)})
			if message != nil && stop == nil {
				stop = message
			}
		}
		if stop != nil {
			if text := strings.TrimSpace(response.Text); text != "" && stop.Kind == "question" && !strings.Contains(stop.Text, text) {
				stop.Text = text + "\n\n" + stop.Text
			}
			turn.visible(*stop)
			return nil
		}
	}
	turn.visible(VisibleMessage{Role: "assistant", Kind: "notice", Text: localized(turn.row.session.Locale, "too_many_steps")})
	return nil
}

func newMessageID() string {
	value, err := id.New()
	if err != nil {
		return fmt.Sprint(time.Now().UnixNano())
	}
	return value
}

func normalizeLocale(value string) string {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(value)), "en") {
		return "en"
	}
	return "ru"
}
