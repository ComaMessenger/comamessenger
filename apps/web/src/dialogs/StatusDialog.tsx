import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Chip, Dialog, FloatingPopover, InlineError } from "../ui";
import { EmojiPickerPanel } from "../lib/emoji";
import { messageOf } from "../errors";
import { useMessenger } from "../shell/MessengerContext";

type Expiry = "none" | "hour" | "today" | "week";
const statusMaxLength = 100;

function expiryToISO(expiry: Expiry): string | null {
  const now = new Date();
  switch (expiry) {
    case "hour":
      return new Date(now.getTime() + 60 * 60_000).toISOString();
    case "today": {
      const end = new Date(now);
      end.setHours(23, 59, 0, 0);
      return end.toISOString();
    }
    case "week":
      return new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString();
    default:
      return null;
  }
}

export function StatusDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { api, user, onUserUpdated } = useMessenger();
  const [emoji, setEmoji] = useState(user.status_emoji);
  const [text, setText] = useState(user.status_text);
  const [expiry, setExpiry] = useState<Expiry>("none");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiTrigger = useRef<HTMLButtonElement>(null);
  const hasStatus = Boolean(user.status_text || user.status_emoji);
  const presets: Array<{ emoji: string; label: string; duration: string; expiry: Expiry }> = [
    { emoji: "📅", label: t("statusPresetMeeting"), duration: t("statusDurationHour"), expiry: "hour" },
    { emoji: "🏠", label: t("statusPresetRemote"), duration: t("statusDurationToday"), expiry: "today" },
    { emoji: "🤒", label: t("statusPresetSick"), duration: t("statusDurationWeek"), expiry: "week" },
    { emoji: "🏝", label: t("statusPresetVacation"), duration: t("statusDurationCustom"), expiry: "none" },
  ];
  const expiries: Array<{ id: Expiry; label: string }> = [
    { id: "none", label: t("statusNever") },
    { id: "hour", label: t("statusInHour") },
    { id: "today", label: t("statusToday") },
    { id: "week", label: t("statusInWeek") },
  ];
  async function run(action: () => Promise<unknown>) {
    setPending(true);
    setError("");
    try {
      await action();
      onUserUpdated(await api.me());
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      title={t("statusTitle")}
      onClose={onClose}
      sheet
      className="status-dialog"
      footer={
        <>
          {hasStatus && (
            <Button
              variant="danger-ghost"
              className="status-dialog__clear"
              disabled={pending}
              onClick={() => void run(() => api.clearStatus())}
            >
              {t("clear")}
            </Button>
          )}
          <span className="status-dialog__spacer" />
          <Button onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            pending={pending}
            onClick={() =>
              void run(() =>
                api.setStatus({ emoji, text: text.trim(), expires_at: expiryToISO(expiry) }),
              )
            }
          >
            {t("save")}
          </Button>
        </>
      }
    >
      <form
        className="status-dialog__form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() =>
            api.setStatus({ emoji, text: text.trim(), expires_at: expiryToISO(expiry) }),
          );
        }}
      >
        <div className="status-dialog__row">
          <button
            ref={emojiTrigger}
            type="button"
            className="status-dialog__emoji"
            aria-label={t("statusEmoji")}
            aria-expanded={emojiOpen}
            onClick={() => setEmojiOpen((open) => !open)}
          >
            <span>{emoji || "🙂"}</span>
            <ChevronDown aria-hidden="true" />
          </button>
          {emojiOpen && (
            <FloatingPopover
              anchorRef={emojiTrigger}
              className="status-dialog__picker"
              placement="side-start"
              width={352}
              gap={16}
              onDismiss={() => setEmojiOpen(false)}
            >
              <div role="dialog" aria-label={t("emoji")}>
                <EmojiPickerPanel
                  height={320}
                  onPick={(value) => {
                    setEmoji(value);
                    setEmojiOpen(false);
                  }}
                />
              </div>
            </FloatingPopover>
          )}
          <label className="status-dialog__text ui-field__control">
            <input
              value={text}
              maxLength={statusMaxLength}
              placeholder={t("statusPlaceholder")}
              aria-label={t("statusText")}
              autoFocus
              onChange={(event) => setText(event.target.value)}
            />
            <span className="status-dialog__counter tabular">
              {text.length} / {statusMaxLength}
            </span>
          </label>
        </div>
        <div className="status-dialog__section">
          <span className="status-dialog__label">{t("statusReset")}</span>
          <div className="status-dialog__chips" role="radiogroup" aria-label={t("statusDuration")}>
            {expiries.map((item) => (
              <Chip
                key={item.id}
                outline
                size="lg"
                role="radio"
                aria-checked={item.id === expiry}
                active={item.id === expiry}
                onClick={() => setExpiry(item.id)}
              >
                {item.label}
              </Chip>
            ))}
          </div>
        </div>
        <div className="status-dialog__section">
          <span className="status-dialog__label">{t("statusQuick")}</span>
          <div className="status-dialog__presets">
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="status-dialog__preset"
                onClick={() => {
                  setEmoji(preset.emoji);
                  setText(preset.label);
                  setExpiry(preset.expiry);
                }}
              >
                <span className="status-dialog__preset-emoji" aria-hidden="true">
                  {preset.emoji}
                </span>
                <span className="status-dialog__preset-label truncate">{preset.label}</span>
                <span className="status-dialog__preset-duration">{preset.duration}</span>
              </button>
            ))}
          </div>
        </div>
        {error && <InlineError title={error} />}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
