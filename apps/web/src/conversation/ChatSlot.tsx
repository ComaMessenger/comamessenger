import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  Clock3,
  Flame,
  ListChecks,
  MessageSquareMore,
  MoreHorizontal,
  Pin,
  Plane,
} from "lucide-react";
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
  type ChatMember,
  type ChatSlot as Slot,
  type Message,
  type MessageTask,
  type SlotItem,
  type SlotKind,
  type SlotPin,
  type TaskViewer,
} from "@comamessenger/core";
import { FloatingPopover, Menu, MenuItem, cx } from "../ui";
import { useMessenger } from "../shell/MessengerContext";
import { useScheduledMessages } from "../scheduled/useScheduled";
import { calendarLocale } from "../requests/format";
import { ChatTasksDrop } from "../tasks/ChatTasksDrop";
import { useChatTasks, useTaskActions } from "../tasks/useTasks";

/** The last slot shown per chat: kept on screen while sources load again. */
const lastSlots = new Map<string, Slot>();

/** Pinned messages with their text, in the order the server gives them. */
function useSlotPins(chatID: string) {
  const { api, store } = useMessenger();
  return useQuery({
    // Under ["pins", chatID]: pinning and unpinning invalidate it too.
    queryKey: ["pins", chatID, "slot"],
    staleTime: 30_000,
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

const kindIcons: Record<SlotKind, ReactNode> = {
  hot: <Flame />,
  away: <Plane />,
  pinned: <Pin />,
  requests: <MessageSquareMore />,
  tasks: <ListChecks />,
  scheduled: <Clock3 />,
};

const kindLabelKeys: Record<SlotKind, string> = {
  hot: "slotKindHot",
  away: "slotKindAway",
  pinned: "slotKindPinned",
  requests: "slotKindRequests",
  tasks: "slotKindTasks",
  scheduled: "slotKindScheduled",
};

/** Done right in the line, for a burning task the reader may close. */
function SlotComplete({
  message,
}: {
  message: Pick<Message, "id" | "chat_id" | "actor_id"> & { task: MessageTask };
}) {
  const { t } = useTranslation();
  const actions = useTaskActions(message);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={false}
      className="task-check task-check--round chat-slot__complete"
      aria-label={t("taskRowComplete", { title: message.task.title })}
      disabled={actions.busy === "status"}
      onClick={() => void actions.setStatus("done")}
    >
      <Check aria-hidden="true" />
    </button>
  );
}

/**
 * The one line under the chat header (decision 17): what burns on the
 * reader, pinned messages, requests waiting for them, open tasks of the
 * chat, their scheduled messages. The first non-empty kind shows; icons on
 * the right switch it until the chat is left. Tasks unfold into a list
 * under the line, as wide as the feed.
 */
export function ChatSlot({
  chatID,
  members,
  messages,
  viewer,
  canCreateTask,
  onJump,
  onNewTask,
}: {
  chatID: string;
  members: ChatMember[];
  messages: readonly Message[];
  viewer: TaskViewer;
  canCreateTask: boolean;
  onJump(messageID: string): void;
  onNewTask(): void;
}) {
  const { t } = useTranslation();
  const { api, store, user, navigate } = useMessenger();
  const features = useStore(store, (state) => state.features);
  const unread = useStore(store, (state) =>
    state.unread.chats.find((item) => item.chat_id === chatID),
  );
  const requestViewers = useStore(store, (state) => state.requestViewers);
  const tasks = useChatTasks(chatID);
  const pins = useSlotPins(chatID);
  const scheduled = useScheduledMessages(api, user.id);
  const [chosen, setChosen] = useState<SlotKind | null>(null);
  const [pinIndex, setPinIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLButtonElement>(null);

  const taskMessages = useMemo(
    () => (tasks.data?.items ?? []).filter(hasTask),
    [tasks.data],
  );
  const now = new Date();
  const built = buildChatSlot(
    {
      viewer,
      features,
      locale: calendarLocale(),
      tasks: tasks.isError ? [] : tasks.data ? taskMessages : undefined,
      taskCounts: tasks.data?.counts,
      pins: pins.isError ? [] : pins.data,
      pinIndex,
      unread,
      messages,
      requestViewers,
      scheduled:
        scheduled.data || scheduled.isError
          ? pendingSummary(scheduled.data ?? [], chatID)
          : undefined,
    },
    now,
  );
  if (built.complete) lastSlots.set(chatID, built);
  const slot = built.complete ? built : lastSlots.get(chatID);
  if (!slot) return null;
  const item = selectSlotItem(slot, chosen);
  if (!item) return null;
  const { chips, overflow } = slotChips(slot);
  const hotTask =
    item.kind === "hot" && item.canComplete && item.targetType === "task"
      ? taskMessages.find((message) => message.id === item.targetMessageId)
      : undefined;

  function tap(current: SlotItem) {
    switch (current.kind) {
      case "hot":
        if (current.targetType === "task") setOpen((value) => !value);
        else if (current.targetMessageId) onJump(current.targetMessageId);
        else navigate("/important?tab=waiting");
        return;
      case "pinned":
        if (current.targetMessageId) onJump(current.targetMessageId);
        if (current.position)
          setPinIndex(nextPinIndex(current.position.index, current.position.total));
        return;
      case "requests":
        if (current.targetMessageId) onJump(current.targetMessageId);
        else navigate("/important?tab=waiting");
        return;
      case "tasks":
        setOpen((value) => !value);
        return;
      case "scheduled":
        navigate(`/scheduled?chat=${chatID}`);
        return;
      case "away":
        return;
    }
  }
  function choose(kind: SlotKind) {
    setChosen(kind);
    setOpen(false);
    setOverflowOpen(false);
  }
  const unfolds = item.kind === "tasks" || item.targetType === "task";

  return (
    <div className="chat-slot-wrap">
      <div
        className={cx("chat-slot", `chat-slot--${item.tone}`)}
        data-slot-kind={item.kind}
      >
        {item.kind === "pinned" && item.position ? (
          <span className="chat-slot__bars" aria-hidden="true">
            {Array.from({ length: Math.min(item.position.total, 3) }, (_, index) => (
              <i
                key={index}
                className={cx(
                  index ===
                    Math.min(item.position!.index, 2) &&
                    "chat-slot__bar--on",
                )}
              />
            ))}
          </span>
        ) : hotTask ? (
          <SlotComplete message={hotTask} />
        ) : (
          <span className="chat-slot__icon" aria-hidden="true">
            {kindIcons[item.kind]}
          </span>
        )}
        <button
          type="button"
          className="chat-slot__main"
          aria-expanded={unfolds ? open : undefined}
          onClick={() => tap(item)}
        >
          <small className="chat-slot__caption truncate">{item.caption}</small>
          {item.title && (
            <span className="chat-slot__title truncate">{item.title}</span>
          )}
        </button>
        {chips.length > 0 && (
          <div
            className="chat-slot__chips"
            role="group"
            aria-label={t("slotKinds")}
          >
            {chips.map((chip) => (
              <button
                key={chip.kind}
                type="button"
                className={cx(
                  "chat-slot__chip",
                  chip.kind === item.kind && "chat-slot__chip--on",
                  chip.tone === "danger" && "chat-slot__chip--danger",
                )}
                aria-pressed={chip.kind === item.kind}
                aria-label={t("slotKindCount", {
                  kind: t(kindLabelKeys[chip.kind]),
                  count: chip.count,
                })}
                title={t(kindLabelKeys[chip.kind])}
                onClick={() => choose(chip.kind)}
              >
                {kindIcons[chip.kind]}
                <span className="tabular">{chip.count}</span>
                {chip.dot && <i className="chat-slot__dot" aria-hidden="true" />}
              </button>
            ))}
            {overflow.length > 0 && (
              <button
                ref={overflowRef}
                type="button"
                className="chat-slot__chip"
                aria-label={t("slotMore")}
                aria-expanded={overflowOpen}
                onClick={() => setOverflowOpen((value) => !value)}
              >
                <MoreHorizontal />
              </button>
            )}
          </div>
        )}
      </div>
      {overflowOpen && (
        <FloatingPopover
          anchorRef={overflowRef}
          placement="bottom-end"
          width={240}
          onDismiss={() => setOverflowOpen(false)}
        >
          <Menu label={t("slotMore")}>
            {overflow.map((entry) => (
              <MenuItem
                key={entry.kind}
                icon={kindIcons[entry.kind]}
                onClick={() => choose(entry.kind)}
              >
                {t("slotKindCount", {
                  kind: t(kindLabelKeys[entry.kind]),
                  count: entry.count,
                })}
              </MenuItem>
            ))}
          </Menu>
        </FloatingPopover>
      )}
      {open && unfolds && (
        <ChatTasksDrop
          tasks={taskMessages}
          viewer={viewer}
          members={members}
          canCreate={canCreateTask}
          onOpenTask={(id) => {
            setOpen(false);
            onJump(id);
          }}
          onAll={() => {
            setOpen(false);
            navigate(`/chat/${chatID}/tasks`);
          }}
          onNew={() => {
            setOpen(false);
            onNewTask();
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
