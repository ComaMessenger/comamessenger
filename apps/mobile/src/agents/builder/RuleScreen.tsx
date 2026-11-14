import { useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  chatName,
  draftChatIDs,
  emptyRule,
  knownEvents,
  ruleFromTrigger,
  ruleProblem,
  timezoneOptions,
  triggerRequest,
  triggerTypes,
  weekDays,
  workDays,
  type RuleForm,
  type TriggerType,
} from "@comamessenger/core";
import { messageOf } from "@/lib/errors";
import { useSignedIn } from "@/session/SessionProvider";
import { SettingsScreen } from "@/settings/SettingsScreen";
import { TimeRow } from "@/settings/PickerRows";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { PickerSheet } from "@/ui/PickerSheet";
import { Divider, GroupBody, NavRow, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { useAgentBuilder } from "./AgentBuilderProvider";
import { Chip, ChipRow } from "./controls";
import { useWebhooks } from "./steps/TriggersStep";

type Picker = "" | "chat" | "event" | "webhook" | "timezone";

/**
 * One launch rule: the subject of its type as a form, never a raw
 * configuration. Saving stores it on the server at once and returns to the
 * step of rules.
 */
export function RuleScreen() {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const builder = useAgentBuilder();
  const { agent, chats, timezone, triggers, draft } = builder;
  const params = useLocalSearchParams<{ triggerId?: string; type?: string }>();
  const original = triggers.data?.find((item) => item.id === params.triggerId);
  const type = (
    triggerTypes.includes(params.type as TriggerType) ? params.type : "mention"
  ) as TriggerType;
  const chatIDs = draftChatIDs(draft);
  const agentChats = chats.filter((chat) => chatIDs.includes(chat.id));
  const [form, setForm] = useState<RuleForm | null>(() =>
    params.triggerId ? null : emptyRule(type, { chatID: chatIDs[0], timezone }),
  );
  useEffect(() => {
    if (!form && original) setForm(ruleFromTrigger(original));
  }, [form, original]);
  const [picker, setPicker] = useState<Picker>("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const webhooks = useWebhooks();
  const released = (webhooks.data ?? []).filter(
    (hook) => hook.agent_use_allowed,
  );

  if (!form)
    return (
      <SettingsScreen
        title={t("agentRuleTitle")}
        query={triggers}
        testID="agent-rule-screen"
      >
        <Notice title={t("agentRuleMissing")} />
      </SettingsScreen>
    );

  const set = (patch: Partial<RuleForm>) =>
    setForm((current) => (current ? { ...current, ...patch } : current));
  const chosenChat = agentChats.find((chat) => chat.id === form.chatID);
  const chatOptions = [
    ...(form.type === "event"
      ? [{ value: "", label: t("agentRuleAnyChat") }]
      : []),
    ...agentChats.map((chat) => ({ value: chat.id, label: chatName(chat) })),
  ];

  async function save() {
    if (!form) return;
    const problem = ruleProblem(form);
    if (problem) {
      setError(t(problem));
      return;
    }
    setPending(true);
    setError("");
    try {
      const request = triggerRequest(form);
      if (original && original.type === request.type)
        await api.updateAgentTrigger(agent.id, original.id, {
          config: request.config,
          timezone: request.timezone,
        });
      else await api.createAgentTrigger(agent.id, request);
      await triggers.refetch();
      router.back();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsScreen
      title={t(`agentRuleType_${form.type}`)}
      subtitle={agent.display_name}
      testID="agent-rule-screen"
    >
      <Text tone="muted" size={14.5}>
        {t(`agentRuleTypeHint_${form.type}`)}
      </Text>
      {form.type === "command" ? (
        <SettingsGroup>
          <GroupBody>
            <TextField
              testID="agent-rule-command"
              label={t("agentRuleCommand")}
              value={form.command}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t("agentRuleCommandPlaceholder")}
              onChangeText={(value) =>
                set({ command: value.replace(/^\/+/, "") })
              }
            />
          </GroupBody>
        </SettingsGroup>
      ) : null}
      {form.type === "keyword" ? (
        <SettingsGroup>
          <GroupBody>
            <TextField
              testID="agent-rule-keywords"
              label={t("agentRuleKeywords")}
              value={form.keywords}
              hint={t("agentRuleKeywordsHint")}
              placeholder={t("agentRuleKeywordsPlaceholder")}
              onChangeText={(keywords) => set({ keywords })}
            />
          </GroupBody>
        </SettingsGroup>
      ) : null}
      {form.type === "event" ? (
        <SettingsGroup>
          <NavRow
            label={t("agentRuleEvent")}
            value={
              (knownEvents as readonly string[]).includes(form.eventType)
                ? t(`agentEventOption_${form.eventType.replace(".", "_")}`)
                : t("agentEvent_other")
            }
            onPress={() => setPicker("event")}
          />
          <Divider />
          <NavRow
            label={t("agentRuleEventChat")}
            value={chosenChat ? chatName(chosenChat) : t("agentRuleAnyChat")}
            onPress={() => setPicker("chat")}
          />
        </SettingsGroup>
      ) : null}
      {form.type === "schedule" ? (
        <>
          <SettingsGroup>
            <TimeRow
              testID="agent-rule-time"
              label={t("agentRuleTime")}
              value={form.time}
              onChange={(time) => set({ time })}
            />
            <Divider />
            <NavRow
              testID="agent-rule-chat"
              label={t("agentRuleScheduleChat")}
              value={chosenChat ? chatName(chosenChat) : t("agentChooseChat")}
              onPress={() => setPicker("chat")}
            />
            <Divider />
            <NavRow
              label={t("agentRuleTimezone")}
              value={form.timezone}
              onPress={() => setPicker("timezone")}
            />
          </SettingsGroup>
          <SettingsGroup title={t("agentRuleDays")}>
            <GroupBody>
              <ChipRow>
                <Chip
                  label={t("agentRuleEveryDay")}
                  selected={form.days.length === 0}
                  onPress={() => set({ days: [] })}
                />
                <Chip
                  label={t("agentRuleWorkDays")}
                  selected={
                    form.days.length === workDays.length &&
                    workDays.every((day) => form.days.includes(day))
                  }
                  onPress={() => set({ days: [...workDays] })}
                />
                {weekDays.map((day) => (
                  <Chip
                    key={day}
                    label={t(`agentWeekdayShort_${day}`)}
                    accessibilityLabel={t(`agentWeekday_${day}`)}
                    selected={form.days.includes(day)}
                    onPress={() =>
                      set({
                        days: form.days.includes(day)
                          ? form.days.filter((item) => item !== day)
                          : [...form.days, day],
                      })
                    }
                  />
                ))}
              </ChipRow>
            </GroupBody>
          </SettingsGroup>
        </>
      ) : null}
      {form.type === "webhook" ? (
        <>
          <SettingsGroup>
            <NavRow
              label={t("agentRuleWebhook")}
              value={
                released.find((hook) => hook.id === form.webhookID)?.name ??
                t("agentRuleWebhookChoose")
              }
              onPress={() => setPicker("webhook")}
            />
            <Divider />
            <NavRow
              label={t("agentRuleScheduleChat")}
              value={chosenChat ? chatName(chosenChat) : t("agentChooseChat")}
              onPress={() => setPicker("chat")}
            />
          </SettingsGroup>
          <SettingsGroup>
            <GroupBody>
              <TextField
                label={t("agentRuleWebhookEvents")}
                value={form.webhookEvents}
                autoCapitalize="none"
                autoCorrect={false}
                hint={t("agentRuleWebhookEventsHint")}
                placeholder={t("agentRuleWebhookEventsPlaceholder")}
                onChangeText={(webhookEvents) => set({ webhookEvents })}
              />
            </GroupBody>
          </SettingsGroup>
        </>
      ) : null}
      {form.type === "every_message" ? (
        <Notice tone="neutral" title={t("agentRuleEveryMessageWarning")} />
      ) : null}
      {(form.type === "schedule" || form.type === "webhook") &&
      agentChats.length === 0 ? (
        <Notice tone="neutral" title={t("agentRuleNeedsChat")} />
      ) : null}
      {error ? <Notice title={error} /> : null}
      <Button
        testID="agent-rule-save"
        label={t("agentRuleSave")}
        pending={pending}
        onPress={() => void save()}
      />

      <PickerSheet
        visible={picker === "chat"}
        title={t("agentChooseChat")}
        value={form.chatID}
        options={chatOptions}
        onSelect={(chatID) => set({ chatID })}
        onClose={() => setPicker("")}
        testID="agent-rule-chat-picker"
      />
      <PickerSheet
        visible={picker === "event"}
        title={t("agentRuleEvent")}
        value={form.eventType}
        options={[
          ...knownEvents.map((kind) => ({
            value: kind as string,
            label: t(`agentEventOption_${kind.replace(".", "_")}`),
          })),
          ...((knownEvents as readonly string[]).includes(form.eventType)
            ? []
            : [{ value: form.eventType, label: t("agentEvent_other") }]),
        ]}
        onSelect={(eventType) => set({ eventType })}
        onClose={() => setPicker("")}
      />
      <PickerSheet
        visible={picker === "webhook"}
        title={t("agentRuleWebhook")}
        value={form.webhookID}
        options={released.map((hook) => ({ value: hook.id, label: hook.name }))}
        onSelect={(webhookID) => set({ webhookID })}
        onClose={() => setPicker("")}
      />
      <PickerSheet
        visible={picker === "timezone"}
        title={t("agentRuleTimezone")}
        value={form.timezone}
        options={timezoneOptions(form.timezone).map((zone) => ({
          value: zone,
          label: zone,
        }))}
        onSelect={(zone) => set({ timezone: zone })}
        onClose={() => setPicker("")}
      />
    </SettingsScreen>
  );
}
