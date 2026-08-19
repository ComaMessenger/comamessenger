import { openDB } from "idb";
import type {
  CheckpointStorage,
  OutboxItem,
  OutboxStorage,
} from "@comamessenger/core";

const database = openDB("coma-client", 1, {
  upgrade(db) {
    db.createObjectStore("meta");
    db.createObjectStore("outbox", { keyPath: "input.client_msg_id" });
  },
});

export const checkpointStorage: CheckpointStorage = {
  async get() {
    return Number((await (await database).get("meta", "checkpoint")) ?? 0);
  },
  async set(value) {
    await (await database).put("meta", value, "checkpoint");
  },
  async clear() {
    await (await database).delete("meta", "checkpoint");
  },
};

export const outboxStorage: OutboxStorage = {
  async list() {
    return (await (await database).getAll("outbox")) as OutboxItem[];
  },
  async put(value) {
    await (await database).put("outbox", value);
  },
  async delete(clientMsgID) {
    await (await database).delete("outbox", clientMsgID);
  },
};
