import { useId, useMemo, useState } from "react";
import { CalendarDays } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  formatReminderWhen,
  reminderAt,
  reminderCustomDays,
  reminderDefaultHour,
  reminderNoteMaxLength,
  reminderPresetHint,
  reminderPresetLabelKeys,
  reminderPresets,
  reminderProblem,
  weekdayShort,
  dayMonth,
  capitalize,
  type ReminderPresetID,
} from "@comamessenger/core";
import {
  Button,
  Chip,
  Dialog,
  FormError,
  RadioOption,
} from "../ui";
import { calendarLocale } from "../requests/format";
import { deviceTimeZone } from "../scheduled/format";

type Choice = ReminderPresetID | "custom";

const pad = (value: number) => String(value).padStart(2, "0");
const dateValue = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * Remind me: four ready-made times, Custom time (a day and a time)
 * and a note only the reader sees. A dialog on desktop, a bottom sheet on
 * phones.
 */
export function ReminderPicker({
  initial,
  editing,
  pending,
  onConfirm,
  onRemove,
  onClose,
}: {
  /** The time already set: the picker opens on Custom time there. */
  initial?: Date;
  editing: boolean;
  pending: boolean;
  /** The note is undefined when it was not touched: the server keeps it. */
  onConfirm(at: Date, note: string | undefined): void;
  onRemove?(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const locale = calendarLocale();
  const groupName = useId();
  const formID = useId();
  const [opened] = useState(() => new Date());
  const presets = useMemo(() => reminderPresets(opened), [opened]);
  const days = useMemo(() => reminderCustomDays(opened), [opened]);
  const [choice, setChoice] = useState<Choice>(() =>
    initial ? "custom" : (presets.find((item) => item.id === "tomorrowMorning")?.id ?? presets[0]?.id ?? "custom"),
  );
  const [day, setDay] = useState(() =>
    dateValue(initial ?? days[0] ?? opened),
  );
  const [otherDate, setOtherDate] = useState(() =>
    Boolean(initial && !days.some((item) => dateValue(item) === dateValue(initial))),
  );
  const [time, setTime] = useState(() =>
    initial
      ? `${pad(initial.getHours())}:${pad(initial.getMinutes())}`
      : `${pad(reminderDefaultHour)}:00`,
  );
  const [note, setNote] = useState("");
  const [noteTouched, setNoteTouched] = useState(false);
  const [touched, setTouched] = useState(false);

  const preset = presets.find((item) => item.id === choice);
  const custom = (() => {
    const [year, month, date] = day.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    if (!year || !month || !date || hour === undefined || Number.isNaN(hour))
      return null;
    return reminderAt(new Date(year, month - 1, date), hour, minute ?? 0);
  })();
  const at = preset ? preset.at : custom;
  const problem = at ? reminderProblem(at, new Date(), note) : "past";
  const valid = !problem;

  function confirm() {
    setTouched(true);
    if (!at || problem) return;
    onConfirm(at, noteTouched ? note : undefined);
  }

  const body = (
    <form
      id={formID}
      className="reminder-picker"
      onSubmit={(event) => {
        event.preventDefault();
        confirm();
      }}
    >
      <fieldset className="reminder-picker__presets">
        <legend className="visually-hidden">{t("reminderPresets")}</legend>
        {presets.map((item) => (
          <RadioOption
            key={item.id}
            name={groupName}
            value={item.id}
            checked={choice === item.id}
            onChange={() => setChoice(item.id)}
            label={t(reminderPresetLabelKeys[item.id])}
            description={reminderPresetHint(item, opened, locale)}
          />
        ))}
        <RadioOption
          name={groupName}
          value="custom"
          checked={choice === "custom"}
          onChange={() => setChoice("custom")}
          label={t("reminderCustom")}
          description={t("reminderZone", { zone: deviceTimeZone() })}
        />
      </fieldset>
      {choice === "custom" && (
        <div className="reminder-picker__custom">
          <div
            className="reminder-picker__days"
            role="radiogroup"
            aria-label={t("reminderDay")}
          >
            {days.map((item) => {
              const value = dateValue(item);
              const active = !otherDate && day === value;
              return (
                <Chip
                  key={value}
                  role="radio"
                  aria-checked={active}
                  active={active}
                  onClick={() => {
                    setOtherDate(false);
                    setDay(value);
                  }}
                >
                  {capitalize(weekdayShort(item, locale))},{" "}
                  {dayMonth(item, opened, locale)}
                </Chip>
              );
            })}
            <Chip
              role="radio"
              aria-checked={otherDate}
              active={otherDate}
              onClick={() => setOtherDate(true)}
            >
              <CalendarDays aria-hidden="true" />
              {t("reminderOtherDate")}
            </Chip>
          </div>
          <div className="reminder-picker__when">
            {otherDate && (
              <label>
                <span>{t("reminderDay")}</span>
                <input
                  type="date"
                  className="request-input"
                  value={day}
                  min={dateValue(opened)}
                  onChange={(event) => setDay(event.target.value)}
                />
              </label>
            )}
            <label>
              <span>{t("reminderTime")}</span>
              <input
                type="time"
                className="request-input"
                value={time}
                step={60}
                aria-invalid={touched && !valid ? true : undefined}
                onChange={(event) => setTime(event.target.value)}
              />
            </label>
          </div>
        </div>
      )}
      <label className="reminder-picker__note">
        <span>{t("reminderNote")}</span>
        <input
          className="request-input"
          value={note}
          maxLength={reminderNoteMaxLength + 20}
          placeholder={t("reminderNotePlaceholder")}
          onChange={(event) => {
            setNote(event.target.value);
            setNoteTouched(true);
          }}
        />
      </label>
      {touched && problem && (
        <FormError
          message={t(
            problem === "noteTooLong" ? "reminderNoteTooLong" : "reminderInvalid",
          )}
        />
      )}
    </form>
  );

  const footer = (
    <>
      {editing && onRemove && (
        <Button variant="ghost" disabled={pending} onClick={onRemove}>
          {t("reminderRemove")}
        </Button>
      )}
      <Button
        type="submit"
        form={formID}
        variant="primary"
        pending={pending}
        disabled={touched && !valid}
      >
        {at && valid
          ? t("reminderConfirm", {
              when: formatReminderWhen(at, new Date(), locale),
            })
          : t("reminderConfirmEmpty")}
      </Button>
    </>
  );

  const title = t(editing ? "messageEditReminder" : "messageRemindMe");
  // A small dialog, as Send later: next to a message a popover with
  // five times, a day, a time and a note does not fit the height.
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="sm"
      sheet
      className="reminder-dialog"
      footer={footer}
    >
      {body}
    </Dialog>
  );
}
