import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Bell, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { reminderKeys } from "@comamessenger/core";
import { Button } from "../ui";
import { useMessenger } from "../shell/MessengerContext";
import { useReminderActions } from "../reminders/useReminders";
import { useWorkplaceFeatures } from "./format";

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
