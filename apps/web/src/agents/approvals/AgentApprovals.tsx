import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  Agent,
  AgentToolConfirmation,
  MessengerAPI,
} from "@comamessenger/core";
import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Badge, Button, FormError, Skeleton } from "../../ui";

export function AgentApprovals({
  api,
  agents,
}: {
  api: MessengerAPI;
  agents: Agent[];
}) {
  const { t } = useTranslation();
  const confirmations = useQuery({
    queryKey: ["agent-tool-confirmations"],
    queryFn: () => api.agentToolConfirmations("pending"),
    refetchInterval: 5_000,
  });
  const [error, setError] = useState("");
  async function decide(confirmation: AgentToolConfirmation, approve: boolean) {
    setError("");
    try {
      if (approve) await api.approveAgentToolConfirmation(confirmation.id);
      else await api.denyAgentToolConfirmation(confirmation.id);
      await confirmations.refetch();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  return (
    <div className="agent-approvals">
      <header>
        <div>
          <h2>{t("agentApprovalsTitle")}</h2>
          <p>{t("agentApprovalsHint")}</p>
        </div>
        <Badge>{confirmations.data?.length ?? 0}</Badge>
      </header>
      {error && <FormError message={error} />}
      {confirmations.isLoading ? (
        <Skeleton />
      ) : confirmations.data?.length ? (
        <div className="agent-approval-list">
          {confirmations.data.map((confirmation) => (
            <article key={confirmation.id}>
              <div>
                <strong>{t(`agentTool_${confirmation.tool_name}`)}</strong>
                <small>
                  {agents.find((item) => item.id === confirmation.agent_id)
                    ?.display_name ?? confirmation.agent_id}
                  {" · "}
                  {new Date(confirmation.requested_at).toLocaleString()}
                </small>
              </div>
              <pre>{JSON.stringify(confirmation.arguments, null, 2)}</pre>
              <footer>
                <Button
                  variant="secondary"
                  onClick={() => void decide(confirmation, false)}
                >
                  <X />
                  {t("deny")}
                </Button>
                <Button onClick={() => void decide(confirmation, true)}>
                  <Check />
                  {t("approve")}
                </Button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <p className="agent-empty-state">{t("agentApprovalsEmpty")}</p>
      )}
    </div>
  );
}
