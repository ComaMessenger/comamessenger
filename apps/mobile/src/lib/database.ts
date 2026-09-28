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
