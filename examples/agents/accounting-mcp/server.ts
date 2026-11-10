// MCP adapter over the accounting API. It speaks the MCP streamable HTTP
// transport (JSON-RPC over POST with JSON responses) and exposes three tools.
// Coma connects to it as a workspace MCP connection; nothing in Coma's core
// knows about this accounting system.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { readJSON, type Instructor, type Slot } from "./accounting-api.ts";

export type AdapterOptions = {
  /** Base URL of the accounting HTTP API. */
  accountingURL: string;
  /** Token for the accounting API; stays inside the adapter. */
  accountingToken: string;
  /** Token Coma must send as "Authorization: Bearer <token>". */
  mcpToken: string;
  port?: number;
  /** Interface to listen on; 0.0.0.0 makes it reachable from a Core container. */
  host?: string;
};

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  call(arguments_: Record<string, unknown>): Promise<unknown>;
};

const PROTOCOL_VERSION = "2025-03-26";

export function adapterTools(options: AdapterOptions): Tool[] {
  const accounting = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(new URL(path, options.accountingURL), {
      ...init,
      headers: {
        Authorization: `Bearer ${options.accountingToken}`,
        "Content-Type": "application/json",
      },
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body };
  };
  const instructors = async () =>
    ((await accounting("/api/instructors")).body.instructors ??
      []) as Instructor[];
  const slots = async (date: string) =>
    ((await accounting(`/api/slots?date=${encodeURIComponent(date)}`)).body
      .slots ?? []) as Slot[];
  const date = {
    type: "string",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    description: "Date, YYYY-MM-DD",
  };
  return [
    {
      name: "get_slots",
      description:
        "Slots of the schedule on a date with room, time and assigned instructor (status free/busy).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["date"],
        properties: { date },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async call(arguments_) {
        const people = new Map(
          (await instructors()).map((item) => [item.id, item.name]),
        );
        return {
          slots: (await slots(String(arguments_.date))).map((slot) => ({
            ...slot,
            instructor: slot.instructor_id
              ? (people.get(slot.instructor_id) ?? null)
              : null,
            status: slot.instructor_id ? "busy" : "free",
          })),
        };
      },
    },
    {
      name: "find_free_instructors",
      description:
        "Instructors without a slot that starts at the given time on the date.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["date", "start"],
        properties: {
          date,
          start: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
        },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async call(arguments_) {
        const busy = new Set(
          (await slots(String(arguments_.date)))
            .filter(
              (slot) => slot.start === arguments_.start && slot.instructor_id,
            )
            .map((slot) => slot.instructor_id),
        );
        return {
          instructors: (await instructors()).filter(
            (item) => !busy.has(item.id),
          ),
        };
      },
    },
    {
      name: "assign_instructor",
      description:
        "Assign an instructor to a free slot. Changes the schedule: Coma asks a person to approve it first.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["slot_id", "instructor_id"],
        properties: {
          slot_id: { type: "string" },
          instructor_id: { type: "string" },
        },
      },
      // Not read-only: Coma treats the tool as a write and, with the binding's
      // "require approval" switch on, holds the call for a person.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async call(arguments_) {
        const result = await accounting(
          `/api/slots/${encodeURIComponent(String(arguments_.slot_id))}/assign`,
          {
            method: "POST",
            body: JSON.stringify({ instructor_id: arguments_.instructor_id }),
          },
        );
        return { assigned: result.status === 200, ...result.body };
      },
    },
  ];
}

/** Starts the MCP adapter (127.0.0.1 unless options.host says otherwise). */
export function startAdapter(
  options: AdapterOptions,
): Promise<{ server: Server; url: string }> {
  const tools = adapterTools(options);
  const sessions = new Set<string>();
  const server = createServer(async (request, response) => {
    const reply = (
      status: number,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      response.writeHead(
        status,
        body === undefined
          ? headers
          : { "Content-Type": "application/json", ...headers },
      );
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (request.url !== "/mcp" || request.method !== "POST") {
      reply(404, { error: "not_found" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${options.mcpToken}`) {
      reply(401, { error: "unauthorized" });
      return;
    }
    let message: {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      message = (await readJSON(request)) as typeof message;
    } catch {
      reply(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    if (message.id === undefined) {
      reply(202);
      return;
    }
    const result = (value: unknown, headers: Record<string, string> = {}) =>
      reply(200, { jsonrpc: "2.0", id: message.id, result: value }, headers);
    const failure = (code: number, text: string) =>
      reply(200, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code, message: text },
      });
    switch (message.method) {
      case "initialize": {
        const session = randomUUID();
        sessions.add(session);
        result(
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "accounting-mcp-example", version: "1.0.0" },
          },
          { "Mcp-Session-Id": session },
        );
        return;
      }
      case "tools/list":
        result({
          tools: tools.map(
            ({ name, description, inputSchema, annotations }) => ({
              name,
              description,
              inputSchema,
              annotations,
            }),
          ),
        });
        return;
      case "tools/call": {
        const tool = tools.find((item) => item.name === message.params?.name);
        if (!tool) {
          failure(-32602, "Unknown tool");
          return;
        }
        try {
          const output = await tool.call(
            (message.params?.arguments ?? {}) as Record<string, unknown>,
          );
          result({
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          });
        } catch {
          result({
            content: [
              { type: "text", text: "Accounting system is unavailable" },
            ],
            isError: true,
          });
        }
        return;
      }
      default:
        failure(-32601, "Method not found");
    }
  });
  return new Promise((resolve) => {
    const host = options.host ?? "127.0.0.1";
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : options.port;
      resolve({
        server,
        url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/mcp`,
      });
    });
  });
}
