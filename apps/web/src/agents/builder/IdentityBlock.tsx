import type { Agent } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { Avatar, Field, TextareaField } from "../../ui";
import type { Draft } from "../shared/draft";
import { BuilderBlock } from "./BuilderBlock";

/** Block 1: the name people see and the task in the agent's own words. */
export function IdentityBlock({
  agent,
  draft,
  onChange,
}: {
  agent: Agent;
  draft: Draft;
  onChange(draft: Draft): void;
}) {
  const { t } = useTranslation();
  const length = (draft.description ?? "").length;
  return (
    <BuilderBlock
      anchor="identity"
      marker="1"
      title={t("agentBlockIdentity")}
      hint={t("agentBlockIdentityHint")}
    >
      <div className="agent-identity">
        <Avatar
          name={draft.display_name || agent.display_name}
          seed={agent.id}
          actorID={agent.id}
          avatarVersion={agent.avatar_version}
          size="lg"
          agent
        />
        <Field
          label={t("agentName")}
          name="agent-name"
          value={draft.display_name}
          maxLength={120}
          onChange={(event) =>
            onChange({ ...draft, display_name: event.target.value })
          }
        />
      </div>
      <TextareaField
        label={t("agentTask")}
        name="agent-task"
        rows={5}
        maxLength={2000}
        value={draft.description ?? ""}
        placeholder={t("agentTaskPlaceholder")}
        hint={t("agentTaskHint", { count: 2000 - length })}
        onChange={(event) =>
          onChange({ ...draft, description: event.target.value })
        }
      />
    </BuilderBlock>
  );
}
