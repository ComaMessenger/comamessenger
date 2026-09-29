import * as SQLite from "expo-sqlite";
import type {
  CheckpointStorage,
  OutboxItem,
  OutboxStorage,
} from "@comamessenger/core";
import { refreshTokenStore } from "./session";

// Append-only: each entry upgrades the schema by one `user_version`.
const migrations = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
   CREATE TABLE outbox (
     client_msg_id TEXT PRIMARY KEY NOT NULL,
     created_at TEXT NOT NULL,
     item TEXT NOT NULL
   );`,
  `CREATE TABLE drafts (
     chat_id TEXT NOT NULL,
     thread_root_id TEXT NOT NULL DEFAULT '',
     body TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (chat_id, thread_root_id)
   );`,
  // Read-only copy of recent server state for offline start (M5).
  `CREATE TABLE cache (
     key TEXT PRIMARY KEY NOT NULL,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
];

async function open(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync("coma.db");
  await db.execAsync("PRAGMA journal_mode = 'wal'");
  const row = await db.getFirstAsync<{ user_version: number }>(
    "PRAGMA user_version",
  );
  const version = row?.user_version ?? 0;
  // The iOS keychain survives reinstalling the app while this database does
  // not, so a fresh database must not resume an old session.
  if (version === 0) await refreshTokenStore.save(null);
  for (let next = version; next < migrations.length; next += 1)
    await db.withExclusiveTransactionAsync(async (tx) => {
      await tx.execAsync(migrations[next]!);
      await tx.execAsync(`PRAGMA user_version = ${next + 1}`);
    });
  return db;
}

export const database = open();

async function getMeta(key: string): Promise<string | null> {
  const row = await (
    await database
  ).getFirstAsync<{ value: string }>("SELECT value FROM meta WHERE key = ?", [
    key,
  ]);
  return row?.value ?? null;
}

async function setMeta(key: string, value: string | null): Promise<void> {
  const db = await database;
  if (value === null)
    await db.runAsync("DELETE FROM meta WHERE key = ?", [key]);
  else
    await db.runAsync(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
}

/** Drops everything tied to the signed-in account: realtime position and unsent messages. */
export async function clearUserData(): Promise<void> {
  const db = await database;
  await db.withExclusiveTransactionAsync(async (tx) => {
    await tx.runAsync("DELETE FROM outbox");
    await tx.runAsync("DELETE FROM drafts");
    await tx.runAsync("DELETE FROM cache");
    await tx.runAsync(
      "DELETE FROM meta WHERE key IN ('checkpoint', 'user_id')",
    );
  });
}

/**
 * Binds local data to the account that signed in. Another account on the same
 * device must never resume the previous checkpoint or send its queued messages.
 */
export async function claimUserData(userID: string): Promise<void> {
  const owner = await getMeta("user_id");
  if (owner && owner !== userID) await clearUserData();
  await setMeta("user_id", userID);
}

export const serverStorage = {
  get: () => getMeta("server_url"),
  set: (url: string | null) => setMeta("server_url", url),
};

export const checkpointStorage: CheckpointStorage = {
  async get() {
    return Number((await getMeta("checkpoint")) ?? 0);
  },
  set: (value) => setMeta("checkpoint", String(value)),
  clear: () => setMeta("checkpoint", null),
};

export const outboxStorage: OutboxStorage = {
  async list() {
    const rows = await (
      await database
    ).getAllAsync<{ item: string }>(
      "SELECT item FROM outbox ORDER BY created_at",
    );
    return rows.map((row) => JSON.parse(row.item) as OutboxItem);
  },
  async put(value) {
    await (
      await database
    ).runAsync(
      "INSERT INTO outbox (client_msg_id, created_at, item) VALUES (?, ?, ?) ON CONFLICT (client_msg_id) DO UPDATE SET item = excluded.item",
      [value.input.client_msg_id, value.createdAt, JSON.stringify(value)],
    );
  },
  async delete(clientMsgID) {
    await (
      await database
    ).runAsync("DELETE FROM outbox WHERE client_msg_id = ?", [clientMsgID]);
  },
};

export type LocalDraft = { body: string; version: number };

/** Unsent composer text per chat or thread; mirrors the server copy's version. */
export const draftStorage = {
  async get(chatID: string, threadRootID: string | null): Promise<LocalDraft> {
    const row = await (
      await database
    ).getFirstAsync<LocalDraft>(
      "SELECT body, version FROM drafts WHERE chat_id = ? AND thread_root_id = ?",
      [chatID, threadRootID ?? ""],
    );
    return row ?? { body: "", version: 0 };
  },
  async set(
    chatID: string,
    threadRootID: string | null,
    draft: LocalDraft,
  ): Promise<void> {
    const db = await database;
    if (!draft.body)
      await db.runAsync(
        "DELETE FROM drafts WHERE chat_id = ? AND thread_root_id = ?",
        [chatID, threadRootID ?? ""],
      );
    else
      await db.runAsync(
        "INSERT INTO drafts (chat_id, thread_root_id, body, version) VALUES (?, ?, ?, ?) ON CONFLICT (chat_id, thread_root_id) DO UPDATE SET body = excluded.body, version = excluded.version",
        [chatID, threadRootID ?? "", draft.body, draft.version],
      );
  },
};

// Bounded so the cache of a busy account stays small: the chat list plus the
// latest messages of the most recently viewed chats.
const cachedMessageChats = 50;

/** JSON snapshot storage for offline start; never a source of permissions. */
export const cacheStorage = {
  async get<T>(key: string): Promise<T | null> {
    const row = await (
      await database
    ).getFirstAsync<{ value: string }>(
      "SELECT value FROM cache WHERE key = ?",
      [key],
    );
    return row ? (JSON.parse(row.value) as T) : null;
  },
  async set(key: string, value: unknown): Promise<void> {
    const db = await database;
    await db.runAsync(
      "INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [key, JSON.stringify(value), Date.now()],
    );
    if (key.startsWith("messages:"))
      await db.runAsync(
        `DELETE FROM cache WHERE key LIKE 'messages:%' AND key NOT IN (
           SELECT key FROM cache WHERE key LIKE 'messages:%' ORDER BY updated_at DESC LIMIT ?
         )`,
        [cachedMessageChats],
      );
  },
};
