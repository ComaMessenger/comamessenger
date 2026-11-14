import { expect, test, type Page } from "@playwright/test";

// The header under a chat title: online, last seen, what people are doing.
const now = new Date("2026-11-14T12:00:00+03:00");
test.use({ timezoneId: "Europe/Moscow", locale: "ru-RU" });

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  org_id: "00000000-0000-4000-8000-000000000010",
  organization_name: "Test space",
  role: "member",
  email: "anna@example.com",
  display_name: "Анна",
  handle: "anna",
  title: "",
  about: "",
  timezone: "Europe/Moscow",
  status: "active",
  must_change_password: false,
  can_create_invitations: false,
  status_emoji: "",
  status_text: "",
  status_expires_at: null,
  created_at: "2026-08-19T00:00:00Z",
};
const person = (id: string, name: string, handle: string, extra = {}) => ({
  actor_id: id,
  display_name: name,
  handle,
  title: "",
  about: "",
  type: "user",
  role: "member",
  joined_at: "2026-08-19T00:00:00Z",
  status_emoji: "",
  status_text: "",
  status_expires_at: null,
  avatar_version: 0,
  ...extra,
});
const me = person(user.id, user.display_name, user.handle);
const lev = person("01a01612-85e4-7145-bda3-82db7b4a3075", "Лев", "lev", {
  last_seen_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
});
const oleg = person("01a01612-85e4-7145-bda3-82db7b4a3076", "Олег", "oleg");
const directID = "00000000-0000-4000-8000-000000000020";
const groupID = "00000000-0000-4000-8000-000000000021";
const base = {
  visibility: "private",
  topic: "",
  role: "member",
  created_at: "2026-08-19T00:00:00Z",
  notify_level: "default",
  muted_until: null,
  last_activity_seq: 0,
  last_message_at: null,
  last_message: null,
  avatar_version: 0,
};
const direct = {
  ...base,
  id: directID,
  kind: "direct",
  name: null,
  display_name: lev.display_name,
  avatar_seed: lev.actor_id,
  direct_peer: lev,
};
const group = {
  ...base,
  id: groupID,
  kind: "group",
  name: "Проект",
  topic: "Запуск нового сайта",
  display_name: "Проект",
  avatar_seed: "project",
};
const preferences = {
  theme: "light",
  locale: "ru",
  in_app_enabled: true,
  push_enabled: false,
  push_preview: false,
  notify_messages: "all",
  notify_threads: "all",
  notify_reactions: true,
  notify_invites: true,
  notify_system: true,
  sound_enabled: false,
  sound_id: "default",
  schedule: null,
  snoozed_until: null,
  email_digest: false,
  last_seen_visibility: "everyone",
};

type Mock = { patches: Record<string, unknown>[] };

async function mockMessenger(page: Page): Promise<Mock> {
  const mock: Mock = { patches: [] };
  await page.clock.setFixedTime(now);
  await page.addInitScript(() => {
    localStorage.setItem("coma-locale", "ru");
    const sent: Record<string, unknown>[] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: null | (() => void) = null;
      onmessage: null | ((event: { data: string }) => void) = null;
      onclose: null | ((event: { code: number }) => void) = null;
      constructor() {
        Object.assign(window, { __socket: this });
        setTimeout(() => this.onopen?.(), 0);
      }
      send(raw: string) {
        const frame = JSON.parse(raw);
        sent.push(frame);
        if (frame.op === "auth")
          setTimeout(
            () =>
              this.onmessage?.({
                data: JSON.stringify({
                  op: "hello",
                  request_id: frame.request_id,
                  connection_id: "00000000-0000-4000-8000-000000000099",
                  current_seq: 0,
                  min_retained_seq: 0,
                  heartbeat_interval_ms: 25000,
                  ack_interval_ms: 1000,
                  ack_batch_size: 50,
                  max_unacked_events: 128,
                  features: ["typing_actions", "presence_snapshot"],
                }),
              }),
            0,
          );
      }
      close() {}
    }
    Object.assign(window, { WebSocket: FakeSocket, __sent: sent });
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    let status = 200;
    let body: unknown = {};
    if (path === "/bootstrap/status") body = { bootstrapped: true };
    else if (path === "/branding")
      body = {
        workspace_name: user.organization_name,
        accent_color: "#174586",
        version: 1,
        password_recovery_available: false,
        email_delivery_available: false,
      };
    else if (path === "/auth/refresh")
      body = { access_token: "test", access_expires_at: "2026-11-15T00:00:00Z", user };
    else if (path === "/me") body = user;
    else if (path === "/preferences") {
      if (request.method() === "PATCH") {
        const patch = request.postDataJSON() as Record<string, unknown>;
        mock.patches.push(patch);
        Object.assign(preferences, patch);
      }
      body = preferences;
    } else if (path === "/preferences/chat-folders" || path === "/preferences/pinned-chats") body = [];
    else if (path === "/chats") body = { chats: [direct, group] };
    else if (path === `/chats/${directID}`) body = direct;
    else if (path === `/chats/${groupID}`) body = group;
    else if (path === "/unread") body = { chats: [], threads: [] };
    else if (path === "/drafts") body = { drafts: [] };
    else if (path === "/agents") body = [];
    else if (path === "/scheduled-messages") body = { scheduled_messages: [] };
    else if (path === `/chats/${directID}/members`) body = { members: [me, lev] };
    else if (path === `/chats/${groupID}/members`) body = { members: [me, lev, oleg] };
    else if (/^\/chats\/[^/]+\/pins$/.test(path)) body = { pins: [] };
    else if (/^\/chats\/[^/]+\/agents$/.test(path)) body = { agents: [] };
    else if (/^\/chats\/[^/]+\/messages$/.test(path)) body = { messages: [], next_before_seq: null };
    else if (/^\/chats\/[^/]+\/read$/.test(path))
      body = { chat_id: directID, last_read_seq: 0, last_read_at: now.toISOString() };
    else if (path.startsWith("/files/uploads") && request.method() === "POST") {
      // Never finishes: the upload stays in flight for the test.
      await new Promise(() => undefined);
      return;
    } else status = 404;
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return mock;
}

/** Pushes a server frame into the fake socket. */
async function push(page: Page, frame: Record<string, unknown>) {
  await page.evaluate((value) => {
    const socket = (window as unknown as { __socket: { onmessage(event: { data: string }): void } }).__socket;
    socket.onmessage({ data: JSON.stringify(value) });
  }, frame);
}

const later = new Date(now.getTime() + 5_000).toISOString();
const status = (page: Page) => page.locator(".conversation-head [data-testid=conversation-status]");

test("direct chat header shows last seen, online and what the peer is doing", async ({ page }) => {
  await mockMessenger(page);
  await page.goto(`/chat/${directID}`);
  await expect(status(page)).toHaveText("был(а) в сети 5 минут назад");
  await expect(page.locator(".conversation-head")).not.toContainText("участник");

  await push(page, { op: "presence", actor_id: lev.actor_id, state: "online", expires_at: new Date(now.getTime() + 60_000).toISOString() });
  await expect(status(page)).toHaveText("в сети");
  await expect(status(page)).toHaveClass(/conversation-status--live/);

  await push(page, { op: "typing", actor_id: lev.actor_id, chat_id: directID, thread_root_id: null, active: true, action: "recording_voice", expires_at: later });
  await expect(status(page)).toHaveText("записывает голосовое");
  await expect(status(page).locator(".typing-dots i")).toHaveCount(3);

  // A frame from an older client has no action: that is typing.
  await push(page, { op: "typing", actor_id: lev.actor_id, chat_id: directID, thread_root_id: null, active: true, expires_at: later });
  await expect(status(page)).toHaveText("печатает");

  // Typing inside a thread does not reach the chat header.
  await push(page, { op: "typing", actor_id: lev.actor_id, chat_id: directID, thread_root_id: null, active: false, expires_at: now.toISOString() });
  await push(page, { op: "typing", actor_id: lev.actor_id, chat_id: directID, thread_root_id: "00000000-0000-4000-8000-000000000077", active: true, expires_at: later });
  await expect(status(page)).toHaveText("в сети");

  await push(page, { op: "presence", actor_id: lev.actor_id, state: "offline", expires_at: now.toISOString(), last_seen_at: now.toISOString() });
  await expect(status(page)).toHaveText("был(а) в сети только что");
});

test("group header counts who is online and names who types", async ({ page }) => {
  await mockMessenger(page);
  await page.goto(`/chat/${groupID}`);
  await expect(status(page)).toHaveText("3 участника");
  await push(page, {
    op: "presence.snapshot",
    actors: [{ actor_id: lev.actor_id, state: "online", expires_at: new Date(now.getTime() + 60_000).toISOString() }],
  });
  await expect(status(page)).toHaveText("3 участника, 2 в сети");

  await push(page, { op: "typing", actor_id: lev.actor_id, chat_id: groupID, thread_root_id: null, active: true, expires_at: later });
  await expect(status(page)).toHaveText("Лев печатает");
  await push(page, { op: "typing", actor_id: oleg.actor_id, chat_id: groupID, thread_root_id: null, active: true, expires_at: later });
  await expect(status(page)).toHaveText("Лев и Олег печатают");
  await push(page, { op: "typing", actor_id: lev.actor_id, chat_id: groupID, thread_root_id: null, active: false, expires_at: now.toISOString() });
  await push(page, { op: "typing", actor_id: oleg.actor_id, chat_id: groupID, thread_root_id: null, active: true, action: "uploading_photo", expires_at: later });
  await expect(status(page)).toHaveText("Олег отправляет фото");
});

test("attaching a photo tells the chat it is being sent", async ({ page }) => {
  await mockMessenger(page);
  await page.goto(`/chat/${directID}`);
  await expect(status(page)).toHaveText("был(а) в сети 5 минут назад");
  await page.locator("input[type=file]").first().setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a", "hex"),
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __sent: Record<string, unknown>[] }).__sent.some(
          (frame) => frame.op === "typing" && frame.action === "uploading_photo" && frame.active === true,
        ),
      ),
    )
    .toBe(true);
});

test("privacy setting hides last seen", async ({ page }) => {
  const mock = await mockMessenger(page);
  await page.goto("/settings/profile");
  await expect(page.getByText("Кто видит, когда я был(а) в сети")).toBeVisible();
  const select = page.locator('select[name="profile-last-seen"]');
  await expect(select).toHaveValue("everyone");
  await select.selectOption("nobody");
  await expect.poll(() => mock.patches.some((patch) => patch.last_seen_visibility === "nobody")).toBe(true);
});
