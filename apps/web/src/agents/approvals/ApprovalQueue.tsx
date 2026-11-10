import { useState } from "react";
import type {
  Agent,
  AgentToolConfirmation,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Button, FormError } from "../../ui";
import { approvalText } from "../activity/feed";
import { formatDateTime } from "../shared/format";

/** Pending actions with a human description and Allow / Deny. */
export function ApprovalQueue({
  api,
  agents,
  chats,
  confirmations,
  onDecided,
}: {
  api: MessengerAPI;
  agents: Agent[];
  chats: Chat[];
  confirmations: AgentToolConfirmation[];
  onDecided(): Promise<unknown>;
}) {
  const { t } = useTranslation();
  if (confirmations.length === 0)
    return <p className="agent-block__empty">{t("agentApprovalsEmpty")}</p>;
  return (
    <div className="agent-approval-queue">
      {confirmations.map((confirmation) => (
        <ApprovalCard
          key={confirmation.id}
          api={api}
          confirmation={confirmation}
          agentName={
            agents.find((agent) => agent.id === confirmation.agent_id)
              ?.display_name ?? t("agentUnknown")
          }
          chats={chats}
          onDecided={onDecided}
        />
      ))}
    </div>
  );
}

function ApprovalCard({
  api,
  confirmation,
  agentName,
  chats,
  onDecided,
}: {
  api: MessengerAPI;
  confirmation: AgentToolConfirmation;
  agentName: string;
  chats: Chat[];
  onDecided(): Promise<unknown>;
}) {
  const { t, i18n } = useTranslation();
  const [pending, setPending] = useState<"" | "approve" | "deny">("");
  const [error, setError] = useState("");
  const text = approvalText(t, confirmation, chats);
  async function decide(approve: boolean) {
    setPending(approve ? "approve" : "deny");
    setError("");
    try {
      if (approve) await api.approveAgentToolConfirmation(confirmation.id);
      else await api.denyAgentToolConfirmation(confirmation.id);
      await onDecided();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending("");
    }
  }
  return (
    <article className="agent-approval">
      <header>
        <strong>{agentName}</strong>
        <time dateTime={confirmation.requested_at}>
          {formatDateTime(confirmation.requested_at, i18n.language)}
        </time>
      </header>
      <p>{text.action}</p>
      {text.quote && <blockquote>{text.quote}</blockquote>}
      <small>
        {t("agentApprovalExpires", {
          time: formatDateTime(confirmation.expires_at, i18n.language),
        })}
      </small>
      <details>
        <summary>{t("agentApprovalDetails")}</summary>
        <pre>{JSON.stringify(confirmation.arguments, null, 2)}</pre>
      </details>
      <FormError message={error} />
      <footer>
        <Button
          size="sm"
          variant="primary"
          pending={pending === "approve"}
          disabled={Boolean(pending)}
          onClick={() => void decide(true)}
        >
          <Check />
          {t("agentApprove")}
        </Button>
        <Button
          size="sm"
          pending={pending === "deny"}
          disabled={Boolean(pending)}
          onClick={() => void decide(false)}
        >
          <X />
          {t("agentDeny")}
        </Button>
      </footer>
    </article>
  );
}
