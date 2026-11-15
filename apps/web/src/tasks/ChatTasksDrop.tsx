import { useEffect } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  chatTaskSections,
  type ChatMember,
  type Message,
  type MessageTask,
  type TaskViewer,
} from "@comamessenger/core";
import { Button } from "../ui";
import { TaskRow } from "./TaskRow";

type TaskMessage = Message & { task: MessageTask };

/**
 * The tasks of the chat under the slot (decision 18): On you with a red
 * line, then Others; All tasks of the chat and + Task at the bottom. A
 * click on a row leads to its card in the feed.
 */
export function ChatTasksDrop({
  tasks,
  viewer,
  members,
  canCreate,
  onOpenTask,
  onAll,
  onNew,
  onClose,
}: {
  tasks: readonly TaskMessage[];
  viewer: TaskViewer;
  members: readonly ChatMember[];
  canCreate: boolean;
  onOpenTask(messageID: string): void;
  onAll(): void;
  onNew(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const now = new Date();
  const { mine, others } = chatTaskSections(tasks, viewer, now);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <button
        type="button"
        className="chat-slot__dim"
        aria-label={t("taskListClose")}
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        className="chat-tasks-drop"
        role="dialog"
        aria-label={t("taskListTitle")}
      >
        <div className="chat-tasks-drop__scroll">
          {mine.length > 0 && (
            <section aria-label={t("taskListMine", { count: mine.length })}>
              <h3 className="chat-tasks-drop__section chat-tasks-drop__section--mine">
                {t("taskListMine", { count: mine.length })}
              </h3>
              {mine.map((row) => (
                <TaskRow
                  key={row.message.id}
                  message={row.message}
                  viewer={viewer}
                  members={members}
                  mine
                  onOpen={() => onOpenTask(row.message.id)}
                />
              ))}
            </section>
          )}
          {others.length > 0 && (
            <section aria-label={t("taskListOthers", { count: others.length })}>
              <h3 className="chat-tasks-drop__section">
                {t("taskListOthers", { count: others.length })}
              </h3>
              {others.map((row) => (
                <TaskRow
                  key={row.message.id}
                  message={row.message}
                  viewer={viewer}
                  members={members}
                  onOpen={() => onOpenTask(row.message.id)}
                />
              ))}
            </section>
          )}
          {!mine.length && !others.length && (
            <p className="chat-tasks-drop__empty">{t("taskListEmpty")}</p>
          )}
        </div>
        <div className="chat-tasks-drop__foot">
          <Button size="sm" onClick={onAll}>
            {t("taskListAll")}
          </Button>
          {canCreate && (
            <Button size="sm" variant="primary" onClick={onNew}>
              <Plus aria-hidden="true" />
              {t("taskListNew")}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
