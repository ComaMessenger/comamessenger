import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Saturday 14 November 2026 in Moscow: November is «this month», October and
// one item from a year ago get their own headings.
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
const lev = {
  actor_id: "01a01612-85e4-7145-bda3-82db7b4a3075",
  display_name: "Лев",
  handle: "lev",
  title: "Дизайнер",
  role: "member",
  joined_at: "2026-08-19T00:00:00Z",
  type: "user",
};
const chatID = "00000000-0000-4000-8000-000000000020";
const message = {
  id: "00000000-0000-4000-8000-000000000030",
  chat_id: chatID,
  actor_id: lev.actor_id,
  client_msg_id: "00000000-0000-4000-8000-000000000031",
  type: "text",
  body: "Макеты готовы",
  body_format: "markdown",
  version: 1,
  created_seq: 3,
  created_at: "2026-11-11T06:30:00Z",
  mentioned_actor_ids: [],
  files: [],
  thread_reply_count: 0,
};
const chat = {
  id: chatID,
  kind: "group",
  visibility: "private",
  name: "Проект",
  topic: "Запуск нового сайта",
  role: "member",
  created_at: "2026-08-19T00:00:00Z",
  display_name: "Проект",
  avatar_seed: "project",
  notify_level: "default",
  muted_until: null,
  last_activity_seq: 3,
  last_message_at: message.created_at,
  last_message: {
    id: message.id,
    actor_id: lev.actor_id,
    actor_display_name: lev.display_name,
    body: message.body,
    created_seq: 3,
    created_at: message.created_at,
    deleted: false,
  },
};
const author = { actor_id: lev.actor_id, display_name: lev.display_name, type: "user", avatar_version: 0 };
const anna = { actor_id: user.id, display_name: user.display_name, type: "user", avatar_version: 0 };

const id = (prefix: string, index: number) => `00000000-0000-4000-8000-${prefix}${String(index).padStart(12 - prefix.length, "0")}`;
function attachment(index: number, createdAt: string, mime: string, name: string, extra: object = {}) {
  return {
    file: {
      id: id("7", index),
      name,
      mime,
      size: 48213 * index,
      status: "ready",
      processing_status: "ready",
      created_at: createdAt,
      uploader_id: lev.actor_id,
      ...extra,
    },
    message_id: id("3", index),
    thread_root_id: null,
    author: index % 2 ? author : anna,
    created_at: createdAt,
  };
}
// Seven photos and videos: a first page of five, then two more.
const media = [
  attachment(1, "2026-11-13T09:00:00Z", "image/jpeg", "макет-главной.jpg"),
  attachment(2, "2026-11-12T09:00:00Z", "image/png", "схема.png"),
  attachment(3, "2026-11-10T09:00:00Z", "video/mp4", "демо.mp4"),
  attachment(4, "2026-11-02T09:00:00Z", "image/jpeg", "офис.jpg"),
  attachment(5, "2026-10-28T09:00:00Z", "image/jpeg", "команда.jpg"),
  attachment(6, "2026-10-03T09:00:00Z", "image/jpeg", "доска.jpg"),
  attachment(7, "2025-11-20T09:00:00Z", "image/jpeg", "архив.jpg"),
];
const files = [
  attachment(11, "2026-11-12T10:00:00Z", "application/pdf", "Бриф на сайт.pdf"),
  attachment(12, "2026-10-01T10:00:00Z", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Смета.xlsx"),
];
const waveform = Array.from({ length: 64 }, (_, index) => Math.round(128 + 100 * Math.sin(index / 3)));
const voices = [
  attachment(21, "2026-11-13T15:00:00Z", "audio/mp4", "voice.m4a", { voice: { duration_ms: 14000, waveform } }),
];
const links = [
  {
    url: "https://пример.рф/бриф",
    domain: "пример.рф",
    label: null,
    message_id: id("3", 31),
    thread_root_id: null,
    author,
    created_at: "2026-11-13T11:00:00Z",
    snippet: "Свежий бриф лежит тут: https://пример.рф/бриф — посмотрите до пятницы",
  },
  {
    url: "https://www.figma.com/file/abc/Site",
    domain: "figma.com",
    label: "Макеты в Figma",
    message_id: id("3", 32),
    thread_root_id: null,
    author: anna,
    created_at: "2026-11-11T08:00:00Z",
    snippet: "[Макеты в Figma](https://www.figma.com/file/abc/Site) — версия 3",
  },
  {
    url: "https://github.com/acme/site/pull/42",
    domain: "github.com",
    label: null,
    message_id: id("3", 33),
    thread_root_id: null,
    author,
    created_at: "2026-10-20T08:00:00Z",
    snippet: "…и ещё правки в https://github.com/acme/site/pull/42",
  },
];

/** A colour tile as the downloaded file of a preview. */
function svgFor(fileID: string) {
  const hues = [12, 48, 96, 160, 205, 260, 320];
  const hue = hues[Number(fileID.slice(-2)) % hues.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,70%)"/><stop offset="1" stop-color="hsl(${hue + 40},60%,45%)"/></linearGradient></defs><rect width="320" height="240" fill="url(#g)"/><circle cx="240" cy="70" r="28" fill="rgba(255,255,255,.55)"/><path d="M0 200 L90 120 L170 190 L230 140 L320 210 L320 240 L0 240Z" fill="rgba(0,0,0,.18)"/></svg>`;
}

async function mockChat(page: Page, theme: "light" | "dark" = "light") {
  const requests: string[] = [];
  await page.clock.setFixedTime(now);
  await page.addInitScript((value) => {
    localStorage.setItem("coma-locale", "ru");
    localStorage.setItem("coma-theme", value);
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: null | (() => void) = null;
      onmessage: null | ((event: { data: string }) => void) = null;
      onclose: null | ((event: { code: number }) => void) = null;
      constructor() {
        setTimeout(() => this.onopen?.(), 0);
      }
      send(raw: string) {
        const frame = JSON.parse(raw);
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
                }),
              }),
            0,
          );
      }
      close() {}
    }
    Object.assign(window, { WebSocket: FakeSocket });
  }, theme);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (path.includes("/shared")) requests.push(path + url.search);
    const download = /^\/files\/([^/]+)\/download$/.exec(path);
    if (download) {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: svgFor(download[1]!) });
      return;
    }
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
    else if (path === "/auth/refresh") body = { access_token: "test", access_expires_at: "2026-11-15T00:00:00Z", user };
    else if (path === "/me") body = user;
    else if (path === "/preferences")
      body = {
        theme,
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
      };
    else if (path === "/preferences/chat-folders" || path === "/preferences/pinned-chats") body = [];
    else if (path === "/chats") body = { chats: [chat] };
    else if (path === "/unread")
      body = { chats: [{ chat_id: chatID, last_read_seq: 3, unread_count: 0, mention_count: 0 }], threads: [] };
    else if (path === "/drafts") body = { drafts: [] };
    else if (path === "/agents") body = [];
    else if (path === "/scheduled-messages") body = { scheduled_messages: [] };
    else if (path === `/chats/${chatID}/members`)
      body = {
        members: [
          { actor_id: user.id, display_name: user.display_name, handle: user.handle, title: "", role: "member", joined_at: "2026-08-19T00:00:00Z", type: "user" },
          lev,
        ],
      };
    else if (path === `/chats/${chatID}/pins`) body = { pins: [] };
    else if (path === `/chats/${chatID}/agents`) body = { agents: [] };
    else if (path === `/chats/${chatID}/notifications`) body = { chat_id: chatID, notify_level: "default", muted_until: null };
    else if (path === `/chats/${chatID}/messages`) body = { messages: [message], next_before_seq: null };
    else if (path === `/chats/${chatID}/read`) body = { chat_id: chatID, last_read_seq: 3, last_read_at: now.toISOString() };
    else if (/^\/messages\/[^/]+\/context$/.test(path))
      body = { messages: [message], target_id: message.id, has_earlier: false, has_later: false };
    else if (path === `/chats/${chatID}/shared`) body = { media: media.length, files: files.length, voice: voices.length, links: links.length };
    else if (path === `/chats/${chatID}/shared/attachments`) {
      const kind = url.searchParams.get("kind");
      const cursor = url.searchParams.get("cursor");
      if (kind === "media")
        body = cursor === "page-2" ? { items: media.slice(5), next_cursor: null } : { items: media.slice(0, 5), next_cursor: "page-2" };
      else if (kind === "files") body = { items: files, next_cursor: null };
      else body = { items: voices, next_cursor: null };
    } else if (path === `/chats/${chatID}/shared/links`) body = { items: links, next_cursor: null };
    else status = 404;
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { requests };
}

const shot = { animations: "disabled" as const };

/**
 * The next page loads when the end of the grid scrolls into view (on a wide
 * screen at once) or with «Показать ещё»; either way all seven arrive.
 */
async function loadAllMedia(dialog: Locator) {
  const more = dialog.getByRole("button", { name: "Показать ещё" });
  await expect(async () => {
    if (await more.isVisible()) await more.click({ timeout: 1000 }).catch(() => undefined);
    await expect(dialog.locator(".chat-info__media")).toHaveCount(7, { timeout: 1000 });
  }).toPass();
  await expect(more).toHaveCount(0);
}

async function openInfo(page: Page) {
  await page.goto(`/chat/${chatID}`);
  await expect(page.locator(".message-feed").getByText("Макеты готовы")).toBeVisible();
  await page.getByRole("button", { name: "О чате" }).click();
  const dialog = page.getByRole("dialog", { name: "О чате" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("медиа чата: вкладки со счётчиками, сетка по месяцам, страницы и просмотр", async ({ page }) => {
  const api = await mockChat(page);
  const dialog = await openInfo(page);
  const tabs = dialog.getByRole("tablist");
  await expect(tabs.getByRole("tab", { name: "Медиа · 7" })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab", { name: "Файлы · 2" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "Голосовые · 1" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "Ссылки · 3" })).toBeVisible();

  // Two pages: the second loads as soon as the end of the first is in view.
  await loadAllMedia(dialog);
  await expect(dialog.getByRole("heading", { name: "Ноябрь", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Октябрь" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Показать ещё" })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Ноябрь 2025" })).toBeVisible();
  expect(api.requests).toContain(`/chats/${chatID}/shared/attachments?kind=media&cursor=page-2&limit=60`);
  await expect(dialog.locator(".chat-info__media img")).toHaveCount(6);
  await dialog.getByRole("tablist").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await expect(dialog).toHaveScreenshot("chat-shared-media.png", shot);

  // A tile opens the viewer at it; arrows step, Esc closes only the viewer.
  await dialog.getByRole("button", { name: "схема.png" }).click();
  const viewer = page.getByRole("dialog", { name: "схема.png" });
  await expect(viewer.getByRole("img", { name: "схема.png" })).toBeVisible();
  await expect(viewer.getByText("2 / 7")).toBeVisible();
  await expect(page).toHaveScreenshot("chat-shared-viewer.png", shot);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "демо.mp4" }).locator("video")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".media-viewer")).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // «Показать в чате» closes everything and jumps to the message.
  await dialog.getByRole("button", { name: "офис.jpg" }).click();
  await page.getByRole("button", { name: "Показать в чате" }).click();
  await expect(page.locator(".media-viewer")).toHaveCount(0);
  await expect(dialog).toHaveCount(0);

  const results = await new AxeBuilder({ page }).include(".message-feed").analyze();
  expect(results.violations.filter((item) => item.impact === "critical")).toEqual([]);
});

test("файлы, голосовые и ссылки чата", async ({ page }) => {
  await mockChat(page);
  const dialog = await openInfo(page);
  const tabs = dialog.getByRole("tablist");

  await tabs.getByRole("tab", { name: /Файлы/ }).click();
  await expect(dialog.getByText("Бриф на сайт.pdf")).toBeVisible();
  await expect(dialog.getByText("PDF · 530,3 КБ · Лев · чт")).toBeVisible();
  await expect(dialog.locator(".chat-info__files")).toHaveScreenshot("chat-shared-files.png", shot);

  await tabs.getByRole("tab", { name: /Голосовые/ }).click();
  await expect(dialog.locator(".chat-shared__voice").getByRole("button", { name: /Воспроизвести|Слушать|Play/ }).first()).toBeVisible();
  await expect(dialog.locator(".chat-shared__voices")).toHaveScreenshot("chat-shared-voice.png", shot);

  await tabs.getByRole("tab", { name: /Ссылки/ }).click();
  const figma = dialog.getByRole("link", { name: "Открыть figma.com в новой вкладке" });
  await expect(figma).toHaveAttribute("href", "https://www.figma.com/file/abc/Site");
  await expect(figma).toHaveAttribute("target", "_blank");
  await expect(figma).toHaveAttribute("rel", /noopener/);
  await expect(figma).toHaveText("Макеты в Figma");
  await expect(dialog.getByRole("link", { name: "Открыть пример.рф в новой вкладке" })).toHaveText("пример.рф");
  await expect(dialog.locator(".chat-shared__links")).toHaveScreenshot("chat-shared-links.png", shot);
  await dialog.locator(".chat-shared__link").first().getByRole("button", { name: "К сообщению" }).click();
  await expect(dialog).toHaveCount(0);
});

test("тёмная тема: медиа и ссылки", async ({ page }) => {
  await mockChat(page, "dark");
  const dialog = await openInfo(page);
  await loadAllMedia(dialog);
  await expect(dialog.locator(".chat-info__media img")).toHaveCount(6);
  await dialog.getByRole("tablist").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await expect(dialog).toHaveScreenshot("chat-shared-media-dark.png", shot);
  await dialog.getByRole("tablist").getByRole("tab", { name: /Ссылки/ }).click();
  await expect(dialog.locator(".chat-shared__link")).toHaveCount(3);
  await expect(dialog.locator(".chat-shared__links")).toHaveScreenshot("chat-shared-links-dark.png", shot);
});
