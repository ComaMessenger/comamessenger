import { useState } from "react";
import type {
  Agent,
  AgentTrigger,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import {
  Button,
  Chip,
  Field,
  FormError,
  IconButton,
  SelectField,
  Skeleton,
  Switch,
} from "../../ui";
import { chatName } from "../shared/format";
import {
  describeRule,
  emptyRule,
  knownEvents,
  ruleFromTrigger,
  ruleProblem,
  triggerRequest,
  triggerTypes,
  weekDays,
  workDays,
  type RuleForm,
  type TriggerType,
} from "../shared/triggers";
import { BuilderBlock } from "./BuilderBlock";

/**
 * Block 4: launch rules read as sentences. Rules are stored by the server
 * immediately, separately from the draft, as in phase 5.2.
 */
export function TriggersBlock({
  api,
  agent,
  chats,
  chatIDs,
  triggers,
  timezone,
}: {
  api: MessengerAPI;
  agent: Agent;
  chats: Chat[];
  /** Chats of the current draft; rules may only point to them. */
  chatIDs: string[];
  triggers: UseQueryResult<AgentTrigger[]>;
  timezone: string;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{
    id: string | null;
    form: RuleForm;
  } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const agentChats = chats.filter((chat) => chatIDs.includes(chat.id));

  async function act(work: () => Promise<unknown>) {
    setPending(true);
    setError("");
    try {
      await work();
      await triggers.refetch();
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setPending(false);
    }
  }

  function start(type: TriggerType) {
    setChoosing(false);
    setEditing({
      id: null,
      form: emptyRule(type, { chatID: chatIDs[0], timezone }),
    });
  }

  async function save() {
    if (!editing) return;
    const problem = ruleProblem(editing.form);
    if (problem) {
      setError(t(problem));
      return;
    }
    const request = triggerRequest(editing.form);
    const original = triggers.data?.find((item) => item.id === editing.id);
    const done = await act(async () => {
      if (original && original.type === request.type)
        await api.updateAgentTrigger(agent.id, original.id, {
          config: request.config,
          timezone: request.timezone,
        });
      else await api.createAgentTrigger(agent.id, request);
    });
    if (done) setEditing(null);
  }

  return (
    <BuilderBlock
      anchor="triggers"
      marker="4"
      title={t("agentBlockTriggers")}
      hint={t("agentBlockTriggersHint")}
    >
      {triggers.isLoading ? (
        <Skeleton />
      ) : (
        <div className="agent-rules">
          {(triggers.data ?? []).length === 0 && !editing && (
            <p className="agent-block__empty">{t("agentRulesEmpty")}</p>
          )}
          {(triggers.data ?? []).map((trigger) =>
            editing?.id === trigger.id ? (
              <RuleEditor
                key={trigger.id}
                form={editing.form}
                chats={agentChats}
                pending={pending}
                onChange={(form) => setEditing({ id: trigger.id, form })}
                onSave={() => void save()}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <RuleRow
                key={trigger.id}
                trigger={trigger}
                chats={chats}
                timezone={timezone}
                disabled={pending}
                onToggle={(enabled) =>
                  void act(() =>
                    api.updateAgentTrigger(agent.id, trigger.id, { enabled }),
                  )
                }
                onEdit={() =>
                  setEditing({ id: trigger.id, form: ruleFromTrigger(trigger) })
                }
                onDelete={() =>
                  void act(() => api.deleteAgentTrigger(agent.id, trigger.id))
                }
              />
            ),
          )}
          {editing?.id === null && (
            <RuleEditor
              form={editing.form}
              chats={agentChats}
              pending={pending}
              onChange={(form) => setEditing({ id: null, form })}
              onSave={() => void save()}
              onCancel={() => setEditing(null)}
            />
          )}
        </div>
      )}
      <FormError message={error} />
      {!editing &&
        (choosing ? (
          <div
            className="agent-rule-types"
            role="group"
            aria-label={t("agentRuleChoose")}
          >
            <span>{t("agentRuleChoose")}</span>
            <div className="agent-chips">
              {triggerTypes.map((type) => (
                <Chip key={type} onClick={() => start(type)}>
                  {t(`agentRuleType_${type}`)}
                </Chip>
              ))}
            </div>
          </div>
        ) : (
          <Button size="sm" onClick={() => setChoosing(true)}>
            <Plus />
            {t("agentRuleAdd")}
          </Button>
        ))}
    </BuilderBlock>
  );
}

function RuleRow({
  trigger,
  chats,
  timezone,
  disabled,
  onToggle,
  onEdit,
  onDelete,
}: {
  trigger: AgentTrigger;
  chats: Chat[];
  timezone: string;
  disabled: boolean;
  onToggle(enabled: boolean): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const { t } = useTranslation();
  const sentence = describeRule(t, trigger, chats, timezone);
  return (
    <div className="agent-rule" data-enabled={trigger.enabled}>
      <p className="agent-rule__sentence">
        <span>{sentence.when}</span>
        {sentence.then && (
          <>
            <ArrowRight aria-hidden="true" />
            <span>{sentence.then}</span>
          </>
        )}
      </p>
      <span className="agent-rule__actions">
        {trigger.type !== "mention" &&
          trigger.type !== "every_message" &&
          trigger.type !== "manual" && (
            <IconButton
              size="icon-sm"
              label={t("agentRuleEdit")}
              disabled={disabled}
              onClick={onEdit}
            >
              <Pencil />
            </IconButton>
          )}
        <IconButton
          size="icon-sm"
          label={t("agentRuleDelete")}
          disabled={disabled}
          onClick={onDelete}
        >
          <Trash2 />
        </IconButton>
        <Switch
          label={t("agentRuleEnabled", { rule: sentence.when })}
          checked={trigger.enabled}
          disabled={disabled}
          onChange={onToggle}
        />
      </span>
    </div>
  );
}

function RuleEditor({
  form,
  chats,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  form: RuleForm;
  chats: Chat[];
  pending: boolean;
  onChange(form: RuleForm): void;
  onSave(): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<RuleForm>) => onChange({ ...form, ...patch });
  const zones = timezoneOptions(form.timezone);
  return (
    <form
      className="agent-rule-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <strong>{t(`agentRuleType_${form.type}`)}</strong>
      <p>{t(`agentRuleTypeHint_${form.type}`)}</p>
      {form.type === "command" && (
        <Field
          label={t("agentRuleCommand")}
          name="agent-rule-command"
          prefix="/"
          value={form.command}
          placeholder={t("agentRuleCommandPlaceholder")}
          onChange={(event) =>
            set({ command: event.target.value.replace(/^\/+/, "") })
          }
        />
      )}
      {form.type === "keyword" && (
        <Field
          label={t("agentRuleKeywords")}
          name="agent-rule-keywords"
          value={form.keywords}
          hint={t("agentRuleKeywordsHint")}
          placeholder={t("agentRuleKeywordsPlaceholder")}
          onChange={(event) => set({ keywords: event.target.value })}
        />
      )}
      {form.type === "event" && (
        <div className="agent-form-row">
          <SelectField
            label={t("agentRuleEvent")}
            name="agent-rule-event"
            value={form.eventType}
            onChange={(event) => set({ eventType: event.target.value })}
          >
            {knownEvents.map((kind) => (
              <option key={kind} value={kind}>
                {t(`agentEventOption_${kind.replace(".", "_")}`)}
              </option>
            ))}
            {!(knownEvents as readonly string[]).includes(form.eventType) && (
              <option value={form.eventType}>{t("agentEvent_other")}</option>
            )}
          </SelectField>
          <SelectField
            required={false}
            label={t("agentRuleEventChat")}
            name="agent-rule-event-chat"
            value={form.chatID}
            onChange={(event) => set({ chatID: event.target.value })}
          >
            <option value="">{t("agentRuleAnyChat")}</option>
            {chats.map((chat) => (
              <option key={chat.id} value={chat.id}>
                {chatName(chat)}
              </option>
            ))}
          </SelectField>
        </div>
      )}
      {form.type === "schedule" && (
        <>
          <div className="agent-form-row">
            <Field
              type="time"
              label={t("agentRuleTime")}
              name="agent-rule-time"
              value={form.time}
              onChange={(event) => set({ time: event.target.value })}
            />
            <SelectField
              label={t("agentRuleScheduleChat")}
              name="agent-rule-schedule-chat"
              value={form.chatID}
              onChange={(event) => set({ chatID: event.target.value })}
            >
              <option value="">{t("agentChooseChat")}</option>
              {chats.map((chat) => (
                <option key={chat.id} value={chat.id}>
                  {chatName(chat)}
                </option>
              ))}
            </SelectField>
          </div>
          <div
            className="agent-days"
            role="group"
            aria-label={t("agentRuleDays")}
          >
            <span>{t("agentRuleDays")}</span>
            <div className="agent-chips">
              <Chip
                active={form.days.length === 0}
                onClick={() => set({ days: [] })}
              >
                {t("agentRuleEveryDay")}
              </Chip>
              <Chip
                active={
                  form.days.length === workDays.length &&
                  workDays.every((day) => form.days.includes(day))
                }
                onClick={() => set({ days: [...workDays] })}
              >
                {t("agentRuleWorkDays")}
              </Chip>
              {weekDays.map((day) => (
                <Chip
                  key={day}
                  active={form.days.includes(day)}
                  aria-label={t(`agentWeekday_${day}`)}
                  onClick={() =>
                    set({
                      days: form.days.includes(day)
                        ? form.days.filter((item) => item !== day)
                        : [...form.days, day],
                    })
                  }
                >
                  {t(`agentWeekdayShort_${day}`)}
                </Chip>
              ))}
            </div>
          </div>
          <SelectField
            label={t("agentRuleTimezone")}
            name="agent-rule-timezone"
            value={form.timezone}
            onChange={(event) => set({ timezone: event.target.value })}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </SelectField>
        </>
      )}
      {form.type === "every_message" && (
        <p className="agent-block__note">{t("agentRuleEveryMessageWarning")}</p>
      )}
      <div className="agent-rule-editor__actions">
        <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" variant="primary" size="sm" pending={pending}>
          {t("agentRuleSave")}
        </Button>
      </div>
    </form>
  );
}

function timezoneOptions(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  const zones = new Set([current, "UTC", ...supported]);
  return [...zones].filter(Boolean);
}
