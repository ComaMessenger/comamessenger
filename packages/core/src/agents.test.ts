import { describe, expect, it } from "vitest";
import {
  agentAccess,
  approvalText,
  chatTriggersOf,
  formatCost,
  formatDuration,
  formatSpending,
  humanStatus,
  humanStatusLabel,
  pendingByAgent,
  runAgentCheck,
  runSentence,
  runTrigger,
  stepText,
  todayActivity,
  toolLabel,
  type AgentTranslate,
} from "./agents";
import type {
  Agent,
  AgentRun,
  AgentRunToolCall,
  AgentToolConfirmation,
  AgentTrigger,
  Chat,
  User,
} from "./types";

const t: AgentTranslate = (key, values) =>
  key === "agentTool_post_message"
    ? "Отправить сообщение"
    : values
      ? `${key}:${JSON.stringify(values)}`
      : key;

const agent = (patch: Partial<Agent>): Agent =>
  ({
    operational_status: "active",
    published_version: 2,
    has_unpublished_changes: false,
    readiness: { state: "active", ready: true, blockers: [] },
    ...patch,
  }) as Agent;

const run = (patch: Partial<AgentRun>): AgentRun =>
  ({
    id: "r1",
    agent_id: "a1",
    chat_id: "c1",
    status: "completed",
    dry_run: false,
    input: { trigger_type: "mention" },
    result_summary: {},
    cost: "0.5",
    currency: "USD",
    error_code: "",
    created_at: new Date().toISOString(),
    ...patch,
  }) as AgentRun;

const hall = { id: "c1", name: "Зал 1" } as Chat;

describe("agent access", () => {
  it("lets any agent permission view the platform", () => {
    const user = (permissions: string[]) =>
      ({ role: "member", permissions }) as unknown as User;
    expect(agentAccess(user([])).allowed).toBe(false);
    expect(agentAccess(user(["agents.approve"]))).toMatchObject({
      canApprove: true,
      canView: true,
      canBuild: false,
    });
    expect(agentAccess(user(["integrations.manage"]))).toMatchObject({
      canView: false,
      allowed: true,
    });
    expect(
      agentAccess({ role: "owner", permissions: [] } as unknown as User)
        .canObserve,
    ).toBe(true);
  });
});

describe("agent status", () => {
  it("puts waiting people first and names problems", () => {
    expect(humanStatus(agent({}), 2)).toEqual({ kind: "approval", count: 2 });
    expect(
      humanStatus(
        agent({
          operational_status: "needs_attention",
          readiness: {
            state: "error",
            ready: false,
            blockers: ["llm_connection_required"],
          } as Agent["readiness"],
        }),
      ),
    ).toEqual({
      kind: "attention",
      reason: "agentBlocker_llm_connection_required",
    });
    expect(humanStatus(agent({ published_version: null }))).toEqual({
      kind: "draft",
    });
  });

  it("labels the chip", () => {
    expect(humanStatusLabel(t, { kind: "approval", count: 3 })).toBe(
      'agentStatus_approval:{"count":3}',
    );
    expect(humanStatusLabel(t, { kind: "working", changed: true })).toBe(
      "agentStatus_workingChanged",
    );
    expect(humanStatusLabel(t, { kind: "paused" })).toBe("agentStatus_paused");
  });

  it("counts pending actions per agent", () => {
    const approvals = [
      { agent_id: "a" },
      { agent_id: "b" },
      { agent_id: "a" },
    ] as AgentToolConfirmation[];
    expect(pendingByAgent(approvals).get("a")).toBe(2);
  });
});

describe("agent formatting", () => {
  it("formats durations through the catalog", () => {
    expect(formatDuration(t, 4.2)).toBe('agentDurationSeconds:{"count":4}');
    expect(formatDuration(t, 0)).toBe("—");
  });

  it("uses the reported currency", () => {
    expect(formatCost("1.5", "EUR", "en")).toBe("€1.50");
    expect(formatCost("0.0042", "USD", "en")).toBe("$0.0042");
    expect(formatCost("1", "bogus", "en")).toBe("$1.00");
  });

  it("names unknown tools in words", () => {
    expect(toolLabel(t, "post_message")).toBe("Отправить сообщение");
    expect(toolLabel(t, "get_slots-today")).toBe(
      'agentToolExternal:{"name":"get slots today"}',
    );
  });
});

describe("runs in words", () => {
  it("tells what started a run", () => {
    expect(runTrigger(run({}))).toBe("mention");
    expect(runTrigger(run({ dry_run: true }))).toBe("check");
    expect(runTrigger(run({ input: {} }))).toBe("manual");
  });

  it("describes a run with its chat or its failure", () => {
    expect(runSentence(t, run({}), [hall])).toBe(
      'agentFeedDone_mention:{"chat":"Зал 1"}',
    );
    expect(runSentence(t, run({ status: "running" }), [])).toBe(
      "agentFeedWorking",
    );
    expect(
      runSentence(
        t,
        run({ status: "failed", error_code: "budget_exceeded" }),
        [],
      ),
    ).toBe('agentFeedFailed:{"reason":"agentRunError_budget_exceeded"}');
  });

  it("sums today without dry runs, per currency", () => {
    const yesterday = new Date(Date.now() - 86_400_000 * 2).toISOString();
    const stats = todayActivity([
      run({}),
      run({ id: "r2", status: "failed", cost: "0.25" }),
      run({ id: "r3", dry_run: true, cost: "9" }),
      run({ id: "r4", created_at: yesterday }),
      run({ id: "r5", currency: "RUB", cost: "30" }),
    ]);
    expect(stats.runs).toHaveLength(3);
    expect(stats.failures).toBe(1);
    expect(stats.spending).toEqual([
      ["USD", 0.75],
      ["RUB", 30],
    ]);
    expect(formatSpending([], "en")).toBe("$0.00");
  });

  it("puts steps in words", () => {
    const call = (patch: Partial<AgentRunToolCall>) =>
      ({
        tool_name: "post_message",
        dry_run: false,
        status: "completed",
        ...patch,
      }) as AgentRunToolCall;
    expect(stepText(t, call({}))).toBe("agentStep_post_message");
    expect(stepText(t, call({ dry_run: true }))).toBe(
      "agentStepWould_post_message",
    );
    expect(stepText(t, call({ tool_name: "crm_find" }))).toBe(
      'agentStepExternal:{"name":"agentToolExternal:{\\"name\\":\\"crm find\\"}"}',
    );
    expect(stepText(t, call({ status: "failed" }))).toBe(
      'agentStepFailed:{"step":"agentStep_post_message"}',
    );
  });
});

describe("pending actions and rules", () => {
  it("summarizes known tools", () => {
    const confirmation = {
      tool_name: "post_message",
      arguments: { chat_id: "c1", body: "  Привет  " },
    } as unknown as AgentToolConfirmation;
    expect(approvalText(t, confirmation, [hall])).toEqual({
      action: 'agentApprovalPostIn:{"chat":"Зал 1"}',
      quote: "Привет",
    });
  });

  it("turns enabled rules into chat triggers", () => {
    const trigger = (patch: Partial<AgentTrigger>) =>
      ({
        enabled: true,
        timezone: "UTC",
        config: {},
        ...patch,
      }) as AgentTrigger;
    expect(
      chatTriggersOf([
        trigger({ type: "mention" }),
        trigger({ type: "command", config: { command: "/svodka" } }),
        trigger({
          type: "schedule",
          config: { hour: 10, minute: 5, days_of_week: [1] },
        }),
        trigger({ type: "keyword", enabled: false }),
        trigger({ type: "manual" }),
      ]),
    ).toEqual([
      { type: "mention" },
      { type: "command", command: "svodka" },
      {
        type: "schedule",
        schedule: { hour: 10, minute: 5, days_of_week: [1], timezone: "UTC" },
      },
    ]);
  });
});

describe("agent check", () => {
  it("polls a dry run until it finishes and reports every state", async () => {
    const states = ["queued", "running", "completed"] as const;
    let call = 0;
    const invoked: unknown[] = [];
    const api = {
      invokeAgent: async (_id: string, input: unknown) => {
        invoked.push(input);
        return run({ id: "dry", status: states[0] });
      },
      agentRun: async () => run({ id: "dry", status: states[++call]! }),
    };
    const seen: string[] = [];
    const last = await runAgentCheck(
      api as never,
      { agentID: "a1", chatID: "c1", prompt: "Привет" },
      new AbortController().signal,
      (state) => seen.push(state.status),
      0,
    );
    expect(last?.status).toBe("completed");
    expect(seen).toEqual(["queued", "running", "completed"]);
    expect(invoked[0]).toMatchObject({
      chat_id: "c1",
      dry_run: true,
      input: { prompt: "Привет", sandbox: true, publish: false },
    });
  });

  it("stops quietly when aborted", async () => {
    const controller = new AbortController();
    const api = {
      invokeAgent: async () => run({ status: "queued" }),
      agentRun: async () => run({ status: "running" }),
    };
    const pending = runAgentCheck(
      api as never,
      { agentID: "a1", chatID: "c1", prompt: "?" },
      controller.signal,
      () => controller.abort(),
      0,
    );
    expect(await pending).toBeNull();
  });
});
