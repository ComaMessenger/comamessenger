import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  capitalize,
  formatReminderWhen,
  reminderFor,
  reminderInput,
  reminderKeys,
  withReminder,
  type Reminder,
  type ReminderIdEntry,
} from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { calendarLocale, reminderErrorText, useWorkplaceFeatures } from "../requests/format";

/**
 * The reader's reminders in one chat: the bells in the feed. Read once per
 * chat and kept current by reminder.* events.
 */
export function useReminderIDs(chatID: string | undefined) {
  const { api, user } = useMessenger();
  const { reminders } = useWorkplaceFeatures();
  return useQuery({
    queryKey: reminderKeys.ids(user.id, chatID ?? ""),
    queryFn: () => api.reminderIDs(chatID!),
    enabled: Boolean(chatID) && reminders,
    staleTime: 60_000,
  });
}

export function useMessageReminder(
  chatID: string | undefined,
  messageID: string,
): ReminderIdEntry | null {
  const query = useReminderIDs(chatID);
  return reminderFor(query.data, messageID);
}

/** Set, move and remove a reminder about a message, with the toast. */
export function useReminderActions() {
  const { t } = useTranslation();
  const { api, user, scheduleReload } = useMessenger();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const touch = useCallback(
    (chatID: string, messageID: string, remindAt: string | null) => {
      queryClient.setQueryData<ReminderIdEntry[]>(
        reminderKeys.ids(user.id, chatID),
        (entries) => withReminder(entries, messageID, remindAt),
      );
      void queryClient.invalidateQueries({
        queryKey: [...reminderKeys.all(user.id), "list"],
      });
      // A fired reminder moved or done: the Important badge changes.
      scheduleReload();
    },
    [queryClient, scheduleReload, user.id],
  );

  const set = useCallback(
    async (
      target: { chatID: string; messageID: string | null; reminderID?: string },
      at: Date,
      note?: string,
    ): Promise<Reminder | null> => {
      try {
        const input = reminderInput(at, note);
        const saved = target.messageID
          ? await api.setMessageReminder(target.messageID, input)
          : await api.updateReminder(target.reminderID!, input);
        if (saved.message_id) touch(target.chatID, saved.message_id, saved.remind_at);
        else {
          void queryClient.invalidateQueries({
            queryKey: [...reminderKeys.all(user.id), "list"],
          });
          scheduleReload();
        }
        toast({
          message: t("reminderSetToast", {
            when: formatReminderWhen(
              new Date(saved.remind_at),
              new Date(),
              calendarLocale(),
            ),
          }),
        });
        return saved;
      } catch (cause) {
        toast({ message: reminderErrorText(cause), tone: "danger" });
        return null;
      }
    },
    [api, queryClient, scheduleReload, t, toast, touch, user.id],
  );

  const remove = useCallback(
    async (
      target: { chatID: string; messageID: string | null; reminderID?: string },
      done = false,
    ): Promise<boolean> => {
      try {
        if (target.messageID) await api.deleteMessageReminder(target.messageID);
        else await api.deleteReminder(target.reminderID!);
        if (target.messageID) touch(target.chatID, target.messageID, null);
        else {
          void queryClient.invalidateQueries({
            queryKey: [...reminderKeys.all(user.id), "list"],
          });
          scheduleReload();
        }
        toast({
          message: t(done ? "reminderDoneToast" : "reminderRemovedToast"),
        });
        return true;
      } catch (cause) {
        toast({ message: reminderErrorText(cause), tone: "danger" });
        return false;
      }
    },
    [api, queryClient, scheduleReload, t, toast, touch, user.id],
  );

  return { set, remove };
}

/** “Tomorrow at 9:00” at the start of a line. */
export function reminderWhenText(at: Date | string, now = new Date()) {
  return capitalize(
    formatReminderWhen(typeof at === "string" ? new Date(at) : at, now, calendarLocale()),
  );
}
