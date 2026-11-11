import { beforeEach, describe, expect, it } from "vitest";
import type { OutboxItem } from "@comamessenger/core";
import { claimDrafts, getLocalDraft, setLocalDraft } from "./drafts";
import {
  dropForeignOutbox,
  ownedOutbox,
  type OwnedOutboxItem,
  type RawOutboxStore,
} from "./ownedOutbox";

function memory(items: OwnedOutboxItem[] = []): RawOutboxStore & {
  items: OwnedOutboxItem[];
} {
  const raw = {
    items,
    async list() {
      return [...raw.items];
    },
    async put(value: OwnedOutboxItem) {
      raw.items = [
        ...raw.items.filter(
          (item) => item.input.client_msg_id !== value.input.client_msg_id,
        ),
        value,
      ];
    },
    async delete(id: string) {
      raw.items = raw.items.filter((item) => item.input.client_msg_id !== id);
    },
  };
  return raw;
}

const item = (id: string): OutboxItem => ({
  chatID: "chat",
  input: { client_msg_id: id, body: id, body_format: "plain" },
  createdAt: "2026-11-11T10:00:00Z",
  attempts: 0,
});

describe("outbox per person", () => {
  it("never hands one person's queued messages to another", async () => {
    const raw = memory();
    await ownedOutbox(raw, "alexey").put(item("a1"));
    // A record written before owners existed belongs to nobody.
    await raw.put(item("legacy"));
    expect(await ownedOutbox(raw, "boris").list()).toEqual([]);
    expect(
      (await ownedOutbox(raw, "alexey").list()).map(
        (x) => x.input.client_msg_id,
      ),
    ).toEqual(["a1"]);
    // Boris cannot delete Alexey's record either.
    await ownedOutbox(raw, "boris").delete("a1");
    expect(raw.items).toHaveLength(2);
    // When Boris takes the browser, the rest is dropped.
    await ownedOutbox(raw, "boris").put(item("b1"));
    await dropForeignOutbox(raw, "boris");
    expect(raw.items.map((x) => x.input.client_msg_id)).toEqual(["b1"]);
    await dropForeignOutbox(raw, null);
    expect(raw.items).toEqual([]);
  });
});

describe("drafts per person", () => {
  beforeEach(() => localStorage.clear());

  it("are not visible to the next person and are removed for them", () => {
    claimDrafts("alexey");
    setLocalDraft("chat", null, "черновик Алексея");
    expect(getLocalDraft("chat", null)).toBe("черновик Алексея");
    // A draft saved by an earlier version, without an owner in the key.
    localStorage.setItem("coma-draft:chat:main", "старый");
    claimDrafts("boris");
    expect(getLocalDraft("chat", null)).toBe("");
    expect(
      Object.keys(localStorage).filter((key) => key.startsWith("coma-draft")),
    ).toEqual([]);
    setLocalDraft("chat", null, "черновик Бориса");
    claimDrafts(null);
    expect(Object.keys(localStorage)).toEqual([]);
  });
});
