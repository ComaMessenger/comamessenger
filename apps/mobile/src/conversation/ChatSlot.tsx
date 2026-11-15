import { useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  Clock3,
  Flame,
  MessageCircleCheck,
  MoreHorizontal,
  Pin,
  Plane,
  SquareCheck,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  buildChatSlot,
  hasTask,
  messagePlainText,
  nextPinIndex,
  pendingSummary,
  selectSlotItem,
  slotChips,
  workplaceFeatures,
  type ChatSlot as Slot,
  type Message,
  type ScheduledMessage,
  type SlotAway,
  type SlotItem,
  type SlotKind,
  type SlotPin,
  type TaskViewer,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { MenuSheet } from "@/ui/MenuSheet";
import { Text } from "@/ui/Text";
import { useNow } from "@/scheduled/clock";
import { calendarLocale } from "@/requests/locale";
import { useChatTasks, useTaskActions } from "@/tasks/useTasks";
import { TaskCheck } from "@/tasks/parts";
import type { TaskRowMessage } from "@/tasks/TaskRow";

/**
 * The last slot shown per reader and chat: kept on screen while the
 * sources load again («Пока источники не загружены, слот показывает
 * последний известный вид»), never an empty or jumping line.
 */
const lastSlots = new Map<string, Slot>();

/** Pinned messages with their text, in the order the server gives them. */
function useSlotPins(chatID: string, enabled: boolean) {
  const { api } = useSignedIn();
  const { store } = useMessenger();
  return useQuery({
    // Under ["pins", chatID]: pinning and unpinning invalidate it too.
    queryKey: ["pins", chatID, "slot"],
    staleTime: 30_000,
    enabled,
    queryFn: async (): Promise<SlotPin[]> => {
      const pins = await api.pins(chatID);
      return Promise.all(
        pins.map(async (pin) => {
          const loaded = store
            .getState()
            .messages[chatID]?.find((item) => item.id === pin.message_id);
          let message: Pick<Message, "body" | "task" | "files"> | undefined =
            loaded;
          if (!message)
            try {
              const context = await api.messageContext(pin.message_id, 0);
              message = context.messages.find(
                (item) => item.id === pin.message_id,
              );
            } catch {
              message = undefined;
            }
          const text = message?.task
            ? message.task.title
            : message
              ? messagePlainText(message.body).trim() ||
                message.files[0]?.name ||
                ""
              : "";
          return { messageID: pin.message_id, text };
        }),
      );
    },
  });
}

/** Waiting and unsent scheduled messages of the chat: the slot counts both. */
function scheduledSummary(items: readonly ScheduledMessage[], chatID: string) {
  const pending = pendingSummary(items, chatID);
  const failed = items.filter(
    (item) => item.chat_id === chatID && item.status === "failed",
  ).length;
  return { count: pending.count + failed, next: pending.next };
}

export type ChatSlotState = ReturnType<typeof useChatSlot>;

/**
 * Everything the slot under the chat header shows (decision 17): what
 * burns on the reader, pinned messages, requests waiting for them, open
 * tasks of the chat, their scheduled messages. The rules are
 * buildChatSlot's; here are the sources and the reader's choice, kept
 * until the chat is left.
 */
export function useChatSlot({
  chatID,
  messages,
  viewer,
  scheduled,
  scheduledLoaded,
  enabled,
  away = null,
}: {
  /**
   * «Отсутствует» (phase 6.7 decision 10): the other person of a direct chat
   * is away, as awaySlot of @comamessenger/core builds it.
   */
  away?: SlotAway | null;
  chatID: string;
  messages: readonly Message[];
  viewer: TaskViewer;
  scheduled: readonly ScheduledMessage[];
  scheduledLoaded: boolean;
  /** Off in a thread: the slot belongs to the chat. */
  enabled: boolean;
}) {
  const { i18n } = useTranslation();
  const { user } = useSignedIn();
  const { store } = useMessenger();
  const features = useStore(store, (state) => state.features);
  const unread = useStore(store, (state) =>
    state.unread.chats.find((item) => item.chat_id === chatID),
  );
  const requestViewers = useStore(store, (state) => state.requestViewers);
  const tasks = useChatTasks(chatID, enabled);
  const pins = useSlotPins(chatID, enabled);
  const now = useNow(60_000, enabled);
  const [chosen, setChosen] = useState<SlotKind | null>(null);
  const [pinIndex, setPinIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const taskMessages = useMemo(
    () =>
      (tasks.data?.items ?? []).filter(hasTask) as unknown as TaskRowMessage[],
    [tasks.data],
  );
  const built = buildChatSlot(
    {
      viewer,
      features,
      locale: calendarLocale(i18n.language),
      tasks: tasks.isError ? [] : tasks.data ? taskMessages : undefined,
      taskCounts: tasks.data?.counts,
      pins: pins.isError ? [] : pins.data,
      pinIndex,
      // Requests count only on servers that have them (wave 1).
      unread: workplaceFeatures(features).requests ? unread : undefined,
      messages,
      requestViewers,
      scheduled: scheduledLoaded
        ? scheduledSummary(scheduled, chatID)
        : undefined,
      away,
    },
    now,
  );
  const key = `${user.id}:${chatID}`;
  if (built.complete) lastSlots.set(key, built);
  const slot = built.complete ? built : (lastSlots.get(key) ?? null);
  const item = enabled && slot ? selectSlotItem(slot, chosen) : null;
  const unfolds = Boolean(
    item && (item.kind === "tasks" || item.targetType === "task"),
  );
  return {
    slot,
    item,
    chips: slot ? slotChips(slot) : { chips: [], overflow: [] },
    taskMessages,
    viewer,
    open: open && unfolds,
    setOpen,
    choose(kind: SlotKind) {
      setChosen(kind);
      setOpen(false);
    },
    nextPin(current: SlotItem) {
      if (current.position)
        setPinIndex(
          nextPinIndex(current.position.index, current.position.total),
        );
    },
  };
}

const kindIcon = (kind: SlotKind, size: number, color: string): ReactNode => {
  switch (kind) {
    case "hot":
      return <Flame size={size} color={color} />;
    case "away":
      return <Plane size={size} color={color} />;
    case "pinned":
      return <Pin size={size} color={color} />;
    case "requests":
      return <MessageCircleCheck size={size} color={color} />;
    case "tasks":
      return <SquareCheck size={size} color={color} />;
    case "scheduled":
      return <Clock3 size={size} color={color} />;
  }
};

const kindLabelKeys: Record<SlotKind, string> = {
  hot: "slotKindHot",
  away: "slotKindAway",
  pinned: "slotKindPinned",
  requests: "slotKindRequests",
  tasks: "slotKindTasks",
  scheduled: "slotKindScheduled",
};

/** «Готово» right in the line, for a burning task the reader may close. */
function SlotComplete({
  message,
  onNotice,
}: {
  message: TaskRowMessage;
  onNotice?(text: string): void;
}) {
  const { t } = useTranslation();
  const actions = useTaskActions(message, onNotice);
  return (
    <TaskCheck
      testID="chat-slot-complete"
      round
      size={22}
      checked={false}
      label={t("taskRowComplete", { title: message.task.title })}
      disabled={actions.busy === "status"}
      onPress={() => void actions.setStatus("done")}
    />
  );
}

/**
 * The one line under the chat header (prototype `.ustrip`): bars of the
 * pinned messages or the kind's icon, the caption and the title, and the
 * kinds' counters on the right (at most four, the rest behind «⋯»). A
 * burning task on the reader turns it red.
 */
export function ChatSlotBar({
  state,
  onTap,
  onNotice,
}: {
  state: ChatSlotState;
  onTap(item: SlotItem): void;
  onNotice?(text: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const item = state.item;
  if (!item) return null;
  const { chips, overflow } = state.chips;
  const hotTask =
    item.kind === "hot" && item.canComplete && item.targetType === "task"
      ? state.taskMessages.find(
          (message) => message.id === item.targetMessageId,
        )
      : undefined;
  const background =
    item.tone === "danger"
      ? theme.dangerSoft
      : item.tone === "warning"
        ? theme.warningSoft
        : theme.surface;
  const captionColor =
    item.tone === "danger"
      ? theme.danger
      : item.tone === "warning"
        ? theme.warning
        : theme.primary;
  const hot = state.slot?.items.some((entry) => entry.kind === "hot");
  const unfolds = item.kind === "tasks" || item.targetType === "task";
  return (
    <View
      testID="chat-slot"
      style={[
        styles.slot,
        { backgroundColor: background, borderBottomColor: theme.border },
      ]}
    >
      {item.kind === "pinned" && item.position ? (
        <View style={styles.bars}>
          {Array.from(
            { length: Math.min(item.position.total, 3) },
            (_, index) => (
              <View
                key={index}
                style={[
                  styles.bar,
                  {
                    backgroundColor:
                      index === Math.min(item.position!.index, 2)
                        ? theme.primary
                        : theme.borderStrong,
                  },
                ]}
              />
            ),
          )}
        </View>
      ) : hotTask ? (
        <SlotComplete message={hotTask} onNotice={onNotice} />
      ) : (
        <View style={styles.icon}>
          {kindIcon(
            item.kind,
            17,
            item.tone === "danger"
              ? theme.danger
              : item.tone === "warning"
                ? theme.warning
                : theme.muted,
          )}
        </View>
      )}
      <Pressable
        testID={`chat-slot-${item.kind}`}
        accessibilityRole="button"
        accessibilityState={unfolds ? { expanded: state.open } : undefined}
        accessibilityLabel={[item.caption, item.title]
          .filter(Boolean)
          .join(". ")}
        onPress={() => onTap(item)}
        style={styles.main}
      >
        <Text
          weight="semibold"
          size={11.5}
          numberOfLines={1}
          style={{ color: captionColor }}
        >
          {item.caption}
        </Text>
        {item.title ? (
          <Text size={13.5} numberOfLines={1}>
            {item.title}
          </Text>
        ) : null}
      </Pressable>
      {unfolds && chips.length === 0 ? (
        <ChevronDown
          size={16}
          color={theme.muted}
          style={state.open ? styles.flipped : undefined}
        />
      ) : null}
      {chips.length > 0 ? (
        <View
          style={styles.chips}
          accessibilityRole="tablist"
          accessibilityLabel={t("slotKinds")}
        >
          {chips.map((chip) => {
            const on = chip.kind === item.kind;
            return (
              <Pressable
                key={chip.kind}
                testID={`chat-slot-chip-${chip.kind}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={t("slotKindCount", {
                  kind: t(kindLabelKeys[chip.kind]),
                  count: chip.count,
                })}
                hitSlop={{ top: 8, bottom: 8 }}
                onPress={() => state.choose(chip.kind)}
                style={[
                  styles.chip,
                  on && { backgroundColor: theme.surfaceSelected },
                ]}
              >
                {kindIcon(
                  chip.kind,
                  14,
                  chip.tone === "danger"
                    ? theme.danger
                    : on
                      ? theme.foreground
                      : theme.muted,
                )}
                <Text
                  weight="bold"
                  size={12}
                  style={{
                    color:
                      chip.tone === "danger"
                        ? theme.danger
                        : on
                          ? theme.foreground
                          : theme.muted,
                  }}
                >
                  {chip.count}
                </Text>
                {chip.dot ? (
                  <View
                    testID="chat-slot-dot"
                    style={[
                      styles.dot,
                      { backgroundColor: hot ? theme.danger : theme.primary },
                    ]}
                  />
                ) : null}
              </Pressable>
            );
          })}
          {overflow.length > 0 ? (
            <Pressable
              testID="chat-slot-more"
              accessibilityRole="button"
              accessibilityLabel={t("slotMore")}
              hitSlop={{ top: 8, bottom: 8 }}
              onPress={() => setOverflowOpen(true)}
              style={styles.chip}
            >
              <MoreHorizontal size={16} color={theme.muted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {overflowOpen ? (
        <MenuSheet
          visible
          title={t("slotKinds")}
          onClose={() => setOverflowOpen(false)}
          items={overflow.map((entry) => ({
            key: entry.kind,
            label: t("slotKindCount", {
              kind: t(kindLabelKeys[entry.kind]),
              count: entry.count,
            }),
            icon: kindIcon(entry.kind, 20, theme.muted),
            onPress: () => state.choose(entry.kind),
          }))}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Prototype `.ustrip`: padding 6px 8px 6px 12px, gap 9px, min-height 46px.
  slot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 12,
    paddingRight: 8,
    minHeight: 46,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // `.ubars i`: 3×9, gap 2.
  bars: { gap: 2 },
  bar: { width: 3, height: 9, borderRadius: 2 },
  icon: { width: 22, alignItems: "center" },
  main: { flex: 1, minWidth: 0 },
  flipped: { transform: [{ rotate: "180deg" }] },
  // `.uchips` / `.uc`: 30 high, padding 0 6px, radius 9.
  chips: { flexDirection: "row", gap: 2 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    height: 30,
    paddingHorizontal: 6,
    borderRadius: 9,
  },
  dot: {
    position: "absolute",
    top: 4,
    right: 3,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
