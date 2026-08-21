import { describe, expect, it } from "vitest";

import {
  OpenAIProvider,
  ProviderError,
  type ProviderEvent,
} from "./providers.js";

describe("provider normalization", () => {
  it("normalizes OpenAI content, tool calls, and usage", async () => {
    const provider = new OpenAIProvider(
      "secret",
      "https://provider.test/v1",
      "openai-compatible",
      async (_url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("Authorization")).toBe("Bearer secret");
        return Response.json({
          choices: [
            {
              message: {
                content: "Drafted",
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "search_messages",
                      arguments: '{"query":"release"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        });
      },
    );
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: "model",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(events[0]).toEqual({ type: "delta", text: "Drafted" });
    expect(events[1]).toMatchObject({
      type: "finish",
      toolCalls: [
        {
          id: "call-1",
          name: "search_messages",
          arguments: { query: "release" },
        },
      ],
      usage: { inputTokens: 12, outputTokens: 4 },
    });
  });

  it("classifies provider throttling as retryable without response payload leakage", async () => {
    const provider = new OpenAIProvider(
      "secret",
      "https://provider.test/v1",
      "openai-compatible",
      async () => Response.json({ secret_detail: "do not surface" }, { status: 429 }),
    );
    let caught: unknown;
    try {
      for await (const _event of provider.stream({
        model: "model",
        messages: [],
        tools: [],
        maxOutputTokens: 10,
        signal: new AbortController().signal,
      })) {
        // no-op
      }
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({
      code: "provider_rate_limited",
      retryable: true,
    });
    expect(String(caught)).not.toContain("secret_detail");
  });
});
