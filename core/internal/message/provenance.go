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
// label (a command, a schedule time, chat event kinds), recorded when the
// message was written — never a keyword pattern, a webhook name or payload,
// a follow-up note or another chat's text.
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
	// The kind and label were recorded when the message was written; older
	// messages show the kind derived from their run, without a label.
	rows, err := tx.Query(ctx, `
		SELECT provenance.message_id::text, provenance.run_id::text, provenance.trigger, COALESCE(provenance.trigger_label,''),
		       COALESCE(run.input->>'trigger_type',''), run.scheduled_for IS NOT NULL, COALESCE(trigger.type,'')
		FROM message_agent_provenance provenance
		JOIN agent_runs run ON run.org_id=provenance.org_id AND run.id=provenance.run_id
		LEFT JOIN agent_triggers trigger ON trigger.org_id=run.org_id AND trigger.id=run.trigger_id
		WHERE provenance.org_id=$1 AND provenance.message_id=ANY($2::uuid[])`, orgID, ids)
	if err != nil {
		return fmt.Errorf("load agent message provenance: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var messageID, runID, label, inputTrigger, triggerType string
		var stored *string
		var scheduled bool
		if err := rows.Scan(&messageID, &runID, &stored, &label, &inputTrigger, &scheduled, &triggerType); err != nil {
			return fmt.Errorf("scan agent message provenance: %w", err)
		}
		kind := ""
		if stored != nil {
			kind = *stored
		} else {
			kind = provenanceKind(inputTrigger, triggerType, scheduled)
		}
		messages[index[messageID]].AgentProvenance = &Provenance{RunID: runID, Trigger: kind, TriggerLabel: label}
	}
	return rows.Err()
}

func provenanceKind(inputTrigger, triggerType string, scheduled bool) string {
	switch {
	case knownProvenanceTriggers[inputTrigger]:
		return inputTrigger
	case knownProvenanceTriggers[triggerType]:
		return triggerType
	case scheduled:
		return "schedule"
	default:
		return "manual"
	}
}

// recordProvenanceReason stores why the run's agent wrote the message, as
// it is at this moment.
func recordProvenanceReason(ctx context.Context, tx pgx.Tx, orgID, messageID, runID string) error {
	var inputTrigger, triggerType, timezone string
	var scheduled bool
	var config []byte
	err := tx.QueryRow(ctx, `SELECT COALESCE(run.input->>'trigger_type',''), run.scheduled_for IS NOT NULL, COALESCE(trigger.type,''),
			COALESCE(trigger.config,'{}'::jsonb), COALESCE(trigger.timezone,'')
		FROM agent_runs run LEFT JOIN agent_triggers trigger ON trigger.org_id=run.org_id AND trigger.id=run.trigger_id
		WHERE run.org_id=$1 AND run.id=$2`, orgID, runID).Scan(&inputTrigger, &scheduled, &triggerType, &config, &timezone)
	if err != nil {
		return fmt.Errorf("load agent run trigger: %w", err)
	}
	kind := provenanceKind(inputTrigger, triggerType, scheduled)
	label := ""
	if triggerType == kind {
		label = triggerLabel(kind, config, timezone)
	}
	_, err = tx.Exec(ctx, `UPDATE message_agent_provenance SET trigger=$2, trigger_label=NULLIF($3,'') WHERE message_id=$1 AND trigger IS NULL`, messageID, kind, label)
	return err
}

// triggerLabel is the short detail readers of the message see. Keyword
// patterns and webhook names are configuration of the agent, not something
// the chat should learn, so only the kind is shown for them.
func triggerLabel(kind string, raw []byte, timezone string) string {
	var config struct {
		Command    string   `json:"command"`
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
