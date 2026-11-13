import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  APIError,
  type DurableEvent,
  type MessengerAPI,
  type ScheduledMessage,
} from "@comamessenger/core";
import { applyScheduledEvent, scheduledKey } from "./scheduledCache";

const user = "user-1";

function record(
  id: string,
  overrides: Partial<ScheduledMessage> = {},
): ScheduledMessage {
  return {
    id,
    chat_id: "chat-1",
    thread_root_id: null,
    reply_to_id: null,
    client_msg_id: `c-${id}`,
    body: `text ${id}`,
    body_format: "markdown",
    mentioned_actor_ids: [],
    files: [],
    silent: false,
    send_at: "2026-11-12T06:00:00Z",
    status: "pending",
    failure_reason: null,
    message_id: null,
    version: 1,
    created_at: "2026-11-11T06:00:00Z",
    updated_at: "2026-11-11T06:00:00Z",
    ...overrides,
  };
}

function event(
  type: string,
  data: Record<string, unknown>,
  seq = 10,
): DurableEvent {
  return {
    seq,
    type,
    subject_id: String(data.id ?? ""),
    chat_id: "chat-1",
    actor_id: user,
    data,
    created_at: "2026-11-11T06:00:00Z",
  } as unknown as DurableEvent;
}

function setup(items?: ScheduledMessage[], fetched?: () => Promise<unknown>) {
  const client = new QueryClient();
  if (items) client.setQueryData(scheduledKey(user), items);
  const scheduledMessage = vi.fn(
    fetched ?? (() => Promise.reject(new Error())),
  );
  const api = { scheduledMessage } as unknown as MessengerAPI;
  const list = () =>
    client.getQueryData<ScheduledMessage[]>(scheduledKey(user));
  return { client, api, list, scheduledMessage };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("scheduled list from realtime", () => {
  it("ignores other events and leaves them to the store", () => {
    const { client, api } = setup([]);
    expect(
      applyScheduledEvent(client, api, user, event("message.created", {})),
    ).toBe(false);
  });

  it("consumes a malformed event without touching the list", () => {
    const { client, api, list } = setup([record("a")]);
    expect(
      applyScheduledEvent(
        client,
        api,
        user,
        event("scheduled_message.updated", { id: "a" }),
      ),
    ).toBe(true);
    expect(list()).toEqual([record("a")]);
  });

  it("reads a record created on another device, since the event has no text", async () => {
    const { client, api, list, scheduledMessage } = setup([], async () =>
      record("n", { version: 1, body: "from the tablet" }),
    );
    applyScheduledEvent(
      client,
      api,
      user,
      event("scheduled_message.created", {
        id: "n",
        chat_id: "chat-1",
        status: "pending",
        version: 1,
        send_at: "2026-11-12T06:00:00Z",
        failure_reason: null,
      }),
    );
    await flush();
    expect(scheduledMessage).toHaveBeenCalledWith("n");
    expect(list()?.map((item) => item.body)).toEqual(["from the tablet"]);
  });

  it("drops a record deleted elsewhere and one that was sent", () => {
    const { client, api, list } = setup([record("a"), record("b")]);
    for (const [id, status] of [
      ["a", "deleted"],
      ["b", "sent"],
    ] as const)
      applyScheduledEvent(
        client,
        api,
        user,
        event(`scheduled_message.${status}`, {
          id,
          chat_id: "chat-1",
          status,
          version: 2,
          send_at: "2026-11-12T06:00:00Z",
          failure_reason: null,
        }),
      );
    expect(list()).toEqual([]);
  });

  it("removes a record the server no longer has when reading it", async () => {
    const { client, api, list } = setup([record("a")], () =>
      Promise.reject(
        new APIError(404, "scheduled_message_not_found" as never, ""),
      ),
    );
    applyScheduledEvent(
      client,
      api,
      user,
      event("scheduled_message.updated", {
        id: "a",
        chat_id: "chat-1",
        status: "pending",
        version: 2,
        send_at: "2026-11-13T06:00:00Z",
        failure_reason: null,
      }),
    );
    await flush();
    expect(list()).toEqual([]);
  });

  it("does nothing before the list is loaded", () => {
    const { client, api, list, scheduledMessage } = setup();
    applyScheduledEvent(
      client,
      api,
      user,
      event("scheduled_message.created", {
        id: "n",
        chat_id: "chat-1",
        status: "pending",
        version: 1,
        send_at: "2026-11-12T06:00:00Z",
        failure_reason: null,
      }),
    );
    expect(list()).toBeUndefined();
    expect(scheduledMessage).not.toHaveBeenCalled();
  });
});
