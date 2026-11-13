import type { OutboxItem, OutboxStorage } from "@comamessenger/core";

/** An outbox record with the person who queued it. */
export type OwnedOutboxItem = OutboxItem & { owner?: string };

/** The raw outbox store of the browser, shared by everyone who signs in. */
export interface RawOutboxStore {
  list(): Promise<OwnedOutboxItem[]>;
  put(value: OwnedOutboxItem): Promise<void>;
  delete(clientMsgID: string): Promise<void>;
}

/**
 * The outbox of one person: records carry their id, and only their records
 * are read. Another person signed in on the same browser never sees, nor
 * sends, them (records saved before owners existed are nobody's).
 */
export function ownedOutbox(raw: RawOutboxStore, owner: string): OutboxStorage {
  return {
    async list() {
      return (await raw.list())
        .filter((item) => item.owner === owner)
        .map(({ owner: _owner, ...item }) => item);
    },
    async put(value) {
      await raw.put({ ...value, owner });
    },
    async delete(clientMsgID) {
      const mine = (await raw.list()).some(
        (item) =>
          item.input.client_msg_id === clientMsgID && item.owner === owner,
      );
      if (mine) await raw.delete(clientMsgID);
    },
  };
}

/** Removes queued messages of anyone but `owner` (everyone's on sign-out). */
export async function dropForeignOutbox(
  raw: RawOutboxStore,
  owner: string | null,
): Promise<void> {
  for (const item of await raw.list())
    if (item.owner !== owner || owner === null)
      await raw.delete(item.input.client_msg_id);
}
