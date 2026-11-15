import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  awayDraftFromStatus,
  awayDraftProblem,
  awayKeys,
  customStatusDraft,
  customStatusExpiries,
  customStatusExpiryLabelKeys,
  customStatusLimits,
  customStatusPresets,
  emptyAwayDraft,
  myStatusSummary,
  statusSheetSections,
  toSetAwayInput,
  toSetStatusInput,
  withDefaultAutoreply,
  type AwayDraft,
  type CustomStatusDraft,
  type StatusSheetSection,
} from "@comamessenger/core";
import {
  Button,
  Chip,
  Dialog,
  FloatingPopover,
  FormError,
  InlineError,
  Segmented,
  Spinner,
} from "../ui";
import { EmojiPickerPanel } from "../lib/emoji";
import { messageOf } from "../errors";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { calendarLocale } from "../requests/format";
import { AwayFields } from "../status/AwayForm";
import {
  awayErrorText,
  awayProblemText,
  useAwayAvailable,
  useAwayLookup,
  useMyAway,
  useSelfAway,
} from "../status/useAway";

/**
 * "Status" (decision 13): "Away" — away with dates, an auto-reply,
 * a substitute and muted push — and "Custom status" (an emoji, a text, until
 * when). Without actor_away on the server only the custom status is here.
 */
export function StatusDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { user } = useMessenger();
  const awayOn = useAwayAvailable();
  const sections = statusSheetSections(awayOn);
  const selfAway = useSelfAway();
  const summary = myStatusSummary(
    { ...user, away: selfAway },
    new Date(),
    calendarLocale(),
  );
  const [tab, setTab] = useState<StatusSheetSection>(() =>
    awayOn && summary.kind !== "custom" ? "away" : "custom",
  );
  const shown = sections.includes(tab) ? tab : "custom";
  const [footer, setFooter] = useState<ReactNode>(null);
  return (
    <Dialog
      title={t("statusTitle")}
      onClose={onClose}
      sheet
      className="status-dialog"
      footer={footer}
    >
      {sections.length > 1 && (
        <div className="status-dialog__tabs">
          <Segmented<StatusSheetSection>
            label={t("statusTabsLabel")}
            value={shown}
            onChange={setTab}
            items={sections.map((id) => ({
              id,
              label: t(id === "away" ? "statusTabAway" : "statusTabCustom"),
            }))}
          />
        </div>
      )}
      {shown === "away" ? (
        <AwaySection onClose={onClose} setFooter={setFooter} />
      ) : (
        <CustomSection onClose={onClose} setFooter={setFooter} />
      )}
    </Dialog>
  );
}

type SectionProps = {
  onClose(): void;
  setFooter(node: ReactNode): void;
};

/** "Away": the form opened on the saved status, or a fresh vacation. */
function AwaySection({ onClose, setFooter }: SectionProps) {
  const { t } = useTranslation();
  const { api, user, onUserUpdated } = useMessenger();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mine = useMyAway();
  const people = useAwayLookup();
  const [opened] = useState(() => new Date());
  const [draft, setDraft] = useState<AwayDraft | null>(null);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState("");
  const locale = calendarLocale();

  useEffect(() => {
    if (draft || mine.isLoading) return;
    setDraft(
      mine.data
        ? awayDraftFromStatus(mine.data)
        : withDefaultAutoreply(emptyAwayDraft(opened), null, opened, locale),
    );
  }, [draft, locale, mine.data, mine.isLoading, opened]);

  const substituteName = (next: AwayDraft) =>
    next.substituteID
      ? (people.lookup(next.substituteID)?.display_name ?? null)
      : null;
  function change(next: AwayDraft) {
    setDraft(withDefaultAutoreply(next, substituteName(next), new Date(), locale));
    setError("");
  }
  // The substitute's name arrives with the directory: fill it in once known.
  useEffect(() => {
    if (!draft || !people.loaded) return;
    const next = withDefaultAutoreply(
      draft,
      substituteName(draft),
      new Date(),
      locale,
    );
    if (next !== draft) setDraft(next);
  }, [people.loaded]);

  const problem = draft ? awayDraftProblem(draft, new Date(), user.id) : null;
  const existing = Boolean(mine.data);

  async function settle() {
    void queryClient.invalidateQueries({ queryKey: awayKeys.all(user.id) });
    void queryClient.invalidateQueries({ queryKey: ["actors"] });
    onUserUpdated(await api.me());
  }
  async function save() {
    if (!draft) return;
    setTouched(true);
    if (problem) return;
    setPending("save");
    setError("");
    try {
      const saved = await api.setAway(toSetAwayInput(draft, new Date()));
      queryClient.setQueryData(awayKeys.mine(user.id), saved);
      await settle();
      toast({ message: t("awaySaved") });
      onClose();
    } catch (cause) {
      setError(awayErrorText(cause));
    } finally {
      setPending(null);
    }
  }
  async function clear() {
    setPending("clear");
    setError("");
    try {
      await api.clearAway();
      queryClient.setQueryData(awayKeys.mine(user.id), null);
      await settle();
      toast({ message: t("awayCleared") });
      onClose();
    } catch (cause) {
      setError(awayErrorText(cause));
    } finally {
      setPending(null);
    }
  }

  const footer = (
    <>
      {existing && (
        <Button
          variant="danger-ghost"
          className="status-dialog__clear"
          pending={pending === "clear"}
          disabled={pending !== null}
          onClick={() => void clear()}
        >
          {t("awayClear")}
        </Button>
      )}
      <span className="status-dialog__spacer" />
      <Button onClick={onClose} disabled={pending !== null}>
        {t("cancel")}
      </Button>
      <Button
        variant="primary"
        pending={pending === "save"}
        disabled={!draft || pending !== null || (touched && Boolean(problem))}
        onClick={() => void save()}
      >
        {t("awaySave")}
      </Button>
    </>
  );
  const footerKey = `${existing}:${pending}:${Boolean(draft)}:${touched && Boolean(problem)}:${JSON.stringify(draft)}`;
  const lastKey = useRef("");
  useEffect(() => {
    if (lastKey.current === footerKey) return;
    lastKey.current = footerKey;
    setFooter(footer);
  });

  if (mine.isError)
    return (
      <InlineError
        title={awayErrorText(mine.error)}
        retryLabel={t("retry")}
        onRetry={() => void mine.refetch()}
      />
    );
  if (!draft)
    return (
      <div className="status-dialog__loading" role="status">
        <Spinner />
        <span>{t("awayLoading")}</span>
      </div>
    );
  return (
    <form
      className="status-dialog__form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <AwayFields
        draft={draft}
        onChange={change}
        problem={touched ? problem : null}
        opened={opened}
      />
      {touched && problem && <FormError message={awayProblemText(problem)} />}
      {error && <FormError message={error} />}
      <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
    </form>
  );
}

/** "Custom status": an emoji, a text up to 100 characters and when it resets. */
function CustomSection({ onClose, setFooter }: SectionProps) {
  const { t } = useTranslation();
  const { api, user, onUserUpdated } = useMessenger();
  const [draft, setDraft] = useState<CustomStatusDraft>(() =>
    customStatusDraft(user),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiTrigger = useRef<HTMLButtonElement>(null);
  const hasStatus = Boolean(user.status_text || user.status_emoji);
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
  const save = () =>
    void run(() => api.setStatus(toSetStatusInput(draft, new Date())));

  const footerKey = `${hasStatus}:${pending}:${JSON.stringify(draft)}`;
  const lastKey = useRef("");
  useEffect(() => {
    if (lastKey.current === footerKey) return;
    lastKey.current = footerKey;
    setFooter(
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
        <Button variant="primary" pending={pending} onClick={save}>
          {t("save")}
        </Button>
      </>,
    );
  });

  return (
    <form
      className="status-dialog__form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
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
          <span>{draft.emoji || "🙂"}</span>
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
                  setDraft((current) => ({ ...current, emoji: value }));
                  setEmojiOpen(false);
                }}
              />
            </div>
          </FloatingPopover>
        )}
        <label className="status-dialog__text ui-field__control">
          <input
            value={draft.text}
            maxLength={customStatusLimits.textMaxLength}
            placeholder={t("statusPlaceholder")}
            aria-label={t("statusText")}
            autoFocus
            onChange={(event) =>
              setDraft((current) => ({ ...current, text: event.target.value }))
            }
          />
          <span className="status-dialog__counter tabular">
            {draft.text.length} / {customStatusLimits.textMaxLength}
          </span>
        </label>
      </div>
      <div className="status-dialog__section">
        <span className="status-dialog__label">{t("statusReset")}</span>
        <div
          className="status-dialog__chips"
          role="radiogroup"
          aria-label={t("statusDuration")}
        >
          {customStatusExpiries.map((expiry) => (
            <Chip
              key={expiry}
              outline
              size="lg"
              role="radio"
              aria-checked={expiry === draft.expiry}
              active={expiry === draft.expiry}
              onClick={() => setDraft((current) => ({ ...current, expiry }))}
            >
              {t(customStatusExpiryLabelKeys[expiry])}
            </Chip>
          ))}
        </div>
      </div>
      <div className="status-dialog__section">
        <span className="status-dialog__label">{t("statusQuick")}</span>
        <div className="status-dialog__presets">
          {customStatusPresets.map((preset) => (
            <button
              key={preset.labelKey}
              type="button"
              className="status-dialog__preset"
              onClick={() =>
                setDraft({
                  emoji: preset.emoji,
                  text: t(preset.labelKey),
                  expiry: preset.expiry,
                })
              }
            >
              <span className="status-dialog__preset-emoji" aria-hidden="true">
                {preset.emoji}
              </span>
              <span className="status-dialog__preset-label truncate">
                {t(preset.labelKey)}
              </span>
              <span className="status-dialog__preset-duration">
                {t(preset.durationKey)}
              </span>
            </button>
          ))}
        </div>
      </div>
      {error && <InlineError title={error} />}
      <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
    </form>
  );
}
