#!/usr/bin/env node
// The other side of header-status.yaml: a second person who writes to the
// account in a direct chat, comes online, records a voice message for a
// while, stops, then leaves. Start it right before the flow:
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     node apps/mobile/e2e/peer-presence.mjs & maestro test e2e/header-status.yaml
//
// The peer (presence-peer@example.test) is invited on the first run.
const api = (process.env.COMA_API ?? "http://localhost:8080").replace(/\/$/, "");
const peerEmail = process.env.COMA_PEER_EMAIL ?? "presence-peer@example.test";
const peerPassword = process.env.COMA_PEER_PASSWORD ?? "presence-peer-1";
const phase = {
  recording: Number(process.env.PHASE_RECORDING_MS ?? 30_000),
  online: Number(process.env.PHASE_ONLINE_MS ?? 25_000),
};

async function call(path, init = {}, token) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text}`);
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}
const login = (email, password) =>
  call("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const owner = await login(process.env.COMA_EMAIL, process.env.COMA_PASSWORD);
let peer;
try {
  peer = await login(peerEmail, peerPassword);
} catch (cause) {
  if (cause.status !== 401 && cause.status !== 403 && cause.status !== 400) throw cause;
  const invitation = await call(
    "/api/v1/invitations",
    { method: "POST", body: JSON.stringify({ email: peerEmail, role: "member" }) },
    owner.access_token,
  );
  const token = new URL(invitation.accept_url).searchParams.get("token") ?? invitation.accept_url.split("/").pop();
  await call(`/api/v1/invitations/${token}/accept`, {
    method: "POST",
    body: JSON.stringify({ display_name: "Ольга", handle: "presence_peer", password: peerPassword }),
  });
  peer = await login(peerEmail, peerPassword);
}

const chat = await call(
  "/api/v1/chats",
  { method: "POST", body: JSON.stringify({ kind: "direct", member_ids: [owner.user.id] }) },
  peer.access_token,
);
// A fresh message puts the chat at the top of the list: chat-row-0.
await call(
  `/api/v1/chats/${chat.id}/messages`,
  { method: "POST", body: JSON.stringify({ client_msg_id: crypto.randomUUID(), body: "Сейчас запишу голосовое", body_format: "markdown" }) },
  peer.access_token,
);

const socket = new WebSocket(api.replace(/^http/, "ws") + "/api/v1/ws");
const send = (frame) => socket.send(JSON.stringify(frame));
await new Promise((resolve, reject) => {
  socket.onerror = reject;
  socket.onopen = () =>
    send({ op: "auth", request_id: crypto.randomUUID(), access_token: peer.access_token, last_seq: 0 });
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.op === "hello") resolve(frame);
    // Unacknowledged events make the server close the socket after 30 s.
    if (frame.op === "event") send({ op: "ack", seq: frame.seq });
    if (frame.op === "error") console.error("peer socket:", frame);
  };
});
send({ op: "subscribe_active", chat_id: chat.id, thread_root_id: null });
send({ op: "presence", state: "active" });
const keepOnline = setInterval(() => send({ op: "presence", state: "active" }), 20_000);
console.log(`peer online in chat ${chat.id}: recording`);

const until = Date.now() + phase.recording;
while (Date.now() < until) {
  send({ op: "typing", chat_id: chat.id, thread_root_id: null, active: true, action: "recording_voice" });
  await sleep(3_000);
}
send({ op: "typing", chat_id: chat.id, thread_root_id: null, active: false, action: "recording_voice" });
console.log("peer online, idle");
await sleep(phase.online);
clearInterval(keepOnline);
socket.close();
console.log("peer offline");
await sleep(500);
