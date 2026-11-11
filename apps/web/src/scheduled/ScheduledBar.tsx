import { ChevronRight, Clock3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pendingSummary } from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";
import { formatScheduledWhen } from "./format";
import { useScheduledMessages } from "./useScheduled";

/**
 * "Scheduled: 2 · next tomorrow at 9:00" under the chat header. The list is
 * the author's own, so the strip never shows anyone else's messages; it is
 * absent when nothing is waiting here.
 */
export function ScheduledBar({ chatID }: { chatID: string }) {
  const { t } = useTranslation();
  const { api, navigate } = useMessenger();
  const query = useScheduledMessages(api);
  const { count, next } = pendingSummary(query.data ?? [], chatID);
  if (!count || !next) return null;
  return (
    <button
      type="button"
      className="scheduled-bar"
      aria-label={`${t("scheduledBarLabel")}: ${t("scheduledBar", {
        count,
        time: formatScheduledWhen(next.send_at),
      })}`}
      onClick={() => navigate(`/scheduled?chat=${chatID}`)}
    >
      <Clock3 aria-hidden="true" />
      <span className="truncate">
        {t("scheduledBar", { count, time: formatScheduledWhen(next.send_at) })}
      </span>
      <ChevronRight aria-hidden="true" className="scheduled-bar__chevron" />
    </button>
  );
}
