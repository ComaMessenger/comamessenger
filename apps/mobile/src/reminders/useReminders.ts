import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  formatReminderWhen,
  reminderErrorKind,
  reminderFor,
  reminderInput,
  reminderKeys,
  withReminder,
  type MessengerAPI,
  type Reminder,
  type ReminderIdEntry,
} from "@comamessenger/core";
import { useSignedIn } from "@/session/SessionProvider";
import { calendarLocale } from "@/requests/locale";

/** The toast text for a failed reminder call. */
export function useReminderErrorText() {
  const { t } = useTranslation();
  return useCallback(
    (error: unknown) =>
      t(`reminderError_${reminderErrorKind(error)}`, {
        defaultValue: t("reminderError_other"),
      }),
    [t],
  );
}

/**
 * The reader's reminder about one message, with its note: the bell list
 * has only times, so the note is looked up in the lists. Null when it is
 * not there (the note then stays as it is on the server).
 */
export async function findReminder(
  api: Pick<MessengerAPI, "reminders">,
  messageID: string,
): Promise<Reminder | null> {
  for (const state of ["pending", "fired"] as const) {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await api.reminders({ state, cursor, limit: 100 });
      const found = result.items.find((item) => item.message_id === messageID);
      if (found) return found;
      if (!result.next_cursor) break;
      cursor = result.next_cursor;
    }
  }
  return null;
}

/**
 * Bells of a chat (listReminderIds) and setting or removing the reader's
 * reminder about a message. Only the reader sees any of it.
 */
export function useChatReminders(chatID: string, enabled: boolean) {
  const { api, user } = useSignedIn();
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();
  const errorText = useReminderErrorText();
  const ids = useQuery({
    queryKey: reminderKeys.ids(user.id, chatID),
    queryFn: () => api.reminderIDs(chatID),
    enabled,
    staleTime: 5 * 60_000,
  });
  const reminded = useMemo(
    () => new Set((ids.data ?? []).map((entry) => entry.message_id)),
    [ids.data],
  );

  const entryFor = useCallback(
    (messageID: string) => reminderFor(ids.data, messageID),
    [ids.data],
  );

  /** Sets or moves the reminder; returns the toast text. */
  const set = useCallback(
    async (messageID: string, at: Date, note: string | undefined) => {
      try {
        const saved = await api.setMessageReminder(
          messageID,
          reminderInput(at, note),
        );
        queryClient.setQueryData<ReminderIdEntry[]>(
          reminderKeys.ids(user.id, chatID),
          (entries) => withReminder(entries, messageID, saved.remind_at),
        );
        void queryClient.invalidateQueries({
          queryKey: [...reminderKeys.all(user.id), "list"],
        });
        return t("reminderSetNotice", {
          when: formatReminderWhen(
            new Date(saved.remind_at),
            new Date(),
            calendarLocale(i18n.language),
          ),
        });
      } catch (error) {
        return errorText(error);
      }
    },
    [api, chatID, errorText, i18n.language, queryClient, t, user.id],
  );

  /** «Готово» or «Убрать». */
  const remove = useCallback(
    async (messageID: string) => {
      try {
        await api.deleteMessageReminder(messageID);
        queryClient.setQueryData<ReminderIdEntry[]>(
          reminderKeys.ids(user.id, chatID),
          (entries) => withReminder(entries, messageID, null),
        );
        void queryClient.invalidateQueries({
          queryKey: [...reminderKeys.all(user.id), "list"],
        });
        return t("reminderRemovedNotice");
      } catch (error) {
        return errorText(error);
      }
    },
    [api, chatID, errorText, queryClient, t, user.id],
  );

  return { ids, reminded, entryFor, set, remove };
}
