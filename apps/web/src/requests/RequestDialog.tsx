import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  autoRemindAt,
  autoRemindAvailable,
  departmentCount,
  departmentPath,
  expandDepartment,
  expandPosition,
  orgIndex,
  emptyRequestDraft,
  formatRequestDue,
  fromLocalInputValue,
  requestAnswerPresets,
  requestCustomOptions,
  requestDraftProblem,
  requestDuePresets,
  requestLimits,
  requestOptionLabels,
  requestPresetLabelKeys,
  requestRecipientIDs,
  requestSignature,
  toCreateRequestInput,
  toLocalInputValue,
  type ChatMember,
  type Message,
  type OrgStructure,
  type RequestAudienceSegment,
  type RequestDraft,
  type RequestDraftAudience,
  type RequestDraftProblem,
} from "@comamessenger/core";
import {
  Avatar,
  AvatarStack,
  Button,
  Chip,
  Dialog,
  FormError,
  IconButton,
  Segmented,
  Switch,
  cx,
} from "../ui";
import { calendarLocale, requestErrorText } from "./format";

type DueChoice = "none" | "today" | "tomorrow" | "friday" | "custom";

/** What the form remembers between openings, per reader and chat. */
type StoredDraft = Omit<RequestDraft, "dueAt"> & {
  due: DueChoice;
  customDue: string;
};

const draftKey = (userID: string, chatID: string) =>
  `coma-request-draft:${userID}:${chatID}`;

function readDraft(userID: string, chatID: string): StoredDraft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(userID, chatID));
    return raw ? (JSON.parse(raw) as StoredDraft) : null;
  } catch {
    return null;
  }
}

function problemText(
  problem: RequestDraftProblem,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  switch (problem.field) {
    case "body":
      return t("requestErrorBody");
    case "audience":
      return t(
        problem.reason === "empty"
          ? "requestErrorAudienceEmpty"
          : "requestErrorAudienceTooMany",
      );
    case "options": {
      const index = (problem.index ?? 0) + 1;
      if (problem.reason === "tooFew") return t("requestErrorOptionsTooFew");
      if (problem.reason === "tooMany") return t("requestErrorOptionsTooMany");
      if (problem.reason === "tooLong")
        return t("requestErrorOptionTooLong", { index });
      return t("requestErrorOptionDuplicate", { index });
    }
    case "dueAt":
      return t(
        problem.reason === "past"
          ? "requestErrorDuePast"
          : "requestErrorDueTooFar",
      );
  }
}

/**
 * Request: asks chosen people of the chat for a one-tap answer. Who (the
 * whole chat or people), what answer (a ready-made type or 2–4 own
 * buttons), a due date and the automatic reminder. The form keeps its draft
 * for the session until the request is sent.
 */
export function RequestDialog({
  chatID,
  userID,
  members,
  createRequest,
  onSent,
  onClose,
  segments = ["chat", "people"],
  structure = null,
}: {
  chatID: string;
  userID: string;
  members: ChatMember[];
  /**
   * "To": the whole chat and people, plus a department and a position for those
   * who may address groups on org_structure servers (audienceSegments).
   */
  segments?: readonly RequestAudienceSegment[];
  /** The org structure for the department and position segments. */
  structure?: OrgStructure | null;
  createRequest(chatID: string, input: ReturnType<typeof toCreateRequestInput>): Promise<Message>;
  onSent(message: Message): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const locale = calendarLocale();
  const [opened] = useState(() => new Date());
  const duePresets = useMemo(() => requestDuePresets(opened), [opened]);
  const stored = useMemo(() => readDraft(userID, chatID), [userID, chatID]);
  const [draft, setDraft] = useState<Omit<RequestDraft, "dueAt">>(() => {
    if (!stored) {
      const { dueAt: _ignored, ...rest } = emptyRequestDraft();
      return rest;
    }
    const { due: _due, customDue: _custom, ...rest } = stored;
    return rest;
  });
  const [due, setDue] = useState<DueChoice>(() => {
    const value = stored?.due ?? "none";
    return value === "none" ||
      value === "custom" ||
      duePresets.some((preset) => preset.id === value)
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
  // A retry of the same request reuses its id: the server returns the
  // message it already made instead of a second one.
  const sent = useRef<{ signature: string; id: string } | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        draftKey(userID, chatID),
        JSON.stringify({ ...draft, due, customDue } satisfies StoredDraft),
      );
    } catch {
      // Private mode: the draft lives as long as the dialog.
    }
  }, [chatID, customDue, draft, due, userID]);

  const people = members.filter(
    (member) => member.type === "user" && member.actor_id !== userID,
  );
  // A stored draft may name a segment this reader no longer has.
  const audience: RequestDraftAudience = segments.includes(draft.audience.kind)
    ? draft.audience
    : { kind: "chat" };
  const recipients = requestRecipientIDs(audience, members, userID, structure);
  const chatPeopleIDs = people.map((member) => member.actor_id);
  const index = structure ? orgIndex(structure) : null;
  const dueAt =
    due === "none"
      ? null
      : due === "custom"
        ? fromLocalInputValue(customDue)
        : (duePresets.find((preset) => preset.id === due)?.at ?? null);
  const now = new Date();
  const full: RequestDraft = { ...draft, audience, dueAt };
  const problem =
    due === "custom" && !dueAt
      ? ({ field: "dueAt", reason: "past" } as const)
      : requestDraftProblem(full, now, recipients.length);
  const autoAvailable = autoRemindAvailable(dueAt, now);
  const options = requestOptionLabels(
    {
      answer:
        draft.preset === "custom"
          ? { preset: "custom", options: requestCustomOptions(draft) }
          : { preset: draft.preset },
    },
    t,
  );

  function update(patch: Partial<Omit<RequestDraft, "dueAt">>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError("");
  }

  async function submit() {
    setTouched(true);
    if (problem) {
      if (problem.field === "body") bodyRef.current?.focus();
      return;
    }
    const at = new Date();
    const probe = toCreateRequestInput(full, "", at);
    const signature = requestSignature(probe);
    if (sent.current?.signature !== signature)
      sent.current = { signature, id: crypto.randomUUID() };
    setPending(true);
    setError("");
    try {
      const message = await createRequest(
        chatID,
        toCreateRequestInput(full, sent.current.id, at),
      );
      try {
        sessionStorage.removeItem(draftKey(userID, chatID));
      } catch {
        // Nothing stored.
      }
      onSent(message);
    } catch (cause) {
      setError(requestErrorText(cause));
    } finally {
      setPending(false);
    }
  }

  const shown = touched && problem ? problemText(problem, t) : "";
  const dueLabel = (id: DueChoice, at?: Date) =>
    id === "friday" && at
      ? t("requestDueBy", { when: formatRequestDue(at, opened, locale) })
      : at
        ? formatRequestDue(at, opened, locale)
        : "";

  return (
    <Dialog
      title={t("requestDialogTitle")}
      onClose={onClose}
      sheet
      className="request-dialog"
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
            {recipients.length
              ? t("requestSend", { count: recipients.length })
              : t("requestSendEmpty")}
          </Button>
        </>
      }
    >
      <form
        className="request-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="request-form__field">
          <span className="request-form__label">{t("requestBodyLabel")}</span>
          <textarea
            ref={bodyRef}
            className="request-form__body"
            rows={3}
            maxLength={4000}
            value={draft.body}
            placeholder={t("requestBodyPlaceholder")}
            aria-invalid={
              touched && problem?.field === "body" ? true : undefined
            }
            onChange={(event) => update({ body: event.target.value })}
          />
        </label>

        <section className="request-form__section">
          <span className="request-form__label" id={`${chatID}-audience`}>
            {t("requestAudienceLabel")}
          </span>
          <Segmented
            label={t("requestAudienceLabel")}
            value={audience.kind}
            onChange={(kind) =>
              update({
                audience:
                  kind === "chat"
                    ? { kind: "chat" }
                    : kind === "people"
                      ? {
                          kind: "people",
                          actorIDs:
                            audience.kind === "people" ? audience.actorIDs : [],
                        }
                      : kind === "department"
                        ? {
                            kind: "department",
                            departmentID:
                              audience.kind === "department"
                                ? audience.departmentID
                                : (index?.order[0]?.id ?? ""),
                          }
                        : {
                            kind: "position",
                            positionID:
                              audience.kind === "position"
                                ? audience.positionID
                                : (index?.positionOrder[0]?.id ?? ""),
                          },
              })
            }
            items={segments.map((id) => ({
              id,
              label: t(
                {
                  chat: "requestAudienceChat",
                  people: "requestAudiencePeople",
                  department: "requestAudienceDepartment",
                  position: "requestAudiencePosition",
                }[id],
              ),
            }))}
          />
          {audience.kind === "department" && index ? (
            <div
              className="request-form__groups"
              role="radiogroup"
              aria-label={t("requestAudienceDepartment")}
            >
              {index.order.map((department) => {
                const inChat = expandDepartment(structure!, department.id, {
                  chatMemberIDs: chatPeopleIDs,
                  excludeActorID: userID,
                }).inChat.length;
                const path = departmentPath(structure!, department.id, {
                  includeSelf: false,
                });
                return (
                  <button
                    key={department.id}
                    type="button"
                    role="radio"
                    aria-checked={audience.departmentID === department.id}
                    className="request-form__group"
                    onClick={() =>
                      update({
                        audience: {
                          kind: "department",
                          departmentID: department.id,
                        },
                      })
                    }
                  >
                    <strong>{department.name}</strong>
                    <small>
                      {[
                        path,
                        t("requestDepartmentMeta", {
                          count: departmentCount(structure!, department.id),
                        }),
                        t("requestInChat", { count: inChat }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </button>
                );
              })}
            </div>
          ) : audience.kind === "position" && index ? (
            <div
              className="request-form__groups"
              role="radiogroup"
              aria-label={t("requestAudiencePosition")}
            >
              {index.positionOrder.map((position) => (
                <button
                  key={position.id}
                  type="button"
                  role="radio"
                  aria-checked={audience.positionID === position.id}
                  className="request-form__group"
                  onClick={() =>
                    update({
                      audience: { kind: "position", positionID: position.id },
                    })
                  }
                >
                  <strong>{position.name}</strong>
                  <small>
                    {t("requestInChat", {
                      count: expandPosition(structure!, position.id, {
                        chatMemberIDs: chatPeopleIDs,
                        excludeActorID: userID,
                      }).inChat.length,
                    })}
                  </small>
                </button>
              ))}
            </div>
          ) : audience.kind === "people" ? (
            people.length ? (
              <div
                className="request-form__chips"
                role="group"
                aria-label={t("requestAudiencePeople")}
              >
                {people.map((member) => {
                  const chosen =
                    audience.kind === "people" &&
                    audience.actorIDs.includes(member.actor_id);
                  return (
                    <Chip
                      key={member.actor_id}
                      active={chosen}
                      onClick={() => {
                        if (audience.kind !== "people") return;
                        const ids = audience.actorIDs;
                        update({
                          audience: {
                            kind: "people",
                            actorIDs: chosen
                              ? ids.filter((id) => id !== member.actor_id)
                              : [...ids, member.actor_id],
                          },
                        });
                      }}
                    >
                      {member.display_name}
                    </Chip>
                  );
                })}
              </div>
            ) : (
              <p className="request-form__hint">{t("requestAudienceNobody")}</p>
            )
          ) : (
            <p className="request-form__hint">
              {people.length
                ? t("requestAudienceChatHint")
                : t("requestAudienceNobody")}
            </p>
          )}
          {recipients.length > 0 && (
            <div className="request-form__who">
              <AvatarStack>
                {recipients.slice(0, 5).map((id) => {
                  const member = members.find((item) => item.actor_id === id);
                  return (
                    <Avatar
                      key={id}
                      name={member?.display_name ?? ""}
                      seed={id}
                      actorID={id}
                      avatarVersion={member?.avatar_version}
                      size="xs"
                    />
                  );
                })}
              </AvatarStack>
              <span>{t("requestWho", { count: recipients.length })}</span>
            </div>
          )}
        </section>

        <section className="request-form__section">
          <span className="request-form__label">{t("requestAnswerLabel")}</span>
          <div
            className="request-form__chips"
            role="radiogroup"
            aria-label={t("requestAnswerLabel")}
          >
            {requestAnswerPresets.map((preset) => (
              <Chip
                key={preset}
                role="radio"
                aria-checked={draft.preset === preset}
                active={draft.preset === preset}
                onClick={() => update({ preset })}
              >
                {t(requestPresetLabelKeys[preset])}
              </Chip>
            ))}
          </div>
          {draft.preset === "custom" && (
            <div className="request-form__options">
              {draft.customOptions.map((value, index) => (
                <div className="request-form__option" key={index}>
                  <input
                    className="request-input"
                    value={value}
                    maxLength={requestLimits.customOptionMaxLength + 8}
                    placeholder={t("requestCustomOption", { index: index + 1 })}
                    aria-label={t("requestCustomOption", { index: index + 1 })}
                    onChange={(event) =>
                      update({
                        customOptions: draft.customOptions.map((item, at) =>
                          at === index ? event.target.value : item,
                        ),
                      })
                    }
                  />
                  {draft.customOptions.length > requestLimits.customOptionsMin && (
                    <IconButton
                      size="icon-sm"
                      label={t("requestRemoveOption", { index: index + 1 })}
                      onClick={() =>
                        update({
                          customOptions: draft.customOptions.filter(
                            (_item, at) => at !== index,
                          ),
                        })
                      }
                    >
                      <X />
                    </IconButton>
                  )}
                </div>
              ))}
              {draft.customOptions.length < requestLimits.customOptionsMax && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="request-form__add"
                  onClick={() =>
                    update({ customOptions: [...draft.customOptions, ""] })
                  }
                >
                  <Plus aria-hidden="true" />
                  {t("requestAddOption")}
                </Button>
              )}
            </div>
          )}
          {options.length > 0 && (
            <div className="request-form__preview">
              <div
                className={cx(
                  "request-buttons",
                  options.length === 1 && "request-buttons--single",
                )}
                aria-hidden="true"
              >
                {options.map((label, index) => (
                  <span
                    key={`${index}-${label}`}
                    className={cx(
                      "request-button",
                      index === 0 && "request-button--primary",
                    )}
                  >
                    {label}
                  </span>
                ))}
              </div>
              <small>{t("requestPreview")}</small>
            </div>
          )}
          <div className="request-form__toggle">
            <span>
              <strong>{t("requestAllowComment")}</strong>
              <small>{t("requestAllowCommentHint")}</small>
            </span>
            <Switch
              checked={draft.allowComment}
              onChange={(allowComment) => update({ allowComment })}
              label={t("requestAllowComment")}
            />
          </div>
        </section>

        <section className="request-form__section">
          <span className="request-form__label">{t("requestDueLabel")}</span>
          <div
            className="request-form__chips"
            role="radiogroup"
            aria-label={t("requestDueLabel")}
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
              {t("requestDueNone")}
            </Chip>
            {duePresets.map((preset) => (
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
                {dueLabel(preset.id, preset.at)}
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
              {t("requestDueOther")}
            </Chip>
          </div>
          {due === "custom" && (
            <label className="request-form__field request-form__date">
              <span className="request-form__label">
                {t("requestDueCustomLabel")}
              </span>
              <input
                type="datetime-local"
                className="request-input"
                value={customDue}
                min={toLocalInputValue(
                  new Date(opened.getTime() + requestLimits.dueMinLeadMs),
                )}
                max={toLocalInputValue(
                  new Date(
                    opened.getTime() + requestLimits.dueHorizonMs - 60_000,
                  ),
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
          <div
            className={cx(
              "request-form__toggle",
              !autoAvailable && "request-form__toggle--disabled",
            )}
          >
            <span>
              <strong>{t("requestAutoRemind")}</strong>
              <small>
                {autoAvailable && dueAt
                  ? t("requestAutoRemindHint", {
                      when: formatRequestDue(
                        autoRemindAt(now, dueAt),
                        now,
                        locale,
                      ),
                    })
                  : t("requestAutoRemindNeedsDue")}
              </small>
            </span>
            <Switch
              checked={draft.autoRemind && autoAvailable}
              disabled={!autoAvailable}
              onChange={(autoRemind) => update({ autoRemind })}
              label={t("requestAutoRemind")}
            />
          </div>
        </section>
        {shown && <FormError message={shown} />}
        {error && <FormError message={error} />}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
