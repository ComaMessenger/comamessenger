import { describe, expect, it } from "vitest";

import {
  AnthropicProvider,
  OpenAIProvider,
  ProviderError,
  type ProviderEvent,
} from "./providers.js";

const runContext = {
  callID: "00000000-0000-7000-8000-000000000001",
  runID: "00000000-0000-7000-8000-000000000002",
  leaseToken: "00000000-0000-7000-8000-000000000003",
};

describe("provider normalization", () => {
  it("normalizes OpenAI content, tool calls, and usage", async () => {
    const provider = new OpenAIProvider(
      "secret",
      "https://provider.test/v1",
      "openai-compatible",
      async (_url, init) => {
        const headers = new Headers(init?.headers);
        const request = JSON.parse(String(init?.body));
        expect(headers.get("Authorization")).toBe("Bearer secret");
        expect(request.stream).toBe(true);
        expect(request.max_tokens).toBe(100);
        expect(request.max_completion_tokens).toBeUndefined();
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"Draft"}}]}',
            'data: {"choices":[{"delta":{"content":"ed","tool_calls":[{"index":0,"id":"call-1","function":{"name":"search_","arguments":"{\\"query\\":"}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"messages","arguments":"\\"release\\"}"}}]},"finish_reason":"tool_calls"}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}',
            "data: [DONE]",
          ].join("\n\n") + "\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    );
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      ...runContext,
      model: "model",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(events.slice(0, 2)).toEqual([
      { type: "delta", text: "Draft" },
      { type: "delta", text: "ed" },
    ]);
    expect(events[2]).toMatchObject({
      type: "finish",
      toolCalls: [
        {
          id: "call-1",
          name: "search_messages",
          arguments: { query: "release" },
        },
      ],
      usage: { inputTokens: 12, outputTokens: 4 },
      stopReason: "tool_calls",
    });
  });

  it("normalizes Anthropic SSE text, tools, and usage", async () => {
    const provider = new AnthropicProvider(
      "secret",
      "https://anthropic.test/v1",
      async () =>
        new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"recall"}}',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"key\\":\\"x\\"}"}}',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
          ].join("\n\n") + "\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      ...runContext,
      model: "claude",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(events[0]).toEqual({ type: "delta", text: "Hi" });
    expect(events[1]).toMatchObject({
      type: "finish",
      toolCalls: [{ id: "tool-1", name: "recall", arguments: { key: "x" } }],
      usage: { inputTokens: 9, outputTokens: 3 },
      stopReason: "end_turn",
    });
  });

  it("uses the official OpenAI completion token field for newer models", async () => {
    const provider = new OpenAIProvider(
      "secret",
      "https://api.openai.test/v1",
      "openai",
      async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        expect(request.max_completion_tokens).toBe(321);
        expect(request.max_tokens).toBeUndefined();
        return new Response(
          'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    );
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      ...runContext,
      model: "gpt-5-mini",
      messages: [],
      tools: [],
      maxOutputTokens: 321,
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ stopReason: "stop" });
  });

  it("classifies provider throttling as retryable without response payload leakage", async () => {
    const provider = new OpenAIProvider(
      "secret",
      "https://provider.test/v1",
      "openai-compatible",
      async () =>
        Response.json({ secret_detail: "do not surface" }, { status: 429 }),
    );
    let caught: unknown;
    try {
      for await (const _event of provider.stream({
        ...runContext,
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

  it("surfaces only a bounded provider error code", async () => {
    const provider = new OpenAIProvider(
      "secret",
      "https://provider.test/v1",
      "openai-compatible",
      async () =>
        Response.json(
          {
            error: { code: "invalid_model", message: "secret provider detail" },
          },
          { status: 400 },
        ),
    );
    let caught: unknown;
    try {
      for await (const _event of provider.stream({
        ...runContext,
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
    expect(String(caught)).toContain("invalid_model");
    expect(String(caught)).not.toContain("secret provider detail");
  });
});
