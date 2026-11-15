import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Bell, Check, ChevronRight, MessageSquareMore } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  formatRequestDue,
  reminderKeys,
  waitingStrip,
  type Message,
} from "@comamessenger/core";
import { Button } from "../ui";
import { useMessenger } from "../shell/MessengerContext";
import { useReminderActions } from "../reminders/useReminders";
import { calendarLocale, useWorkplaceFeatures } from "./format";

/**
 * “Waiting for your answer · by Fri, 18:00” under the chat header. Counts come from
 * GET /unread; a click scrolls to the earliest waiting request, or opens
 * Important → Waiting for you when it is not loaded. Returns null when nothing waits,
 * so the Scheduled strip may show instead.
 */
export function WaitingStrip({
  chatID,
  messages,
  onJump,
}: {
  chatID: string;
  messages: readonly Pick<Message, "id" | "request" | "created_seq">[];
  onJump(messageID: string): void;
}) {
  const { t } = useTranslation();
  const { store, navigate } = useMessenger();
  const { requests } = useWorkplaceFeatures();
  const chat = useStore(store, (state) =>
    state.unread.chats.find((item) => item.chat_id === chatID),
  );
  const viewers = useStore(store, (state) => state.requestViewers);
  if (!requests) return null;
  const strip = waitingStrip(chat, messages, viewers);
  if (!strip) return null;
  const parts = [
    strip.dueAt
      ? t("requestDueBy", {
          when: formatRequestDue(strip.dueAt, new Date(), calendarLocale()),
        })
      : null,
    strip.count > 1 ? t("requestStripCount", { count: strip.count }) : null,
  ].filter(Boolean);
  return (
    <button
      type="button"
      className="chat-strip chat-strip--waiting"
      onClick={() =>
        strip.messageID
          ? onJump(strip.messageID)
          : navigate("/important?tab=waiting")
      }
    >
      <MessageSquareMore aria-hidden="true" />
      <span className="truncate">
        <strong>{t("requestStrip")}</strong>
        {parts.length > 0 && ` · ${parts.join(" · ")}`}
      </span>
      <ChevronRight aria-hidden="true" className="chat-strip__chevron" />
    </button>
  );
}

/**
 * “Reminder · note · Done” when the chat was opened from a fired
 * reminder (`?message=…&reminder=…`, the push address).
 */
export function ReminderStrip({ chatID }: { chatID: string }) {
  const { t } = useTranslation();
  const { api, user, navigate } = useMessenger();
  const { reminders } = useWorkplaceFeatures();
  const search = useRouterState({
    select: (state) => state.location.search as Record<string, unknown>,
  });
  const reminderID =
    typeof search.reminder === "string" ? search.reminder : null;
  const messageID = typeof search.message === "string" ? search.message : null;
  const { remove } = useReminderActions();
  const fired = useQuery({
    // Its own key: the Reminders tab keeps pages under the list key.
    queryKey: [...reminderKeys.list(user.id, "fired"), "strip"],
    queryFn: () => api.reminders({ state: "fired", limit: 100 }),
    enabled: Boolean(reminderID) && reminders,
  });
  if (!reminderID || !messageID || !reminders) return null;
  const item = fired.data?.items.find((entry) => entry.id === reminderID);
  return (
    <div className="chat-strip chat-strip--reminder" role="status">
      <Bell aria-hidden="true" />
      <span className="truncate">
        {item?.note
          ? t("reminderStripNote", { note: item.note })
          : t("reminderStrip")}
      </span>
      <Button
        size="sm"
        onClick={() =>
          void remove({ chatID, messageID }, true).then((done) => {
            if (done) navigate(`/chat/${chatID}`);
          })
        }
      >
        <Check aria-hidden="true" />
        {t("reminderDone")}
      </Button>
    </div>
  );
}
