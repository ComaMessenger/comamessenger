// Visual preview harness: `node scripts/preview/preview.mjs [all|shell|mobile|auth|dialogs]`
// with the dev server on 127.0.0.1:5173. PREVIEW_THEME=dark switches the theme,
// PREVIEW_OUT overrides the output folder (default scripts/preview/shots/).
// Screenshot harness with a mocked API, mirroring e2e/foundation.spec.ts mocks.
import { chromium, devices } from "@playwright/test";
import { mkdirSync } from "node:fs";

const out = process.env.PREVIEW_OUT ?? new URL("./shots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const base = "http://127.0.0.1:5173";
const mode = process.argv[2] ?? "all";
const theme = process.env.PREVIEW_THEME ?? "light";

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = {
  id: uid(1), org_id: uid(10), organization_name: "Северный офис", role: "owner",
  email: "lev@severny.ru", display_name: "Лев Кузнецов", handle: "lev", title: "CEO", about: "",
  timezone: "Europe/Moscow", status: "active", permissions: ["agents.manage", "chats.moderate", "members.manage", "invitations.manage"],
  must_change_password: false, can_create_invitations: true, status_emoji: "", status_text: "",
  status_expires_at: null, avatar_version: 0, created_at: "2026-08-19T00:00:00Z",
};
const actors = [
  { actor_id: uid(2), display_name: "Мария Лебедева", handle: "maria", title: "Product designer", about: "", type: "user", status_emoji: "", status_text: "", status_expires_at: null, avatar_version: 0 },
  { actor_id: uid(3), display_name: "Анна Соколова", handle: "anna", title: "Product lead", about: "", type: "user", status_emoji: "🎧", status_text: "В фокусе до 15:00", status_expires_at: null, avatar_version: 0 },
  { actor_id: uid(4), display_name: "Илья Крамер", handle: "ilya", title: "Backend engineer", about: "", type: "user", status_emoji: "🏝", status_text: "В отпуске до 15 сентября", status_expires_at: null, avatar_version: 0 },
  { actor_id: uid(5), display_name: "Coma Assistant", handle: "assistant", title: "Сводки по тредам, поиск по базе знаний", about: "", type: "agent", status_emoji: "", status_text: "", status_expires_at: null, avatar_version: 0 },
  { actor_id: uid(6), display_name: "Ольга Верёвкина", handle: "olga", title: "Head of People", about: "", type: "user", status_emoji: "", status_text: "", status_expires_at: null, avatar_version: 0 },
];
const members = [
  { actor_id: user.id, type: "user", display_name: user.display_name, handle: user.handle, title: user.title, role: "owner", joined_at: "2026-08-19T00:00:00Z", status_emoji: "", status_text: "", status_expires_at: null, avatar_version: 0 },
  ...actors.map((a) => ({ actor_id: a.actor_id, type: a.type, display_name: a.display_name, handle: a.handle, title: a.title, role: a.actor_id === uid(2) ? "admin" : "member", joined_at: "2026-08-19T00:00:00Z", status_emoji: a.status_emoji, status_text: a.status_text, status_expires_at: null, avatar_version: 0 })),
];
const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
const chat = (n, extra) => ({
  id: uid(20 + n), kind: "group", visibility: "private", name: "", topic: "", role: "owner", created_at: "2026-03-12T10:00:00Z",
  display_name: "", avatar_seed: `seed-${n}`, avatar_version: 0, notify_level: "default", muted_until: null, last_activity_seq: 10, last_message_at: iso(30), ...extra,
});
const chats = [
  chat(1, { display_name: "Дизайн-команда", name: "Дизайн-команда", topic: "продуктовый дизайн Coma", last_message: { id: uid(101), actor_id: uid(2), actor_display_name: "Мария", body: "Выложила финальные макеты онбординга, посмотрите до стендапа", created_seq: 10, created_at: iso(20), deleted: false }, last_message_at: iso(20) }),
  chat(2, { kind: "direct", display_name: "Анна Соколова", direct_peer: actors[1], last_message: { id: uid(102), actor_id: uid(3), actor_display_name: "Анна", body: "Ок, тогда созвон в 15:00", created_seq: 5, created_at: iso(29), deleted: false }, last_message_at: iso(29) }),
  chat(3, { display_name: "Backend", name: "Backend", last_message: { id: uid(103), actor_id: uid(4), actor_display_name: "Илья", body: "@lev миграция готова, нужен ревью схемы", created_seq: 7, created_at: iso(62), deleted: false }, last_message_at: iso(62) }),
  chat(4, { kind: "channel", role: "member", display_name: "Объявления", name: "Объявления", notify_level: "none", last_message: { id: uid(104), actor_id: uid(6), actor_display_name: "Ольга", body: "В пятницу офис закрыт, работаем удалённо", created_seq: 3, created_at: iso(60 * 26), deleted: false }, last_message_at: iso(60 * 26) }),
  chat(5, { kind: "direct", display_name: "Coma Assistant", direct_peer: actors[3], last_message: { id: uid(105), actor_id: uid(5), actor_display_name: "Coma Assistant", body: "Сводка по 14 тредам готова", created_seq: 2, created_at: iso(60 * 3), deleted: false }, last_message_at: iso(60 * 3) }),
  chat(6, { kind: "direct", display_name: "Илья Крамер", direct_peer: actors[2], last_message: { id: uid(106), actor_id: uid(4), actor_display_name: "Илья", body: "Спасибо, посмотрю", created_seq: 2, created_at: iso(60 * 4), deleted: false }, last_message_at: iso(60 * 4) }),
  chat(7, { display_name: "Продукт · Q4", name: "Продукт · Q4", last_message: { id: uid(107), actor_id: user.id, actor_display_name: "Лев", body: "Закрепил roadmap в важных", created_seq: 2, created_at: iso(60 * 50), deleted: false }, last_message_at: iso(60 * 50) }),
  chat(8, { kind: "channel", display_name: "Инциденты", name: "Инциденты", notify_level: "none", last_message: { id: uid(108), actor_id: uid(5), actor_display_name: "Coma Assistant", body: "Инцидент #412 закрыт, RCA в треде", created_seq: 120, created_at: iso(60 * 70), deleted: false }, last_message_at: iso(60 * 70) }),
  chat(9, { display_name: "Маркетинг", name: "Маркетинг", topic: "запуск лендинга", last_message: null, last_message_at: null }),
];
const unread = {
  chats: [
    { chat_id: chats[0].id, last_read_seq: 7, unread_count: 3, mention_count: 0 },
    { chat_id: chats[2].id, last_read_seq: 6, unread_count: 1, mention_count: 1 },
    { chat_id: chats[7].id, last_read_seq: 0, unread_count: 120, mention_count: 0 },
  ],
  threads: [{ thread_root_id: uid(201), chat_id: chats[0].id, last_read_seq: 0, unread_count: 2, mention_count: 0 }],
};
const msg = (n, actor, body, minutesAgo, extra = {}) => ({
  id: uid(200 + n), chat_id: chats[0].id, actor_id: actor, client_msg_id: uid(300 + n), type: "text", body, body_format: "markdown",
  version: 1, created_seq: n, created_at: iso(minutesAgo), mentioned_actor_ids: [], files: [], thread_reply_count: 0, ...extra,
});
const history = [
  msg(1, uid(2), "Выложила финальные макеты онбординга в фигму, посмотрите до стендапа. Основные изменения — в композере и в пустых состояниях.", 32, { thread_reply_count: 3 }),
  msg(2, uid(2), "Спека тоже обновлена:", 31),
  msg(3, uid(3), "В композере хорошо. По пустым состояниям есть вопрос: почему в каналах кнопка «Искать в сообщениях», а не «Сбросить фильтр»?", 27, { reply_to_id: uid(201), edited_at: iso(20) }),
  msg(4, uid(4), "Со стороны бэка ничего не меняется, поле `filter` уже поддерживает оба варианта.", 25),
  msg(5, uid(6), "Схема миграции: https://wiki.severny.ru/backend/migrations/2026-09-users-presence", 24, { forwarded_from: { author_name: "Илья Крамер", author_handle: "ilya", created_at: iso(60) } }),
  msg(6, uid(4), "", 23, { deleted_at: iso(22) }),
  msg(7, uid(5), "Сравнил v3 и v4. Отличий в композере два: перенесён переключатель Enter/Shift+Enter и добавлен пункт «Отправить позже». Пустые состояния — три новых экрана.", 21),
  msg(8, user.id, "Согласен, давайте закрепим в важных", 10),
  msg(9, user.id, "И заведу тред по ревью", 9),
  msg(10, uid(3), "Ок, тогда созвон в 15:00", 5),
];
const reactions = { [uid(201)]: [{ message_id: uid(201), actor_id: uid(3), emoji: "👍", created_at: iso(30) }, { message_id: uid(201), actor_id: user.id, emoji: "👍", created_at: iso(30) }, { message_id: uid(201), actor_id: uid(4), emoji: "👀", created_at: iso(30) }], [uid(204)]: [{ message_id: uid(204), actor_id: uid(3), emoji: "✅", created_at: iso(30) }] };
const threadReplies = [
  { ...msg(11, uid(3), "Посмотрела, композер стал заметно чище. Вопрос только по пустым состояниям.", 28), thread_root_id: uid(201) },
  { ...msg(12, uid(2), "Там логика такая: в канале пользователь чаще ищет конкретное объявление, а не список.", 26), thread_root_id: uid(201) },
  { ...msg(13, uid(5), "В аналитике за август 71 % поисков в каналах — по тексту сообщений.", 24), thread_root_id: uid(201) },
];
const preferences = { theme: "light", locale: "ru", in_app_enabled: true, push_enabled: false, push_preview: false, notify_messages: "all", notify_threads: "all", notify_reactions: true, notify_invites: true, notify_system: true, sound_enabled: true, sound_id: "default", schedule: null, snoozed_until: null, email_digest: false };

async function mock(page, { signedOut = false, bootstrapped = true, recovery = true } = {}) {
  await page.addInitScript((themeValue) => {
    localStorage.setItem("coma-locale", "ru");
    localStorage.setItem("coma-theme", themeValue);
    class FakeSocket {
      static OPEN = 1;
      static latest = null;
      readyState = 1; onopen = null; onmessage = null; onclose = null;
      constructor() { FakeSocket.latest = this; setTimeout(() => this.onopen?.(), 0); }
      send(raw) {
        const frame = JSON.parse(raw);
        if (frame.op === "auth") setTimeout(() => this.onmessage?.({ data: JSON.stringify({ op: "hello", request_id: frame.request_id, connection_id: "00000000-0000-4000-8000-000000000099", current_seq: 120, min_retained_seq: 0, heartbeat_interval_ms: 25000, ack_interval_ms: 1000, ack_batch_size: 50, max_unacked_events: 128 }) }), 0);
      }
      close() {}
    }
    Object.assign(window, { WebSocket: FakeSocket, __emitComaEvent: (frame) => FakeSocket.latest?.onmessage?.({ data: JSON.stringify(frame) }) });
  }, theme);
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname; const method = route.request().method();
    let status = 200; let body = {};
    const ends = (s) => path.endsWith(s);
    if (ends("/bootstrap/status")) body = { bootstrapped };
    else if (ends("/branding")) body = { workspace_name: "Северный офис", accent_color: "#174586", version: 1, password_recovery_available: recovery, email_delivery_available: recovery };
    else if (ends("/auth/refresh")) { if (signedOut) { status = 401; body = { code: "unauthorized", message: "signed out" }; } else body = { access_token: "t", access_expires_at: "2027-01-01T00:00:00Z", user }; }
    else if (ends("/auth/login")) { status = 401; body = { code: "unauthorized", message: "bad" }; }
    else if (ends("/auth/password/forgot")) { status = 202; body = undefined; }
    else if (ends("/agents/tool-confirmations")) body = [{ id: uid(900), agent_id: uid(5), run_id: uid(901), tool_call_id: uid(902), correlation_id: uid(903), tool_name: "read_folder", required_scope: "files.read", arguments: {}, status: "pending" }];
    else if (ends("/agents")) body = [];
    else if (ends("/chats/discover")) body = { chats: [{ id: uid(40), kind: "channel", name: "маршруты-доставки", topic: "", created_at: iso(9000) }] };
    else if (/\/chats\/[^/]+\/members$/.test(path)) body = { members };
    else if (/\/chats\/[^/]+\/messages$/.test(path)) body = { messages: history, next_before_seq: null };
    else if (/\/chats\/[^/]+\/pins$/.test(path)) body = { pins: [{ message_id: uid(201), pinned_by: user.id, pinned_at: iso(60) }] };
    else if (/\/chats\/[^/]+\/notification-preferences$/.test(path)) body = { chat_id: chats[0].id, notify_level: "default", muted_until: null };
    else if (ends("/chats")) body = { chats };
    else if (/\/messages\/[^/]+\/thread$/.test(path)) body = { messages: [history[0], ...threadReplies], next_before_seq: null };
    else if (/\/messages\/[^/]+\/reactions$/.test(path)) body = { reactions: reactions[path.split("/").at(-2)] ?? [] };
    else if (/\/messages\/[^/]+\/receipts$/.test(path)) body = { receipts: [{ actor_id: uid(3), read_at: iso(20) }, { actor_id: uid(4), read_at: iso(18) }] };
    else if (/\/messages\/[^/]+\/context$/.test(path)) { const id = path.split("/").at(-2); const m = [...history, ...threadReplies].find((x) => x.id === id); body = { messages: m ? [m] : [], target_id: id, has_earlier: false, has_later: false }; }
    else if (ends("/threads")) body = { threads: [{ root: history[0], reply_count: 3, last_reply_seq: 13, last_activity_seq: 13, followed_at: iso(30) }, { root: { ...history[2], chat_id: chats[2].id, body: "@lev миграция готова, нужен ревью схемы https://wiki.severny.ru/backend/migrations/2026-09-users-presence" }, reply_count: 1, last_reply_seq: 9, last_activity_seq: 9, followed_at: iso(60) }], next_before_seq: null };
    else if (ends("/unread")) body = unread;
    else if (ends("/drafts")) body = { drafts: [] };
    else if (ends("/preferences/chat-folders")) body = [{ id: uid(50), name: "Продукт", icon: "folder", color: "green", chat_ids: [chats[0].id, chats[6].id] }];
    else if (ends("/preferences/pinned-chats")) body = [chats[3].id];
    else if (ends("/preferences")) body = { ...preferences, theme };
    else if (ends("/me")) body = user;
    else if (ends("/actors")) body = { actors };
    else if (ends("/search")) body = { results: [{ kind: "message", chat_id: chats[2].id, message_id: uid(203), actor_id: uid(4), snippet: "@lev миграция готова, нужен ревью схемы", rank: 1, created_seq: 7, created_at: iso(62) }, { kind: "file", chat_id: chats[2].id, message_id: uid(204), actor_id: uid(4), file_id: uid(700), file_name: "migration-plan-2026-09.pdf", file_mime: "application/pdf", snippet: "план на сентябрь, финальная версия", rank: 0.9, created_seq: 6, created_at: iso(60 * 200) }], next_cursor: "next" };
    else if (ends("/push/config")) body = { enabled: false, public_key: "" };
    else { body = {}; }
    if (method === "POST" && ends("/read")) body = { chat_id: chats[0].id, last_read_seq: 10 };
    await route.fulfill({ status, contentType: "application/json", body: body === undefined ? "" : JSON.stringify(body) });
  });
}

const browser = await chromium.launch();
async function shot(name, { viewport = { width: 1440, height: 900 }, mobile = false, path = "/chats", options = {}, after } = {}) {
  const context = await browser.newContext(mobile ? { ...devices["iPhone 13"] } : { viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] pageerror`, e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log(`[${name}] console`, m.text().slice(0, 200)); });
  await mock(page, options);
  await page.goto(base + path);
  await page.waitForTimeout(1200);
  if (after) await after(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}${name}.png`, fullPage: false });
  console.log("saved", name);
  await context.close();
}

const all = mode === "all";
if (all || mode === "shell") {
  await shot("01-welcome");
  await shot("02-conversation", { path: `/chat/${chats[0].id}` });
  await shot("03-thread", { path: `/chat/${chats[0].id}/thread/${uid(201)}` });
  await shot("04-threads", { path: "/threads" });
  await shot("05-important", { path: "/important" });
  await shot("06-members", { path: "/members" });
  await shot("07-collapsed", { after: async (p) => { await p.getByRole("button", { name: "Свернуть боковую панель" }).click({ force: true }); } });
  await shot("08-profile-menu", { path: `/chat/${chats[0].id}`, after: async (p) => { await p.locator(".sidebar-profile__identity").click(); await p.getByRole("button", { name: /Не беспокоить/ }).click(); await p.getByRole("button", { name: "Своё время…" }).click(); } });
}
if (all || mode === "mobile") {
  await shot("m01-chats", { mobile: true });
  await shot("m02-conversation", { mobile: true, path: `/chat/${chats[0].id}` });
  await shot("m03-thread", { mobile: true, path: `/chat/${chats[0].id}/thread/${uid(201)}` });
  await shot("m04-more", { mobile: true, path: "/more" });
  await shot("m05-members", { mobile: true, path: "/members" });
}
if (all || mode === "auth") {
  await shot("a01-login", { options: { signedOut: true } });
  await shot("a02-login-error", { options: { signedOut: true }, after: async (p) => { await p.getByLabel("Почта").fill("lev@severny.ru"); await p.getByLabel("Пароль", { exact: true }).fill("wrongpass"); await p.getByRole("button", { name: "Войти" }).click(); await p.waitForTimeout(500); } });
  await shot("a03-recovery", { options: { signedOut: true }, after: async (p) => { await p.getByRole("button", { name: "Забыли пароль?" }).click(); } });
  await shot("a04-bootstrap", { options: { bootstrapped: false } });
  await shot("a05-reset", { options: { signedOut: true }, path: "/reset-password?token=abc" });
  await shot("a06-invite", { options: { signedOut: true }, path: "/invite/tok" });
  await shot("a07-login-mobile", { mobile: true, options: { signedOut: true } });
}
if (all || mode === "dialogs") {
  await shot("d01-search", { after: async (p) => { await p.keyboard.press("Meta+k").catch(() => {}); await p.getByRole("button", { name: "Поиск" }).first().click(); await p.waitForTimeout(300); await p.keyboard.type("мар"); await p.waitForTimeout(500); } });
  await shot("d02-search-messages", { after: async (p) => { await p.getByRole("button", { name: "Поиск" }).first().click(); await p.getByRole("tab", { name: /Сообщения/ }).click(); await p.keyboard.type("миграция"); await p.waitForTimeout(700); } });
  await shot("d03-new-chat", { after: async (p) => { await p.getByRole("button", { name: "Создать чат" }).first().click(); } });
  await shot("d04-new-folder", { after: async (p) => { await p.getByRole("button", { name: "Создать папку" }).first().click(); } });
  await shot("d05-chat-info", { path: `/chat/${chats[0].id}`, after: async (p) => { await p.getByRole("button", { name: "О чате" }).click(); await p.waitForTimeout(500); } });
  await shot("d06-status", { after: async (p) => { await p.getByRole("button", { name: /Лев Кузнецов/ }).click(); await p.getByRole("menuitem", { name: /статус/i }).click(); } });
  await shot("d07-profile-menu", { after: async (p) => { await p.getByRole("button", { name: /Лев Кузнецов/ }).click(); await p.getByRole("button", { name: /Не беспокоить/ }).click(); } });
  await shot("d08-workspace-menu", { after: async (p) => { await p.getByRole("button", { name: /Северный офис/ }).first().click(); } });
  await shot("d09-message-menu", { path: `/chat/${chats[0].id}`, after: async (p) => { const row = p.locator("#message-" + uid(203)); await row.hover(); await row.getByRole("button", { name: "Действия с сообщением" }).click(); } });
  await shot("d10-context-menu", { after: async (p) => { await p.locator(".chat-list").getByRole("button", { name: /Дизайн-команда/ }).click({ button: "right" }); } });
  await shot("d11-notify", { after: async (p) => { await p.getByRole("button", { name: "Уведомления" }).first().click(); } });
  await shot("d12-forward", { path: `/chat/${chats[0].id}`, after: async (p) => { const row = p.locator("#message-" + uid(203)); await row.hover(); await row.getByRole("button", { name: "Действия с сообщением" }).click(); await p.getByRole("menuitem", { name: /Переслать/ }).click(); await p.waitForTimeout(300); } });
  await shot("d13-details", { path: `/chat/${chats[0].id}`, after: async (p) => { const row = p.locator("#message-" + uid(203)); await row.hover(); await row.getByRole("button", { name: "Действия с сообщением" }).click(); await p.getByRole("menuitem", { name: /Просмотры/ }).click(); await p.waitForTimeout(300); } });
  await shot("d14-search-mobile", { mobile: true, after: async (p) => { await p.getByRole("button", { name: "Поиск" }).first().click(); await p.keyboard.type("мар"); await p.waitForTimeout(500); } });
  await shot("d15-leave-mobile", { mobile: true, after: async (p) => { const row = p.locator(".chat-list").getByRole("button", { name: /Дизайн-команда/ }); await row.click({ button: "right" }); await p.getByRole("menuitem", { name: /Покинуть/ }).click(); } });
}
await browser.close();
