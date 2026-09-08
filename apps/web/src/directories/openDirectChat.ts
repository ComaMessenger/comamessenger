import type { MessengerAPI } from "@comamessenger/core";
import type { MessengerStore } from "../shell/MessengerContext";

/** Finds the existing direct chat with an actor or creates one, then returns its id. */
export async function openDirectChat(
  api: MessengerAPI,
  store: MessengerStore,
  actorID: string,
): Promise<string> {
  const existing = Object.values(store.getState().chats).find(
    (chat) => chat.kind === "direct" && chat.direct_peer?.actor_id === actorID,
  );
  if (existing) return existing.id;
  const chat = await api.createChat({
    kind: "direct",
    visibility: "private",
    name: "",
    topic: "",
    member_ids: [actorID],
  });
  store.setState((state) => ({ chats: { ...state.chats, [chat.id]: chat } }));
  return chat.id;
}
