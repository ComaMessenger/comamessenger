import type {
  Chat,
  ChatMember,
  ClientMessage,
  UnreadSnapshot,
  User,
} from "@comamessenger/core";
import { cacheStorage } from "@/lib/database";
import type { MessengerStore } from "./MessengerProvider";

const messagesPerChat = 50;

export type CachedShell = {
  chats: Chat[];
  unread: UnreadSnapshot;
  pinnedChatIDs: string[];
};

export function cachedUser() {
  return cacheStorage.get<User>("user");
}

export function cacheUser(user: User) {
  return cacheStorage.set("user", user);
}

export function cacheShell(shell: CachedShell) {
  return cacheStorage.set("shell", shell);
}

export function cachedShell() {
  return cacheStorage.get<CachedShell>("shell");
}

/** Only messages the server confirmed are cached; the outbox keeps the rest. */
function cacheable(messages: ClientMessage[]) {
  return messages
    .filter((message) => !message.delivery || message.delivery === "sent")
    .slice(-messagesPerChat);
}

/**
 * Mirrors message lists of the domain store into the cache, debounced per
 * chat, and returns the unsubscribe function.
 */
export function persistMessages(store: MessengerStore): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.messages === previous.messages) return;
    for (const chatID of Object.keys(state.messages)) {
      if (state.messages[chatID] === previous.messages[chatID]) continue;
      clearTimeout(timers.get(chatID));
      timers.set(
        chatID,
        setTimeout(() => {
          timers.delete(chatID);
          const messages = cacheable(store.getState().messages[chatID] ?? []);
          if (messages.length)
            void cacheStorage
              .set(`messages:${chatID}`, messages)
              .catch(() => undefined);
        }, 1000),
      );
    }
  });
  return () => {
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
  };
}

export async function cachedMessages(chatID: string) {
  return (await cacheStorage.get<ClientMessage[]>(`messages:${chatID}`)) ?? [];
}

/**
 * Runs a request and mirrors its result into the cache; offline, the last
 * saved result is returned instead of the network error.
 */
export async function withCache<T>(
  key: string,
  request: () => Promise<T>,
): Promise<T> {
  try {
    const value = await request();
    void cacheStorage.set(key, value).catch(() => undefined);
    return value;
  } catch (cause) {
    const saved = await cacheStorage.get<T>(key).catch(() => null);
    if (saved !== null) return saved;
    throw cause;
  }
}

export type { ChatMember };
