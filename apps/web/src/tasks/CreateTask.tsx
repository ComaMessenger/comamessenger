import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  taskAssigneeSegments,
  taskKeys,
  type ChatMember,
  type Message,
  type TaskDraft,
} from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { TaskDialog } from "./TaskDialog";
import { useOrgStructure } from "../org/useOrg";

/**
 * New task wired to the messenger: the org segments the reader may
 * use, the people who wrote last as the first chips, and the new card put
 * into the feed at once.
 */
export function CreateTaskDialog({
  chatID,
  members,
  initial,
  source,
  onCreated,
  onClose,
}: {
  chatID: string;
  members: ChatMember[];
  initial?: TaskDraft;
  source?: { authorName: string; excerpt: string } | null;
  onCreated?(message: Message): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { api, store, user, scheduleReload } = useMessenger();
  const structure = useOrgStructure(api);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const features = useStore(store, (state) => state.features);
  const feed = useStore(store, (state) => state.messages[chatID]);
  const segments = taskAssigneeSegments(user, features, structure.data);
  const recentIDs = useMemo(() => {
    const ids: string[] = [];
    for (const message of [...(feed ?? [])].reverse()) {
      if (message.actor_id === user.id || ids.includes(message.actor_id))
        continue;
      ids.push(message.actor_id);
      if (ids.length >= 5) break;
    }
    return ids;
  }, [feed, user.id]);
  return (
    <TaskDialog
      chatID={chatID}
      userID={user.id}
      members={members}
      initial={initial}
      source={source}
      segments={segments}
      structure={structure.data}
      recentIDs={recentIDs}
      createTask={(id, input) => api.createTask(id, input)}
      onSent={(message) => {
        store.getState().reconcile(message);
        void queryClient.invalidateQueries({
          queryKey: taskKeys.all(user.id),
        });
        scheduleReload();
        const responsible = message.task?.assignee.actor_id;
        toast({
          message:
            responsible === user.id
              ? t("taskCreatedMine")
              : message.task?.assignee.kind === "person"
                ? t("taskCreated")
                : t("taskCreatedQueue"),
        });
        onCreated?.(message);
        onClose();
      }}
      onClose={onClose}
    />
  );
}
