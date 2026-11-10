import type { Agent } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import type { AgentTone } from "@comamessenger/core";
import { Avatar, Chip, Field, TextareaField } from "../../ui";
import type { Draft } from "../shared/draft";
import { BuilderBlock } from "./BuilderBlock";

/** Agent instructions limit, as in Core and the API schema. */
const maxInstructionsLength = 4000;

const tones: AgentTone[] = ["concise", "friendly", "formal", ""];

/**
 * Block 1: the name people see, the task in the agent's own words and the
 * tone. The server turns the tone into an explicit line of the instructions,
 * shown in advanced settings.
 */
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
        maxLength={maxInstructionsLength}
        value={draft.description ?? ""}
        placeholder={t("agentTaskPlaceholder")}
        hint={t("agentTaskHint", { count: maxInstructionsLength - length })}
        onChange={(event) =>
          onChange({ ...draft, description: event.target.value })
        }
      />
      <div className="agent-days" role="group" aria-label={t("agentTone")}>
        <span>{t("agentTone")}</span>
        <div className="agent-chips">
          {tones.map((tone) => (
            <Chip
              key={tone || "none"}
              active={(draft.tone ?? "") === tone}
              onClick={() => onChange({ ...draft, tone })}
            >
              {t(`agentTone_${tone || "none"}`)}
            </Chip>
          ))}
        </div>
        <small className="agent-muted">{t("agentToneHint")}</small>
      </div>
    </BuilderBlock>
  );
}
