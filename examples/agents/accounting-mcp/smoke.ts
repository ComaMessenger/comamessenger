// Smoke test: starts the fictional accounting API and the MCP adapter on
// free ports and walks the slot scenario through the MCP protocol the same
// way Coma does. Exits with a non-zero code on any mismatch.
import assert from "node:assert/strict";

import { startAccountingAPI } from "./accounting-api.ts";
import { sign } from "./notify.ts";
import { startAdapter } from "./server.ts";

// The webhook signature matches Core's test vector (core/internal/webhook).
assert.equal(
  sign("whsec_test", "1700000000", "d-1", '{"slot_id":"s-2"}'),
  "sha256=393c836bf2323a343fc3b6ce5b20451968d8703f8a439a14a99c765f4ff05145",
);

const accounting = await startAccountingAPI("accounting-token");
const adapter = await startAdapter({
  accountingURL: accounting.url,
  accountingToken: "accounting-token",
  mcpToken: "mcp-token",
});

let id = 0;
let session = "";
async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  token = "mcp-token",
) {
  const response = await fetch(adapter.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-03-26",
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  session = response.headers.get("Mcp-Session-Id") ?? session;
  return {
    status: response.status,
    body: (await response.json()) as { result?: any; error?: unknown },
  };
}
async function call(name: string, arguments_: Record<string, unknown>) {
  const { body } = await rpc("tools/call", { name, arguments: arguments_ });
  assert.equal(body.error, undefined, `${name} failed`);
  return body.result.structuredContent;
}

try {
  assert.equal(
    (await rpc("initialize", {}, "wrong-token")).status,
    401,
    "adapter must require its token",
  );
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  assert.equal(initialized.body.result.protocolVersion, "2025-03-26");
  assert.ok(session, "session id is issued");

  const tools = (await rpc("tools/list")).body.result.tools as Array<{
    name: string;
    annotations: { readOnlyHint: boolean };
  }>;
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.annotations.readOnlyHint]),
    [
      ["get_slots", true],
      ["find_free_instructors", true],
      ["assign_instructor", false],
    ],
    "two read tools and one write tool",
  );

  const before = await call("get_slots", { date: "2026-11-12" });
  const free = before.slots.filter(
    (slot: { status: string }) => slot.status === "free",
  );
  assert.deepEqual(
    free.map((slot: { id: string }) => slot.id),
    ["s-2"],
    "one free slot on 2026-11-12",
  );

  const candidates = await call("find_free_instructors", {
    date: "2026-11-12",
    start: "10:00",
  });
  assert.ok(
    candidates.instructors.some((item: { id: string }) => item.id === "i-3"),
  );

  const assigned = await call("assign_instructor", {
    slot_id: "s-2",
    instructor_id: "i-3",
  });
  assert.equal(assigned.assigned, true);
  const after = await call("get_slots", { date: "2026-11-12" });
  assert.equal(
    after.slots.find((slot: { id: string }) => slot.id === "s-2").instructor,
    "Мария Смирнова",
  );

  const again = await call("assign_instructor", {
    slot_id: "s-2",
    instructor_id: "i-1",
  });
  assert.equal(again.assigned, false, "a taken slot is not reassigned");
  console.log("accounting MCP adapter smoke test passed");
} finally {
  adapter.server.close();
  accounting.server.close();
}
