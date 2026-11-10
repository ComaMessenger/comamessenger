import { describe, expect, it } from "vitest";
import type { Agent } from "@comamessenger/core";
import {
  actionLocked,
  actionMode,
  externalMode,
  withActionMode,
} from "./confirmation";
import { draftChatIDs, draftOf, updateOf } from "./draft";

describe("confirmation per action", () => {
  it("uses safe defaults and treats a mixed group as confirm", () => {
    expect(actionMode({}, "direct")).toBe("confirm");
    expect(actionMode({}, "post")).toBe("auto");
    expect(
      actionMode({ post_message: "auto", reply_in_thread: "confirm" }, "post"),
    ).toBe("confirm");
    expect(withActionMode({}, "post", "confirm")).toEqual({
      post_message: "confirm",
      reply_in_thread: "confirm",
    });
    expect(actionLocked(["add_reaction"], "react")).toBe(true);
  });

  it("lets the connection policy win for external tools", () => {
    expect(externalMode({ confirmation_policy: { put: "auto" } }, "put", true)).toBe(
      "confirm",
    );
    expect(externalMode({ confirmation_policy: { put: "auto" } }, "put", false)).toBe(
      "auto",
    );
    expect(externalMode({}, "put", false)).toBe("confirm");
    expect(externalMode({ require_write_confirmation: false }, "put", false)).toBe(
      "auto",
    );
  });
});

describe("reading and writing chats", () => {
  it("saves both lists and their union as chat_ids", () => {
    const agent = {
      chat_ids: ["a", "b"],
      read_chat_ids: ["a", "b"],
      write_chat_ids: ["a"],
      allowed_scopes: [],
    } as unknown as Agent;
    const draft = { ...draftOf(agent), write_chat_ids: ["c"] };
    expect(draftChatIDs(draft)).toEqual(["a", "b", "c"]);
    expect(updateOf(draft)).toMatchObject({
      chat_ids: ["a", "b", "c"],
      read_chat_ids: ["a", "b"],
      write_chat_ids: ["c"],
    });
  });

  it("keeps old agents working without the new fields", () => {
    const agent = { chat_ids: ["a"], allowed_scopes: [] } as unknown as Agent;
    const draft = draftOf(agent);
    expect(draft.read_chat_ids).toEqual(["a"]);
    expect(draft.write_chat_ids).toEqual(["a"]);
  });
});
