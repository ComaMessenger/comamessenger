import { createStore, type StoreApi } from "zustand/vanilla";
import { completeMessage } from "./messageShape";
import type { TypingAction } from "./presenceText";
import type {
  Chat,
  ClientMessage,
  DurableEvent,
  RealtimeState,
  UnreadSnapshot,
} from "./types";

export type MessengerState = {
  chats: Record<string, Chat>;
  messages: Record<string, ClientMessage[]>;
  unread: UnreadSnapshot;
  typing: Record<string, string[]>;
  /**
   * What each person is doing, by scope: the chat ID for the chat itself,
   * `${chatID}:${threadRootID}` inside a thread. Entries expire on their own.
   */
  typingActions: Record<string, Record<string, TypingActionState>>;
  presence: Record<string, "online" | "away" | "offline">;
  /** Exact last seen learnt from realtime frames, newer than REST. */
  lastSeen: Record<string, string>;
  agentStatuses: Record<string, AgentStatusState>;
  messageStreams: Record<string, MessageStreamState>;
  checkpoint: number;
  realtime: RealtimeState;
  activeChatID: string | null;
  replaceChats(chats: Chat[]): void;
  replaceMessages(chatID: string, messages: ClientMessage[]): void;
  prependMessages(chatID: string, messages: ClientMessage[]): void;
  optimistic(message: ClientMessage): void;
  reconcile(message: ClientMessage): void;
  retrying(clientMsgID: string): void;
  failed(clientMsgID: string, code: string): void;
  apply(event: DurableEvent): boolean;
  /**
   * Loads a whole message by REST when a realtime frame was too large and
   * came as a stub (`truncated: true`). Without a loader the stub is kept.
   */
  setMessageLoader(loader: MessageLoader | null): void;
  setUnread(value: UnreadSnapshot): void;
  setRealtime(value: RealtimeState): void;
  setActive(chatID: string | null): void;
  setTyping(
    chatID: string,
    actorID: string,
    active: boolean,
    options?: {
      action?: TypingAction;
      expiresAt?: string;
      threadRootID?: string | null;
    },
  ): void;
  setPresence(
    actorID: string,
    state: "online" | "away" | "offline",
    options?: { expiresAt?: string; lastSeenAt?: string },
  ): void;
  /** Everyone online or away right now, sent once after connecting. */
  applyPresenceSnapshot(
    entries: { actorID: string; state: "online" | "away"; expiresAt: string }[],
  ): void;
  /** Typing is short-lived: drop it whenever the socket goes. */
  clearTyping(): void;
  setAgentStatus(value: AgentStatusState): void;
  applyMessageStream(value: MessageStreamFrame): void;
  clearAgentEphemeral(): void;
  resetDurable(checkpoint: number): void;
};
export type TypingActionState = { action: TypingAction; expiresAt: number };
export function typingScope(chatID: string, threadRootID?: string | null) {
  return threadRootID ? `${chatID}:${threadRootID}` : chatID;
}
export type AgentStatusState = {
  runID: string;
  actorID: string;
  chatID: string;
  threadRootID: string | null;
  state:
    | "thinking"
    | "tool"
    | "streaming"
    | "completed"
    | "failed"
    | "canceled";
  expiresAt: string;
};
export type MessageStreamState = {
  streamID: string;
  runID: string;
  actorID: string;
  chatID: string;
  threadRootID: string | null;
  body: string;
  index: number;
  expiresAt: string;
};
export type MessageStreamFrame = Omit<MessageStreamState, "body"> & {
  delta: string;
  reset: boolean;
  done: boolean;
};
export type MessageLoader = (
  messageID: string,
) => Promise<ClientMessage | null>;

/** The loader every client uses: the message's context window by REST. */
export function restMessageLoader(api: {
  messageContext(
    messageID: string,
    limit?: number,
  ): Promise<{ messages: ClientMessage[] }>;
}): MessageLoader {
  return async (messageID) =>
    (await api.messageContext(messageID, 3)).messages.find(
      (item) => item.id === messageID,
    ) ?? null;
}
const emptyUnread: UnreadSnapshot = { chats: [], threads: [] };
export function createMessengerStore(checkpoint = 0): StoreApi<MessengerState> {
  let loader: MessageLoader | null = null;
  // Highest version requested per message: one request per stub, however
  // often the frame is replayed.
  const requested = new Map<string, number>();
  // Latest presence expiry per person: a newer frame cancels the old timer.
  const presenceExpiry = new Map<string, string>();
  return createStore<MessengerState>((set, get) => ({
    chats: {},
    messages: {},
    unread: emptyUnread,
    typing: {},
    typingActions: {},
    presence: {},
    lastSeen: {},
    agentStatuses: {},
    messageStreams: {},
    checkpoint,
    realtime: "idle",
    activeChatID: null,
    replaceChats: (items) =>
      set({ chats: Object.fromEntries(items.map((item) => [item.id, item])) }),
    replaceMessages: (chatID, items) =>
      set((state) => ({
        messages: {
          ...state.messages,
          [chatID]: uniqueSorted(items.map((item) => completeMessage(item))),
        },
      })),
    prependMessages: (chatID, items) =>
      set((state) => ({
        messages: {
          ...state.messages,
          [chatID]: uniqueSorted([
            ...items.map((item) => completeMessage(item)),
            ...(state.messages[chatID] ?? []),
          ]),
        },
      })),
    optimistic: (message) =>
      set((state) => ({
        messages: {
          ...state.messages,
          [message.chat_id]: uniqueSorted([
            ...(state.messages[message.chat_id] ?? []),
            message,
          ]),
        },
      })),
    reconcile: (message) =>
      set((state) => ({ messages: reconcileMessage(state.messages, message) })),
    retrying: (clientMsgID) =>
      set((state) => ({
        messages: mapMessages(state.messages, (item) =>
          item.client_msg_id === clientMsgID
            ? { ...item, delivery: "retrying" }
            : item,
        ),
      })),
    failed: (clientMsgID, code) =>
      set((state) => ({
        messages: mapMessages(state.messages, (item) =>
          item.client_msg_id === clientMsgID
            ? { ...item, delivery: "failed", errorCode: code }
            : item,
        ),
      })),
    setMessageLoader: (value) => {
      loader = value;
    },
    apply: (event) => {
      if (event.seq <= get().checkpoint) return false;
      const stub =
        (event.type === "message.created" ||
          event.type === "message.updated" ||
          event.type === "message.deleted") &&
        (event.data as { truncated?: unknown }).truncated === true
          ? (event.data as unknown as ClientMessage)
          : null;
      set((state) => {
        let messages = state.messages;
        if (
          event.type === "message.created" ||
          event.type === "message.updated" ||
          event.type === "message.deleted"
        ) {
          const incoming = event.data as unknown as ClientMessage;
          const chatID = incoming.chat_id ?? event.chat_id;
          if (chatID) {
            const current = messages[chatID] ?? [];
            const byID = current.findIndex(
              (item) =>
                item.id === incoming.id ||
                item.client_msg_id === incoming.client_msg_id,
            );
            // A stub stands for a frame too large to send; any other frame
            // may still be a partial message, so keep what is already known.
            const delivered: ClientMessage = stub
              ? truncatedMessage(stub, byID >= 0 ? current[byID] : undefined)
              : completeMessage(
                  { ...incoming, delivery: "sent" },
                  byID >= 0 ? current[byID] : undefined,
                );
            const next: ClientMessage[] =
              byID >= 0
                ? current.map((item, index) =>
                    index === byID
                      ? stub
                        ? delivered
                        : mergeMessage(item, delivered)
                      : item,
                  )
                : [...current, delivered];
            let withThreadCount = next;
            // A reply's frame carries its root's current count; servers
            // before it did not, and the client guessed ±1.
            const rootCount = incoming.thread_root_reply_count;
            const exact =
              typeof rootCount === "number" && Number.isFinite(rootCount);
            if (
              incoming.thread_root_id &&
              (exact || event.type !== "message.updated")
            ) {
              const delta = event.type === "message.created" ? 1 : -1;
              withThreadCount = next.map((item) =>
                item.id === incoming.thread_root_id
                  ? {
                      ...item,
                      thread_reply_count: exact
                        ? rootCount
                        : Math.max(0, (item.thread_reply_count ?? 0) + delta),
                    }
                  : item,
              );
            }
            messages = {
              ...messages,
              [chatID]: uniqueSorted(withThreadCount),
            };
          }
        }
        return { messages, checkpoint: event.seq };
      });
      if (stub && loader && (requested.get(stub.id) ?? 0) < stub.version) {
        requested.set(stub.id, stub.version);
        const load = loader;
        void load(stub.id)
          .then((full) => {
            if (!full) return;
            const known = (get().messages[full.chat_id] ?? []).find(
              (item) => item.id === full.id,
            );
            // A newer frame may have arrived while loading.
            if (known && known.version > full.version) return;
            get().reconcile(full);
          })
          .catch(() => {
            // The stub stays; the feed shows the message on its next load.
          });
      }
      return true;
    },
    setUnread: (unread) => set({ unread }),
    setRealtime: (realtime) => set({ realtime }),
    setActive: (activeChatID) => set({ activeChatID }),
    setTyping: (chatID, actorID, active, options = {}) => {
      const scope = typingScope(chatID, options.threadRootID);
      const expiresAt = options.expiresAt
        ? Date.parse(options.expiresAt)
        : Date.now() + 6_000;
      set((state) => {
        const values = new Set(state.typing[chatID] ?? []);
        if (active) values.add(actorID);
        else values.delete(actorID);
        const scoped = { ...state.typingActions[scope] };
        if (active)
          scoped[actorID] = { action: options.action ?? "typing", expiresAt };
        else delete scoped[actorID];
        return {
          typing: { ...state.typing, [chatID]: [...values] },
          typingActions: { ...state.typingActions, [scope]: scoped },
        };
      });
      if (!active) return;
      // A client that vanishes never says it stopped: expire on its own.
      const delay = expiryDelay(new Date(expiresAt).toISOString());
      setTimeout(() => {
        const current = get().typingActions[scope]?.[actorID];
        if (current?.expiresAt !== expiresAt) return;
        get().setTyping(chatID, actorID, false, {
          threadRootID: options.threadRootID ?? null,
        });
      }, delay);
    },
    setPresence: (actorID, value, options = {}) => {
      set((state) => ({
        presence: { ...state.presence, [actorID]: value },
        ...(options.lastSeenAt
          ? { lastSeen: { ...state.lastSeen, [actorID]: options.lastSeenAt } }
          : {}),
      }));
      if (value === "offline" || !options.expiresAt) return;
      const expiresAt = options.expiresAt;
      presenceExpiry.set(actorID, expiresAt);
      setTimeout(
        () => {
          if (presenceExpiry.get(actorID) !== expiresAt) return;
          presenceExpiry.delete(actorID);
          if (get().presence[actorID] === "offline") return;
          set((state) => ({
            presence: { ...state.presence, [actorID]: "offline" },
          }));
        },
        expiryDelay(expiresAt, 5 * 60_000),
      );
    },
    applyPresenceSnapshot: (entries) => {
      const listed = new Set(entries.map((entry) => entry.actorID));
      // The snapshot is complete: whoever it leaves out is gone.
      set((state) => {
        const next = { ...state.presence };
        for (const [actorID, value] of Object.entries(next))
          if (value !== "offline" && !listed.has(actorID))
            next[actorID] = "offline";
        return { presence: next };
      });
      for (const entry of entries)
        get().setPresence(entry.actorID, entry.state, {
          expiresAt: entry.expiresAt,
        });
    },
    clearTyping: () => set({ typing: {}, typingActions: {} }),
    setAgentStatus: (value) => {
      set((state) => {
        const next = { ...state.agentStatuses };
        if (
          value.state === "completed" ||
          Date.parse(value.expiresAt) <= Date.now()
        )
          delete next[value.runID];
        else next[value.runID] = value;
        return { agentStatuses: next };
      });
      const delay = expiryDelay(value.expiresAt);
      if (delay > 0)
        setTimeout(
          () =>
            set((state) => {
              if (
                state.agentStatuses[value.runID]?.expiresAt !== value.expiresAt
              )
                return state;
              const next = { ...state.agentStatuses };
              delete next[value.runID];
              return { agentStatuses: next };
            }),
          delay,
        );
    },
    applyMessageStream: (value) => {
      set((state) => {
        const next = { ...state.messageStreams };
        const current = next[value.streamID];
        if (value.done || Date.parse(value.expiresAt) <= Date.now()) {
          delete next[value.streamID];
        } else if (!current || value.index > current.index) {
          next[value.streamID] = {
            streamID: value.streamID,
            runID: value.runID,
            actorID: value.actorID,
            chatID: value.chatID,
            threadRootID: value.threadRootID,
            body: value.reset
              ? value.delta
              : (current?.body ?? "") + value.delta,
            index: value.index,
            expiresAt: value.expiresAt,
          };
        }
        return { messageStreams: next };
      });
      const delay = expiryDelay(value.expiresAt);
      if (!value.done && delay > 0)
        setTimeout(
          () =>
            set((state) => {
              if (
                state.messageStreams[value.streamID]?.expiresAt !==
                value.expiresAt
              )
                return state;
              const next = { ...state.messageStreams };
              delete next[value.streamID];
              return { messageStreams: next };
            }),
          delay,
        );
    },
    clearAgentEphemeral: () => set({ agentStatuses: {}, messageStreams: {} }),
    resetDurable: (value) =>
      set({
        chats: {},
        messages: {},
        unread: emptyUnread,
        agentStatuses: {},
        messageStreams: {},
        checkpoint: value,
      }),
  }));
}
function expiryDelay(expiresAt: string, cap = 60_000): number {
  return Math.max(0, Math.min(cap, Date.parse(expiresAt) - Date.now() + 25));
}
function uniqueSorted(items: ClientMessage[]): ClientMessage[] {
  const unique = new Map<string, ClientMessage>();
  for (const item of items)
    unique.set(item.id || item.client_msg_id, {
      ...unique.get(item.id || item.client_msg_id),
      ...item,
    });
  return [...unique.values()].sort((a, b) => a.created_seq - b.created_seq);
}
function mapMessages(
  input: Record<string, ClientMessage[]>,
  map: (item: ClientMessage) => ClientMessage,
) {
  return Object.fromEntries(
    Object.entries(input).map(([key, items]) => [key, items.map(map)]),
  );
}
function reconcileMessage(
  input: Record<string, ClientMessage[]>,
  incoming: ClientMessage,
): Record<string, ClientMessage[]> {
  const current = input[incoming.chat_id] ?? [];
  const index = current.findIndex(
    (item) =>
      item.id === incoming.id || item.client_msg_id === incoming.client_msg_id,
  );
  const delivered = { ...incoming, delivery: "sent" as const };
  const next =
    index >= 0
      ? current.map((item, position) =>
          position === index ? mergeMessage(item, delivered) : item,
        )
      : [...current, delivered];
  return { ...input, [incoming.chat_id]: uniqueSorted(next) };
}

/**
 * Merges a server representation into the cached message. Realtime payloads
 * omit hydrated lists (files, thread counters), so those are kept, but
 * `blocks` is authoritative: an absent field means the card was removed, for
 * example when the message was deleted.
 */
export function mergeMessage(
  current: ClientMessage,
  incoming: ClientMessage,
): ClientMessage {
  const merged: ClientMessage = { ...current, ...incoming };
  if (incoming.blocks === undefined) delete merged.blocks;
  return merged;
}

/**
 * A message from a truncated realtime frame: the stub's ids, version and
 * counters over what the client already knew (text, files, card), or empty
 * values, until the whole message is loaded by REST.
 */
function truncatedMessage(
  stub: ClientMessage,
  known: ClientMessage | undefined,
): ClientMessage {
  const partial: Partial<ClientMessage> = stub;
  const result: ClientMessage & { truncated?: boolean } = {
    ...known,
    ...stub,
    body: known?.body ?? "",
    files: known?.files ?? [],
    mentioned_actor_ids:
      partial.mentioned_actor_ids ?? known?.mentioned_actor_ids ?? [],
    thread_reply_count:
      partial.thread_reply_count ?? known?.thread_reply_count ?? 0,
    delivery: "sent",
  };
  if (known?.blocks !== undefined) result.blocks = known.blocks;
  if (stub.deleted_at) {
    result.body = "";
    delete result.blocks;
  }
  delete result.truncated;
  return result;
}
