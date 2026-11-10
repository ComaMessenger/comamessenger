import type { Agent, MessengerAPI } from "@comamessenger/core";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Field, SelectField } from "../../ui";
import { SettingsSection } from "../../settings/components/SettingsPrimitives";
import { triggerConfig, triggerDetails } from "./triggers";
import type { AgentOperationsState } from "./useAgentOperations";

export function AgentTriggersSection({
  api,
  agent,
  canBuild,
  operations,
}: {
  api: MessengerAPI;
  agent: Agent;
  canBuild: boolean;
  operations: AgentOperationsState;
}) {
  const { t } = useTranslation();
  const {
    triggers,
    triggerType,
    setTriggerType,
    triggerValue,
    setTriggerValue,
    action,
  } = operations;
  async function createTrigger() {
    const config = triggerConfig(triggerType, triggerValue, agent.chat_ids[0]);
    await action(() =>
      api.createAgentTrigger(agent.id, {
        type: triggerType as
          | "manual"
          | "mention"
          | "command"
          | "keyword"
          | "every_message"
          | "schedule"
          | "event",
        config,
        enabled: true,
        timezone: "UTC",
        missed_runs_policy: "latest",
      }),
    );
    setTriggerValue("");
  }
  return (
    <SettingsSection
      title={t("agentTriggers")}
      description={t("agentTriggersHint")}
      wide
    >
      {canBuild && (
        <div className="agent-inline-form">
          <SelectField
            label={t("type")}
            name="trigger-type"
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value)}
          >
            {[
              "manual",
              "mention",
              "command",
              "keyword",
              "every_message",
              "schedule",
              "event",
            ].map((type) => (
              <option key={type} value={type}>
                {t(`agentTrigger_${type}`)}
              </option>
            ))}
          </SelectField>
          {!["manual", "mention", "every_message"].includes(triggerType) && (
            <Field
              required={false}
              label={t("configuration")}
              name="trigger-value"
              value={triggerValue}
              placeholder={
                triggerType === "schedule"
                  ? "09:00"
                  : triggerType === "event"
                    ? "member.joined"
                    : ""
              }
              onChange={(e) => setTriggerValue(e.target.value)}
            />
          )}
          <Button onClick={() => void createTrigger()}>
            <Plus />
            {t("add")}
          </Button>
        </div>
      )}
      <div className="agent-record-list">
        {(triggers.data ?? []).map((trigger) => (
          <div key={trigger.id}>
            <span>
              <strong>{t(`agentTrigger_${trigger.type}`)}</strong>
              <small>{triggerDetails(t, trigger.type, trigger.config)}</small>
            </span>
            <Badge tone={trigger.enabled ? "success" : "neutral"}>
              {trigger.enabled ? t("enabled") : t("disabled")}
            </Badge>
            {canBuild && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void action(() =>
                    api.updateAgentTrigger(agent.id, trigger.id, {
                      enabled: !trigger.enabled,
                    }),
                  )
                }
              >
                {trigger.enabled ? t("disable") : t("enable")}
              </Button>
            )}
            {canBuild && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("delete")}
                onClick={() =>
                  void action(() =>
                    api.deleteAgentTrigger(agent.id, trigger.id),
                  )
                }
              >
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
