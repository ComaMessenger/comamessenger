import { APIError, type Draft, type MessengerAPI } from "@comamessenger/core";

// Drafts belong to the signed-in person: keys carry their id, so the next
// person on this browser never reads them. Set by claimDrafts on sign-in.
let draftOwner = "";

const draftPrefix = "coma-draft:";
const versionPrefix = "coma-draft-version:";

function draftKey(chatID: string, threadID: string | null) {
  return `${draftPrefix}${draftOwner}:${chatID}:${threadID ?? "main"}`;
}

function draftVersionKey(chatID: string, threadID: string | null) {
  return `${versionPrefix}${draftOwner}:${chatID}:${threadID ?? "main"}`;
}

/**
 * Makes `owner` the person whose drafts are read and written, and removes
 * everyone else's drafts (all of them on sign-out, owner null), including
 * drafts saved before keys carried an owner.
 */
export function claimDrafts(owner: string | null) {
  draftOwner = owner ?? "";
  const keep =
    owner === null
      ? null
      : [`${draftPrefix}${owner}:`, `${versionPrefix}${owner}:`];
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && (key.startsWith(draftPrefix) || key.startsWith(versionPrefix)))
      keys.push(key);
  }
  for (const key of keys)
    if (!keep || !keep.some((prefix) => key.startsWith(prefix)))
      localStorage.removeItem(key);
}

export function getLocalDraft(chatID: string, threadID: string | null) {
  return localStorage.getItem(draftKey(chatID, threadID)) ?? "";
}

export function setLocalDraft(
  chatID: string,
  threadID: string | null,
  body: string,
) {
  if (body) localStorage.setItem(draftKey(chatID, threadID), body);
  else localStorage.removeItem(draftKey(chatID, threadID));
}

export function hydrateDrafts(drafts: Draft[]) {
  for (const draft of drafts) {
    const threadID = draft.thread_root_id ?? null;
    setLocalDraft(draft.chat_id, threadID, draft.body);
    localStorage.setItem(
      draftVersionKey(draft.chat_id, threadID),
      String(draft.version),
    );
  }
}

export async function syncDraft(
  api: MessengerAPI,
  chatID: string,
  threadID: string | null,
  body: string,
) {
  setLocalDraft(chatID, threadID, body);
  if (!body) {
    await api.deleteDraft(chatID, threadID ?? undefined).catch(() => undefined);
    localStorage.removeItem(draftVersionKey(chatID, threadID));
    return;
  }
  let version = Number(
    localStorage.getItem(draftVersionKey(chatID, threadID)) ?? 0,
  );
  try {
    const saved = await api.putDraft(
      chatID,
      body,
      version,
      threadID ?? undefined,
    );
    localStorage.setItem(
      draftVersionKey(chatID, threadID),
      String(saved.version),
    );
  } catch (cause) {
    if (!(cause instanceof APIError) || cause.status !== 409) return;
    try {
      const current = (await api.drafts()).find(
        (item) =>
          item.chat_id === chatID && (item.thread_root_id ?? null) === threadID,
      );
      version = current?.version ?? 0;
      const saved = await api.putDraft(
        chatID,
        body,
        version,
        threadID ?? undefined,
      );
      localStorage.setItem(
        draftVersionKey(chatID, threadID),
        String(saved.version),
      );
    } catch {
      // Local draft remains authoritative until the next reconnect/blur retry.
    }
  }
}
