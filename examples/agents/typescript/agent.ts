declare const process: {
  env: Record<string, string | undefined>;
  exitCode: number;
};

type Actor = { id: string };
type Checkpoint = { last_event_seq: number };
type Message = {
  id: string;
  chat_id: string;
  actor_id: string;
  thread_root_id?: string | null;
  mentioned_actor_ids: string[];
};
type Frame = {
  op?: string;
  seq?: number;
  type?: string;
  current_seq?: number;
  data?: unknown;
  code?: string;
  fatal?: boolean;
};

const coreURL = required("COMA_CORE_URL").replace(/\/$/, "");
const apiKey = required("COMA_AGENT_API_KEY");
const consumer = process.env.COMA_RUNTIME_CONSUMER ?? "external-ts-example";
const websocketURL = `${coreURL.replace(/^http/, "ws")}/api/v1/ws`;
let actorID = "";

async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${coreURL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${method} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function connectOnce(): Promise<void> {
  const checkpoint = await request<Checkpoint>(
    `/api/v1/agent-runtime/checkpoints/${encodeURIComponent(consumer)}`,
  );
  const socket = new WebSocket(websocketURL);
  let chain = Promise.resolve();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(cause);
    };

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          op: "auth",
          request_id: crypto.randomUUID(),
          access_token: apiKey,
          last_seq: checkpoint.last_event_seq,
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      chain = chain
        .then(() =>
          handleFrame(socket, JSON.parse(String(event.data)) as Frame),
        )
        .catch(fail);
    });
    socket.addEventListener("error", () => fail(new Error("WebSocket error")));
    socket.addEventListener("close", () => {
      chain.then(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, fail);
    });
  });
}

async function handleFrame(socket: WebSocket, frame: Frame): Promise<void> {
  if (frame.op === "hello") {
    console.log(`Connected as ${actorID}; resume is active.`);
    return;
  }
  if (frame.op === "resync_required") {
    await saveCheckpoint(requiredNumber(frame.current_seq, "current_seq"));
    socket.close(1000, "checkpoint resynchronized");
    return;
  }
  if (frame.op === "error") {
    console.error(`WebSocket error frame: ${frame.code ?? "unknown"}`);
    if (frame.fatal) socket.close();
    return;
  }
  if (frame.op !== "event") return;

  const seq = requiredNumber(frame.seq, "seq");
  if (frame.type === "message.created" && isMessage(frame.data)) {
    const message = frame.data;
    if (
      message.actor_id !== actorID &&
      message.mentioned_actor_ids.includes(actorID)
    ) {
      await reply(message, seq);
      console.log(`Replied to mention ${message.id} at event ${seq}.`);
    }
  }
  await saveCheckpoint(seq);
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ op: "ack", seq }));
  }
}

async function reply(message: Message, seq: number): Promise<void> {
  await request(`/api/v1/agent-tools/reply_in_thread`, "POST", {
    arguments: {
      chat_id: message.chat_id,
      client_msg_id: await stableUUID(`reply:${seq}`),
      body: `I received your mention (message \`${message.id}\`).`,
      body_format: "markdown",
      thread_root_id: message.thread_root_id ?? message.id,
      mentioned_actor_ids: [],
      file_ids: [],
    },
    correlation_id: await stableUUID(`correlation:${seq}`),
    confirmed: true,
  });
}

async function saveCheckpoint(seq: number): Promise<void> {
  await request(
    `/api/v1/agent-runtime/checkpoints/${encodeURIComponent(consumer)}`,
    "PUT",
    { last_event_seq: seq },
  );
}

async function stableUUID(label: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${actorID}:${label}`),
    ),
  ).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<Message>;
  return (
    typeof message.id === "string" &&
    typeof message.chat_id === "string" &&
    typeof message.actor_id === "string" &&
    Array.isArray(message.mentioned_actor_ids)
  );
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`Invalid ${name}`);
  }
  return result;
}

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main(): Promise<void> {
  actorID = (await request<Actor>("/api/v1/me")).id;
  let delay = 500;
  for (;;) {
    try {
      await connectOnce();
      delay = 500;
    } catch (cause) {
      console.error(cause);
    }
    await wait(delay + Math.random() * 250);
    delay = Math.min(30_000, delay * 2);
  }
}

void main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
