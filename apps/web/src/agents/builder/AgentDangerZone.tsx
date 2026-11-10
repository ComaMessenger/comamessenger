import { useState } from "react";
import type { Agent, MessengerAPI } from "@comamessenger/core";
import { Copy, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Button, Dialog, FormError } from "../../ui";

type Pending = "" | "duplicate" | "reset" | "delete";

/**
 * Copy, reset to the role and delete. Errors of a confirmation are shown in
 * its own dialog, not behind it.
 */
export function AgentDangerZone({
  api,
  agent,
  navigate,
  refetchAgents,
}: {
  api: MessengerAPI;
  agent: Agent;
  navigate(to: string): void;
  refetchAgents(): Promise<unknown>;
}) {
  const { t, i18n } = useTranslation();
  const [dialog, setDialog] = useState<"" | "reset" | "delete">("");
  const [pending, setPending] = useState<Pending>("");
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");

  async function duplicate() {
    setPending("duplicate");
    setError("");
    try {
      const created = await api.duplicateAgent(agent.id, {
        display_name: `${agent.display_name} — ${t("copySuffix")}`,
        handle: `${agent.handle.slice(0, 24)}_${Math.random().toString(36).slice(2, 6)}`,
      });
      await refetchAgents();
      navigate(`/agents/${created.id}`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending("");
    }
  }

  async function confirm(kind: "reset" | "delete") {
    setPending(kind);
    setDialogError("");
    try {
      if (kind === "delete") {
        await api.deleteAgent(agent.id);
        setDialog("");
        navigate("/agents");
      } else {
        await api.resetAgentRecipe(
          agent.id,
          i18n.resolvedLanguage ?? i18n.language,
        );
        setDialog("");
      }
      await refetchAgents();
    } catch (cause) {
      setDialogError(messageOf(cause));
    } finally {
      setPending("");
    }
  }

  return (
    <section className="agent-danger">
      <h4>{t("agentManageTitle")}</h4>
      <div className="agent-danger__actions">
        <Button
          size="sm"
          pending={pending === "duplicate"}
          onClick={() => void duplicate()}
        >
          <Copy />
          {t("duplicateAgent")}
        </Button>
        {agent.recipe !== "custom" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDialogError("");
              setDialog("reset");
            }}
          >
            <RotateCcw />
            {t("resetTemplate")}
          </Button>
        )}
        <Button
          size="sm"
          variant="danger-ghost"
          onClick={() => {
            setDialogError("");
            setDialog("delete");
          }}
        >
          <Trash2 />
          {t("deleteAgent")}
        </Button>
      </div>
      <FormError message={error} />
      {dialog && (
        <Dialog
          title={t(
            dialog === "delete" ? "deleteAgentTitle" : "resetTemplateTitle",
          )}
          description={t(
            dialog === "delete"
              ? "deleteAgentDescription"
              : "resetTemplateDescription",
            { name: agent.display_name },
          )}
          onClose={() => setDialog("")}
        >
          <FormError message={dialogError} />
          <div className="ui-dialog__actions">
            <Button
              variant="ghost"
              disabled={Boolean(pending)}
              onClick={() => setDialog("")}
            >
              {t("cancel")}
            </Button>
            <Button
              variant={dialog === "delete" ? "danger" : "primary"}
              pending={pending === dialog}
              onClick={() => void confirm(dialog)}
            >
              {dialog === "delete" ? <Trash2 /> : <RotateCcw />}
              {t(
                dialog === "delete"
                  ? "deleteAgentConfirm"
                  : "resetTemplateConfirm",
              )}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
