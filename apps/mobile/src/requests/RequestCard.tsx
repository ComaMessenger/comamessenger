import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Bell, Check, MessageCircleCheck, Users } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  formatRequestDue,
  requestAudienceText,
  requestLimits,
  requestView,
  type Message,
  type MessageRequestViewer,
} from "@comamessenger/core";
import { radius } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import { useClock, useNow } from "@/scheduled/clock";
import { formatTime } from "@/scheduled/format";
import { calendarLocale } from "./locale";
import { AnswerButtons, Pill, SmallButton } from "./parts";
import { useRequestActions } from "./useRequestActions";

export type RequestCardMessage = Pick<
  Message,
  "id" | "chat_id" | "actor_id" | "edited_at" | "request"
>;

/**
 * The part of a «Запрос» bubble under its author: what kind of request,
 * whom it asks and the due date, then one of three views as in the
 * prototype's «Компоненты»:
 *
 * - a recipient answers with one tap, then sees «Ваш ответ», «Изменить» and
 *   «+ Комментарий»;
 * - the author (and a chat admin) sees bars per answer, «Ответили N из M»,
 *   «Подробнее», «Напомнить · k» and «Закрыть»;
 * - everyone else sees «Ответа ждут не от вас — кнопок нет».
 *
 * The text of the request is rendered by the bubble between `header` and
 * the rest (see MessageRow), so mentions and formatting stay as in any
 * message.
 */
export function RequestCard({
  message,
  fallbackViewer,
  part,
  preview = false,
  compact = false,
  onNotice,
}: {
  message: RequestCardMessage;
  /** The viewer of an inbox item, until the store knows a fresher one. */
  fallbackViewer?: MessageRequestViewer;
  part: "header" | "body";
  /** The still copy in the long-press menu. */
  preview?: boolean;
  /** «Важные → Ждут вас»: the buttons and the answer only, as in the prototype. */
  compact?: boolean;
  onNotice?(text: string): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const clock = useClock();
  const { user } = useSignedIn();
  const { store } = useMessenger();
  const entry = useStore(store, (state) => state.requestViewers[message.id]);
  const viewer = entry?.viewer ?? fallbackViewer ?? null;
  const now = useNow(60_000);
  const actions = useRequestActions(onNotice);
  const [changing, setChanging] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");
  const locale = calendarLocale(i18n.language);
  const view = requestView(message, viewer, { selfID: user.id, now, t });

  const missing = view
    ? view.viewerMissing || Boolean(entry?.provisional)
    : false;
  const { load } = actions;
  useEffect(() => {
    if (missing && !preview) load(message.id, message.chat_id);
  }, [load, message.chat_id, message.id, missing, preview]);

  if (!view) return null;

  if (part === "header") {
    const pill = view.pill;
    return (
      <View style={styles.header}>
        <View style={styles.kind}>
          <MessageCircleCheck size={15} color={theme.muted} />
          <Text tone="muted" weight="semibold" size={12} style={styles.grow}>
            {t("requestKind")}
          </Text>
          {pill?.kind === "closed" ? (
            <Pill
              label={t("requestClosed")}
              tone={pill.warning ? "warning" : "neutral"}
            />
          ) : pill?.kind === "due" ? (
            <Pill
              label={t("requestDueBy", {
                when: formatRequestDue(pill.at, now, locale),
              })}
              tone="warning"
            />
          ) : null}
        </View>
        <Text tone="muted" size={12} testID="request-audience-line">
          {t("requestAudienceLine", {
            audience: requestAudienceText(view.audience, locale),
            count: view.total,
          })}
        </Text>
      </View>
    );
  }

  const chatID = message.chat_id;
  const interactive = !preview;
  const counts = t("requestAnsweredOf", {
    answered: view.answered,
    total: view.total,
  });

  function confirmClose() {
    Alert.alert(t("requestCloseTitle"), t("requestCloseHint"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("requestClose"),
        onPress: () => void actions.close(message.id, chatID),
      },
    ]);
  }

  // The author, and a chat admin who is not asked: bars per answer, then
  // the actions. A chat admin who is asked answers like anyone else and
  // finds the answers under «Подробнее».
  if (view.tally && view.role !== "recipient") {
    const total = Math.max(1, view.total);
    const rows = [
      ...view.tally.map((row) => ({ ...row, none: false })),
      { label: t("requestNoAnswer"), count: view.waiting, none: true },
    ];
    return (
      <View testID="request-card-author">
        <View style={styles.bars}>
          {rows.map((row, index) => (
            <View
              key={`${index}-${row.label}`}
              style={styles.bar}
              accessible
              accessibilityLabel={`${row.label}: ${row.count}`}
            >
              <Text
                size={13.5}
                numberOfLines={1}
                tone={row.none ? "muted" : "default"}
                style={styles.barLabel}
              >
                {row.label}
              </Text>
              <View
                style={[
                  styles.track,
                  { backgroundColor: theme.surfaceSelected },
                ]}
              >
                <View
                  style={[
                    styles.fill,
                    {
                      width: `${Math.min(100, (row.count / total) * 100)}%`,
                      backgroundColor: row.none
                        ? theme.borderStrong
                        : theme.primary,
                    },
                  ]}
                />
              </View>
              <Text
                size={13.5}
                weight="semibold"
                tone={row.none ? "muted" : "default"}
                style={styles.barCount}
              >
                {row.count}
              </Text>
            </View>
          ))}
        </View>
        <View style={styles.foot}>
          <Text tone="muted" size={12.5} style={styles.grow}>
            {counts}
          </Text>
          {view.canViewAnswers && interactive ? (
            <Pressable
              testID="request-details"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() =>
                router.push(`/chat/${chatID}/request/${message.id}`)
              }
            >
              <Text tone="primary" weight="semibold" size={12.5}>
                {t("requestDetails")}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {interactive &&
        (view.remind.kind !== "hidden" || (view.canClose && view.open)) ? (
          <View style={styles.actions}>
            {view.remind.kind === "ready" ? (
              <SmallButton
                testID="request-remind"
                label={t("requestRemindCount", { count: view.remind.count })}
                icon={<Bell size={15} color={theme.foreground} />}
                onPress={() => void actions.remind(message.id, chatID)}
              />
            ) : view.remind.kind === "cooldown" ? (
              <View
                style={[styles.done, { backgroundColor: theme.successSoft }]}
              >
                <Text
                  weight="semibold"
                  size={12.5}
                  style={{ color: theme.success }}
                >
                  {t("requestRemindCooldown", {
                    time: formatTime(view.remind.until, clock),
                  })}
                </Text>
              </View>
            ) : view.remind.kind === "allAnswered" ? (
              <View
                style={[styles.done, { backgroundColor: theme.successSoft }]}
              >
                <Text
                  weight="semibold"
                  size={12.5}
                  style={{ color: theme.success }}
                >
                  {t("requestAllAnswered")}
                </Text>
              </View>
            ) : null}
            {view.canClose && view.open ? (
              <SmallButton
                testID="request-close"
                label={t("requestClose")}
                onPress={confirmClose}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  // Someone else is asked: no buttons for this reader.
  if (view.notForYou)
    return (
      <View testID="request-card-observer">
        <View style={[styles.out, { backgroundColor: theme.surfaceSelected }]}>
          <Users size={15} color={theme.muted} style={styles.outIcon} />
          <Text tone="muted" size={12.5} style={styles.grow}>
            {t("requestNotForYou")}
          </Text>
        </View>
        <Text tone="muted" size={12} style={styles.counts}>
          {counts}
        </Text>
      </View>
    );

  const answer = view.answer;
  const showButtons =
    interactive &&
    ((view.showButtons && !answer) || (changing && view.canChange));
  return (
    <View testID="request-card-recipient">
      {showButtons ? (
        <AnswerButtons
          options={view.options}
          testIDPrefix="request-answer"
          onAnswer={(option) => {
            setChanging(false);
            void actions.answer(message.id, chatID, option);
          }}
        />
      ) : answer ? (
        <View
          testID="request-my-answer"
          style={[styles.mine, { backgroundColor: theme.successSoft }]}
        >
          <Check size={16} color={theme.success} strokeWidth={2.4} />
          <Text
            weight="semibold"
            size={13.5}
            numberOfLines={2}
            style={[styles.grow, { color: theme.success }]}
          >
            {t("requestYourAnswer", { answer: answer.label })}
            {answer.late ? ` · ${t("requestLate")}` : ""}
          </Text>
          {view.canChange && interactive ? (
            <Pressable
              testID="request-change"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setChanging(true)}
            >
              <Text tone="primary" weight="semibold" size={13}>
                {t("requestChange")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {answer && !showButtons && commenting ? (
        <View style={styles.commentRow}>
          <TextInput
            testID="request-comment-input"
            value={comment}
            onChangeText={setComment}
            autoFocus
            placeholder={t("requestCommentPlaceholder")}
            placeholderTextColor={theme.muted}
            maxLength={requestLimits.commentMaxLength}
            maxFontSizeMultiplier={maxTextScale}
            style={[
              styles.commentInput,
              {
                color: theme.foreground,
                borderColor: theme.borderStrong,
                backgroundColor: theme.surface,
              },
            ]}
          />
          <SmallButton
            testID="request-comment-save"
            label={t("requestCommentSave")}
            variant="primary"
            onPress={() => {
              setCommenting(false);
              void actions.answer(
                message.id,
                chatID,
                answer.option,
                comment.trim(),
              );
            }}
          />
        </View>
      ) : answer && !showButtons && answer.comment ? (
        <Pressable
          disabled={!view.canComment || !interactive}
          onPress={() => {
            setComment(answer.comment);
            setCommenting(true);
          }}
        >
          <Text tone="muted" size={13} style={styles.counts}>
            {t("requestYourComment")}{" "}
            <Text size={13} weight="semibold">
              {answer.comment}
            </Text>
          </Text>
        </Pressable>
      ) : answer && !showButtons && view.canComment && interactive ? (
        <Pressable
          testID="request-add-comment"
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => {
            setComment("");
            setCommenting(true);
          }}
          style={styles.addComment}
        >
          <Text tone="primary" weight="semibold" size={13}>
            {t("requestAddComment")}
          </Text>
        </Pressable>
      ) : null}
      {compact ? null : (
        <View style={styles.foot}>
          <Text tone="muted" size={12} style={[styles.grow, styles.counts]}>
            {counts}
            {answer && view.canChange && view.changeUntil
              ? ` · ${t("requestChangeUntil", {
                  when: formatRequestDue(view.changeUntil, now, locale),
                })}`
              : ""}
          </Text>
          {view.canViewAnswers && interactive ? (
            <Pressable
              testID="request-details-admin"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() =>
                router.push(`/chat/${chatID}/request/${message.id}`)
              }
              style={styles.counts}
            >
              <Text tone="primary" weight="semibold" size={12.5}>
                {t("requestDetails")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { marginBottom: 4 },
  // Prototype `.pk`: icon 15, «Запрос» 12px 600, the pill on the right.
  kind: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
    marginBottom: 3,
  },
  grow: { flex: 1, minWidth: 0 },
  // Prototype `.rsum` / `.rs`.
  bars: { gap: 6, marginTop: 4 },
  bar: { flexDirection: "row", alignItems: "center", gap: 8 },
  barLabel: { width: 92 },
  track: { flex: 1, height: 8, borderRadius: 4, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 4 },
  barCount: { width: 22, textAlign: "right", fontVariant: ["tabular-nums"] },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 8,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 9 },
  done: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 9,
    justifyContent: "center",
  },
  // Prototype `.rq-out`.
  out: {
    flexDirection: "row",
    gap: 7,
    alignItems: "flex-start",
    marginTop: 8,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  outIcon: { marginTop: 1 },
  counts: { marginTop: 6 },
  // Prototype `.ackdone`.
  mine: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  addComment: { marginTop: 6, alignSelf: "flex-start" },
  commentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
  },
  commentInput: {
    flex: 1,
    height: 38,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontFamily: fonts.regular,
    fontSize: 14,
  },
});
