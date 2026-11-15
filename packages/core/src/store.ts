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
import { isAwayEvent, parseAwayEvent, type AwayOverrides } from "./away";
import {
  isPollEvent,
  mergePollViewer,
  newerPoll,
  parsePollEvent,
  pollReloadDelayMs,
  reducePoll,
  type PollCacheAccess,
  type PollCacheEntry,
  type PollViewers,
} from "./polls";
import {
  absorbEarlyTasks,
  parseTaskEvent,
  reduceTask,
  rememberTaskUpdate,
  type EarlyTaskUpdates,
  type TaskCacheAccess,
} from "./tasks";
import type {
  AwayPublic,
  Chat,
  ClientMessage,
  DurableEvent,
  MessageTask,
  PollState,
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
  /**
   * The reader's state of each poll, by message id (wave 4): the one source
   * for poll cards. Filled from REST (`poll_viewer` of feed pages is moved
   * here and dropped from the message, getPoll, votePoll, closePoll) and
   * the reader's own poll.vote.updated.
   */
  pollViewers: PollViewers;
  /**
   * Away statuses from actor.away.updated by person, fresher than any page
   * read before (null — removed). Read through currentAway/withCurrentAway.
   */
  awayOverrides: AwayOverrides;
  /** The signed-in person: tells whether the reader wrote a poll. */
  selfID: string | null;
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
  setSelfID(actorID: string | null): void;
  /** The poll and the reader's viewer of one message, as the cache has them. */
  pollEntry(messageID: string, chatID?: string): PollCacheEntry;
  /**
   * Puts a poll read by REST (getPoll, votePoll, closePoll, a «Ждут вас»
   * item) into the cache when it is not older than what is there.
   */
  setPollState(messageID: string, state: PollState, chatID?: string): void;
  /** Writes an entry as it is: an optimistic vote or the rollback. */
  setPollEntry(messageID: string, entry: PollCacheEntry, chatID?: string): void;
  /**
   * Reads a poll again (getPoll) after poll.updated when the reader sees
   * results: the counts per option are never in frames. Only for cards on
   * screen (mountPoll), pollReloadDelayMs after the last event.
   */
  setPollLoader(loader: PollLoader | null): void;
  /** A poll card is on screen; call the returned function when it leaves. */
  mountPoll(messageID: string): () => void;
  /** An away status learnt by REST or an event; null — removed. */
  setAwayOverride(actorID: string, away: AwayPublic | null): void;
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
/** getPoll of one message. */
export type PollLoader = (messageID: string) => Promise<PollState>;

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
  let pollLoader: PollLoader | null = null;
  // Poll cards on screen (several cards may show one poll) and pending reloads.
  const mountedPolls = new Map<string, number>();
  const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedulePollReload = (
    get: () => MessengerState,
    messageID: string,
    chatID?: string,
  ) => {
    if (!pollLoader || !mountedPolls.get(messageID)) return;
    const pending = pollTimers.get(messageID);
    if (pending) clearTimeout(pending);
    pollTimers.set(
      messageID,
      setTimeout(() => {
        pollTimers.delete(messageID);
        if (!pollLoader || !mountedPolls.get(messageID)) return;
        void pollLoader(messageID)
          .then((value) => get().setPollState(messageID, value, chatID))
          .catch(() => {
            // The card keeps the counters of the event; the next one retries.
          });
      }, pollReloadDelayMs),
    );
  };
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
    pollViewers: {},
    awayOverrides: {},
    selfID: null,
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
          pollViewers: absorbPollViewers(state.pollViewers, items),
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
          pollViewers: absorbPollViewers(state.pollViewers, items),
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
          pollViewers: absorbPollViewers(state.pollViewers, [message]),
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
    setSelfID: (selfID) => set({ selfID }),
    pollEntry: (messageID, chatID) => readPollEntry(get(), messageID, chatID),
    setPollState: (messageID, value, chatID) =>
      set((state) => {
        const current = readPollEntry(state, messageID, chatID);
        return writePollEntry(
          state,
          messageID,
          {
            poll: newerPoll(current.poll, value.poll),
            viewer: mergePollViewer(
              current.viewer ?? undefined,
              value.viewer,
              value.poll.version,
            ),
          },
          chatID,
        );
      }),
    setPollEntry: (messageID, entry, chatID) =>
      set((state) => writePollEntry(state, messageID, entry, chatID)),
    setPollLoader: (value) => {
      pollLoader = value;
    },
    mountPoll: (messageID) => {
      mountedPolls.set(messageID, (mountedPolls.get(messageID) ?? 0) + 1);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const left = (mountedPolls.get(messageID) ?? 1) - 1;
        if (left > 0) {
          mountedPolls.set(messageID, left);
          return;
        }
        mountedPolls.delete(messageID);
        const pending = pollTimers.get(messageID);
        if (pending) clearTimeout(pending);
        pollTimers.delete(messageID);
      };
    },
    setAwayOverride: (actorID, away) =>
      set((state) => ({
        awayOverrides: { ...state.awayOverrides, [actorID]: away },
      })),
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
      if (isPollEvent(event.type)) {
        const parsed = parsePollEvent(event);
        let reload = false;
        set((state) => {
          if (!parsed || parsed.type === "poll.notified")
            return { checkpoint: event.seq };
          const messageID = parsed.data.message_id;
          const entry = readPollEntry(state, messageID, parsed.data.chat_id);
          const found = findMessage(
            state.messages,
            messageID,
            parsed.data.chat_id,
          );
          const author = found
            ? state.messages[found.chatID]![found.index]!.actor_id
            : null;
          const result = reducePoll(entry, parsed, {
            isAuthor: Boolean(state.selfID && author === state.selfID),
          });
          reload = result.reload;
          if (!result.changed) return { checkpoint: event.seq };
          return {
            ...writePollEntry(state, messageID, result, parsed.data.chat_id),
            checkpoint: event.seq,
          };
        });
        if (reload && parsed)
          schedulePollReload(get, parsed.data.message_id, parsed.data.chat_id);
        return true;
      }
      if (isAwayEvent(event.type)) {
        const parsed = parseAwayEvent(event);
        set((state) =>
          parsed?.type === "actor.away.updated"
            ? {
                awayOverrides: {
                  ...state.awayOverrides,
                  [parsed.data.actor_id]: parsed.data.away,
                },
                checkpoint: event.seq,
              }
            : { checkpoint: event.seq },
        );
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
        pollViewers: {},
        awayOverrides: {},
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
  // And poll.updated.
  if (
    current.poll &&
    incoming.poll &&
    current.poll.version > incoming.poll.version
  )
    merged.poll = current.poll;
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
  return keepNewerPolls(cached, keepNewerTaskItems(cached, incoming));
}

/** The same for polls: a cached poll.updated beats an older page. */
function keepNewerPolls(
  cached: readonly ClientMessage[],
  incoming: ClientMessage[],
): ClientMessage[] {
  if (!cached.some((item) => item.poll)) return incoming;
  const polls = new Map(
    cached
      .filter((item) => item.poll)
      .map((item) => [item.id, item.poll!] as const),
  );
  return incoming.map((item) => {
    const poll = polls.get(item.id);
    return poll && item.poll && poll.version > item.poll.version
      ? { ...item, poll }
      : item;
  });
}

function keepNewerTaskItems(
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

/** The message without its REST-only viewers: the store keeps viewers apart. */
function withoutViewer<T extends ClientMessage>(message: T): T {
  if (!("request_viewer" in message) && !("poll_viewer" in message))
    return message;
  const rest = { ...message };
  delete rest.request_viewer;
  delete rest.poll_viewer;
  return rest;
}

function absorbPollViewers(
  viewers: PollViewers,
  messages: readonly ClientMessage[],
): PollViewers {
  let next = viewers;
  for (const message of messages) {
    if (!message.poll || !message.poll_viewer) continue;
    if (next === viewers) next = { ...viewers };
    next[message.id] = mergePollViewer(
      next[message.id],
      message.poll_viewer,
      message.poll.version,
    );
  }
  return next;
}

function readPollEntry(
  state: Pick<MessengerState, "messages" | "pollViewers">,
  messageID: string,
  chatID?: string,
): PollCacheEntry {
  const found = findMessage(state.messages, messageID, chatID);
  return {
    poll: found
      ? (state.messages[found.chatID]![found.index]!.poll ?? null)
      : null,
    viewer: state.pollViewers[messageID] ?? null,
  };
}

function writePollEntry(
  state: Pick<MessengerState, "messages" | "pollViewers">,
  messageID: string,
  entry: PollCacheEntry,
  chatID?: string,
): Pick<MessengerState, "messages" | "pollViewers"> {
  let { messages, pollViewers } = state;
  const found = entry.poll ? findMessage(messages, messageID, chatID) : null;
  if (found && entry.poll) {
    const list = [...messages[found.chatID]!];
    list[found.index] = { ...list[found.index]!, poll: entry.poll };
    messages = { ...messages, [found.chatID]: list };
  }
  if (entry.viewer) pollViewers = { ...pollViewers, [messageID]: entry.viewer };
  else if (pollViewers[messageID]) {
    pollViewers = { ...pollViewers };
    delete pollViewers[messageID];
  }
  return { messages, pollViewers };
}

/**
 * The cache access performPollAction works through, over the messenger
 * store: the poll and the viewer of one message.
 */
export function storePollCache(
  store: StoreApi<MessengerState>,
  messageID: string,
  chatID?: string,
): PollCacheAccess {
  return {
    read: () => store.getState().pollEntry(messageID, chatID),
    write: (entry) => store.getState().setPollEntry(messageID, entry, chatID),
  };
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
