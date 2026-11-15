import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Bell, ChartNoAxesColumn, Check, Trophy } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  formatPollDue,
  pollAnsweredText,
  pollView,
  togglePollChoice,
  type ChatMember,
  type Message,
  type PollView,
  type PollViewer,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { AvatarStack } from "@/ui/AvatarStack";
import { Text } from "@/ui/Text";
import { calendarLocale } from "@/requests/locale";
import { Pill, SmallButton } from "@/requests/parts";
import type { PollActions } from "./usePoll";

export type PollCardMessage = Pick<
  Message,
  "id" | "chat_id" | "actor_id" | "edited_at" | "poll"
>;

/**
 * The poll in the feed, as in the prototype's «Опросы» (phones B and C) and
 * «Компоненты». Before the reader's vote: circles (squares with several
 * answers) and «N из M ответили», never the counts. After the vote, for the
 * author always and for everyone once closed: bars, percentages, the
 * reader's check mark and, in an ordinary poll, the faces of who chose
 * what. A closed poll highlights the leader and says the result. Pure: the
 * container (PollMessage) passes the viewer, the actions and the faces.
 */
export function PollCard({
  message,
  viewer,
  selfID,
  actions,
  anonChoice = null,
  optionVoters,
  members = [],
  now,
  preview = false,
  compact = false,
  onOpenVoters,
}: {
  message: PollCardMessage;
  viewer: PollViewer | null;
  selfID: string;
  actions: PollActions;
  /** The reader's choice in an anonymous poll as this device remembers it. */
  anonChoice?: readonly number[] | null;
  /** First voters of each option, for the faces next to it (ordinary polls). */
  optionVoters?: Readonly<Record<number, readonly string[]>>;
  members?: ChatMember[];
  now: Date;
  /** The still copy in the long-press menu: nothing reacts to touch. */
  preview?: boolean;
  /** «Важные → Ждут вас»: the options and the vote only. */
  compact?: boolean;
  /** «Кто голосовал». */
  onOpenVoters?(): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const locale = calendarLocale(i18n.language);
  const view = pollView(message, viewer, {
    selfID,
    now,
    locale,
    anonChoice,
  });
  const [selection, setSelection] = useState<number[]>([]);
  const mine = view?.options.filter((o) => o.chosen).map((o) => o.index) ?? [];
  const mineKey = mine.join(",");
  // A vote from another device replaces what was ticked here.
  const lastMine = useRef(mineKey);
  useEffect(() => {
    if (lastMine.current === mineKey) return;
    lastMine.current = mineKey;
    setSelection([]);
  }, [mineKey]);
  if (!view) return null;
  const due = (at: Date) => formatPollDue(at, now, locale);
  const busy = actions.busy !== null;
  const interactive = !preview && view.voteMode !== "none";
  const selecting = view.voteMode === "select";

  async function tap(index: number) {
    if (!view || busy) return;
    if (view.voteMode === "select") {
      setSelection((current) => togglePollChoice(current, index, true));
      return;
    }
    if (view.voteMode !== "instant") return;
    if (!view.multiple) {
      if (view.voted && mine.length === 1 && mine[0] === index) return;
      await actions.vote([index]);
      return;
    }
    // Several answers after the first vote: each tap changes the vote, and
    // the last option unticked takes the vote back.
    const next = togglePollChoice(mine, index, true);
    if (next.length) await actions.vote(next);
    else await actions.retract();
  }

  function confirmClose() {
    Alert.alert(t("pollCloseTitle"), t("pollCloseHint"), [
      { text: t("cancel"), style: "cancel" },
      { text: t("pollClose"), onPress: () => void actions.close() },
    ]);
  }

  const label = view.anonymous
    ? t("pollCardLabelAnonymous")
    : t("pollCardLabel");
  const links = !preview && !compact;

  return (
    <View testID="poll-card">
      <View style={styles.kind}>
        <ChartNoAxesColumn size={15} color={theme.muted} />
        <Text
          tone="muted"
          weight="semibold"
          size={12}
          numberOfLines={2}
          style={styles.grow}
        >
          {view.multiple ? `${label} · ${t("pollCardMultiple")}` : label}
        </Text>
        <PollPill view={view} due={due} />
      </View>
      <Text
        testID="poll-question"
        weight="semibold"
        size={15.5}
        style={styles.question}
      >
        {view.question}
      </Text>

      {view.options.map((option) => {
        const ticked = selecting
          ? selection.includes(option.index)
          : option.chosen;
        const faces = optionVoters?.[option.index] ?? [];
        const percent = view.showResults ? (option.percent ?? 0) : 0;
        const accessible =
          view.showResults && option.percent !== null
            ? t("pollOptionResult", {
                label: option.label,
                percent: option.percent,
              })
            : option.label;
        return (
          <Pressable
            key={option.index}
            testID={`poll-option-${option.index}`}
            accessibilityRole={
              interactive
                ? view.input === "checkbox"
                  ? "checkbox"
                  : "radio"
                : "text"
            }
            accessibilityLabel={
              option.chosen && view.showResults
                ? t("pollOptionChosen", { label: accessible })
                : accessible
            }
            accessibilityState={
              interactive ? { checked: ticked, disabled: busy } : undefined
            }
            disabled={!interactive || busy}
            onPress={() => void tap(option.index)}
            style={({ pressed }) => [
              styles.option,
              {
                borderColor: option.winner ? theme.primary : theme.border,
                backgroundColor:
                  pressed && interactive ? theme.surfaceHover : theme.surface,
              },
            ]}
          >
            <View
              pointerEvents="none"
              style={[
                styles.fill,
                {
                  width: `${percent}%`,
                  backgroundColor: option.chosen
                    ? theme.primarySoft
                    : theme.surfaceSelected,
                },
              ]}
            />
            {!view.showResults || selecting ? (
              <View
                style={[
                  styles.mark,
                  view.input === "checkbox" && styles.square,
                  ticked
                    ? {
                        backgroundColor: theme.primary,
                        borderColor: theme.primary,
                      }
                    : { borderColor: theme.borderStrong },
                ]}
              >
                {ticked ? (
                  <Check size={13} strokeWidth={2.8} color={theme.onPrimary} />
                ) : null}
              </View>
            ) : null}
            <Text
              size={14.5}
              weight={option.chosen ? "semibold" : "regular"}
              numberOfLines={1}
              style={styles.label}
            >
              {option.label}
            </Text>
            {view.showResults ? (
              <>
                {option.winner ? (
                  <Trophy size={15} color={theme.primary} />
                ) : null}
                {option.chosen ? (
                  <Check size={16} strokeWidth={2.6} color={theme.primary} />
                ) : null}
                {!view.anonymous && faces.length > 0 ? (
                  <AvatarStack
                    actorIDs={faces.slice(0, 3) as string[]}
                    members={members}
                    size={20}
                    ring={theme.surface}
                  />
                ) : null}
                <Text
                  testID={`poll-percent-${option.index}`}
                  weight="bold"
                  size={13.5}
                  style={styles.percent}
                >
                  {option.percent === null ? "" : `${option.percent}%`}
                </Text>
              </>
            ) : null}
          </Pressable>
        );
      })}

      {selecting && !preview ? (
        <View style={styles.vote}>
          <SmallButton
            testID="poll-vote"
            variant="primary"
            label={t("pollVote")}
            disabled={!selection.length || busy}
            onPress={() =>
              void actions.vote(selection).then((done) => {
                if (done) setSelection([]);
              })
            }
          />
        </View>
      ) : null}
      {view.finalVoteHint ? (
        <Text tone="muted" size={12.5} style={styles.note}>
          {t("pollFinalHint")}
        </Text>
      ) : null}
      {view.anonymous && view.voted && !mine.length && view.open ? (
        <Text tone="muted" size={12.5} style={styles.note}>
          {t("pollYouVoted")}
        </Text>
      ) : null}
      {view.resultsLoading ? (
        <Text tone="muted" size={12.5} style={styles.note}>
          {t("pollResultsLoading")}
        </Text>
      ) : null}
      {view.result ? (
        <View
          testID="poll-result"
          style={[styles.result, { backgroundColor: theme.primarySoft }]}
        >
          <Check size={16} color={theme.primary} strokeWidth={2.4} />
          <Text
            weight="semibold"
            size={13.5}
            style={[styles.grow, { color: theme.primary }]}
          >
            {view.result}
          </Text>
        </View>
      ) : null}

      {compact ? null : (
        <View style={styles.foot}>
          <Text testID="poll-answered" tone="muted" size={12.5}>
            {pollAnsweredText(view.voterCount, view.memberCount, locale)}
            {view.edited ? ` · ${t("pollEdited")}` : ""}
          </Text>
          <View style={styles.grow} />
          {links && view.canRetract ? (
            <Link
              testID="poll-retract"
              label={t("pollRetract")}
              disabled={busy}
              onPress={() => void actions.retract()}
            />
          ) : null}
          {links &&
          (view.canViewVoters || view.canViewWaiting) &&
          view.showResults &&
          onOpenVoters ? (
            <Link
              testID="poll-who-voted"
              label={t("pollWhoVoted")}
              onPress={onOpenVoters}
            />
          ) : null}
          {links && view.canClose ? (
            <Link
              testID="poll-close"
              label={t("pollClose")}
              disabled={busy}
              onPress={confirmClose}
            />
          ) : null}
        </View>
      )}

      {links && view.remind.kind !== "hidden" ? (
        <View style={styles.actions}>
          {view.remind.kind === "ready" ? (
            <SmallButton
              testID="poll-remind"
              label={t("pollRemind", { count: view.remind.count })}
              icon={<Bell size={15} color={theme.foreground} />}
              disabled={busy}
              onPress={() => void actions.remind()}
            />
          ) : view.remind.kind === "cooldown" ? (
            <Text testID="poll-remind-cooldown" tone="muted" size={12.5}>
              {t("pollRemindCooldown", { when: due(view.remind.until) })}
            </Text>
          ) : (
            <View style={[styles.done, { backgroundColor: theme.successSoft }]}>
              <Text
                weight="semibold"
                size={12.5}
                style={{ color: theme.success }}
              >
                {t("pollAllAnswered")}
              </Text>
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

function Link({
  label,
  testID,
  disabled,
  onPress,
}: {
  label: string;
  testID: string;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
    >
      <Text tone="primary" weight="semibold" size={12.5}>
        {label}
      </Text>
    </Pressable>
  );
}

function PollPill({
  view,
  due,
}: {
  view: Pick<PollView, "pill">;
  due(at: Date): string;
}) {
  const { t } = useTranslation();
  const pill = view.pill;
  if (!pill) return null;
  if (pill.kind === "closed") return <Pill label={t("pollClosed")} />;
  return <Pill label={t("pollDueBy", { when: due(pill.at) })} tone="warning" />;
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  // Prototype `.pk`: 12px, 600, muted, the pill at the end.
  kind: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
    marginBottom: 3,
  },
  // `.pq`: 600, 15.5px.
  question: { marginBottom: 4, lineHeight: 20 },
  // `.po`: 42 high, 12 radius, a bar behind.
  option: {
    height: 42,
    marginTop: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    overflow: "hidden",
  },
  fill: { position: "absolute", left: 0, top: 0, bottom: 0 },
  mark: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  square: { borderRadius: 6 },
  label: { flex: 1, minWidth: 0 },
  percent: { minWidth: 34, textAlign: "right", fontVariant: ["tabular-nums"] },
  vote: { marginTop: 8, alignItems: "flex-start" },
  note: { marginTop: 6 },
  // `.pres`: the result on the primary soft.
  result: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
  },
  // `.pfoot`.
  foot: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: 10,
    rowGap: 4,
    marginTop: 8,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  done: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
});
