import { useTranslation } from "react-i18next";
import type { ChatMember } from "@comamessenger/core";
import { Avatar, PresenceDot, Tag } from "../ui";
import { Markdown } from "../markdown";

export type AgentRunState = "thinking" | "tool" | "streaming" | "completed" | "failed" | "canceled";

/** Live agent output while a run streams into the chat. */
export function AgentStreamRow({
  body,
  author,
  state,
}: {
  body: string;
  author?: ChatMember;
  state: AgentRunState;
}) {
  const { t } = useTranslation();
  const name = author?.display_name ?? t("agent");
  return (
    <article className="message message--agent-live" aria-live="polite">
      <div className="message__gutter">
        <Avatar
          name={name}
          seed={author?.actor_id ?? "agent"}
          actorID={author?.actor_id}
          avatarVersion={author?.avatar_version}
          agent
          size="md"
        />
      </div>
      <div className="message__content">
        <header className="message__meta">
          <strong>{name}</strong>
          <Tag tone="agent">{t("agentTag")}</Tag>
          <span className="message__agent-state">
            <PresenceDot pulse />
            {t(`agentState_${state}`)}
          </span>
        </header>
        <div className="message__body">
          {body ? <Markdown source={body} /> : null}
          <span className="message__cursor" aria-hidden="true" />
        </div>
      </div>
    </article>
  );
}
