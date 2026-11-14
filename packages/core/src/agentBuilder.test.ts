import { describe, expect, it } from "vitest";
import { APIError } from "./api";
import {
  agentBuilderState,
  architectProblemOf,
  chatRole,
  createAgentProblem,
  draftProblems,
  loosenedLabels,
  loosenedOf,
  needDone,
  newAgentRequest,
  passportItems,
  publishBlockers,
  stepFilled,
  stepOfPlace,
  stepProblems,
  triggersToLocalize,
  withChatRole,
} from "./agentBuilder";
import { draftOf, emptyDraft } from "./agentDraft";
import type {
  Agent,
  AgentLlmConnection,
  AgentRecipe,
  AgentRun,
  AgentTrigger,
  Chat,
} from "./types";

const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

const agent = (patch: Partial<Agent> = {}): Agent =>
  ({
    id: "agent-1",
    display_name: "Справка",
    handle: "help_1",
    kind: "builtin",
    recipe: "custom",
    description: "Отвечает по регламентам.",
    enabled: false,
    allowed_scopes: ["messages:read", "messages:write", "runtime:execute"],
    llm_connection_id: "conn-1",
    provider: "openai",
    model: "gpt-5-mini",
    endpoint_url: "",
    external_data_sharing_approved: true,
    daily_cost_limit: "",
    monthly_cost_limit: "",
    max_output_tokens: 2048,
    max_tool_iterations: 8,
    max_chain_depth: 3,
    per_chat_concurrency: 1,
    rate_limit_per_minute: 60,
    provider_rate_limit_per_minute: 300,
    execution_timeout_seconds: 600,
    chat_ids: ["chat-1"],
    read_chat_ids: ["chat-1"],
    write_chat_ids: ["chat-1"],
    knowledge_collection_ids: [],
    readiness: { state: "ready", blockers: [] },
    published_version: null,
    published_at: null,
    has_unpublished_changes: true,
    ...patch,
  }) as unknown as Agent;

const connection = {
  id: "conn-1",
  name: "provod.ai",
  provider: "openai-compatible",
  default_model: "gpt-5.4-mini",
  enabled: true,
  health_status: "healthy",
} as AgentLlmConnection;

const trigger = (patch: Partial<AgentTrigger> = {}) =>
  ({
    id: "t1",
    type: "mention",
    config: {},
    enabled: true,
    timezone: "UTC",
    ...patch,
  }) as AgentTrigger;

describe("publish blockers", () => {
  it("are empty for a ready custom agent", () => {
    const value = agent();
    expect(publishBlockers(value, draftOf(value), [], [connection])).toEqual(
      [],
    );
  });

  it("point to the place that fixes them", () => {
    const value = agent({
      recipe: "help_desk" as Agent["recipe"],
      chat_ids: [],
      read_chat_ids: [],
      write_chat_ids: [],
      external_data_sharing_approved: false,
      llm_connection_id: "gone",
    });
    const blockers = publishBlockers(value, draftOf(value), [], [connection]);
    expect(
      blockers.map((item) => [item.key, stepOfPlace(item.anchor)]),
    ).toEqual([
      ["chat_required", "places"],
      ["llm_connection_unavailable", "review"],
      ["external_data_approval_required", "review"],
      ["trigger_required", "triggers"],
    ]);
  });
});

describe("draft problems", () => {
  it("stop a save the server would reject, by step", () => {
    const draft = {
      ...draftOf(agent()),
      display_name: " ",
      handle: "A",
      daily_cost_limit: "5,5",
      max_tool_iterations: 99,
    };
    expect(draftProblems(draft).map((item) => item.field)).toEqual([
      "display_name",
      "handle",
      "daily_cost_limit",
      "max_tool_iterations",
    ]);
    expect(stepProblems("role", draft).map((item) => item.key)).toEqual([
      "agentNameRequired",
    ]);
    expect(stepProblems("review", draft)).toHaveLength(3);
    expect(stepProblems("places", draft)).toEqual([]);
  });

  it("accepts a fresh draft", () => {
    expect(draftProblems(emptyDraft())).toEqual([]);
  });
});

describe("steps", () => {
  it("are filled as the draft grows", () => {
    const draft = draftOf(agent());
    expect(stepFilled("role", draft, [])).toBe(true);
    expect(stepFilled("places", draft, [])).toBe(true);
    expect(stepFilled("skills", draft, [])).toBe(true);
    expect(stepFilled("triggers", draft, [])).toBe(false);
    expect(stepFilled("triggers", draft, [trigger()])).toBe(true);
    expect(stepFilled("role", { ...draft, description: "" }, undefined)).toBe(
      false,
    );
  });
});

describe("chat roles", () => {
  it("read, write or both, keeping chat_ids their union", () => {
    let draft = draftOf(agent());
    draft = withChatRole(draft, "chat-2", "read");
    expect(chatRole(draft, "chat-2")).toBe("read");
    draft = withChatRole(draft, "chat-1", "write");
    expect(chatRole(draft, "chat-1")).toBe("write");
    expect(draft.chat_ids).toEqual(["chat-1", "chat-2"]);
    draft = withChatRole(draft, "chat-1", null);
    expect(draft.chat_ids).toEqual(["chat-2"]);
    expect(draft.write_chat_ids).toEqual([]);
  });
});

describe("creating a draft", () => {
  const recipe = {
    id: "help_desk",
    name: "Справочная",
    scopes: ["messages:read"],
  } as unknown as AgentRecipe;

  it("asks for a name and, for a role, a chat", () => {
    expect(createAgentProblem({ name: "", chatID: "", recipe: null })).toBe(
      "agentCreateNameRequired",
    );
    expect(createAgentProblem({ name: "A", chatID: "", recipe })).toBe(
      "agentCreateChatRequired",
    );
    expect(createAgentProblem({ name: "A", chatID: "", recipe: null })).toBe(
      null,
    );
  });

  it("starts with the healthy workspace model", () => {
    const request = newAgentRequest({
      recipe,
      name: " Справка ",
      chatID: "chat-1",
      connections: [connection],
      locale: "ru",
    });
    expect(request).toMatchObject({
      display_name: "Справка",
      recipe: "help_desk",
      chat_ids: ["chat-1"],
      llm_connection_id: "conn-1",
      model: "gpt-5.4-mini",
      enabled: false,
    });
  });

  it("moves UTC recipe rules into the creator's timezone", () => {
    const rules = [trigger(), trigger({ id: "t2", timezone: "Europe/Moscow" })];
    expect(triggersToLocalize(rules, "Europe/Moscow").map((r) => r.id)).toEqual(
      ["t1"],
    );
    expect(triggersToLocalize(rules, "UTC")).toEqual([]);
  });
});

describe("loosened confirmations", () => {
  it("are read from the refused publish and named for people", () => {
    const cause = new APIError(409, "agent_confirmation_loosened", "", {
      loosened: [
        "send_direct_message",
        "post_message",
        "reply_in_thread",
        "mcp:crm/create",
      ],
    });
    const keys = loosenedOf(cause)!;
    expect(loosenedLabels(t, keys)).toEqual([
      "agentAction_direct",
      "agentAction_post",
      'agentLoosenedExternal:{"connection":"crm","tool":"create"}',
    ]);
    expect(loosenedOf(new Error("x"))).toBeNull();
  });
});

describe("architect problems", () => {
  it("map server codes and describe the rest", () => {
    expect(
      architectProblemOf(new APIError(409, "architect_busy", ""), () => ""),
    ).toEqual({ kind: "busy" });
    expect(architectProblemOf(new Error("x"), () => "offline")).toEqual({
      kind: "other",
      message: "offline",
    });
  });
});

describe("builder state", () => {
  it("says what is published and what is not", () => {
    expect(agentBuilderState(agent(), true, "ru").key).toBe(
      "agentStateUnsaved",
    );
    expect(agentBuilderState(agent(), false, "ru").key).toBe(
      "agentStateNeverPublished",
    );
    expect(
      agentBuilderState(
        agent({ published_version: 2, has_unpublished_changes: true }),
        false,
        "ru",
      ),
    ).toEqual({ key: "agentStateDraftDiffers", values: { version: 2 } });
  });
});

describe("recipe needs", () => {
  it("count a chat, a collection or an integration", () => {
    const draft = draftOf(agent());
    expect(
      needDone(
        { kind: "chats", required: true, label: "", hint: "" },
        draft,
        {},
      ),
    ).toBe(true);
    expect(
      needDone(
        { kind: "schedule", required: true, label: "", hint: "" },
        draft,
        { mcp_bindings: [{ connection_id: "c", allowed_tools: [] }] },
      ),
    ).toBe(true);
  });
});

describe("passport", () => {
  it("shows only what the saved draft has", () => {
    const chats = [{ id: "chat-1", name: "Зал 1" } as Chat];
    const items = passportItems(t, {
      agent: agent(),
      chats,
      connections: [connection],
      collections: [],
      triggers: [trigger()],
      timezone: "UTC",
    });
    expect(items.map((item) => [item.key, item.body !== null])).toEqual([
      ["who", true],
      ["knows", false],
      ["can", true],
      ["when", true],
      ["where", true],
      ["model", true],
    ]);
    expect(items.find((item) => item.key === "where")?.body).toBe("Зал 1");
    expect(
      passportItems(t, {
        agent: undefined,
        chats,
        connections: [],
        collections: undefined,
        triggers: undefined,
        timezone: "UTC",
      }).every((item) => item.body === null),
    ).toBe(true);
  });
});
