import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  awayEndOfDay,
  awayKindEmoji,
  awayKindTitle,
  awayKinds,
  awayLimits,
  awayPresets,
  awayStartOfDay,
  fromLocalInputValue,
  toLocalInputValue,
  withAwayKind,
  withAwayPreset,
  type AwayDraft,
  type AwayDraftProblem,
} from "@comamessenger/core";
import { Avatar, Chip, Switch, cx } from "../ui";
import { AutoReplyTag } from "./AutoReplyTag";
import { calendarLocale } from "../requests/format";
import { MemberPicker } from "../tasks/MemberPicker";
import { useMessenger } from "../shell/MessengerContext";
import { useAllActors } from "../org/useOrg";

const pad = (value: number) => String(value).padStart(2, "0");
const dayValue = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
function fromDayValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

/**
 * The fields of "Away" (prototype "Away", phone A): the kind
 * tiles, "From" and "Until" with the kind's chips or another date, the
 * auto-reply with its preview, "Instead of me" and "Mute
 * notifications". A vacation is set in whole days (date inputs); the others
 * to the minute (datetime-local). The parent keeps the draft and saves.
 */
export function AwayFields({
  draft,
  onChange,
  problem,
  opened,
}: {
  draft: AwayDraft;
  onChange(next: AwayDraft): void;
  /** Shown after a save was tried. */
  problem: AwayDraftProblem | null;
  opened: Date;
}) {
  const { t } = useTranslation();
  const { api, user } = useMessenger();
  const locale = calendarLocale();
  const everyone = useAllActors(api);
  const people = (everyone.data ?? []).filter(
    (actor) => actor.type === "user" && actor.actor_id !== user.id,
  );
  const substitute = draft.substituteID
    ? people.find((actor) => actor.actor_id === draft.substituteID)
    : undefined;
  const [startCustom, setStartCustom] = useState(
    () => draft.startsAt !== null && draft.startsAt.getTime() > opened.getTime(),
  );
  const [endCustom, setEndCustom] = useState(
    () => draft.endsAt !== null && draft.endsPreset === null,
  );
  const [picking, setPicking] = useState(false);
  const pickerAnchor = useRef<HTMLButtonElement>(null);
  const wholeDays = draft.kind === "vacation";
  const presets = awayPresets(draft.kind, opened, {
    startsAt: draft.startsAt,
    locale,
  });
  const invalid = (field: AwayDraftProblem["field"]) =>
    problem?.field === field ? true : undefined;

  const startValue = draft.startsAt ?? opened;
  const endValue = draft.endsAt;
  // The last day covered: a vacation "until 30 November" ends at 1 December 0:00.
  const lastDay = endValue ? new Date(endValue.getTime() - 60_000) : null;

  function setStart(value: string) {
    const parsed = wholeDays
      ? (() => {
          const day = fromDayValue(value);
          return day ? awayStartOfDay(day) : null;
        })()
      : fromLocalInputValue(value);
    onChange({ ...draft, startsAt: parsed });
  }
  function setEnd(value: string) {
    const parsed = wholeDays
      ? (() => {
          const day = fromDayValue(value);
          return day ? awayEndOfDay(day) : null;
        })()
      : fromLocalInputValue(value);
    onChange({ ...draft, endsAt: parsed, endsPreset: null });
  }

  return (
    <div className="away-form">
      <section className="away-form__section">
        <span className="away-form__label">{t("awayKindLabel")}</span>
        <div
          className="away-form__kinds"
          role="radiogroup"
          aria-label={t("awayKindLabel")}
        >
          {awayKinds.map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={draft.kind === kind}
              className={cx(
                "away-kind",
                draft.kind === kind && "away-kind--on",
              )}
              onClick={() => {
                setEndCustom(false);
                onChange(withAwayKind(draft, kind, new Date()));
              }}
            >
              <span className="away-kind__emoji" aria-hidden="true">
                {awayKindEmoji[kind]}
              </span>
              <span className="away-kind__title">
                {awayKindTitle(kind, locale)}
              </span>
            </button>
          ))}
        </div>
        {draft.kind === "other" && (
          <label className="away-form__field">
            <span className="away-form__label">{t("awayLabelLabel")}</span>
            <input
              className="request-input"
              value={draft.label}
              maxLength={awayLimits.labelMaxLength}
              placeholder={t("awayLabelPlaceholder")}
              aria-invalid={invalid("label")}
              onChange={(event) =>
                onChange({ ...draft, label: event.target.value })
              }
            />
          </label>
        )}
      </section>

      <section className="away-form__section">
        <span className="away-form__label">{t("awayFromLabel")}</span>
        <div
          className="request-form__chips"
          role="radiogroup"
          aria-label={t("awayFromLabel")}
        >
          <Chip
            role="radio"
            aria-checked={!startCustom}
            active={!startCustom}
            onClick={() => {
              setStartCustom(false);
              onChange({ ...draft, startsAt: null });
            }}
          >
            {t("awayFromNow")}
          </Chip>
          <Chip
            role="radio"
            aria-checked={startCustom}
            active={startCustom}
            onClick={() => {
              setStartCustom(true);
              if (!draft.startsAt || draft.startsAt <= opened) {
                const tomorrow = awayStartOfDay(
                  new Date(opened.getTime() + 24 * 60 * 60_000),
                );
                onChange({ ...draft, startsAt: tomorrow });
              }
            }}
          >
            {t("awayFromOther")}
          </Chip>
        </div>
        {startCustom && (
          <label className="away-form__field">
            <span className="away-form__label">{t("awayFromCustomLabel")}</span>
            <input
              type={wholeDays ? "date" : "datetime-local"}
              className="request-input"
              value={
                wholeDays ? dayValue(startValue) : toLocalInputValue(startValue)
              }
              aria-invalid={invalid("startsAt")}
              step={wholeDays ? undefined : 60}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
        )}
      </section>

      <section className="away-form__section">
        <span className="away-form__label">{t("awayUntilLabel")}</span>
        <div
          className="request-form__chips"
          role="radiogroup"
          aria-label={t("awayUntilLabel")}
        >
          {presets.map((preset) => {
            const on = !endCustom && draft.endsPreset === preset.id;
            return (
              <Chip
                key={preset.id}
                role="radio"
                aria-checked={on}
                active={on}
                onClick={() => {
                  setEndCustom(false);
                  onChange(withAwayPreset(draft, preset));
                }}
              >
                {preset.label}
              </Chip>
            );
          })}
          <Chip
            role="radio"
            aria-checked={endCustom || (!draft.endsPreset && !!draft.endsAt)}
            active={endCustom || (!draft.endsPreset && !!draft.endsAt)}
            onClick={() => {
              setEndCustom(true);
              onChange({ ...draft, endsPreset: null });
            }}
          >
            {t("awayUntilOther")}
          </Chip>
        </div>
        {(endCustom || (!draft.endsPreset && draft.endsAt)) && (
          <label className="away-form__field">
            <span className="away-form__label">
              {t("awayUntilCustomLabel")}
            </span>
            <input
              type={wholeDays ? "date" : "datetime-local"}
              className="request-input"
              value={
                endValue
                  ? wholeDays
                    ? dayValue(lastDay!)
                    : toLocalInputValue(endValue)
                  : ""
              }
              aria-invalid={invalid("endsAt")}
              step={wholeDays ? undefined : 60}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
        )}
      </section>

      <section className="away-form__section">
        <span className="away-form__label">{t("awaySubstitute")}</span>
        <small className="away-form__hint">{t("awaySubstituteHint")}</small>
        <div className="request-form__chips">
          <Chip
            active={!draft.substituteID}
            aria-pressed={!draft.substituteID}
            onClick={() => onChange({ ...draft, substituteID: null })}
          >
            {t("awaySubstituteNone")}
          </Chip>
          {substitute && (
            <Chip active aria-pressed>
              <Avatar
                name={substitute.display_name}
                seed={substitute.actor_id}
                actorID={substitute.actor_id}
                avatarVersion={substitute.avatar_version}
                size="xs"
              />
              {substitute.display_name}
            </Chip>
          )}
          <button
            ref={pickerAnchor}
            type="button"
            className="ui-chip away-form__choose"
            aria-expanded={picking}
            onClick={() => setPicking((value) => !value)}
          >
            {t("awaySubstituteChoose")}
            <ChevronDown aria-hidden="true" />
          </button>
        </div>
        {picking && (
          <MemberPicker
            anchorRef={pickerAnchor}
            members={people}
            selfID={user.id}
            selected={draft.substituteID}
            label={t("awaySubstitute")}
            onPick={(actorID) => {
              setPicking(false);
              onChange({ ...draft, substituteID: actorID });
            }}
            onDismiss={() => setPicking(false)}
          />
        )}
      </section>

      <section className="away-form__section">
        <div className="request-form__toggle">
          <span>
            <strong>{t("awayAutoreply")}</strong>
            <small>{t("awayAutoreplyHint")}</small>
          </span>
          <Switch
            checked={draft.autoreplyEnabled}
            onChange={(autoreplyEnabled) =>
              onChange({ ...draft, autoreplyEnabled })
            }
            label={t("awayAutoreply")}
          />
        </div>
        {draft.autoreplyEnabled && (
          <>
            <textarea
              className="request-form__body away-form__autoreply"
              rows={3}
              maxLength={awayLimits.autoreplyMaxLength}
              value={draft.autoreplyText}
              aria-label={t("awayAutoreplyText")}
              aria-invalid={invalid("autoreply")}
              onChange={(event) =>
                onChange({
                  ...draft,
                  autoreplyText: event.target.value,
                  autoreplyEdited: true,
                })
              }
            />
            <div className="away-form__preview">
              <div className="away-preview" aria-hidden="true">
                <span className="away-preview__meta">
                  <strong>{user.display_name}</strong>
                  <AutoReplyTag />
                </span>
                <span className="away-preview__text">
                  {draft.autoreplyText.trim()}
                </span>
              </div>
              <small>{t("awayAutoreplyPreview")}</small>
            </div>
          </>
        )}
      </section>

      <section className="away-form__section">
        <div className="request-form__toggle">
          <span>
            <strong>{t("awayMute")}</strong>
            <small>{t("awayMuteHint")}</small>
          </span>
          <Switch
            checked={draft.mutePush}
            onChange={(mutePush) => onChange({ ...draft, mutePush })}
            label={t("awayMute")}
          />
        </div>
      </section>
    </div>
  );
}
