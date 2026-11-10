import { describe, expect, it } from "vitest";
import {
  actionResponder,
  actionState,
  audienceIncludes,
  canPress,
  confirmationFields,
  confirmationStatus,
  isConfirmationCard,
  grantsPermission,
  pressFailure,
  renderableBlocks,
} from "./blocks";
import { chatCommands, commandQuery, matchCommands } from "./commands";
import type { ChatAgent, MessageAction, MessageBlocks } from "./types";

const me = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const at = "2026-11-10T10:00:00Z";

function action(patch: Partial<MessageAction> = {}): MessageAction {
  return {
    id: "ack",
    label: "Принял слот",
    style: "primary",
    limit: "per_actor",
    closed: false,
    responses: [],
    ...patch,
  };
}

function blocks(actions: MessageAction[]): MessageBlocks {
  return { version: 1, card: { title: "Слот" }, actions };
}

describe("renderableBlocks", () => {
  it("falls back to the body for unknown versions, deletions and empty blocks", () => {
    const card = blocks([action()]);
    expect(renderableBlocks({ blocks: card, deleted_at: null })).toBe(card);
    expect(renderableBlocks({ blocks: { ...card, version: 2 }, deleted_at: null })).toBeNull();
    expect(renderableBlocks({ blocks: { ...card, version: 0 }, deleted_at: null })).toBeNull();
    expect(renderableBlocks({ blocks: card, deleted_at: at })).toBeNull();
    expect(renderableBlocks({ blocks: undefined, deleted_at: null })).toBeNull();
    expect(renderableBlocks({ blocks: { version: 1 }, deleted_at: null })).toBeNull();
    expect(
      renderableBlocks({
        blocks: { version: 1, sources: [{ kind: "document", title: "Регламент" }] },
        deleted_at: null,
      }),
    ).not.toBeNull();
  });
});

describe("audienceIncludes", () => {
  it("decides only what the client can know", () => {
    expect(audienceIncludes(undefined, { actorID: me })).toBe(true);
    expect(audienceIncludes({}, { actorID: me })).toBe(true);
    expect(audienceIncludes({ actor_ids: [me] }, { actorID: me })).toBe(true);
    expect(audienceIncludes({ actor_ids: [other] }, { actorID: me })).toBe(false);
    expect(
      audienceIncludes({ chat_roles: ["admin"] }, { actorID: me, chatRole: "member" }),
    ).toBe(false);
    expect(audienceIncludes({ chat_roles: ["admin"] }, { actorID: me })).toBeUndefined();
    expect(
      audienceIncludes({ permissions: ["agents.approve"] }, { actorID: me, orgRole: "member" }),
    ).toBeUndefined();
    expect(
      audienceIncludes(
        { permissions: ["agents.approve"] },
        { actorID: me, hasPermission: (value) => value === "agents.approve" },
      ),
    ).toBe(true);
    expect(
      audienceIncludes(
        { actor_ids: [other], org_roles: ["admin"] },
        { actorID: me, orgRole: "member", hasPermission: () => false },
      ),
    ).toBe(false);
  });
});

describe("actionState", () => {
  const viewer = { actorID: me, chatRole: "member" as const, orgRole: "member" as const };

  it("is available, then pending, then pressed by me", () => {
    const fresh = action();
    expect(actionState(fresh, blocks([fresh]), viewer)).toBe("available");
    expect(actionState(fresh, blocks([fresh]), viewer, { pending: true })).toBe("pending");
    const pressed = action({ responses: [{ actor_id: me, responded_at: at }] });
    expect(actionState(pressed, blocks([pressed]), viewer, { pending: true })).toBe("pressed");
    expect(canPress("pressed")).toBe(false);
    expect(canPress("available")).toBe(true);
  });

  it("stays available for others under per_actor and closes for everyone under single", () => {
    const shared = action({ responses: [{ actor_id: other, responded_at: at }] });
    expect(actionState(shared, blocks([shared]), viewer)).toBe("available");
    const taken = action({
      limit: "single",
      closed: true,
      responses: [{ actor_id: other, responded_at: at }],
    });
    expect(actionState(taken, blocks([taken]), viewer)).toBe("taken");
    expect(actionResponder(taken, blocks([taken]))).toEqual({ actorID: other, respondedAt: at });
  });

  it("marks the other buttons of my group as chosen elsewhere", () => {
    const can = action({ id: "can", group: "answer", responses: [{ actor_id: me, responded_at: at }] });
    const cannot = action({ id: "cannot", group: "answer" });
    const card = blocks([can, cannot]);
    expect(actionState(can, card, viewer)).toBe("pressed");
    expect(actionState(cannot, card, viewer)).toBe("chosen_other");
  });

  it("shows a decided group as taken and an expired one as closed", () => {
    const approve = action({
      id: "approve",
      limit: "single",
      group: "decision",
      closed: true,
      responses: [{ actor_id: other, responded_at: at }],
    });
    const deny = action({ id: "deny", limit: "single", group: "decision", closed: true });
    const decided = blocks([approve, deny]);
    expect(actionState(deny, decided, viewer)).toBe("taken");
    expect(actionResponder(deny, decided)?.actorID).toBe(other);
    const expired = blocks([{ ...approve, responses: [] }, deny]);
    expect(actionState(deny, expired, viewer)).toBe("closed");
  });

  it("reflects the audience and server rejections", () => {
    const admins = action({ allowed: { chat_roles: ["admin", "owner"] } });
    expect(actionState(admins, blocks([admins]), viewer)).toBe("unavailable");
    const approvers = action({ allowed: { permissions: ["agents.approve"] } });
    expect(actionState(approvers, blocks([approvers]), viewer)).toBe("available");
    expect(actionState(approvers, blocks([approvers]), viewer, { forbidden: true })).toBe(
      "unavailable",
    );
    expect(actionState(approvers, blocks([approvers]), viewer, { closed: true })).toBe("closed");
  });
});

describe("pressFailure", () => {
  it("maps stable error codes", () => {
    expect(pressFailure("forbidden")).toEqual({ local: { forbidden: true }, kind: "forbidden" });
    expect(pressFailure("action_closed").kind).toBe("closed");
    expect(pressFailure("action_conflict").kind).toBe("conflict");
    expect(pressFailure(undefined).kind).toBe("error");
  });
});

describe("confirmation cards", () => {
  const card: MessageBlocks = {
    version: 1,
    card: {
      title: "send_direct_message",
      status: { label: "Approval required", tone: "warning" },
      fields: [
        { label: "actor_id", value: other },
        { label: "body", value: "Записка на закупку готова" },
        { label: "body_format", value: "plain" },
        { label: "client_msg_id", value: "00000000-0000-4000-8000-000000000003" },
        { label: "chat_id", value: "00000000-0000-4000-8000-000000000004" },
        { label: "message_id", value: "00000000-0000-4000-8000-000000000005" },
      ],
    },
    actions: [
      action({
        id: "approve",
        label: "Approve",
        limit: "single",
        group: "decision",
        binding: { kind: "tool_confirmation", decision: "approve" },
      }),
    ],
  };

  it("are recognised by their binding and their status is mapped", () => {
    expect(isConfirmationCard(card)).toBe(true);
    expect(isConfirmationCard(blocks([action()]))).toBe(false);
    expect(confirmationStatus(card)).toBe("pending");
    expect(
      confirmationStatus({ ...card, card: { title: "x", status: { label: "Denied", tone: "danger" } } }),
    ).toBe("denied");
    expect(
      confirmationStatus({ ...card, card: { title: "x", status: { label: "Custom", tone: "info" } } }),
    ).toBeNull();
  });

  it("keep readable arguments and drop identifiers", () => {
    expect(confirmationFields(card)).toEqual([
      { kind: "actor", key: "actor_id", actorID: other },
      { kind: "text", key: "body", value: "Записка на закупку готова" },
      { kind: "chat", key: "chat_id", chatID: "00000000-0000-4000-8000-000000000004" },
    ]);
  });
});

describe("chat commands", () => {
  const agent = (patch: Partial<ChatAgent>): ChatAgent => ({
    agent_id: "a1",
    display_name: "Передача",
    handle: "handover",
    description: "Что оставить следующему",
    avatar_version: 0,
    status: "active",
    scopes: [],
    knowledge_collection_count: 0,
    triggers: [],
    can_manage: false,
    ...patch,
  });

  it("lists commands of active agents and matches the typed prefix", () => {
    const commands = chatCommands([
      agent({ triggers: [{ type: "command", command: "передать" }, { type: "mention" }] }),
      agent({
        agent_id: "a2",
        display_name: "Справка",
        triggers: [{ type: "command", command: "спросить" }],
      }),
      agent({ agent_id: "a3", status: "paused", triggers: [{ type: "command", command: "пауза" }] }),
    ]);
    expect(commands.map((item) => item.command)).toEqual(["передать", "спросить"]);
    expect(commandQuery("/пере")).toBe("пере");
    expect(commandQuery("/")).toBe("");
    expect(commandQuery("/передать завтра")).toBeNull();
    expect(commandQuery("текст /x")).toBeNull();
    expect(matchCommands(commands, "спр").map((item) => item.agentName)).toEqual(["Справка"]);
    expect(matchCommands(commands, "справ").map((item) => item.command)).toEqual(["спросить"]);
  });
});

describe("grantsPermission", () => {
  it("follows owner, explicit and agents.manage grants", () => {
    expect(grantsPermission("owner", [], "agents.approve")).toBe(true);
    expect(grantsPermission("admin", [], "agents.approve")).toBe(false);
    expect(grantsPermission("member", ["agents.approve"], "agents.approve")).toBe(true);
    expect(grantsPermission("admin", ["agents.manage"], "agents.approve")).toBe(true);
    expect(grantsPermission("admin", ["agents.manage"], "chats.moderate")).toBe(false);
  });
});
