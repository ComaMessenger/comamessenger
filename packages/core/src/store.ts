import { createStore, type StoreApi } from "zustand/vanilla";
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
  presence: Record<string, "online" | "away" | "offline">;
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
  setUnread(value: UnreadSnapshot): void;
  setRealtime(value: RealtimeState): void;
  setActive(chatID: string | null): void;
  setTyping(chatID: string, actorID: string, active: boolean): void;
  setPresence(actorID: string, state: "online" | "away" | "offline"): void;
  setAgentStatus(value: AgentStatusState): void;
  applyMessageStream(value: MessageStreamFrame): void;
  clearAgentEphemeral(): void;
  resetDurable(checkpoint: number): void;
};
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
const emptyUnread: UnreadSnapshot = { chats: [], threads: [] };
export function createMessengerStore(checkpoint = 0): StoreApi<MessengerState> {
  return createStore<MessengerState>((set, get) => ({
    chats: {},
    messages: {},
    unread: emptyUnread,
    typing: {},
    presence: {},
    agentStatuses: {},
    messageStreams: {},
    checkpoint,
    realtime: "idle",
    activeChatID: null,
    replaceChats: (items) =>
      set({ chats: Object.fromEntries(items.map((item) => [item.id, item])) }),
    replaceMessages: (chatID, items) =>
      set((state) => ({
        messages: { ...state.messages, [chatID]: uniqueSorted(items) },
      })),
    prependMessages: (chatID, items) =>
      set((state) => ({
        messages: {
          ...state.messages,
          [chatID]: uniqueSorted([...items, ...(state.messages[chatID] ?? [])]),
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
    apply: (event) => {
      if (event.seq <= get().checkpoint) return false;
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
            const delivered: ClientMessage = { ...incoming, delivery: "sent" };
            const next: ClientMessage[] =
              byID >= 0
                ? current.map((item, index) =>
                    index === byID ? { ...item, ...delivered } : item,
                  )
                : [...current, delivered];
            let withThreadCount = next;
            if (incoming.thread_root_id && event.type !== "message.updated") {
              const delta = event.type === "message.created" ? 1 : -1;
              withThreadCount = next.map((item) =>
                item.id === incoming.thread_root_id
                  ? {
                      ...item,
                      thread_reply_count: Math.max(
                        0,
                        item.thread_reply_count + delta,
                      ),
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
      return true;
    },
    setUnread: (unread) => set({ unread }),
    setRealtime: (realtime) => set({ realtime }),
    setActive: (activeChatID) => set({ activeChatID }),
    setTyping: (chatID, actorID, active) =>
      set((state) => {
        const values = new Set(state.typing[chatID] ?? []);
        if (active) values.add(actorID);
        else values.delete(actorID);
        return { typing: { ...state.typing, [chatID]: [...values] } };
      }),
    setPresence: (actorID, value) =>
      set((state) => ({ presence: { ...state.presence, [actorID]: value } })),
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
function expiryDelay(expiresAt: string): number {
  return Math.max(0, Math.min(60_000, Date.parse(expiresAt) - Date.now() + 25));
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
          position === index ? { ...item, ...delivered } : item,
        )
      : [...current, delivered];
  return { ...input, [incoming.chat_id]: uniqueSorted(next) };
}
