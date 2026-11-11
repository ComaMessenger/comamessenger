import { useId, useMemo, useState } from "react";
import { BellOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  fromLocalInputValue,
  isSchedulable,
  scheduleHorizonMs,
  scheduleMinimumLeadMs,
  schedulePresets,
  toLocalInputValue,
} from "@comamessenger/core";
import { Button, Dialog, FormError, RadioOption, Switch } from "../ui";
import { deviceTimeZone, formatScheduledWhen, presetLabel } from "./format";

/**
 * The choice of a send time: one of the ready-made times still ahead or a
 * custom one on the device clock. Presets are computed once, when the
 * picker opens, so they do not shift under the pointer; validity is checked
 * against the clock at every render and again on confirm.
 */
export function useScheduleChoice(initial?: Date) {
  const [opened] = useState(() => new Date());
  const presets = useMemo(() => schedulePresets(opened), [opened]);
  const [choice, setChoice] = useState<string>(() =>
    initial ? "custom" : (presets[0]?.id ?? "custom"),
  );
  const [custom, setCustom] = useState(() =>
    toLocalInputValue(
      initial && isSchedulable(initial, opened)
        ? initial
        : new Date(opened.getTime() + 2 * 60 * 60 * 1000),
    ),
  );
  const [touched, setTouched] = useState(false);
  const preset = presets.find((item) => item.id === choice);
  const at = preset ? preset.at : fromLocalInputValue(custom);
  const valid = Boolean(at && isSchedulable(at, new Date()));
  return {
    opened,
    presets,
    choice,
    setChoice,
    custom,
    setCustom,
    touched,
    setTouched,
    at: valid ? at : null,
  };
}

export type ScheduleChoice = ReturnType<typeof useScheduleChoice>;

export function ScheduleTimeFields({ state }: { state: ScheduleChoice }) {
  const { t } = useTranslation();
  const groupName = useId();
  const minimum = toLocalInputValue(
    new Date(state.opened.getTime() + scheduleMinimumLeadMs),
  );
  const maximum = toLocalInputValue(
    new Date(state.opened.getTime() + scheduleHorizonMs - 60_000),
  );
  return (
    <>
      <fieldset className="schedule-fields">
        <legend className="visually-hidden">{t("schedulePresets")}</legend>
        {state.presets.map((item) => (
          <RadioOption
            key={item.id}
            name={groupName}
            value={item.id}
            checked={state.choice === item.id}
            onChange={() => state.setChoice(item.id)}
            label={presetLabel(item.id)}
            description={formatScheduledWhen(item.at, state.opened)}
          />
        ))}
        <RadioOption
          name={groupName}
          value="custom"
          checked={state.choice === "custom"}
          onChange={() => state.setChoice("custom")}
          label={t("schedulePresetCustom")}
          description={t("scheduleCustomHint", { zone: deviceTimeZone() })}
        />
      </fieldset>
      {state.choice === "custom" && (
        <label className="schedule-fields__custom">
          <span>{t("scheduleCustomLabel")}</span>
          <input
            type="datetime-local"
            value={state.custom}
            min={minimum}
            max={maximum}
            step={60}
            aria-invalid={state.touched && !state.at ? true : undefined}
            onChange={(event) => {
              state.setTouched(true);
              state.setCustom(event.target.value);
            }}
          />
        </label>
      )}
      {state.choice === "custom" && state.touched && !state.at && (
        <FormError message={t("scheduleCustomInvalid")} />
      )}
    </>
  );
}

export function SilentToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange(value: boolean): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="schedule-silent">
      <BellOff aria-hidden="true" />
      <span>
        <strong>{t("scheduleSilentLabel")}</strong>
        <small>{t("scheduleSilentHint")}</small>
      </span>
      <Switch
        checked={checked}
        onChange={onChange}
        label={t("scheduleSilentLabel")}
      />
    </div>
  );
}

/** Picks when a message goes out and, optionally, "without sound". */
export function ScheduleDialog({
  title,
  initial,
  silent: initialSilent = false,
  showSilent = true,
  pending = false,
  error,
  move = false,
  onConfirm,
  onClose,
}: {
  title?: string;
  /** Current send time when moving a scheduled message. */
  initial?: Date;
  silent?: boolean;
  showSilent?: boolean;
  pending?: boolean;
  error?: string;
  /** The button says "Move to …" instead of "Schedule: …". */
  move?: boolean;
  onConfirm(at: Date, silent: boolean): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const state = useScheduleChoice(initial);
  const [silent, setSilent] = useState(initialSilent);
  const timeLabel = state.at ? formatScheduledWhen(state.at) : "";

  function confirm() {
    state.setTouched(true);
    if (!state.at || !isSchedulable(state.at, new Date())) return;
    onConfirm(state.at, silent);
  }

  return (
    <Dialog
      title={title ?? t("scheduleDialogTitle")}
      onClose={onClose}
      size="sm"
      sheet
      className="schedule-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            pending={pending}
            disabled={!state.at}
            onClick={confirm}
          >
            {timeLabel
              ? t(move ? "scheduleMove" : "scheduleConfirm", {
                  time: timeLabel,
                })
              : t("scheduleConfirmEmpty")}
          </Button>
        </>
      }
    >
      <form
        className="schedule-dialog__form"
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        <ScheduleTimeFields state={state} />
        {showSilent && <SilentToggle checked={silent} onChange={setSilent} />}
        {error && <FormError message={error} />}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
