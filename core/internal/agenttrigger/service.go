package agenttrigger

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid   = errors.New("invalid agent trigger")
	ErrForbidden = errors.New("agent trigger forbidden")
	ErrNotFound  = errors.New("agent trigger not found")
	ErrConflict  = errors.New("agent trigger conflict")
)

type Trigger struct {
	ID               string          `json:"id"`
	OrgID            string          `json:"org_id"`
	AgentID          string          `json:"agent_id"`
	Type             string          `json:"type"`
	Config           json.RawMessage `json:"config"`
	Enabled          bool            `json:"enabled"`
	Timezone         string          `json:"timezone"`
	MissedRunsPolicy string          `json:"missed_runs_policy"`
	NextRunAt        *time.Time      `json:"next_run_at,omitempty"`
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
}

type CreateInput struct {
	Type             string          `json:"type"`
	Config           json.RawMessage `json:"config"`
	Enabled          bool            `json:"enabled"`
	Timezone         string          `json:"timezone"`
	MissedRunsPolicy string          `json:"missed_runs_policy"`
}

type UpdateInput struct {
	Config           *json.RawMessage `json:"config"`
	Enabled          *bool            `json:"enabled"`
	Timezone         *string          `json:"timezone"`
	MissedRunsPolicy *string          `json:"missed_runs_policy"`
}

type event struct {
	seq          int64
	kind         string
	actorID      *string
	actorType    string
	subjectID    string
	chatID       *string
	threadRootID *string
	body         string
	mentioned    []string
	sourceDepth  *int
}

type Service struct {
	pool   *pgxpool.Pool
	logger *slog.Logger
	now    func() time.Time
}

func NewService(pool *pgxpool.Pool, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{pool: pool, logger: logger, now: time.Now}
}

func (service *Service) Create(ctx context.Context, current identity.User, agentID string, input CreateInput) (Trigger, error) {
	if !canManage(current) {
		return Trigger{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil {
		return Trigger{}, ErrNotFound
	}
	normalized, next, err := service.normalize(input)
	if err != nil {
		return Trigger{}, err
	}
	triggerID, err := id.New()
	if err != nil {
		return Trigger{}, err
	}
	auditID, err := id.New()
	if err != nil {
		return Trigger{}, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Trigger{}, err
	}
	defer tx.Rollback(ctx)
	if err := validateAgentAndScheduleChat(ctx, tx, current.OrgID, agentID, normalized); err != nil {
		return Trigger{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO agent_triggers(id,org_id,agent_id,type,config,enabled,timezone,missed_runs_policy,next_run_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, triggerID, current.OrgID, agentID, normalized.Type, normalized.Config,
		normalized.Enabled, normalized.Timezone, normalized.MissedRunsPolicy, next); err != nil {
		return Trigger{}, err
	}
	metadata, _ := json.Marshal(map[string]any{"trigger_id": triggerID, "type": normalized.Type, "enabled": normalized.Enabled})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'agent.trigger.create','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return Trigger{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Trigger{}, err
	}
	return service.get(ctx, current.OrgID, triggerID)
}

func (service *Service) List(ctx context.Context, current identity.User, agentID string) ([]Trigger, error) {
	if !canManage(current) {
		return nil, ErrForbidden
	}
	rows, err := service.pool.Query(ctx, triggerSelect+` WHERE trigger.org_id=$1 AND trigger.agent_id=$2 ORDER BY trigger.created_at`, current.OrgID, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Trigger, 0)
	for rows.Next() {
		item, err := scanTrigger(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (service *Service) Update(ctx context.Context, current identity.User, agentID, triggerID string, input UpdateInput) (Trigger, error) {
	if !canManage(current) {
		return Trigger{}, ErrForbidden
	}
	existing, err := service.get(ctx, current.OrgID, triggerID)
	if err != nil || existing.AgentID != agentID {
		if err == nil {
			err = ErrNotFound
		}
		return Trigger{}, err
	}
	prospective := CreateInput{Type: existing.Type, Config: existing.Config, Enabled: existing.Enabled, Timezone: existing.Timezone, MissedRunsPolicy: existing.MissedRunsPolicy}
	if input.Config != nil {
		prospective.Config = *input.Config
	}
	if input.Enabled != nil {
		prospective.Enabled = *input.Enabled
	}
	if input.Timezone != nil {
		prospective.Timezone = *input.Timezone
	}
	if input.MissedRunsPolicy != nil {
		prospective.MissedRunsPolicy = *input.MissedRunsPolicy
	}
	normalized, next, err := service.normalize(prospective)
	if err != nil {
		return Trigger{}, err
	}
	auditID, err := id.New()
	if err != nil {
		return Trigger{}, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Trigger{}, err
	}
	defer tx.Rollback(ctx)
	if err := validateAgentAndScheduleChat(ctx, tx, current.OrgID, agentID, normalized); err != nil {
		return Trigger{}, err
	}
	result, err := tx.Exec(ctx, `UPDATE agent_triggers SET config=$4,enabled=$5,timezone=$6,missed_runs_policy=$7,next_run_at=$8,updated_at=now()
		WHERE org_id=$1 AND agent_id=$2 AND id=$3`, current.OrgID, agentID, triggerID, normalized.Config, normalized.Enabled,
		normalized.Timezone, normalized.MissedRunsPolicy, next)
	if err != nil {
		return Trigger{}, err
	}
	if result.RowsAffected() != 1 {
		return Trigger{}, ErrNotFound
	}
	metadata, _ := json.Marshal(map[string]any{"trigger_id": triggerID, "enabled": normalized.Enabled})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'agent.trigger.update','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return Trigger{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Trigger{}, err
	}
	return service.get(ctx, current.OrgID, triggerID)
}

func (service *Service) Delete(ctx context.Context, current identity.User, agentID, triggerID string) error {
	if !canManage(current) {
		return ErrForbidden
	}
	auditID, err := id.New()
	if err != nil {
		return err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `DELETE FROM agent_triggers WHERE org_id=$1 AND agent_id=$2 AND id=$3`, current.OrgID, agentID, triggerID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return ErrConflict
		}
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrNotFound
	}
	metadata, _ := json.Marshal(map[string]any{"trigger_id": triggerID})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'agent.trigger.delete','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func validateAgentAndScheduleChat(ctx context.Context, tx pgx.Tx, orgID, agentID string, input CreateInput) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT true FROM agents WHERE org_id=$1 AND actor_id=$2 FOR UPDATE`, orgID, agentID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	chatID := ""
	if input.Type == "schedule" {
		var config scheduleConfig
		if err := json.Unmarshal(input.Config, &config); err != nil {
			return ErrInvalid
		}
		chatID = config.ChatID
	} else if input.Type == "event" {
		var config eventConfig
		if err := json.Unmarshal(input.Config, &config); err != nil {
			return ErrInvalid
		}
		chatID = config.ChatID
	}
	if chatID == "" {
		return nil
	}
	if err := tx.QueryRow(ctx, `SELECT true FROM chat_members WHERE org_id=$1 AND actor_id=$2 AND chat_id=$3`, orgID, agentID, chatID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	} else {
		return err
	}
}

func (service *Service) DispatchEvents(ctx context.Context) error {
	rows, err := service.pool.Query(ctx, `SELECT agent.actor_id,agent.org_id,agent.max_chain_depth
		FROM agents agent JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id
		WHERE agent.enabled AND actor.status='active' AND actor.deleted_at IS NULL ORDER BY agent.actor_id`)
	if err != nil {
		return err
	}
	type target struct {
		agent    string
		org      string
		maxDepth int
	}
	targets := make([]target, 0)
	for rows.Next() {
		var item target
		if err := rows.Scan(&item.agent, &item.org, &item.maxDepth); err != nil {
			rows.Close()
			return err
		}
		targets = append(targets, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, target := range targets {
		if err := service.dispatchAgent(ctx, target.org, target.agent, target.maxDepth); err != nil {
			service.logger.Error("agent trigger dispatch failed", "org_id", target.org, "agent_id", target.agent, "error", err)
		}
	}
	return nil
}

func (service *Service) dispatchAgent(ctx context.Context, orgID, agentID string, maxDepth int) error {
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO agent_checkpoints(org_id,agent_id,last_event_seq)
		SELECT $1,$2,event_seq FROM organizations WHERE id=$1 ON CONFLICT(agent_id) DO NOTHING`, orgID, agentID); err != nil {
		return err
	}
	var checkpoint int64
	if err := tx.QueryRow(ctx, `SELECT last_event_seq FROM agent_checkpoints WHERE agent_id=$1 FOR UPDATE`, agentID).Scan(&checkpoint); err != nil {
		return err
	}
	triggers, err := loadTriggers(ctx, tx, orgID, agentID)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT event.seq,event.type,event.actor_id,COALESCE(actor.type,'system'),event.chat_id,event.subject_id,
			message.thread_root_id,COALESCE(message.body,''),COALESCE(message.mentioned_actor_ids,'{}'::uuid[]),provenance.chain_depth
		FROM events event LEFT JOIN actors actor ON actor.org_id=event.org_id AND actor.id=event.actor_id
		LEFT JOIN messages message ON message.org_id=event.org_id AND message.id=event.subject_id
		LEFT JOIN message_agent_provenance provenance ON provenance.message_id=message.id
		WHERE event.org_id=$1 AND event.seq>$2 AND (event.chat_id IS NULL OR EXISTS(
			SELECT 1 FROM chat_members member WHERE member.org_id=event.org_id AND member.chat_id=event.chat_id AND member.actor_id=$3))
		ORDER BY event.seq LIMIT 100`, orgID, checkpoint, agentID)
	if err != nil {
		return err
	}
	events := make([]event, 0)
	for rows.Next() {
		var item event
		if err := rows.Scan(&item.seq, &item.kind, &item.actorID, &item.actorType, &item.chatID, &item.subjectID, &item.threadRootID, &item.body, &item.mentioned, &item.sourceDepth); err != nil {
			rows.Close()
			return err
		}
		events = append(events, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, item := range events {
		for _, trigger := range triggers {
			matched, includeAgents := matches(trigger, item, agentID)
			if !matched || (item.actorID != nil && *item.actorID == agentID) || (item.actorType == "agent" && !includeAgents) {
				continue
			}
			depth := 0
			if item.sourceDepth != nil {
				depth = *item.sourceDepth + 1
			}
			if depth > maxDepth {
				continue
			}
			runID, err := id.New()
			if err != nil {
				return err
			}
			correlationID, err := id.New()
			if err != nil {
				return err
			}
			runChatID := item.chatID
			runThreadRootID := item.threadRootID
			if trigger.Type == "event" {
				var config eventConfig
				_ = json.Unmarshal(trigger.Config, &config)
				if config.ChatID != "" {
					runChatID = &config.ChatID
					if item.chatID == nil || *item.chatID != config.ChatID {
						runThreadRootID = nil
					}
				}
			}
			payloadData := map[string]any{
				"event_seq": item.seq, "event_type": item.kind, "subject_id": item.subjectID,
				"source_chat_id": item.chatID, "chat_id": runChatID,
				"thread_root_id": item.threadRootID, "message_body": item.body,
				"trigger_type": trigger.Type, "trigger_id": trigger.ID,
			}
			if trigger.Type == "command" {
				var config commandConfig
				_ = json.Unmarshal(trigger.Config, &config)
				payloadData["command"] = config.Command
				payloadData["command_arguments"] = commandArguments(item.body)
			}
			payload, _ := json.Marshal(payloadData)
			if _, err := tx.Exec(ctx, `INSERT INTO agent_runs(id,org_id,agent_id,trigger_id,trigger_event_seq,chat_id,thread_root_id,requested_by,
					correlation_id,chain_depth,provider,model,input,timeout_at)
				SELECT $1,agent.org_id,agent.actor_id,$2,$3,$4,$5,$6,$7,$8,agent.provider,agent.model,$9,
					now()+make_interval(secs=>agent.execution_timeout_seconds)
				FROM agents agent WHERE agent.org_id=$10 AND agent.actor_id=$11
				ON CONFLICT(agent_id,trigger_id,trigger_event_seq) WHERE trigger_id IS NOT NULL AND trigger_event_seq IS NOT NULL DO NOTHING`,
				runID, trigger.ID, item.seq, runChatID, runThreadRootID, item.actorID, correlationID, depth, payload, orgID, agentID); err != nil {
				return err
			}
		}
		checkpoint = item.seq
	}
	if len(events) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE agent_checkpoints SET last_event_seq=$2,updated_at=now() WHERE agent_id=$1`, agentID, checkpoint); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (service *Service) DispatchSchedules(ctx context.Context) error {
	now := service.now().UTC()
	rows, err := service.pool.Query(ctx, `SELECT trigger.id FROM agent_triggers trigger
		WHERE trigger.enabled AND trigger.type='schedule' AND trigger.next_run_at<=$1
		ORDER BY trigger.next_run_at LIMIT 100`, now)
	if err != nil {
		return err
	}
	due := make([]string, 0)
	for rows.Next() {
		var triggerID string
		if err := rows.Scan(&triggerID); err != nil {
			rows.Close()
			return err
		}
		due = append(due, triggerID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, triggerID := range due {
		if err := service.dispatchSchedule(ctx, triggerID, now); err != nil {
			service.logger.Error("agent schedule dispatch failed", "trigger_id", triggerID, "error", err)
		}
	}
	return nil
}

func (service *Service) dispatchSchedule(ctx context.Context, triggerID string, now time.Time) error {
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	trigger, err := scanTrigger(tx.QueryRow(ctx, triggerSelect+` WHERE trigger.id=$1 AND trigger.enabled AND trigger.type='schedule'
		AND trigger.next_run_at<=$2 FOR UPDATE OF trigger SKIP LOCKED`, triggerID, now))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	scheduled := *trigger.NextRunAt
	var config scheduleConfig
	if err := json.Unmarshal(trigger.Config, &config); err != nil {
		return err
	}
	shouldRun := trigger.MissedRunsPolicy == "latest" || now.Sub(scheduled) <= 2*time.Minute
	if shouldRun {
		runID, err := id.New()
		if err != nil {
			return err
		}
		correlationID, err := id.New()
		if err != nil {
			return err
		}
		var sinceLastRun *time.Time
		if err := tx.QueryRow(ctx, `SELECT max(scheduled_for) FROM agent_runs WHERE trigger_id=$1 AND scheduled_for<$2`, trigger.ID, scheduled).Scan(&sinceLastRun); err != nil {
			return err
		}
		payload, _ := json.Marshal(map[string]any{
			"scheduled_for":  scheduled,
			"since_last_run": sinceLastRun,
			"chat_id":        config.ChatID,
			"timezone":       trigger.Timezone,
			"trigger_type":   trigger.Type,
			"trigger_id":     trigger.ID,
		})
		if _, err := tx.Exec(ctx, `INSERT INTO agent_runs(id,org_id,agent_id,trigger_id,scheduled_for,chat_id,correlation_id,provider,model,input,timeout_at)
				SELECT $1,agent.org_id,agent.actor_id,$2,$3,$4,$5,agent.provider,agent.model,$6,
					now()+make_interval(secs=>agent.execution_timeout_seconds)
				FROM agents agent
				JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id AND actor.status='active' AND actor.deleted_at IS NULL
				JOIN chat_members member ON member.org_id=agent.org_id AND member.actor_id=agent.actor_id AND member.chat_id=$4
				WHERE agent.org_id=$7 AND agent.actor_id=$8 AND agent.enabled
				ON CONFLICT(trigger_id,scheduled_for) WHERE trigger_id IS NOT NULL AND scheduled_for IS NOT NULL DO NOTHING`,
			runID, trigger.ID, scheduled, config.ChatID, correlationID, payload, trigger.OrgID, trigger.AgentID); err != nil {
			return err
		}
	}
	next, err := nextSchedule(config, trigger.Timezone, now)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_triggers SET next_run_at=$2,updated_at=now() WHERE id=$1`, trigger.ID, next); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (service *Service) Run(ctx context.Context, interval time.Duration) {
	if interval < 100*time.Millisecond {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := service.DispatchEvents(ctx); err != nil && !errors.Is(err, context.Canceled) {
				service.logger.Error("agent trigger event dispatch failed", "error", err)
			}
			if err := service.DispatchSchedules(ctx); err != nil && !errors.Is(err, context.Canceled) {
				service.logger.Error("agent trigger schedule dispatch failed", "error", err)
			}
		}
	}
}

type scheduleConfig struct {
	ChatID     string `json:"chat_id"`
	Hour       int    `json:"hour"`
	Minute     int    `json:"minute"`
	DaysOfWeek []int  `json:"days_of_week"`
}
type messageOptions struct {
	IncludeAgentMessages bool `json:"include_agent_messages"`
}
type commandConfig struct {
	Command              string `json:"command"`
	IncludeAgentMessages bool   `json:"include_agent_messages"`
}
type keywordConfig struct {
	Pattern              string `json:"pattern"`
	CaseSensitive        bool   `json:"case_sensitive"`
	IncludeAgentMessages bool   `json:"include_agent_messages"`
}
type eventConfig struct {
	EventTypes           []string `json:"event_types"`
	IncludeAgentMessages bool     `json:"include_agent_messages"`
	ChatID               string   `json:"chat_id,omitempty"`
}

func (service *Service) normalize(input CreateInput) (CreateInput, *time.Time, error) {
	input.Type = strings.ToLower(strings.TrimSpace(input.Type))
	input.Timezone = strings.TrimSpace(input.Timezone)
	if input.Timezone == "" {
		input.Timezone = "UTC"
	}
	if len(input.Timezone) > 64 {
		return input, nil, ErrInvalid
	}
	if _, err := time.LoadLocation(input.Timezone); err != nil {
		return input, nil, ErrInvalid
	}
	if input.MissedRunsPolicy == "" {
		input.MissedRunsPolicy = "skip"
	}
	if input.MissedRunsPolicy != "skip" && input.MissedRunsPolicy != "latest" {
		return input, nil, ErrInvalid
	}
	if len(input.Config) == 0 {
		input.Config = json.RawMessage(`{}`)
	}
	var next *time.Time
	switch input.Type {
	case "mention", "every_message":
		var config messageOptions
		if err := decodeConfig(input.Config, &config); err != nil {
			return input, nil, ErrInvalid
		}
		input.Config, _ = json.Marshal(config)
	case "command":
		var config commandConfig
		if err := decodeConfig(input.Config, &config); err != nil {
			return input, nil, ErrInvalid
		}
		config.Command = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(config.Command)), "/")
		if len(config.Command) < 1 || len(config.Command) > 64 || strings.ContainsAny(config.Command, " \t\r\n") {
			return input, nil, ErrInvalid
		}
		input.Config, _ = json.Marshal(config)
	case "keyword":
		var config keywordConfig
		if err := decodeConfig(input.Config, &config); err != nil || len(config.Pattern) < 1 || len(config.Pattern) > 200 {
			return input, nil, ErrInvalid
		}
		if _, err := regexp.Compile(config.Pattern); err != nil {
			return input, nil, ErrInvalid
		}
		input.Config, _ = json.Marshal(config)
	case "event":
		var config eventConfig
		if err := decodeConfig(input.Config, &config); err != nil || len(config.EventTypes) < 1 || len(config.EventTypes) > 50 {
			return input, nil, ErrInvalid
		}
		seen := make(map[string]struct{}, len(config.EventTypes))
		if config.ChatID != "" && uuid.Validate(config.ChatID) != nil {
			return input, nil, ErrInvalid
		}
		for _, kind := range config.EventTypes {
			kind = strings.TrimSpace(kind)
			if kind == "" || len(kind) > 120 {
				return input, nil, ErrInvalid
			}
			seen[kind] = struct{}{}
		}
		config.EventTypes = config.EventTypes[:0]
		for kind := range seen {
			config.EventTypes = append(config.EventTypes, kind)
		}
		sort.Strings(config.EventTypes)
		input.Config, _ = json.Marshal(config)
	case "schedule":
		var config scheduleConfig
		if err := decodeConfig(input.Config, &config); err != nil || uuid.Validate(config.ChatID) != nil || config.Hour < 0 || config.Hour > 23 ||
			config.Minute < 0 || config.Minute > 59 || len(config.DaysOfWeek) > 7 {
			return input, nil, ErrInvalid
		}
		seen := make(map[int]struct{}, len(config.DaysOfWeek))
		for _, day := range config.DaysOfWeek {
			if day < 0 || day > 6 {
				return input, nil, ErrInvalid
			}
			seen[day] = struct{}{}
		}
		config.DaysOfWeek = config.DaysOfWeek[:0]
		for day := range seen {
			config.DaysOfWeek = append(config.DaysOfWeek, day)
		}
		sort.Ints(config.DaysOfWeek)
		value, err := nextSchedule(config, input.Timezone, service.now().UTC())
		if err != nil {
			return input, nil, ErrInvalid
		}
		next = &value
		input.Config, _ = json.Marshal(config)
	default:
		return input, nil, ErrInvalid
	}
	return input, next, nil
}

func decodeConfig(data json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return ErrInvalid
	}
	return nil
}

func matches(trigger Trigger, item event, agentID string) (bool, bool) {
	switch trigger.Type {
	case "mention":
		var config messageOptions
		_ = json.Unmarshal(trigger.Config, &config)
		if item.kind != "message.created" {
			return false, config.IncludeAgentMessages
		}
		for _, mentioned := range item.mentioned {
			if mentioned == agentID {
				return true, config.IncludeAgentMessages
			}
		}
		return false, config.IncludeAgentMessages
	case "command":
		var config commandConfig
		_ = json.Unmarshal(trigger.Config, &config)
		body := strings.TrimSpace(item.body)
		if end := strings.IndexAny(body, " \t\r\n"); end >= 0 {
			body = body[:end]
		}
		return item.kind == "message.created" && strings.EqualFold(body, "/"+config.Command), config.IncludeAgentMessages
	case "keyword":
		var config keywordConfig
		_ = json.Unmarshal(trigger.Config, &config)
		if item.kind != "message.created" {
			return false, config.IncludeAgentMessages
		}
		pattern := config.Pattern
		if !config.CaseSensitive {
			pattern = "(?i)" + pattern
		}
		matched, _ := regexp.MatchString(pattern, item.body)
		return matched, config.IncludeAgentMessages
	case "every_message":
		var config messageOptions
		_ = json.Unmarshal(trigger.Config, &config)
		return item.kind == "message.created", config.IncludeAgentMessages
	case "event":
		var config eventConfig
		_ = json.Unmarshal(trigger.Config, &config)
		for _, kind := range config.EventTypes {
			if item.kind == kind {
				return true, config.IncludeAgentMessages
			}
		}
		return false, config.IncludeAgentMessages
	default:
		return false, false
	}
}

func commandArguments(body string) string {
	trimmed := strings.TrimSpace(body)
	if end := strings.IndexAny(trimmed, " \t\r\n"); end >= 0 {
		return strings.TrimSpace(trimmed[end:])
	}
	return ""
}

func nextSchedule(config scheduleConfig, timezone string, after time.Time) (time.Time, error) {
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, err
	}
	days := make(map[int]bool, len(config.DaysOfWeek))
	for _, day := range config.DaysOfWeek {
		days[day] = true
	}
	local := after.In(location)
	for offset := 0; offset <= 8; offset++ {
		date := local.AddDate(0, 0, offset)
		if len(days) > 0 && !days[int(date.Weekday())] {
			continue
		}
		candidate := time.Date(date.Year(), date.Month(), date.Day(), config.Hour, config.Minute, 0, 0, location)
		if candidate.After(local) {
			return candidate.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("%w: schedule has no next occurrence", ErrInvalid)
}

func loadTriggers(ctx context.Context, tx pgx.Tx, orgID, agentID string) ([]Trigger, error) {
	rows, err := tx.Query(ctx, triggerSelect+` WHERE trigger.org_id=$1 AND trigger.agent_id=$2 AND trigger.enabled AND trigger.type<>'schedule'`, orgID, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Trigger, 0)
	for rows.Next() {
		item, err := scanTrigger(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (service *Service) get(ctx context.Context, orgID, triggerID string) (Trigger, error) {
	result, err := scanTrigger(service.pool.QueryRow(ctx, triggerSelect+` WHERE trigger.org_id=$1 AND trigger.id=$2`, orgID, triggerID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Trigger{}, ErrNotFound
	}
	return result, err
}

const triggerSelect = `SELECT trigger.id,trigger.org_id,trigger.agent_id,trigger.type,trigger.config,trigger.enabled,
	trigger.timezone,trigger.missed_runs_policy,trigger.next_run_at,trigger.created_at,trigger.updated_at FROM agent_triggers trigger`

type scanner interface{ Scan(...any) error }

func scanTrigger(row scanner) (Trigger, error) {
	var result Trigger
	err := row.Scan(&result.ID, &result.OrgID, &result.AgentID, &result.Type, &result.Config, &result.Enabled,
		&result.Timezone, &result.MissedRunsPolicy, &result.NextRunAt, &result.CreatedAt, &result.UpdatedAt)
	return result, err
}

func canManage(current identity.User) bool {
	return permission.Allows(current.OrgRole, current.Permissions, permission.AgentsManage)
}
