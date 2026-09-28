import { APIError, type Draft, type MessengerAPI } from "@comamessenger/core";
import { draftStorage } from "./database";

/** Server drafts from other devices replace local copies on sign-in. */
export async function hydrateDrafts(drafts: Draft[]): Promise<void> {
  for (const draft of drafts)
    await draftStorage.set(draft.chat_id, draft.thread_root_id ?? null, {
      body: draft.body,
      version: draft.version,
    });
}

/**
 * Saves the composer text locally at once and mirrors it to the server with
 * optimistic versioning; on a version conflict the local text wins.
 */
export async function syncDraft(
  api: MessengerAPI,
  chatID: string,
  threadRootID: string | null,
  body: string,
): Promise<void> {
  const local = await draftStorage.get(chatID, threadRootID);
  await draftStorage.set(chatID, threadRootID, {
    body,
    version: local.version,
  });
  if (!body) {
    await api
      .deleteDraft(chatID, threadRootID ?? undefined)
      .catch(() => undefined);
    return;
  }
  const save = async (version: number) => {
    const saved = await api.putDraft(
      chatID,
      body,
      version,
      threadRootID ?? undefined,
    );
    await draftStorage.set(chatID, threadRootID, {
      body,
      version: saved.version,
    });
  };
  try {
    await save(local.version);
  } catch (cause) {
    if (!(cause instanceof APIError) || cause.status !== 409) return;
    try {
      const current = (await api.drafts()).find(
        (item) =>
          item.chat_id === chatID &&
          (item.thread_root_id ?? null) === threadRootID,
      );
      await save(current?.version ?? 0);
    } catch {
      // The local draft stays authoritative until the next edit.
    }
  }
}
