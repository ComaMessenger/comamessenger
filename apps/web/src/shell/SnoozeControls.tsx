import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Chip } from "../ui";
import { localDateTimeInZone, minutesFromNow, tomorrowAtNine } from "../lib/timezone";
import { useMessenger } from "./MessengerContext";

/** Quick "do not disturb" presets shared by the profile menu and the mobile More page. */
export function SnoozeControls({
  size = "md",
  onApplied,
}: {
  size?: "md" | "lg";
  onApplied?(): void;
}) {
  const { t } = useTranslation();
  const { user, snoozedUntil, updateSnooze } = useMessenger();
  const [custom, setCustom] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [pending, setPending] = useState(false);
  async function apply(until: string | null) {
    setPending(true);
    try {
      await updateSnooze(until);
      onApplied?.();
    } finally {
      setPending(false);
    }
  }
  const chipSize = size === "lg" ? "xl" : "md";
  return (
    <div className="snooze-controls" aria-busy={pending}>
      <div className="snooze-controls__presets">
        <Chip outline size={chipSize} disabled={pending} onClick={() => void apply(minutesFromNow(30))}>
          {t("snooze30")}
        </Chip>
        <Chip outline size={chipSize} disabled={pending} onClick={() => void apply(minutesFromNow(60))}>
          {t("snooze60")}
        </Chip>
        <Chip outline size={chipSize} disabled={pending} onClick={() => void apply(minutesFromNow(120))}>
          {t("snooze120")}
        </Chip>
        <Chip
          outline
          size={chipSize}
          disabled={pending}
          onClick={() => void apply(tomorrowAtNine(user.timezone))}
        >
          {t("snoozeTomorrow")}
        </Chip>
        <Chip
          outline
          size={chipSize}
          className="snooze-controls__custom-toggle"
          aria-expanded={customOpen}
          onClick={() => setCustomOpen((open) => !open)}
        >
          {t("dndCustomTime")}
        </Chip>
      </div>
      {customOpen && (
        <div className="snooze-controls__custom">
          <input
            type="datetime-local"
            aria-label={t("snoozeCustom")}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
          />
          <Button
            variant="primary"
            size="sm"
            disabled={!custom || pending}
            onClick={() => void apply(localDateTimeInZone(custom, user.timezone))}
          >
            {t("apply")}
          </Button>
        </div>
      )}
      {snoozedUntil && (
        <Button
          variant="secondary"
          size="sm"
          block
          disabled={pending}
          className="snooze-controls__resume"
          onClick={() => void apply(null)}
        >
          {t("dndResume")}
        </Button>
      )}
    </div>
  );
}
