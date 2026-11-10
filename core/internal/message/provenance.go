package message

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Provenance says why an agent wrote a message. It is visible to everyone
// who sees the message, so it carries only the kind of trigger and a short
// label set by the agent's builders (a command, a schedule time, a webhook
// name), never a webhook payload, a follow-up note or another chat's text.
type Provenance struct {
	RunID        string `json:"run_id"`
	Trigger      string `json:"trigger"`
	TriggerLabel string `json:"trigger_label,omitempty"`
}

// knownProvenanceTriggers are the trigger kinds clients describe in words.
var knownProvenanceTriggers = map[string]bool{
	"manual": true, "mention": true, "command": true, "keyword": true, "every_message": true, "schedule": true,
	"event": true, "webhook": true, "followup": true, "message_action": true, "collection": true, "confirmation": true,
}

func hydrateAgentProvenance(ctx context.Context, tx pgx.Tx, orgID string, messages []Message) error {
	if len(messages) == 0 {
		return nil
	}
	ids := make([]string, 0, len(messages))
	index := make(map[string]int, len(messages))
	for position := range messages {
		ids = append(ids, messages[position].ID)
		index[messages[position].ID] = position
	}
	rows, err := tx.Query(ctx, `
		SELECT provenance.message_id::text, provenance.run_id::text, COALESCE(run.input->>'trigger_type',''),
		       run.scheduled_for IS NOT NULL, COALESCE(trigger.type,''), COALESCE(trigger.config,'{}'::jsonb),
		       COALESCE(trigger.timezone,''), COALESCE(webhook.name,'')
		FROM message_agent_provenance provenance
		JOIN agent_runs run ON run.org_id=provenance.org_id AND run.id=provenance.run_id
		LEFT JOIN agent_triggers trigger ON trigger.org_id=run.org_id AND trigger.id=run.trigger_id
		LEFT JOIN integration_webhooks webhook ON webhook.org_id=run.org_id AND trigger.type='webhook'
			AND webhook.id::text=trigger.config->>'webhook_id'
		WHERE provenance.org_id=$1 AND provenance.message_id=ANY($2::uuid[])`, orgID, ids)
	if err != nil {
		return fmt.Errorf("load agent message provenance: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var messageID, runID, inputTrigger, triggerType, timezone, webhookName string
		var scheduled bool
		var config []byte
		if err := rows.Scan(&messageID, &runID, &inputTrigger, &scheduled, &triggerType, &config, &timezone, &webhookName); err != nil {
			return fmt.Errorf("scan agent message provenance: %w", err)
		}
		kind := inputTrigger
		if !knownProvenanceTriggers[kind] {
			kind = triggerType
		}
		if !knownProvenanceTriggers[kind] {
			kind = "manual"
			if scheduled {
				kind = "schedule"
			}
		}
		label := ""
		if triggerType == kind {
			label = triggerLabel(kind, config, timezone, webhookName)
		}
		messages[index[messageID]].AgentProvenance = &Provenance{RunID: runID, Trigger: kind, TriggerLabel: label}
	}
	return rows.Err()
}

func triggerLabel(kind string, raw []byte, timezone, webhookName string) string {
	var config struct {
		Command    string   `json:"command"`
		Pattern    string   `json:"pattern"`
		Hour       *int     `json:"hour"`
		Minute     *int     `json:"minute"`
		EventTypes []string `json:"event_types"`
	}
	_ = json.Unmarshal(raw, &config)
	switch kind {
	case "command":
		if config.Command != "" {
			return "/" + config.Command
		}
	case "keyword":
		return truncateLabel(config.Pattern)
	case "schedule":
		if config.Hour != nil && config.Minute != nil {
			label := fmt.Sprintf("%02d:%02d", *config.Hour, *config.Minute)
			if timezone != "" && timezone != "UTC" {
				label += " " + timezone
			} else {
				label += " UTC"
			}
			return label
		}
	case "event":
		return truncateLabel(strings.Join(config.EventTypes, ", "))
	case "webhook":
		return truncateLabel(webhookName)
	}
	return ""
}

func truncateLabel(value string) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) > 80 {
		return string(runes[:79]) + "…"
	}
	return string(runes)
}
