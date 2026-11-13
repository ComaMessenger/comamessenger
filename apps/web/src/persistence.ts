import { openDB } from "idb";
import type { CheckpointStorage, OutboxStorage } from "@comamessenger/core";
import { claimDrafts } from "./lib/drafts";
import {
  dropForeignOutbox,
  ownedOutbox,
  type OwnedOutboxItem,
  type RawOutboxStore,
} from "./lib/ownedOutbox";

const database = openDB("coma-client", 1, {
  upgrade(db) {
    db.createObjectStore("meta");
    db.createObjectStore("outbox", { keyPath: "input.client_msg_id" });
  },
});

const rawOutbox: RawOutboxStore = {
  async list() {
    return (await (await database).getAll("outbox")) as OwnedOutboxItem[];
  },
  async put(value) {
    await (await database).put("outbox", value);
  },
  async delete(clientMsgID) {
    await (await database).delete("outbox", clientMsgID);
  },
};

export function outboxStorageFor(owner: string): OutboxStorage {
  return ownedOutbox(rawOutbox, owner);
}

/** Realtime position of one person (another person's events differ). */
export function checkpointStorageFor(owner: string): CheckpointStorage {
  const key = `checkpoint:${owner}`;
  return {
    async get() {
      return Number((await (await database).get("meta", key)) ?? 0);
    },
    async set(value) {
      await (await database).put("meta", value, key);
    },
    async clear() {
      await (await database).delete("meta", key);
    },
  };
}

/**
 * Called whenever the signed-in person changes (and with null on sign-out):
 * drafts switch owner at once; queued messages, checkpoints and drafts of
 * anyone else are removed from this browser.
 */
export function claimClientStorage(owner: string | null): Promise<void> {
  claimDrafts(owner);
  return (async () => {
    await dropForeignOutbox(rawOutbox, owner);
    const db = await database;
    for (const key of await db.getAllKeys("meta"))
      if (key !== `checkpoint:${owner}`) await db.delete("meta", key);
  })().catch(() => undefined);
}
