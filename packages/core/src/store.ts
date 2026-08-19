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
  resetDurable(checkpoint: number): void;
};
const emptyUnread: UnreadSnapshot = { chats: [], threads: [] };
export function createMessengerStore(checkpoint = 0): StoreApi<MessengerState> {
  return createStore<MessengerState>((set, get) => ({
    chats: {},
    messages: {},
    unread: emptyUnread,
    typing: {},
    presence: {},
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
        if (event.type.startsWith("message.")) {
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
            messages = { ...messages, [chatID]: uniqueSorted(next) };
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
    resetDurable: (value) =>
      set({ chats: {}, messages: {}, unread: emptyUnread, checkpoint: value }),
  }));
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
