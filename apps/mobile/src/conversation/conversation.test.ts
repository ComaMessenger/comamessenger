import { describe, expect, it } from "vitest";
import { feedRows, type ClientMessage } from "@comamessenger/core";
import { bubbleCorners, bubblePlacement, messageMarks } from "./bubbles";
import { canPinIn, messageMenu, type MessageMenuFacts } from "./menuItems";

function message(id: string, actor: string, minute: number): ClientMessage {
  return {
    id,
    chat_id: "chat",
    actor_id: actor,
    client_msg_id: id,
    type: "text",
    body: id,
    body_format: "markdown",
    version: 1,
    created_seq: minute,
    created_at: `2026-11-11T09:${String(minute).padStart(2, "0")}:00Z`,
    mentioned_actor_ids: [],
    thread_reply_count: 0,
    files: [],
  };
}

describe("bubblePlacement", () => {
  const rows = feedRows(
    [
      message("a", "anna", 1),
      message("b", "anna", 2),
      message("c", "anna", 3),
      message("d", "me", 4),
      message("e", "anna", 30),
    ],
    0,
  );

  it("names the first bubble of a run and puts the avatar by the last", () => {
    const first = bubblePlacement(rows, 0, "me", true);
    const middle = bubblePlacement(rows, 1, "me", true);
    const last = bubblePlacement(rows, 2, "me", true);
    expect(first).toMatchObject({
      first: true,
      last: false,
      showName: true,
      showAvatar: false,
    });
    expect(middle).toMatchObject({
      first: false,
      last: false,
      showName: false,
      showAvatar: false,
      avatarColumn: true,
    });
    expect(last).toMatchObject({
      first: false,
      last: true,
      showName: false,
      showAvatar: true,
    });
  });

  it("never names or pictures the reader's own messages", () => {
    expect(bubblePlacement(rows, 3, "me", true)).toMatchObject({
      own: true,
      showName: false,
      avatarColumn: false,
      showAvatar: false,
    });
  });

  it("starts a new run after a pause and in direct chats shows no author", () => {
    expect(bubblePlacement(rows, 4, "me", true).first).toBe(true);
    expect(bubblePlacement(rows, 0, "me", false)).toMatchObject({
      showName: false,
      avatarColumn: false,
    });
  });

  it("lets a leading row start a run even when grouped", () => {
    expect(bubblePlacement(rows, 1, "me", true, true)).toMatchObject({
      first: true,
      showName: true,
    });
  });

  it("tucks the author's side of the bubble", () => {
    expect(bubbleCorners({ own: true, first: true }, 18, 6)).toEqual({
      borderTopLeftRadius: 18,
      borderBottomLeftRadius: 18,
      borderTopRightRadius: 18,
      borderBottomRightRadius: 6,
    });
    expect(bubbleCorners({ own: false, first: false }, 18, 6)).toMatchObject({
      borderTopLeftRadius: 6,
      borderBottomLeftRadius: 6,
      borderTopRightRadius: 18,
    });
  });
});

describe("messageMenu", () => {
  const base: MessageMenuFacts = {
    own: false,
    canModerate: false,
    canPin: false,
    pinned: false,
    saved: false,
    inThread: false,
    hasText: true,
    persisted: true,
  };

  it("keeps the web order and hides edit and delete on someone else's message", () => {
    expect(messageMenu(base)).toEqual([
      ["reply", "thread"],
      ["save", "forward", "details"],
      ["copyLink", "copyText"],
    ]);
  });

  it("lets the author edit and delete, and a moderator delete only", () => {
    expect(messageMenu({ ...base, own: true }).slice(-2)).toEqual([
      ["edit"],
      ["delete"],
    ]);
    const moderated = messageMenu({ ...base, canModerate: true });
    expect(moderated.at(-1)).toEqual(["delete"]);
    expect(moderated.flat()).not.toContain("edit");
  });

  it("offers Important to everyone and pinning to chat admins", () => {
    expect(messageMenu({ ...base, saved: true })[1]![0]).toBe("unsave");
    expect(messageMenu({ ...base, canPin: true })[1]).toEqual([
      "save",
      "pin",
      "forward",
      "details",
    ]);
    expect(messageMenu({ ...base, canPin: true, pinned: true })[1]![1]).toBe(
      "unpin",
    );
    expect(canPinIn("owner")).toBe(true);
    expect(canPinIn("admin")).toBe(true);
    expect(canPinIn("member")).toBe(false);
    expect(canPinIn(undefined)).toBe(false);
  });

  it("has no thread item inside a thread and no text items without text", () => {
    const items = messageMenu({
      ...base,
      own: true,
      inThread: true,
      hasText: false,
    }).flat();
    expect(items).not.toContain("thread");
    expect(items).not.toContain("copyText");
    expect(items).not.toContain("edit");
    expect(items).toContain("delete");
  });

  it("leaves only copying for a message the server does not have yet", () => {
    expect(messageMenu({ ...base, own: true, persisted: false })).toEqual([
      ["copyText"],
    ]);
  });
});

describe("messageMarks", () => {
  it("shows the chat's pin and the reader's star side by side", () => {
    expect(messageMarks({ pinned: true, saved: true, deleted: false })).toEqual(
      ["pin", "star"],
    );
    expect(
      messageMarks({ pinned: true, saved: false, deleted: false }),
    ).toEqual(["pin"]);
    expect(
      messageMarks({ pinned: false, saved: true, deleted: false }),
    ).toEqual(["star"]);
    expect(messageMarks({ pinned: true, saved: true, deleted: true })).toEqual(
      [],
    );
  });
});
