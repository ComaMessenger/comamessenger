import { createContext, useContext } from "react";
import type {
  ChatFolder,
  MessengerAPI,
  Outbox,
  RealtimeCoordinator,
  User,
  createMessengerStore,
} from "@comamessenger/core";

export type MessengerStore = ReturnType<typeof createMessengerStore>;

export type SearchRequest = {
  tab?: "people" | "messages";
  query?: string;
  chatID?: string;
};

export type ShellDialog =
  | { kind: "new-chat" }
  | { kind: "new-folder" }
  | { kind: "notifications" }
  | { kind: "status" }
  | { kind: "search"; request?: SearchRequest };

export type MessengerContextValue = {
  api: MessengerAPI;
  user: User;
  store: MessengerStore;
  coordinator: RealtimeCoordinator;
  outbox: Outbox;
  path: string;
  navigate(to: string): void;
  reload(): Promise<void>;
  /** Resolves once the first chat list / unread snapshot has been loaded. */
  whenReady(): Promise<void>;
  scheduleReload(): void;
  onUserUpdated(user: User): void;
  logout(): Promise<void>;
  folders: ChatFolder[];
  saveFolders(next: ChatFolder[]): Promise<void>;
  pinnedChatIDs: string[];
  togglePinnedChat(chatID: string): Promise<void>;
  snoozedUntil: string | null;
  updateSnooze(until: string | null): Promise<void>;
  openDialog(dialog: ShellDialog): void;
  closeDialog(): void;
};

export const MessengerContext = createContext<MessengerContextValue | null>(
  null,
);

export function useMessenger() {
  const value = useContext(MessengerContext);
  if (!value) throw new Error("useMessenger must be used inside <Messenger>");
  return value;
}
