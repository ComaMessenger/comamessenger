import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import * as Haptics from "expo-haptics";
import { CalendarDays, Equal, Plus, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  addPollOption,
  canAddPollOption,
  clockTime,
  emptyPollDraft,
  formatPollDue,
  movePollOption,
  parsePollDraft,
  pollDraftProblem,
  pollDraftTouched,
  pollDuePresetLabelKeys,
  pollDuePresets,
  pollLimits,
  removePollOption,
  serializePollDraft,
  toCreatePollInput,
  type PollDraft,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { accountValues } from "@/lib/database";
import { useSignedIn } from "@/session/SessionProvider";
import { useMessenger } from "@/messenger/MessengerProvider";
import { BottomSheet } from "@/ui/BottomSheet";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import { useNow } from "@/scheduled/clock";
import { calendarLocale } from "@/requests/locale";
import { Chip, SectionLabel, ToggleRow, WideButton } from "@/requests/parts";
import { DateTimeRow } from "@/status/DateTimeRow";
import { pollErrorText, pollProblemText } from "./format";
import { sendPoll } from "./outbox";

const draftKey = (chatID: string) => `poll_draft:${chatID}`;

/** A row of «Варианты»: 42 high and 6 apart, for the drag handle. */
const rowStep = 48;

/**
 * «Новый опрос» from the «+» menu (prototype «Опросы», phone A): the
 * question, 2–10 options that move by the handle, «Несколько ответов»,
 * «Анонимно» (off by default, with what it costs), «Принимать ответы» and
 * «Отправить опрос». Kept on the device per chat until it is sent; sending
 * goes through the poll queue, so a poll written offline goes once the
 * network is back.
 */
export function PollSheet({
  visible,
  chatID,
  onClose,
  onNotice,
}: {
  visible: boolean;
  chatID: string;
  onClose(): void;
  onNotice(text: string): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const { store } = useMessenger();
  const locale = calendarLocale(i18n.language);
  const now = useNow(30_000, visible);
  const [draft, setDraft] = useState<PollDraft>(emptyPollDraft);
  const [customDue, setCustomDue] = useState(false);
  const [sending, setSending] = useState(false);
  const [tried, setTried] = useState(false);
  const loaded = useRef<string | null>(null);

  // The form of this chat comes back as it was left.
  useEffect(() => {
    if (!visible || loaded.current === chatID) return;
    loaded.current = chatID;
    void accountValues
      .get<string>(draftKey(chatID))
      .then((stored) => {
        const restored = parsePollDraft(stored, new Date());
        if (!restored) return;
        setDraft(restored);
        setCustomDue(
          restored.dueAt !== null &&
            !pollDuePresets(new Date()).some(
              (preset) => preset.at.getTime() === restored.dueAt?.getTime(),
            ),
        );
      })
      .catch(() => undefined);
  }, [chatID, visible]);

  function update(next: (current: PollDraft) => PollDraft) {
    setDraft((current) => {
      const value = next(current);
      void accountValues
        .set(
          draftKey(chatID),
          pollDraftTouched(value) ? serializePollDraft(value) : null,
        )
        .catch(() => undefined);
      return value;
    });
  }

  const problem = pollDraftProblem(draft, now);
  const presets = useMemo(() => pollDuePresets(now), [now]);

  function pickDue(at: Date | null, custom: boolean) {
    setCustomDue(custom);
    update((current) => ({ ...current, dueAt: at }));
  }

  function otherDate() {
    const tomorrow = presets.find((preset) => preset.id === "tomorrow");
    pickDue(
      draft.dueAt ?? tomorrow?.at ?? new Date(now.getTime() + 86_400_000),
      true,
    );
  }

  async function send() {
    setTried(true);
    if (problem || sending) return;
    setSending(true);
    try {
      const result = await sendPoll(api, store, chatID, (clientMsgID) =>
        toCreatePollInput(draft, clientMsgID),
      );
      if (result.kind === "refused") {
        Alert.alert(t("pollSendFailed"), pollErrorText(t, result.error));
        return;
      }
      await accountValues.set(draftKey(chatID), null).catch(() => undefined);
      setDraft(emptyPollDraft());
      setCustomDue(false);
      setTried(false);
      onClose();
      onNotice(result.kind === "sent" ? t("pollSent") : t("pollQueued"));
    } finally {
      setSending(false);
    }
  }

  const optionProblem =
    tried && problem?.field === "options" ? problem : undefined;

  return (
    <BottomSheet
      visible={visible}
      title={t("pollSheetTitle")}
      onClose={onClose}
      testID="poll-sheet"
    >
      <SectionLabel>{t("pollQuestionLabel")}</SectionLabel>
      <TextInput
        testID="poll-question-input"
        value={draft.question}
        onChangeText={(question) =>
          update((current) => ({ ...current, question }))
        }
        placeholder={t("pollQuestionPlaceholder")}
        placeholderTextColor={theme.muted}
        accessibilityLabel={t("pollQuestionLabel")}
        selectionColor={theme.primary}
        maxLength={pollLimits.questionMaxLength}
        multiline
        maxFontSizeMultiplier={maxTextScale}
        style={[
          styles.question,
          {
            color: theme.foreground,
            backgroundColor: theme.surface,
            borderColor:
              tried && problem?.field === "question"
                ? theme.danger
                : theme.borderStrong,
          },
        ]}
      />

      <SectionLabel>{t("pollOptionsLabel")}</SectionLabel>
      {draft.options.map((option, index) => (
        <OptionRow
          key={index}
          index={index}
          count={draft.options.length}
          value={option}
          invalid={
            optionProblem?.index === index ||
            (optionProblem?.reason === "tooFew" && !option.trim())
          }
          onChange={(text) =>
            update((current) => {
              const options = [...current.options];
              options[index] = text;
              return { ...current, options };
            })
          }
          onRemove={() => update((current) => removePollOption(current, index))}
          onMove={(to) =>
            update((current) => movePollOption(current, index, to))
          }
        />
      ))}
      {canAddPollOption(draft) ? (
        <Pressable
          testID="poll-option-add"
          accessibilityRole="button"
          onPress={() => update(addPollOption)}
          style={styles.add}
        >
          <Plus size={18} color={theme.primary} />
          <Text tone="primary" weight="semibold" size={15}>
            {t("pollAddOption")}
          </Text>
        </Pressable>
      ) : null}
      {optionProblem ? (
        <Text tone="danger" size={13} style={styles.error}>
          {pollProblemText(t, optionProblem)}
        </Text>
      ) : null}

      <SectionLabel>{t("pollSettingsLabel")}</SectionLabel>
      <ToggleRow
        testID="poll-multiple"
        label={t("pollMultiple")}
        hint={t("pollMultipleHint")}
        value={draft.multiple}
        onChange={(multiple) => update((current) => ({ ...current, multiple }))}
      />
      <ToggleRow
        testID="poll-anonymous"
        label={t("pollAnonymous")}
        hint={t("pollAnonymousHint")}
        value={draft.anonymous}
        onChange={(anonymous) =>
          update((current) => ({ ...current, anonymous }))
        }
      />

      <SectionLabel>{t("pollDueLabel")}</SectionLabel>
      <View style={styles.chips}>
        <Chip
          testID="poll-due-none"
          label={t("pollDueNone")}
          selected={draft.dueAt === null}
          onPress={() => pickDue(null, false)}
        />
        {presets.map((preset) => (
          <Chip
            key={preset.id}
            testID={`poll-due-${preset.id}`}
            label={t(pollDuePresetLabelKeys[preset.id], {
              // Prototype: «до 18:00», «до завтра, 12:00», «до пт, 18:00».
              when:
                preset.id === "today"
                  ? clockTime(preset.at, locale)
                  : formatPollDue(preset.at, now, locale),
            })}
            selected={
              !customDue && draft.dueAt?.getTime() === preset.at.getTime()
            }
            onPress={() => pickDue(preset.at, false)}
          />
        ))}
        <Chip
          testID="poll-due-other"
          label={
            customDue && draft.dueAt
              ? t("pollDueBy", {
                  when: formatPollDue(draft.dueAt, now, locale),
                })
              : t("pollDueOther")
          }
          selected={customDue}
          icon={
            <CalendarDays
              size={15}
              color={customDue ? theme.primary : theme.foreground}
            />
          }
          onPress={otherDate}
        />
      </View>
      {customDue && draft.dueAt ? (
        <DateTimeRow
          testID="poll-due-custom"
          value={draft.dueAt}
          minimum={now}
          maximum={new Date(now.getTime() + pollLimits.dueHorizonMs)}
          onChange={(at) => pickDue(at, true)}
        />
      ) : null}
      {problem?.field === "dueAt" && (tried || customDue) ? (
        <Text tone="danger" size={13} style={styles.error}>
          {pollProblemText(t, problem)}
        </Text>
      ) : null}

      {tried && problem?.field === "question" ? (
        <Text tone="danger" size={13} style={styles.error}>
          {pollProblemText(t, problem)}
        </Text>
      ) : null}
      <WideButton
        testID="poll-send"
        label={t("pollSend")}
        pending={sending}
        disabled={tried && Boolean(problem)}
        onPress={() => void send()}
        style={styles.send}
      />
    </BottomSheet>
  );
}

/**
 * One option: the handle (`.pf` with the drag icon), the field and «×»
 * while there are more than two. The handle moves the row by dragging; for
 * a screen reader it offers «Выше» and «Ниже».
 */
function OptionRow({
  index,
  count,
  value,
  invalid,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  count: number;
  value: string;
  invalid: boolean;
  onChange(text: string): void;
  onRemove(): void;
  onMove(to: number): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const shift = useRef(new Animated.Value(0)).current;
  const [dragging, setDragging] = useState(false);
  const move = useRef(onMove);
  move.current = onMove;
  const position = useRef({ index, count });
  position.current = { index, count };
  const drag = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activeOffsetY([-4, 4])
        .onStart(() => {
          setDragging(true);
          void Haptics.selectionAsync();
        })
        .onUpdate((event) => shift.setValue(event.translationY))
        .onEnd((event) => {
          const { index: from, count: rows } = position.current;
          const to = Math.max(
            0,
            Math.min(rows - 1, from + Math.round(event.translationY / rowStep)),
          );
          shift.setValue(0);
          if (to !== from) move.current(to);
        })
        .onFinalize(() => {
          shift.setValue(0);
          setDragging(false);
        }),
    [shift],
  );
  const number = index + 1;
  return (
    <Animated.View
      style={[
        styles.option,
        dragging && styles.dragging,
        { transform: [{ translateY: shift }] },
      ]}
    >
      <GestureDetector gesture={drag}>
        <View
          testID={`poll-option-handle-${index}`}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={t("pollDragOption", { index: number })}
          accessibilityHint={t("pollDragOptionHint")}
          accessibilityActions={[
            ...(index > 0
              ? [{ name: "decrement", label: t("pollMoveUp") }]
              : []),
            ...(index < count - 1
              ? [{ name: "increment", label: t("pollMoveDown") }]
              : []),
          ]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "decrement" && index > 0)
              onMove(index - 1);
            if (
              event.nativeEvent.actionName === "increment" &&
              index < count - 1
            )
              onMove(index + 1);
          }}
          hitSlop={8}
          style={styles.handle}
        >
          <Equal size={18} color={theme.muted} />
        </View>
      </GestureDetector>
      <TextInput
        testID={`poll-option-input-${index}`}
        value={value}
        onChangeText={onChange}
        placeholder={t("pollOptionPlaceholder", { index: number })}
        placeholderTextColor={theme.muted}
        accessibilityLabel={t("pollOptionPlaceholder", { index: number })}
        selectionColor={theme.primary}
        maxLength={pollLimits.optionMaxLength}
        maxFontSizeMultiplier={maxTextScale}
        style={[
          styles.field,
          {
            color: theme.foreground,
            backgroundColor: theme.surface,
            borderColor: invalid ? theme.danger : theme.borderStrong,
          },
        ]}
      />
      {count > pollLimits.optionsMin ? (
        <Pressable
          testID={`poll-option-remove-${index}`}
          accessibilityRole="button"
          accessibilityLabel={t("pollRemoveOption", { index: number })}
          hitSlop={8}
          onPress={onRemove}
          style={styles.remove}
        >
          <X size={17} color={theme.muted} />
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // `.fi` of the question: one line that grows.
  question: {
    minHeight: 42,
    maxHeight: 120,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    fontFamily: fonts.regular,
    fontSize: 15.5,
    textAlignVertical: "top",
  },
  // `.pf`: the handle, the field and «×», 6 apart.
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 42,
    marginBottom: 6,
  },
  dragging: { zIndex: 2, opacity: 0.92 },
  handle: { width: 24, alignItems: "center", justifyContent: "center" },
  field: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontFamily: fonts.regular,
    fontSize: 15.5,
  },
  remove: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  // `.addo`: primary, 600, under the fields.
  add: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 6,
    paddingBottom: 2,
    paddingLeft: 24,
    minHeight: 36,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  error: { marginTop: 6 },
  send: { marginTop: 16 },
});
