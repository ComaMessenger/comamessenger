import type { Agent } from "@comamessenger/core";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Dialog } from "../../ui";
import type { AgentEditorState } from "./useAgentEditor";

export function ResetRecipeDialog({
  agent,
  editor,
}: {
  agent: Agent;
  editor: AgentEditorState;
}) {
  const { t } = useTranslation();
  const { pending, setResetOpen } = editor;
  return (
    <Dialog
      title={t("resetTemplateTitle")}
      description={t("resetTemplateDescription", {
        name: agent.display_name,
      })}
      onClose={() => setResetOpen(false)}
    >
      <div className="ui-dialog__actions">
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => setResetOpen(false)}
        >
          {t("cancel")}
        </Button>
        <Button disabled={pending} onClick={() => editor.resetRecipe(agent)}>
          <RotateCcw />
          {pending ? t("saving") : t("resetTemplateConfirm")}
        </Button>
      </div>
    </Dialog>
  );
}
