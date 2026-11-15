import { createStore, type StoreApi } from "zustand/vanilla";
import { completeMessage } from "./messageShape";
import { parseInstant, type TypingAction } from "./presenceText";
import {
  isRequestEvent,
  mergeRequestViewer,
  parseRequestEvent,
  reduceRequest,
  type RequestCacheEntry,
  type RequestEvent,
  type RequestViewers,
} from "./requests";
import {
  absorbEarlyTasks,
  parseTaskEvent,
  reduceTask,
  rememberTaskUpdate,
  type EarlyTaskUpdates,
  type TaskCacheAccess,
} from "./tasks";
import type {
  Chat,
  ClientMessage,
  DurableEvent,
  MessageTask,
  RealtimeState,
  RequestState,
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
  /** HelloFrame.features of the current connection; empty before hello. */
  features: readonly string[];
  /**
   * The reader's part in each request, by message id: the one source for
   * request cards. Filled from REST (`request_viewer` of feed pages is moved
   * here and dropped from the message), request.assigned and the reader's
   * own answer events.
   */
  requestViewers: RequestViewers;
  /**
   * task.updated that ran ahead of its message (a page still loading,
   * message.created behind), by message id: put in when the message comes.
   */
  earlyTasks: EarlyTaskUpdates;
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
  /**
   * Reads a request again (getRequest) when an event says the reader's state
   * changed in a way it does not carry, such as a comment from another
   * device. Without a loader the cache keeps what it knows.
   */
  setRequestLoader(loader: RequestLoader | null): void;
  setFeatures(value: readonly string[]): void;
  /** The request and viewer of one message, as the cache has them. */
  requestEntry(messageID: string, chatID?: string): RequestCacheEntry;
  /**
   * Puts a request read by REST (getRequest, answerRequest, closeRequest,
   * an inbox item) into the cache: the message's request if it is loaded,
   * and the viewer map.
   */
  setRequestState(
    messageID: string,
    state: RequestState,
    chatID?: string,
  ): void;
  /**
   * Writes an entry as it is: an optimistic answer (optimisticAnswer) or the
   * entry kept to roll it back. A null viewer removes the reader's state.
   */
  setRequestEntry(
    messageID: string,
    entry: RequestCacheEntry,
    chatID?: string,
  ): void;
  /** Message.task of a cached message; null when it is not loaded. */
  taskOf(messageID: string, chatID?: string): MessageTask | null;
  /**
   * Writes a task as it is, older or not: an optimistic one, a rollback or
   * a REST reply (performTaskAction checks versions itself). A message not
   * loaded yet gets it when it comes, if it is newer.
   */
  setTask(messageID: string, task: MessageTask, chatID?: string): void;
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
export type RequestLoader = (messageID: string) => Promise<RequestState>;
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
  let requestLoader: RequestLoader | null = null;
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
    features: [],
    requestViewers: {},
    earlyTasks: {},
    replaceChats: (items) =>
      set({ chats: Object.fromEntries(items.map((item) => [item.id, item])) }),
    replaceMessages: (chatID, items) =>
      set((state) => {
        const early = absorbEarlyTasks(
          state.earlyTasks,
          keepNewerTasks(
            state.messages[chatID] ?? [],
            items.map((item) => withoutViewer(completeMessage(item))),
          ),
        );
        return {
          requestViewers: absorbViewers(state.requestViewers, items),
          earlyTasks: early.early,
          messages: {
            ...state.messages,
            [chatID]: uniqueSorted([...early.messages]),
          },
        };
      }),
    prependMessages: (chatID, items) =>
      set((state) => {
        const early = absorbEarlyTasks(
          state.earlyTasks,
          keepNewerTasks(
            state.messages[chatID] ?? [],
            items.map((item) => withoutViewer(completeMessage(item))),
          ),
        );
        return {
          requestViewers: absorbViewers(state.requestViewers, items),
          earlyTasks: early.early,
          messages: {
            ...state.messages,
            [chatID]: uniqueSorted([
              ...early.messages,
              ...(state.messages[chatID] ?? []),
            ]),
          },
        };
      }),
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
      set((state) => {
        const early = absorbEarlyTasks(state.earlyTasks, [
          withoutViewer(message),
        ]);
        return {
          requestViewers: absorbViewers(state.requestViewers, [message]),
          earlyTasks: early.early,
          messages: reconcileMessage(state.messages, early.messages[0]!),
        };
      }),
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
    setRequestLoader: (value) => {
      requestLoader = value;
    },
    setFeatures: (features) => set({ features: [...features] }),
    requestEntry: (messageID, chatID) => readEntry(get(), messageID, chatID),
    setRequestState: (messageID, value, chatID) =>
      set((state) => {
        const current = readEntry(state, messageID, chatID);
        const request =
          current.request && current.request.version > value.request.version
            ? current.request
            : value.request;
        return writeEntry(
          state,
          messageID,
          {
            request,
            viewer: mergeRequestViewer(
              state.requestViewers[messageID],
              value.viewer,
              value.request.version,
            ),
          },
          chatID,
        );
      }),
    setRequestEntry: (messageID, entry, chatID) =>
      set((state) => writeEntry(state, messageID, entry, chatID)),
    taskOf: (messageID, chatID) => {
      const state = get();
      const found = findMessage(state.messages, messageID, chatID);
      return found
        ? (state.messages[found.chatID]![found.index]!.task ?? null)
        : null;
    },
    setTask: (messageID, task, chatID) =>
      set((state) => {
        const found = findMessage(state.messages, messageID, chatID);
        if (!found)
          return {
            earlyTasks: rememberTaskUpdate(state.earlyTasks, {
              message_id: messageID,
              task,
            }),
          };
        const list = [...state.messages[found.chatID]!];
        list[found.index] = { ...list[found.index]!, task };
        return { messages: { ...state.messages, [found.chatID]: list } };
      }),
    apply: (event) => {
      if (event.seq <= get().checkpoint) return false;
      if (event.type === "task.updated" || event.type === "task.notified") {
        const parsed = parseTaskEvent(event);
        set((state) => {
          if (parsed?.type !== "task.updated") return { checkpoint: event.seq };
          const update = parsed.data;
          const found = findMessage(
            state.messages,
            update.message_id,
            update.chat_id,
          );
          if (!found)
            return {
              earlyTasks: rememberTaskUpdate(state.earlyTasks, update),
              checkpoint: event.seq,
            };
          const list = state.messages[found.chatID]!;
          const current = list[found.index]!;
          const next = reduceTask(current, update);
          if (next === current) return { checkpoint: event.seq };
          const copy = [...list];
          copy[found.index] = next;
          return {
            messages: { ...state.messages, [found.chatID]: copy },
            checkpoint: event.seq,
          };
        });
        return true;
      }
      if (isRequestEvent(event.type)) {
        const parsed = parseRequestEvent(event);
        let refetch = false;
        set((state) => {
          if (!parsed) return { checkpoint: event.seq };
          const result = applyRequestEvent(state, parsed);
          refetch = result.refetch;
          return { ...result.patch, checkpoint: event.seq };
        });
        if (refetch && parsed && requestLoader) {
          const messageID = parsed.data.message_id;
          const chatID = parsed.data.chat_id;
          void requestLoader(messageID)
            .then((value) => get().setRequestState(messageID, value, chatID))
            .catch(() => {
              // The card keeps what the event said; the next load fixes it.
            });
        }
        return true;
      }
      const stub =
        (event.type === "message.created" ||
          event.type === "message.updated" ||
          event.type === "message.deleted") &&
        (event.data as { truncated?: unknown }).truncated === true
          ? (event.data as unknown as ClientMessage)
          : null;
      set((state) => {
        let messages = state.messages;
        let earlyTasks = state.earlyTasks;
        if (
          event.type === "message.created" ||
          event.type === "message.updated" ||
          event.type === "message.deleted"
        ) {
          let incoming = event.data as unknown as ClientMessage;
          const early = state.earlyTasks[incoming.id];
          if (early) {
            if (incoming.task)
              incoming = reduceTask(incoming, {
                message_id: incoming.id,
                task: early,
              });
            earlyTasks = { ...state.earlyTasks };
            delete earlyTasks[incoming.id];
          }
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
        return { messages, earlyTasks, checkpoint: event.seq };
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
      const parsed = options.expiresAt ? parseInstant(options.expiresAt) : NaN;
      const expiresAt = Number.isNaN(parsed) ? Date.now() + 6_000 : parsed;
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
      set((state) => {
        const lastSeen = { ...state.lastSeen };
        if (options.lastSeenAt) lastSeen[actorID] = options.lastSeenAt;
        // Leaving without a time means the time is no longer ours to see
        // (the person hid it, or we did): drop the old exact one.
        else if (value !== "online") delete lastSeen[actorID];
        return { presence: { ...state.presence, [actorID]: value }, lastSeen };
      });
      // expires_at means nothing for "offline": the person is gone until a
      // new frame says otherwise.
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
          parseInstant(value.expiresAt) <= Date.now()
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
        if (value.done || parseInstant(value.expiresAt) <= Date.now()) {
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
        requestViewers: {},
        earlyTasks: {},
        checkpoint: value,
      }),
  }));
}
function expiryDelay(expiresAt: string, cap = 60_000): number {
  const at = parseInstant(expiresAt);
  if (Number.isNaN(at)) return cap;
  return Math.max(0, Math.min(cap, at - Date.now() + 25));
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
  // request.updated may have run ahead of a frame or page with the message.
  if (
    current.request &&
    incoming.request &&
    current.request.version > incoming.request.version
  )
    merged.request = current.request;
  // task.updated may have run ahead too.
  if (
    current.task &&
    incoming.task &&
    current.task.version > incoming.task.version
  )
    merged.task = current.task;
  return merged;
}

/**
 * A page read by REST may be older than a task.updated applied meanwhile:
 * the cached task stays when its version is higher.
 */
function keepNewerTasks(
  cached: readonly ClientMessage[],
  incoming: ClientMessage[],
): ClientMessage[] {
  if (!cached.some((item) => item.task)) return incoming;
  const tasks = new Map(
    cached
      .filter((item) => item.task)
      .map((item) => [item.id, item.task!] as const),
  );
  return incoming.map((item) => {
    const task = tasks.get(item.id);
    return task ? reduceTask(item, { message_id: item.id, task }) : item;
  });
}

/**
 * The cache access performTaskAction works through, over the messenger
 * store: the task of one cached message.
 */
export function storeTaskCache(
  store: StoreApi<MessengerState>,
  messageID: string,
  chatID?: string,
): TaskCacheAccess {
  return {
    read: () => store.getState().taskOf(messageID, chatID),
    write: (task) => store.getState().setTask(messageID, task, chatID),
  };
}

/** The message without its REST-only viewer: the store keeps viewers apart. */
function withoutViewer<T extends ClientMessage>(message: T): T {
  if (!("request_viewer" in message)) return message;
  const rest = { ...message };
  delete rest.request_viewer;
  return rest;
}

function absorbViewers(
  viewers: RequestViewers,
  messages: readonly ClientMessage[],
): RequestViewers {
  let next = viewers;
  for (const message of messages) {
    if (!message.request || !message.request_viewer) continue;
    if (next === viewers) next = { ...viewers };
    next[message.id] = mergeRequestViewer(
      next[message.id],
      message.request_viewer,
      message.request.version,
    );
  }
  return next;
}

function findMessage(
  messages: Record<string, ClientMessage[]>,
  messageID: string,
  chatID?: string,
): { chatID: string; index: number } | null {
  const chats = chatID ? [chatID] : Object.keys(messages);
  for (const key of chats) {
    const index = (messages[key] ?? []).findIndex(
      (item) => item.id === messageID,
    );
    if (index >= 0) return { chatID: key, index };
  }
  return null;
}

function readEntry(
  state: Pick<MessengerState, "messages" | "requestViewers">,
  messageID: string,
  chatID?: string,
): RequestCacheEntry {
  const found = findMessage(state.messages, messageID, chatID);
  return {
    request: found
      ? (state.messages[found.chatID]![found.index]!.request ?? null)
      : null,
    viewer: state.requestViewers[messageID] ?? null,
  };
}

function writeEntry(
  state: Pick<MessengerState, "messages" | "requestViewers">,
  messageID: string,
  entry: RequestCacheEntry,
  chatID?: string,
): Pick<MessengerState, "messages" | "requestViewers"> {
  let { messages, requestViewers } = state;
  const found = entry.request ? findMessage(messages, messageID, chatID) : null;
  if (found && entry.request) {
    const list = [...messages[found.chatID]!];
    list[found.index] = { ...list[found.index]!, request: entry.request };
    messages = { ...messages, [found.chatID]: list };
  }
  if (entry.viewer)
    requestViewers = { ...requestViewers, [messageID]: entry.viewer };
  else if (requestViewers[messageID]) {
    requestViewers = { ...requestViewers };
    delete requestViewers[messageID];
  }
  return { messages, requestViewers };
}

function applyRequestEvent(
  state: Pick<MessengerState, "messages" | "requestViewers">,
  event: RequestEvent,
): {
  patch: Partial<Pick<MessengerState, "messages" | "requestViewers">>;
  refetch: boolean;
} {
  const messageID = event.data.message_id;
  const result = reduceRequest(
    readEntry(state, messageID, event.data.chat_id),
    event,
    new Date(),
  );
  if (!result.changed) return { patch: {}, refetch: result.refetch };
  return {
    patch: writeEntry(state, messageID, result, event.data.chat_id),
    refetch: result.refetch,
  };
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
