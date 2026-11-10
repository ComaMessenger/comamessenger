package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
)

// ChatAgent describes an agent working in a chat for the people of that chat:
// what it reads, what it may do and how it starts. Management-only data
// (model, limits, connections, keys) is deliberately absent.
type ChatAgent struct {
	AgentID                  string             `json:"agent_id"`
	DisplayName              string             `json:"display_name"`
	Handle                   string             `json:"handle"`
	Description              string             `json:"description"`
	AvatarVersion            int64              `json:"avatar_version"`
	Status                   string             `json:"status"`
	Scopes                   []Scope            `json:"scopes"`
	KnowledgeCollectionCount int                `json:"knowledge_collection_count"`
	Triggers                 []ChatAgentTrigger `json:"triggers"`
	CanManage                bool               `json:"can_manage"`
}

type ChatAgentTrigger struct {
	Type     string             `json:"type"`
	Command  string             `json:"command,omitempty"`
	Schedule *ChatAgentSchedule `json:"schedule,omitempty"`
}

type ChatAgentSchedule struct {
	Hour       int    `json:"hour"`
	Minute     int    `json:"minute"`
	DaysOfWeek []int  `json:"days_of_week"`
	Timezone   string `json:"timezone"`
}

type ChatAgentList struct {
	Agents []ChatAgent `json:"agents"`
}

// ChatAgents lists the agents that are members of a chat the current actor
// belongs to. Unpublished agents are visible to agent managers only; the
// published configuration is reported, never the draft.
func (service *Service) ChatAgents(ctx context.Context, current identity.User, chatID string) (ChatAgentList, error) {
	if uuid.Validate(chatID) != nil {
		return ChatAgentList{}, ErrNotFound
	}
	var member bool
	if err := service.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM chat_members WHERE org_id=$1 AND chat_id=$2 AND actor_id=$3)`,
		current.OrgID, chatID, current.ActorID).Scan(&member); err != nil {
		return ChatAgentList{}, fmt.Errorf("check chat membership: %w", err)
	}
	if !member {
		return ChatAgentList{}, ErrNotFound
	}
	manager := canView(current)
	rows, err := service.pool.Query(ctx, `SELECT agent.actor_id, actor.display_name, actor.handle, agent.description, actor.avatar_version,
			agent.operational_status, agent.allowed_scopes, cardinality(agent.knowledge_collection_ids)
		FROM chat_members member
		JOIN agents agent ON agent.org_id=member.org_id AND agent.actor_id=member.actor_id
		JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id
		WHERE member.org_id=$1 AND member.chat_id=$2 AND agent.deleted_at IS NULL AND agent.system_role IS NULL
		  AND actor.deleted_at IS NULL AND (agent.published_version IS NOT NULL OR $3)
		ORDER BY actor.display_name, actor.id`, current.OrgID, chatID, manager)
	if err != nil {
		return ChatAgentList{}, fmt.Errorf("list chat agents: %w", err)
	}
	defer rows.Close()
	result := ChatAgentList{Agents: []ChatAgent{}}
	index := map[string]int{}
	ids := []string{}
	canManage := canPublish(current)
	for rows.Next() {
		var item ChatAgent
		var scopes []string
		var collections *int
		if err := rows.Scan(&item.AgentID, &item.DisplayName, &item.Handle, &item.Description, &item.AvatarVersion,
			&item.Status, &scopes, &collections); err != nil {
			return ChatAgentList{}, err
		}
		item.Scopes = make([]Scope, 0, len(scopes))
		for _, scope := range scopes {
			// Runtime capabilities describe the worker, not what the agent does in chats.
			if scope == string(ScopeRuntimeExecute) || scope == string(ScopeRuntimeWorker) {
				continue
			}
			item.Scopes = append(item.Scopes, Scope(scope))
		}
		if collections != nil {
			item.KnowledgeCollectionCount = *collections
		}
		item.Triggers = []ChatAgentTrigger{}
		item.CanManage = canManage
		index[item.AgentID] = len(result.Agents)
		ids = append(ids, item.AgentID)
		result.Agents = append(result.Agents, item)
	}
	if err := rows.Err(); err != nil {
		return ChatAgentList{}, err
	}
	rows.Close()
	if len(ids) == 0 {
		return result, nil
	}
	triggers, err := service.pool.Query(ctx, `SELECT agent_id, type, config, timezone FROM agent_triggers
		WHERE org_id=$1 AND agent_id=ANY($2::uuid[]) AND enabled AND superseded_at IS NULL AND type<>'manual'
		ORDER BY created_at, id`, current.OrgID, ids)
	if err != nil {
		return ChatAgentList{}, fmt.Errorf("list chat agent triggers: %w", err)
	}
	defer triggers.Close()
	for triggers.Next() {
		var agentID, kind, timezone string
		var config []byte
		if err := triggers.Scan(&agentID, &kind, &config, &timezone); err != nil {
			return ChatAgentList{}, err
		}
		trigger, applies := chatTrigger(kind, config, timezone, chatID)
		if !applies {
			continue
		}
		position := index[agentID]
		result.Agents[position].Triggers = append(result.Agents[position].Triggers, trigger)
	}
	return result, triggers.Err()
}

// chatTrigger reports a trigger in chat terms and whether it can start the
// agent in the given chat. Patterns and event filters stay server-side.
func chatTrigger(kind string, config []byte, timezone, chatID string) (ChatAgentTrigger, bool) {
	switch kind {
	case "mention", "keyword", "every_message":
		return ChatAgentTrigger{Type: kind}, true
	case "command":
		var value struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(config, &value) != nil || value.Command == "" {
			return ChatAgentTrigger{}, false
		}
		return ChatAgentTrigger{Type: kind, Command: value.Command}, true
	case "event":
		var value struct {
			ChatID string `json:"chat_id"`
		}
		_ = json.Unmarshal(config, &value)
		return ChatAgentTrigger{Type: kind}, value.ChatID == "" || value.ChatID == chatID
	case "schedule":
		var value struct {
			ChatID     string `json:"chat_id"`
			Hour       int    `json:"hour"`
			Minute     int    `json:"minute"`
			DaysOfWeek []int  `json:"days_of_week"`
		}
		if json.Unmarshal(config, &value) != nil || value.ChatID != chatID {
			return ChatAgentTrigger{}, false
		}
		if value.DaysOfWeek == nil {
			value.DaysOfWeek = []int{}
		}
		return ChatAgentTrigger{Type: kind, Schedule: &ChatAgentSchedule{Hour: value.Hour, Minute: value.Minute, DaysOfWeek: value.DaysOfWeek, Timezone: timezone}}, true
	default:
		return ChatAgentTrigger{}, false
	}
}
