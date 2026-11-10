import type { Agent } from "@comamessenger/core";
import { Copy, RotateCcw, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui";
import type { AgentDetailSection } from "../routes";
import type { AgentEditorState } from "./useAgentEditor";

export function AgentEditorToolbar({
  selected,
  section,
  canBuild,
  editor,
}: {
  selected: Agent | undefined;
  section: AgentDetailSection;
  canBuild: boolean;
  editor: AgentEditorState;
}) {
  const { t } = useTranslation();
  const { pending } = editor;
  return (
    <div className="agent-editor__toolbar">
      <div>
        <h2>{selected?.display_name ?? t("agentsEmptyTitle")}</h2>
        <p>{selected ? `@${selected.handle}` : t("agentsEmptyHint")}</p>
      </div>
      {canBuild && selected && section === "behavior" && (
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => void editor.save()}
        >
          <Save />
          {pending ? t("saving") : t("save")}
        </Button>
      )}
      {canBuild && selected && section === "settings" && (
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => editor.duplicate(selected)}
        >
          <Copy />
          {t("duplicateAgent")}
        </Button>
      )}
      {canBuild &&
        selected &&
        selected.recipe !== "custom" &&
        section === "settings" && (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => editor.setResetOpen(true)}
          >
            <RotateCcw />
            {t("resetTemplate")}
          </Button>
        )}
      {canBuild && selected && section === "settings" && (
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => editor.setDeleteOpen(true)}
        >
          <Trash2 />
          {t("deleteAgent")}
        </Button>
      )}
    </div>
  );
}
