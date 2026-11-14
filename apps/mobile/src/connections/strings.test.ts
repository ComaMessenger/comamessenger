import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  APIError,
  connectionErrorKey,
  connectionRequestErrorKey,
} from "@comamessenger/core";
import { en } from "../i18n/en";
import { ru } from "../i18n/ru";

vi.mock("@/i18n", () => ({ default: { addResourceBundle: () => undefined } }));
const { connectionsEn, connectionsRu } = await import("./strings");

const dir = __dirname;
const keys = new Set([...Object.keys(ru), ...Object.keys(connectionsRu)]);

/** Every string literal inside a `t(...)` call, ternary branches included. */
function literalKeys(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bt\(/g)) {
    let depth = 0;
    let end = match.index! + 1;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    const call = source.slice(match.index! + 2, end);
    for (const literal of call.matchAll(/"([a-zA-Z][A-Za-z0-9_]+)"/g))
      found.push(literal[1]!);
  }
  return found;
}

describe("connections translations", () => {
  it("has every key the screens ask for", () => {
    const missing = readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"))
      .flatMap((name) => literalKeys(readFileSync(join(dir, name), "utf8")))
      .filter((key) => !keys.has(key));
    expect(missing).toEqual([]);
  });

  it("speaks both languages, without shadowing the app's keys", () => {
    expect(Object.keys(connectionsEn).sort()).toEqual(
      Object.keys(connectionsRu).sort(),
    );
    const own = Object.keys(connectionsRu);
    expect(own.filter((key) => key in ru || key in en)).toEqual([]);
  });

  it("has the templated keys", () => {
    const templated = [
      ...["openai", "anthropic", "openai-compatible"].map(
        (p) => `connProvider_${p}`,
      ),
      ...["untested", "healthy", "unhealthy"].map((s) => `connHealth_${s}`),
      ...[
        "required",
        "invalid",
        "scheme",
        "credentials",
        "metadata",
        "internal",
      ].map((p) => `connEndpointProblem_${p}`),
      "connDelivery_accepted",
      "connDelivery_rejected",
      "connNotFound",
    ];
    expect(templated.filter((key) => !keys.has(key))).toEqual([]);
  });

  it("has the keys packages/core hands out", () => {
    const codes = [
      "unauthorized",
      "forbidden",
      "rate_limited",
      "network_error",
      "provider_error",
      "credentials_required",
      "mcp_endpoint_forbidden",
      "mcp_unauthorized",
      "mcp_timeout",
      "mcp_redirect_refused",
      "mcp_http_error",
      "mcp_invalid_response",
      "mcp_output_too_large",
      "mcp_transport_error",
      "mcp_rpc_error",
      "?",
    ].map(connectionErrorKey);
    const refusals = (["model", "mcp", "webhook"] as const).flatMap((kind) => [
      connectionRequestErrorKey(
        new APIError(409, "integration_in_use", ""),
        kind,
      ),
      connectionRequestErrorKey(
        new APIError(409, "integration_usage_changed", ""),
        kind,
      ),
      connectionRequestErrorKey(
        new APIError(422, "validation_failed", ""),
        kind,
      ),
      connectionRequestErrorKey(
        new APIError(
          422,
          "validation_failed",
          "INTEGRATIONS_ALLOWED_PRIVATE_TARGETS",
        ),
        kind,
      ),
    ]);
    const shared = [...codes, ...refusals].filter(
      (key): key is string => key !== null,
    );
    expect(shared.filter((key) => !keys.has(key))).toEqual([]);
  });
});
