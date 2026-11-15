import { useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  addPollOption,
  canAddPollOption,
  emptyPollDraft,
  formatPollDue,
  fromLocalInputValue,
  movePollOption,
  parsePollDraft,
  pollDraftProblem,
  pollDraftTouched,
  pollDuePresetLabelKeys,
  pollDuePresets,
  pollLimits,
  pollSignature,
  removePollOption,
  serializePollDraft,
  toCreatePollInput,
  toLocalInputValue,
  type CreatePollRequest,
  type Message,
  type PollDraft,
  type PollDuePresetID,
} from "@comamessenger/core";
import { Button, Chip, Dialog, FormError, IconButton, Switch, cx } from "../ui";
import { calendarLocale } from "../requests/format";
import { pollErrorText, pollProblemText } from "./format";

type DueChoice = "none" | PollDuePresetID | "custom";

/** What the form keeps between openings, per reader and chat. */
type Stored = { draft: string; due: DueChoice; customDue: string };

const draftKey = (userID: string, chatID: string) =>
  `coma-poll-draft:${userID}:${chatID}`;

function readStored(userID: string, chatID: string): Stored | null {
  try {
    const raw = sessionStorage.getItem(draftKey(userID, chatID));
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

/**
 * New poll from «+»: the question, 2–10 options in any order (drag the
 * handle or press an arrow on it), several answers, anonymous, and how long
 * votes are accepted. The draft stays for the session until the poll is
 * sent; a retry of the same poll reuses its id.
 */
export function PollDialog({
  chatID,
  userID,
  createPoll,
  onSent,
  onClose,
}: {
  chatID: string;
  userID: string;
  createPoll(chatID: string, input: CreatePollRequest): Promise<Message>;
  onSent(message: Message): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const locale = calendarLocale();
  const [opened] = useState(() => new Date());
  const presets = useMemo(() => pollDuePresets(opened), [opened]);
  const stored = useMemo(() => readStored(userID, chatID), [userID, chatID]);
  const [draft, setDraft] = useState<Omit<PollDraft, "dueAt">>(() => {
    const parsed = parsePollDraft(stored?.draft ?? null, opened);
    const { dueAt: _ignored, ...rest } = parsed ?? emptyPollDraft();
    return rest;
  });
  const [due, setDue] = useState<DueChoice>(() => {
    const value = stored?.due ?? "none";
    return value === "none" ||
      value === "custom" ||
      presets.some((preset) => preset.id === value)
      ? value
      : "none";
  });
  const [customDue, setCustomDue] = useState(
    () =>
      stored?.customDue ||
      toLocalInputValue(new Date(opened.getTime() + 24 * 60 * 60_000)),
  );
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState<number | null>(null);
  const sent = useRef<{ signature: string; id: string } | null>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const optionRefs = useRef<Array<HTMLInputElement | null>>([]);
  const focusOption = useRef<number | null>(null);

  const dueAt =
    due === "none"
      ? null
      : due === "custom"
        ? fromLocalInputValue(customDue)
        : (presets.find((preset) => preset.id === due)?.at ?? null);
  const full: PollDraft = { ...draft, dueAt };

  useEffect(() => {
    try {
      if (!pollDraftTouched(full) && due === "none") {
        sessionStorage.removeItem(draftKey(userID, chatID));
        return;
      }
      sessionStorage.setItem(
        draftKey(userID, chatID),
        JSON.stringify({
          draft: serializePollDraft({ ...draft, dueAt: null }),
          due,
          customDue,
        } satisfies Stored),
      );
    } catch {
      // Private mode: the draft lives as long as the dialog.
    }
    // full is derived from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatID, customDue, draft, due, userID]);

  useEffect(() => {
    const index = focusOption.current;
    if (index === null) return;
    focusOption.current = null;
    optionRefs.current[index]?.focus();
  });

  const now = new Date();
  const problem =
    due === "custom" && !dueAt
      ? ({ field: "dueAt", reason: "past" } as const)
      : pollDraftProblem(full, now);

  function update(next: Omit<PollDraft, "dueAt">) {
    setDraft(next);
    setError("");
  }
  const withDue = (value: Omit<PollDraft, "dueAt">): PollDraft => ({
    ...value,
    dueAt: null,
  });
  const strip = ({ dueAt: _dueAt, ...rest }: PollDraft) => rest;
  function move(from: number, to: number) {
    update(strip(movePollOption(withDue(draft), from, to)));
  }

  async function submit() {
    setTouched(true);
    if (problem) {
      if (problem.field === "question") questionRef.current?.focus();
      else if (problem.field === "options" && problem.index !== undefined)
        optionRefs.current[problem.index]?.focus();
      return;
    }
    const probe = toCreatePollInput(full, "");
    const signature = pollSignature(probe);
    if (sent.current?.signature !== signature)
      sent.current = { signature, id: crypto.randomUUID() };
    setPending(true);
    setError("");
    try {
      const message = await createPoll(
        chatID,
        toCreatePollInput(full, sent.current.id),
      );
      try {
        sessionStorage.removeItem(draftKey(userID, chatID));
      } catch {
        // Nothing stored.
      }
      onSent(message);
    } catch (cause) {
      setError(pollErrorText(cause));
    } finally {
      setPending(false);
    }
  }

  const shown = touched && problem ? pollProblemText(problem) : "";
  const badOption =
    touched && problem?.field === "options" ? problem.index : undefined;

  return (
    <Dialog
      title={t("pollDialogTitle")}
      onClose={onClose}
      sheet
      className="poll-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            pending={pending}
            disabled={touched && Boolean(problem)}
            onClick={() => void submit()}
          >
            {t("pollSend")}
          </Button>
        </>
      }
    >
      <form
        className="request-form poll-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="request-form__field">
          <span className="request-form__label">{t("pollQuestionLabel")}</span>
          <textarea
            ref={questionRef}
            className="request-form__body poll-form__question"
            rows={2}
            maxLength={pollLimits.questionMaxLength + 20}
            value={draft.question}
            placeholder={t("pollQuestionPlaceholder")}
            aria-invalid={
              touched && problem?.field === "question" ? true : undefined
            }
            onChange={(event) =>
              update({ ...draft, question: event.target.value })
            }
          />
        </label>

        <section className="request-form__section">
          <span className="request-form__label" id={`${chatID}-poll-options`}>
            {t("pollOptionsLabel")}
          </span>
          <ol
            className="poll-form__options"
            aria-labelledby={`${chatID}-poll-options`}
          >
            {draft.options.map((value, index) => (
              <li
                key={index}
                className={cx(
                  "poll-form__option",
                  dragging === index && "poll-form__option--dragging",
                )}
                onDragOver={(event) => {
                  if (dragging === null) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging !== null && dragging !== index)
                    move(dragging, index);
                  setDragging(null);
                }}
              >
                <button
                  type="button"
                  className="poll-form__handle"
                  draggable
                  aria-label={t("pollMoveOption", { index: index + 1 })}
                  onDragStart={(event) => {
                    setDragging(index);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", String(index));
                  }}
                  onDragEnd={() => setDragging(null)}
                  onKeyDown={(event) => {
                    const to =
                      event.key === "ArrowUp"
                        ? index - 1
                        : event.key === "ArrowDown"
                          ? index + 1
                          : null;
                    if (to === null || to < 0 || to >= draft.options.length)
                      return;
                    event.preventDefault();
                    move(index, to);
                    requestAnimationFrame(() =>
                      document
                        .querySelectorAll<HTMLButtonElement>(
                          ".poll-form__handle",
                        )
                        [to]?.focus(),
                    );
                  }}
                >
                  <GripVertical aria-hidden="true" />
                </button>
                <input
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  className="request-input"
                  value={value}
                  maxLength={pollLimits.optionMaxLength + 20}
                  placeholder={t("pollOptionPlaceholder", { index: index + 1 })}
                  aria-label={t("pollOptionPlaceholder", { index: index + 1 })}
                  aria-invalid={badOption === index ? true : undefined}
                  onChange={(event) =>
                    update({
                      ...draft,
                      options: draft.options.map((item, at) =>
                        at === index ? event.target.value : item,
                      ),
                    })
                  }
                  onKeyDown={(event) => {
                    // Enter on the last filled row adds the next one.
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    if (
                      index === draft.options.length - 1 &&
                      canAddPollOption(draft)
                    ) {
                      focusOption.current = index + 1;
                      update(strip(addPollOption(withDue(draft))));
                    } else optionRefs.current[index + 1]?.focus();
                  }}
                />
                {draft.options.length > pollLimits.optionsMin && (
                  <IconButton
                    size="icon-sm"
                    label={t("pollRemoveOption", { index: index + 1 })}
                    onClick={() =>
                      update(strip(removePollOption(withDue(draft), index)))
                    }
                  >
                    <X />
                  </IconButton>
                )}
              </li>
            ))}
          </ol>
          {canAddPollOption(draft) && (
            <Button
              variant="ghost"
              size="sm"
              className="request-form__add"
              onClick={() => {
                focusOption.current = draft.options.length;
                update(strip(addPollOption(withDue(draft))));
              }}
            >
              <Plus aria-hidden="true" />
              {t("pollAddOption")}
            </Button>
          )}
        </section>

        <section className="request-form__section">
          <span className="request-form__label">{t("pollSettingsLabel")}</span>
          <div className="request-form__toggle">
            <span>
              <strong>{t("pollMultiple")}</strong>
              <small>{t("pollMultipleHint")}</small>
            </span>
            <Switch
              checked={draft.multiple}
              onChange={(multiple) => update({ ...draft, multiple })}
              label={t("pollMultiple")}
            />
          </div>
          <div className="request-form__toggle">
            <span>
              <strong>{t("pollAnonymous")}</strong>
              <small>{t("pollAnonymousHint")}</small>
            </span>
            <Switch
              checked={draft.anonymous}
              onChange={(anonymous) => update({ ...draft, anonymous })}
              label={t("pollAnonymous")}
            />
          </div>
        </section>

        <section className="request-form__section">
          <span className="request-form__label">{t("pollDueLabel")}</span>
          <div
            className="request-form__chips"
            role="radiogroup"
            aria-label={t("pollDueLabel")}
          >
            <Chip
              role="radio"
              aria-checked={due === "none"}
              active={due === "none"}
              onClick={() => {
                setDue("none");
                setError("");
              }}
            >
              {t("pollDueNone")}
            </Chip>
            {presets.map((preset) => (
              <Chip
                key={preset.id}
                role="radio"
                aria-checked={due === preset.id}
                active={due === preset.id}
                onClick={() => {
                  setDue(preset.id);
                  setError("");
                }}
              >
                {t(pollDuePresetLabelKeys[preset.id], {
                  when: formatPollDue(preset.at, opened, locale),
                })}
              </Chip>
            ))}
            <Chip
              role="radio"
              aria-checked={due === "custom"}
              active={due === "custom"}
              onClick={() => {
                setDue("custom");
                setError("");
              }}
            >
              {t("pollDueOther")}
            </Chip>
          </div>
          {due === "custom" && (
            <label className="request-form__field request-form__date">
              <span className="request-form__label">
                {t("pollDueCustomLabel")}
              </span>
              <input
                type="datetime-local"
                className="request-input"
                value={customDue}
                min={toLocalInputValue(
                  new Date(opened.getTime() + pollLimits.dueMinLeadMs),
                )}
                max={toLocalInputValue(
                  new Date(opened.getTime() + pollLimits.dueHorizonMs - 60_000),
                )}
                step={60}
                aria-invalid={
                  touched && problem?.field === "dueAt" ? true : undefined
                }
                onChange={(event) => {
                  setCustomDue(event.target.value);
                  setError("");
                }}
              />
            </label>
          )}
        </section>
        {shown && <FormError message={shown} />}
        {error && <FormError message={error} />}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
