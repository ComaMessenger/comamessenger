import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { CalendarDays, Plus, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  autoRemindAt,
  autoRemindAvailable,
  emptyRequestDraft,
  formatRequestDue,
  requestAnswerPresets,
  requestDraftProblem,
  requestDuePresets,
  requestLimits,
  requestOptionLabels,
  requestPresetLabelKeys,
  audienceSegments,
  requestRecipientIDs,
  toCreateRequestInput,
  type ChatMember,
  type RequestDraft,
  type RequestDraftAudience,
  type RequestDraftProblem,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { accountValues } from "@/lib/database";
import { useSignedIn } from "@/session/SessionProvider";
import { useMessenger } from "@/messenger/MessengerProvider";
import { Avatar } from "@/ui/Avatar";
import { AvatarStack } from "@/ui/AvatarStack";
import { BottomSheet } from "@/ui/BottomSheet";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import { useClock, useNow } from "@/scheduled/clock";
import { combine, formatDate, formatTime } from "@/scheduled/format";
import { RequestGroupChoice } from "@/org/RequestGroupChoice";
import { useOrg } from "@/org/useOrg";
import { calendarLocale } from "./locale";
import { sendRequest } from "./outbox";
import { useRequestErrorText } from "./useRequestActions";
import {
  AnswerButtons,
  Chip,
  SectionLabel,
  Segmented,
  ToggleRow,
  WideButton,
} from "./parts";

/** The form kept on the device until it is sent, per chat. */
type StoredDraft = Omit<RequestDraft, "dueAt"> & { dueAt: string | null };

const draftKey = (chatID: string) => `request_draft:${chatID}`;

function toStored(draft: RequestDraft): StoredDraft {
  return { ...draft, dueAt: draft.dueAt ? draft.dueAt.toISOString() : null };
}

function fromStored(value: StoredDraft | null): RequestDraft | null {
  if (!value || typeof value.body !== "string") return null;
  return {
    ...emptyRequestDraft(),
    ...value,
    dueAt: value.dueAt ? new Date(value.dueAt) : null,
  };
}

/** The draft is empty: nothing worth keeping. */
function blank(draft: RequestDraft) {
  return !draft.body.trim();
}

/** A department or position not chosen yet, or nobody of it in the chat. */
function groupProblemKey(audience: RequestDraftAudience): string | null {
  if (audience.kind === "department")
    return audience.departmentID
      ? "orgRequestNobody"
      : "orgRequestPickDepartment";
  if (audience.kind === "position")
    return audience.positionID ? "orgRequestNobody" : "orgRequestPickPosition";
  return null;
}

function problemKey(problem: RequestDraftProblem): string {
  switch (problem.field) {
    case "body":
      return "requestProblemBody";
    case "audience":
      return problem.reason === "tooMany"
        ? "requestProblemTooMany"
        : "requestProblemAudience";
    case "options":
      return {
        tooFew: "requestProblemOptionsFew",
        tooMany: "requestProblemOptionsMany",
        tooLong: "requestProblemOptionLong",
        duplicate: "requestProblemOptionDuplicate",
      }[problem.reason];
    case "dueAt":
      return problem.reason === "tooFar"
        ? "requestProblemDueFar"
        : "requestProblemDuePast";
  }
}

/**
 * «Запрос» from the «+» menu: the question, whom to ask (the whole chat or
 * chosen people; departments and positions come with wave 2), the kind of
 * answer with a preview, a due date and the reminder before it. Kept on the
 * device until sent; sending goes through the request queue, so a request
 * written offline goes once the network is back.
 */
export function RequestSheet({
  visible,
  chatID,
  members,
  audience,
  onClose,
  onNotice,
}: {
  visible: boolean;
  chatID: string;
  members: ChatMember[];
  /** Whom to ask, set by the opener (a department or a person card). */
  audience?: RequestDraftAudience;
  onClose(): void;
  onNotice(text: string): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const scheme = useColorScheme();
  const clock = useClock();
  const { api, user } = useSignedIn();
  const errorText = useRequestErrorText();
  const { store } = useMessenger();
  const locale = calendarLocale(i18n.language);
  const now = useNow(30_000, visible);
  const [draft, setDraft] = useState<RequestDraft>(emptyRequestDraft);
  const [customDue, setCustomDue] = useState(false);
  const [sending, setSending] = useState(false);
  const [tried, setTried] = useState(false);
  const loaded = useRef<string | null>(null);
  // Wave 2: «Отдел» and «Должность» with requests.address_groups.
  const org = useOrg();
  const segments = audienceSegments(user, org.features, org.structure);

  // The form of this chat comes back as it was left.
  useEffect(() => {
    if (!visible || loaded.current === chatID) {
      if (visible && audience) update({ audience });
      return;
    }
    loaded.current = chatID;
    void accountValues
      .get<StoredDraft>(draftKey(chatID))
      .then((stored) => {
        const restored = fromStored(stored);
        if (!restored) {
          if (audience) update({ audience });
          return;
        }
        setDraft(audience ? { ...restored, audience } : restored);
        setCustomDue(
          restored.dueAt !== null &&
            !requestDuePresets(new Date()).some(
              (preset) => preset.at.getTime() === restored.dueAt?.getTime(),
            ),
        );
      })
      .catch(() => undefined);
    // The opener's audience applies once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatID, visible]);

  function update(patch: Partial<RequestDraft>) {
    setDraft((current) => {
      const next = { ...current, ...patch };
      void accountValues
        .set(draftKey(chatID), blank(next) ? null : toStored(next))
        .catch(() => undefined);
      return next;
    });
  }

  const people = useMemo(
    () =>
      members.filter(
        (member) => member.type === "user" && member.actor_id !== user.id,
      ),
    [members, user.id],
  );
  // A kept draft for a department or position the author may no longer
  // address falls back to the whole chat.
  const allowed = segments.includes(draft.audience.kind);
  const audienceNow: RequestDraftAudience = useMemo(
    () => (allowed ? draft.audience : { kind: "chat" }),
    [allowed, draft.audience],
  );
  const recipients = useMemo(
    () => requestRecipientIDs(audienceNow, members, user.id, org.structure),
    [audienceNow, members, user.id, org.structure],
  );
  const problem = requestDraftProblem(draft, now, recipients.length);
  const options = requestOptionLabels(
    {
      answer:
        draft.preset === "custom"
          ? {
              preset: "custom",
              options: draft.customOptions
                .map((option) => option.trim())
                .filter(Boolean),
            }
          : { preset: draft.preset },
    },
    t,
  );
  const duePresets = useMemo(() => requestDuePresets(now), [now]);
  const remindPossible = autoRemindAvailable(draft.dueAt, now);
  const chosen =
    draft.audience.kind === "people" ? draft.audience.actorIDs : [];

  function togglePerson(actorID: string) {
    const next = chosen.includes(actorID)
      ? chosen.filter((id) => id !== actorID)
      : [...chosen, actorID];
    update({ audience: { kind: "people", actorIDs: next } });
  }

  function setOption(index: number, text: string) {
    const next = [...draft.customOptions];
    next[index] = text;
    update({ customOptions: next });
  }

  function pickDue(at: Date | null, custom: boolean) {
    setCustomDue(custom);
    update({ dueAt: at });
  }

  function customStart() {
    const tomorrow = duePresets.find((preset) => preset.id === "tomorrow");
    return draft.dueAt ?? tomorrow?.at ?? new Date(now.getTime() + 86_400_000);
  }

  function onPicked(part: "date" | "time") {
    return (event: DateTimePickerEvent, picked?: Date) => {
      if (event.type !== "set" || !picked) return;
      const base = customStart();
      pickDue(
        part === "date" ? combine(picked, base) : combine(base, picked),
        true,
      );
    };
  }

  function openOtherDate() {
    const start = customStart();
    if (Platform.OS === "android")
      DateTimePickerAndroid.open({
        value: start,
        mode: "date",
        minimumDate: now,
        maximumDate: new Date(now.getTime() + requestLimits.dueHorizonMs),
        onChange: (event, picked) => {
          if (event.type !== "set" || !picked) return;
          const day = combine(picked, start);
          DateTimePickerAndroid.open({
            value: day,
            mode: "time",
            is24Hour: !clock.hour12,
            onChange: (timeEvent, time) => {
              pickDue(
                timeEvent.type === "set" && time ? combine(day, time) : day,
                true,
              );
            },
          });
        },
      });
    else pickDue(start, true);
  }

  async function send() {
    setTried(true);
    if (problem || sending) return;
    setSending(true);
    const sentAt = new Date();
    try {
      const result = await sendRequest(api, store, chatID, (clientMsgID) =>
        toCreateRequestInput(
          { ...draft, audience: audienceNow },
          clientMsgID,
          sentAt,
        ),
      );
      if (result.kind === "refused") {
        Alert.alert(t("requestSendFailed"), errorText(result.error));
        return;
      }
      await accountValues.set(draftKey(chatID), null).catch(() => undefined);
      setDraft(emptyRequestDraft());
      setCustomDue(false);
      setTried(false);
      onClose();
      onNotice(result.kind === "sent" ? t("requestSent") : t("requestQueued"));
    } finally {
      setSending(false);
    }
  }

  const dueLabel = (at: Date, id?: string) =>
    id === "friday"
      ? t("requestDueBy", { when: formatRequestDue(at, now, locale) })
      : formatRequestDue(at, now, locale);
  const remindAt =
    draft.dueAt && remindPossible ? autoRemindAt(now, draft.dueAt) : null;

  return (
    <BottomSheet
      visible={visible}
      title={t("requestTitle")}
      onClose={onClose}
      testID="request-sheet"
    >
      <TextInput
        testID="request-body"
        value={draft.body}
        onChangeText={(body) => update({ body })}
        placeholder={t("requestBodyPlaceholder")}
        placeholderTextColor={theme.muted}
        accessibilityLabel={t("requestBodyLabel")}
        selectionColor={theme.primary}
        multiline
        maxFontSizeMultiplier={maxTextScale}
        style={[
          styles.body,
          {
            color: theme.foreground,
            borderColor:
              tried && problem?.field === "body"
                ? theme.danger
                : theme.borderStrong,
            backgroundColor: theme.surface,
          },
        ]}
      />

      <SectionLabel>{t("requestWhoLabel")}</SectionLabel>
      <Segmented
        testID="request-audience"
        value={audienceNow.kind}
        options={segments.map((kind) => ({
          value: kind,
          label: t(
            {
              chat: "requestAudienceChat",
              people: "requestAudiencePeople",
              department: "orgRequestDepartment",
              position: "orgRequestPosition",
            }[kind],
          ),
        }))}
        onChange={(kind) =>
          update({
            audience:
              kind === "chat"
                ? { kind: "chat" }
                : kind === "people"
                  ? { kind: "people", actorIDs: chosen }
                  : kind === "department"
                    ? { kind: "department", departmentID: "" }
                    : { kind: "position", positionID: "" },
          })
        }
      />
      {(audienceNow.kind === "department" || audienceNow.kind === "position") &&
      org.structure ? (
        <RequestGroupChoice
          kind={audienceNow.kind}
          audience={audienceNow}
          structure={org.structure}
          members={members}
          authorID={user.id}
          onChange={(next) => update({ audience: next })}
        />
      ) : null}
      {draft.audience.kind === "people" ? (
        <View style={[styles.chips, styles.peopleChips]}>
          {people.map((member) => {
            const on = chosen.includes(member.actor_id);
            return (
              <Chip
                key={member.actor_id}
                testID={`request-person-${member.handle}`}
                label={member.display_name}
                selected={on}
                icon={
                  <Avatar
                    name={member.display_name}
                    seed={member.actor_id}
                    size={20}
                    actorID={member.actor_id}
                    avatarVersion={member.avatar_version}
                  />
                }
                onPress={() => togglePerson(member.actor_id)}
              />
            );
          })}
        </View>
      ) : null}
      <View style={styles.summary}>
        {recipients.length > 0 ? (
          <AvatarStack
            actorIDs={recipients.slice(0, 5)}
            members={members}
            ring={theme.surface}
          />
        ) : null}
        <Text
          testID="request-recipients"
          tone="muted"
          size={13.5}
          style={styles.grow}
        >
          <Text size={13.5} weight="semibold">
            {t("requestWaitingFrom", { count: recipients.length })}
          </Text>
          {recipients.length > 0 ? ` ${t("requestOthersSee")}` : ""}
        </Text>
      </View>
      {tried && problem?.field === "audience" ? (
        <Text tone="danger" size={13}>
          {t(groupProblemKey(audienceNow) ?? problemKey(problem))}
        </Text>
      ) : null}

      <SectionLabel>{t("requestAnswerLabel")}</SectionLabel>
      <View style={styles.chips}>
        {requestAnswerPresets.map((preset) => (
          <Chip
            key={preset}
            testID={`request-preset-${preset}`}
            label={t(requestPresetLabelKeys[preset])}
            selected={draft.preset === preset}
            onPress={() => update({ preset })}
          />
        ))}
      </View>
      {draft.preset === "custom" ? (
        <View style={styles.custom}>
          {draft.customOptions.map((option, index) => (
            <View key={index} style={styles.customRow}>
              <TextInput
                testID={`request-option-${index}`}
                value={option}
                onChangeText={(text) => setOption(index, text)}
                placeholder={t("requestOptionPlaceholder", {
                  number: index + 1,
                })}
                placeholderTextColor={theme.muted}
                maxLength={requestLimits.customOptionMaxLength}
                maxFontSizeMultiplier={maxTextScale}
                style={[
                  styles.option,
                  {
                    color: theme.foreground,
                    borderColor:
                      tried &&
                      problem?.field === "options" &&
                      problem.index === index
                        ? theme.danger
                        : theme.borderStrong,
                    backgroundColor: theme.surface,
                  },
                ]}
              />
              {draft.customOptions.length > requestLimits.customOptionsMin ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("requestOptionRemove")}
                  hitSlop={8}
                  onPress={() =>
                    update({
                      customOptions: draft.customOptions.filter(
                        (_, other) => other !== index,
                      ),
                    })
                  }
                  style={styles.removeOption}
                >
                  <X size={18} color={theme.muted} />
                </Pressable>
              ) : null}
            </View>
          ))}
          {draft.customOptions.length < requestLimits.customOptionsMax ? (
            <Pressable
              testID="request-option-add"
              accessibilityRole="button"
              onPress={() =>
                update({ customOptions: [...draft.customOptions, ""] })
              }
              style={styles.addOption}
            >
              <Plus size={16} color={theme.primary} />
              <Text tone="primary" weight="semibold" size={14}>
                {t("requestOptionAdd")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {options.length > 0 ? (
        <>
          <View
            testID="request-preview"
            style={[styles.preview, { borderColor: theme.borderStrong }]}
          >
            <AnswerButtons options={options} disabled />
          </View>
          <Text tone="muted" size={13} style={styles.previewCaption}>
            {t("requestPreviewCaption")}
          </Text>
        </>
      ) : null}
      {tried && problem?.field === "options" ? (
        <Text tone="danger" size={13}>
          {t(problemKey(problem))}
        </Text>
      ) : null}

      <ToggleRow
        testID="request-comment"
        label={t("requestCommentLabel")}
        hint={t("requestCommentHint")}
        value={draft.allowComment}
        onChange={(allowComment) => update({ allowComment })}
      />

      <SectionLabel>{t("requestDueLabel")}</SectionLabel>
      <View style={styles.chips}>
        <Chip
          testID="request-due-none"
          label={t("requestDueNone")}
          selected={draft.dueAt === null}
          onPress={() => pickDue(null, false)}
        />
        {duePresets.map((preset) => (
          <Chip
            key={preset.id}
            testID={`request-due-${preset.id}`}
            label={dueLabel(preset.at, preset.id)}
            selected={
              !customDue && draft.dueAt?.getTime() === preset.at.getTime()
            }
            onPress={() => pickDue(preset.at, false)}
          />
        ))}
        <Chip
          testID="request-due-other"
          label={
            customDue && draft.dueAt
              ? formatRequestDue(draft.dueAt, now, locale)
              : t("requestDueOther")
          }
          selected={customDue}
          icon={
            <CalendarDays
              size={15}
              color={customDue ? theme.primary : theme.foreground}
            />
          }
          onPress={openOtherDate}
        />
      </View>
      {customDue && draft.dueAt && Platform.OS === "ios" ? (
        <View
          style={[
            styles.iosRow,
            { borderColor: theme.primary, backgroundColor: theme.primarySoft },
          ]}
        >
          <DateTimePicker
            testID="request-due-date"
            accessibilityLabel={t("scheduledPickDate")}
            value={draft.dueAt}
            mode="date"
            display="compact"
            minimumDate={now}
            maximumDate={new Date(now.getTime() + requestLimits.dueHorizonMs)}
            locale={clock.locale}
            accentColor={theme.primary}
            themeVariant={scheme === "dark" ? "dark" : "light"}
            onChange={onPicked("date")}
          />
          <DateTimePicker
            testID="request-due-time"
            accessibilityLabel={t("scheduledPickTime")}
            value={draft.dueAt}
            mode="time"
            display="compact"
            locale={clock.locale}
            accentColor={theme.primary}
            themeVariant={scheme === "dark" ? "dark" : "light"}
            onChange={onPicked("time")}
          />
        </View>
      ) : null}
      {customDue && draft.dueAt && Platform.OS === "android" ? (
        <Text tone="muted" size={13} style={styles.previewCaption}>
          {`${formatDate(draft.dueAt, now, clock)}, ${formatTime(draft.dueAt, clock)}`}
        </Text>
      ) : null}
      {problem?.field === "dueAt" && (tried || customDue) ? (
        <Text tone="danger" size={13} style={styles.previewCaption}>
          {t(problemKey(problem))}
        </Text>
      ) : null}
      {draft.dueAt ? (
        <ToggleRow
          testID="request-auto-remind"
          label={t("requestAutoRemindLabel")}
          hint={
            remindAt
              ? t("requestAutoRemindHint", {
                  when: formatRequestDue(remindAt, now, locale),
                })
              : t("requestAutoRemindUnavailable")
          }
          value={draft.autoRemind && remindPossible}
          disabled={!remindPossible}
          onChange={(autoRemind) => update({ autoRemind })}
        />
      ) : null}

      {tried && problem && problem.field === "body" ? (
        <Text tone="danger" size={13} style={styles.previewCaption}>
          {t(problemKey(problem))}
        </Text>
      ) : null}
      <WideButton
        testID="request-send"
        label={t("requestSend", { count: recipients.length })}
        pending={sending}
        disabled={tried && Boolean(problem)}
        onPress={() => void send()}
        style={styles.send}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    minHeight: 72,
    maxHeight: 160,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingTop: 11,
    paddingBottom: 11,
    fontFamily: fonts.regular,
    fontSize: 16,
    textAlignVertical: "top",
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  peopleChips: { marginTop: spacing[2] },
  summary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
  },
  grow: { flex: 1, minWidth: 0 },
  custom: { gap: 6, marginTop: spacing[2] },
  customRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  option: {
    flex: 1,
    height: 42,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontFamily: fonts.regular,
    fontSize: 15.5,
  },
  removeOption: { width: 32, alignItems: "center" },
  addOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 6,
  },
  // Prototype `.prev`: a dashed frame around the buttons as recipients see them.
  preview: {
    marginTop: 12,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingBottom: 10,
    paddingTop: 2,
  },
  previewCaption: { marginTop: 6 },
  iosRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: spacing[2],
    paddingVertical: 4,
    gap: spacing[2],
    marginTop: spacing[2],
  },
  send: { marginTop: 14 },
});
