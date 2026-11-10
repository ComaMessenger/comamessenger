import type { Agent } from "@comamessenger/core";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Dialog } from "../../ui";
import type { AgentEditorState } from "./useAgentEditor";

export function DeleteAgentDialog({
  agent,
  editor,
}: {
  agent: Agent;
  editor: AgentEditorState;
}) {
  const { t } = useTranslation();
  const { pending, setDeleteOpen } = editor;
  return (
    <Dialog
      title={t("deleteAgentTitle")}
      description={t("deleteAgentDescription", {
        name: agent.display_name,
      })}
      onClose={() => setDeleteOpen(false)}
    >
      <div className="ui-dialog__actions">
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => setDeleteOpen(false)}
        >
          {t("cancel")}
        </Button>
        <Button
          variant="danger"
          disabled={pending}
          onClick={() => editor.remove(agent)}
        >
          <Trash2 />
          {t("deleteAgentConfirm")}
        </Button>
      </div>
    </Dialog>
  );
}
