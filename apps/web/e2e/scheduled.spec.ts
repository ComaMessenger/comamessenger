import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Wednesday 11 November 2026, 10:15 in Moscow: the presets are in an hour
// (11:15), this evening (18:00), tomorrow 9:00 and Monday 16 November 9:00.
const now = new Date("2026-11-11T10:15:00+03:00");
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
const otherUser = {
  ...user,
  id: "00000000-0000-4000-8000-000000000002",
  email: "boris@example.com",
  display_name: "Борис",
  handle: "boris",
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
const goneChatID = "00000000-0000-4000-8000-000000000029";
const chat = {
  id: chatID,
  kind: "group",
  visibility: "private",
  name: "Проект",
  topic: "",
  role: "member",
  created_at: "2026-08-19T00:00:00Z",
  display_name: "Проект",
  avatar_seed: "project",
  notify_level: "default",
  muted_until: null,
  last_activity_seq: 3,
  last_message_at: "2026-11-11T06:30:00Z",
  last_message: {
    id: "00000000-0000-4000-8000-000000000030",
    actor_id: lev.actor_id,
    actor_display_name: lev.display_name,
    body: "Макеты готовы",
    created_seq: 3,
    created_at: "2026-11-11T06:30:00Z",
    deleted: false,
  },
};
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

type Record = {
  id: string;
  chat_id: string;
  thread_root_id: string | null;
  reply_to_id: string | null;
  client_msg_id: string;
  body: string;
  body_format: "plain" | "markdown";
  mentioned_actor_ids: string[];
  files: Array<{ id: string; name: string; mime: string; size: number }>;
  silent: boolean;
  send_at: string;
  status: "pending" | "failed" | "sent";
  failure_reason: string | null;
  message_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  failed_at: string | null;
};

function record(id: number, patch: Partial<Record>): Record {
  return {
    id: `00000000-0000-4000-8000-0000000005${String(id).padStart(2, "0")}`,
    chat_id: chatID,
    thread_root_id: null,
    reply_to_id: null,
    client_msg_id: `00000000-0000-4000-8000-0000000006${String(id).padStart(2, "0")}`,
    body: "",
    body_format: "markdown",
    mentioned_actor_ids: [],
    files: [],
    silent: false,
    send_at: "2026-11-12T06:00:00Z",
    status: "pending",
    failure_reason: null,
    message_id: null,
    version: 1,
    created_at: "2026-11-10T08:00:00Z",
    updated_at: "2026-11-10T08:00:00Z",
    sent_at: null,
    failed_at: null,
    ...patch,
  };
}

function fixtures(): Record[] {
  return [
    record(1, {
      body: "Напоминание: созвон в 18:30, ссылка в описании встречи",
      send_at: "2026-11-11T15:00:00Z",
      silent: true,
    }),
    record(2, {
      body: "Доброе утро! Отправляю план на неделю — посмотрите до обеда.",
      reply_to_id: message.id,
      files: [
        {
          id: "00000000-0000-4000-8000-000000000701",
          name: "plan-week-46.pdf",
          mime: "application/pdf",
          size: 48213,
        },
      ],
    }),
    record(3, {
      body: "Итоги ретро — в треде",
      thread_root_id: message.id,
      send_at: "2026-11-16T06:00:00Z",
    }),
    record(4, {
      body: "Отчёт за неделю",
      status: "failed",
      failure_reason: "not_member",
      send_at: "2026-11-11T06:00:00Z",
      failed_at: "2026-11-11T06:00:05Z",
      version: 2,
    }),
    record(5, {
      body: "Поздравляю с запуском!",
      chat_id: goneChatID,
      status: "failed",
      failure_reason: "chat_unavailable",
      send_at: "2026-11-10T09:00:00Z",
      failed_at: "2026-11-10T09:00:03Z",
      version: 2,
    }),
  ];
}

async function mockScheduled(
  page: Page,
  options: {
    theme?: "light" | "dark";
    scheduled?: Record[];
    conflictOnce?: boolean;
    /** Signing out lets `otherUser` sign in; their list never arrives. */
    switchUser?: boolean;
  } = {},
) {
  const { theme = "light", conflictOnce = false, switchUser = false } = options;
  let session: "first" | "out" | "second" = "first";
  const current = () => (session === "second" ? otherUser : user);
  let scheduled = options.scheduled ?? fixtures();
  let conflict = conflictOnce;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  await page.clock.setFixedTime(now);
  await page.addInitScript((value) => {
    localStorage.setItem("coma-locale", "ru");
    localStorage.setItem("coma-theme", value);
    class FakeSocket {
      static OPEN = 1;
      static latest: FakeSocket | null = null;
      readyState = 1;
      onopen: null | (() => void) = null;
      onmessage: null | ((event: { data: string }) => void) = null;
      onclose: null | ((event: { code: number }) => void) = null;
      constructor() {
        FakeSocket.latest = this;
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
    Object.assign(window, {
      WebSocket: FakeSocket,
      __emitComaEvent: (frame: unknown) =>
        FakeSocket.latest?.onmessage?.({ data: JSON.stringify(frame) }),
    });
  }, theme);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = request.method();
    const input = (() => {
      try {
        return request.postDataJSON() as { [key: string]: unknown };
      } catch {
        return null;
      }
    })();
    if (
      path.includes("scheduled") ||
      path.startsWith("/sessions/revoke") ||
      path === "/me/password" ||
      path === "/me/email/change"
    )
      requests.push({ method, path, body: input });
    let status = 200;
    let body: unknown = {};
    const scheduledMatch = /^\/scheduled-messages\/([^/]+)(\/send)?$/.exec(
      path,
    );
    if (path === "/bootstrap/status") body = { bootstrapped: true };
    else if (path === "/branding")
      body = {
        workspace_name: user.organization_name,
        accent_color: "#174586",
        version: 1,
        password_recovery_available: false,
        email_delivery_available: false,
      };
    else if (path === "/auth/refresh") {
      if (session === "out") {
        status = 401;
        body = { code: "unauthorized", message: "signed out" };
      } else
        body = {
          access_token: "test",
          access_expires_at: "2026-11-12T00:00:00Z",
          user: current(),
        };
    } else if (path === "/auth/logout" && switchUser) {
      session = "out";
      status = 204;
      body = undefined;
    } else if (path === "/auth/login" && switchUser) {
      session = "second";
      body = {
        access_token: "test-2",
        access_expires_at: "2026-11-12T00:00:00Z",
        user: otherUser,
      };
    } else if (path === "/me") body = current();
    else if (path === "/me/password" || path === "/sessions/revoke-others") {
      status = 204;
      body = undefined;
    } else if (path === "/preferences")
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
    else if (path === "/preferences/chat-folders") body = [];
    else if (path === "/preferences/pinned-chats") body = [];
    else if (path === "/chats") body = { chats: [chat] };
    else if (path === "/unread")
      body = {
        chats: [
          {
            chat_id: chatID,
            last_read_seq: 3,
            unread_count: 0,
            mention_count: 0,
          },
        ],
        threads: [],
      };
    else if (path === "/drafts") body = { drafts: [] };
    else if (path === "/agents") body = [];
    else if (path === `/chats/${chatID}/members`)
      body = {
        members: [
          {
            actor_id: user.id,
            display_name: user.display_name,
            handle: user.handle,
            title: "",
            role: "member",
            joined_at: "2026-08-19T00:00:00Z",
            type: "user",
          },
          lev,
        ],
      };
    else if (path === `/chats/${chatID}/pins`) body = { pins: [] };
    else if (path === `/chats/${chatID}/agents`) body = { agents: [] };
    else if (path === `/chats/${chatID}/messages` && method === "POST") {
      status = 201;
      requests.push({ method, path, body: input });
      body = {
        ...message,
        id: "00000000-0000-4000-8000-000000000040",
        actor_id: user.id,
        client_msg_id: input?.client_msg_id,
        body: input?.body,
        silent: input?.silent === true,
        created_seq: 4,
        created_at: now.toISOString(),
      };
    } else if (path === `/chats/${chatID}/messages`)
      body = { messages: [message], next_before_seq: null };
    else if (/^\/messages\/[^/]+\/thread$/.test(path))
      body = { messages: [message], next_before_seq: null };
    else if (path === `/chats/${chatID}/read`)
      body = {
        chat_id: chatID,
        last_read_seq: 3,
        last_read_at: now.toISOString(),
      };
    else if (path === `/chats/${chatID}/scheduled-messages`) {
      const created = record(90, {
        client_msg_id: String(input?.client_msg_id),
        body: String(input?.body ?? ""),
        reply_to_id: (input?.reply_to_id as string) ?? null,
        silent: input?.silent === true,
        send_at: String(input?.send_at),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      });
      scheduled = [...scheduled, created];
      status = 201;
      body = created;
    } else if (path === "/scheduled-messages" && session === "second") {
      // The second person's list never arrives: whatever the page shows
      // can only come from what the tab kept.
      requests.push({ method, path: "second:" + path, body: null });
      return;
    } else if (path === "/scheduled-messages") {
      const filter = url.searchParams.get("chat_id");
      body = {
        scheduled_messages: scheduled.filter(
          (item) => !filter || item.chat_id === filter,
        ),
      };
    } else if (scheduledMatch) {
      const id = scheduledMatch[1]!;
      const current = scheduled.find((item) => item.id === id);
      if (!current) {
        status = 404;
        body = { code: "scheduled_message_not_found", message: "gone" };
      } else if (scheduledMatch[2]) {
        if (current.failure_reason === "not_member") {
          status = 409;
          body = {
            code: "scheduled_message_not_retryable",
            message: "still failing",
            details: { reason: "not_member" },
          };
        } else {
          scheduled = scheduled.filter((item) => item.id !== id);
          body = {
            ...current,
            status: "sent",
            body: "",
            failure_reason: null,
            message_id: "00000000-0000-4000-8000-000000000041",
            version: current.version + 2,
            sent_at: now.toISOString(),
          };
        }
      } else if (method === "DELETE") {
        scheduled = scheduled.filter((item) => item.id !== id);
        status = 204;
        body = undefined;
      } else if (method === "PATCH") {
        if (conflict) {
          // Someone changed it on the phone meanwhile.
          conflict = false;
          Object.assign(current, {
            body: "Изменено на телефоне",
            version: current.version + 1,
          });
          status = 409;
          body = { code: "version_conflict", message: "changed" };
        } else if (input?.expected_version !== current.version) {
          status = 409;
          body = { code: "version_conflict", message: "changed" };
        } else {
          const next = {
            ...current,
            ...(typeof input?.body === "string" ? { body: input.body } : {}),
            ...(typeof input?.silent === "boolean"
              ? { silent: input.silent }
              : {}),
            ...(typeof input?.send_at === "string"
              ? {
                  send_at: input.send_at,
                  status: "pending" as const,
                  failure_reason: null,
                  failed_at: null,
                }
              : {}),
            ...(Array.isArray(input?.file_ids)
              ? {
                  files: current.files.filter((file) =>
                    (input.file_ids as string[]).includes(file.id),
                  ),
                }
              : {}),
            version: current.version + 1,
          };
          scheduled = scheduled.map((item) => (item.id === id ? next : item));
          body = next;
        }
      } else body = current;
    } else if (path === "/sessions")
      body = {
        sessions: [
          {
            id: "session-current",
            user_agent: "Playwright",
            ip_address: "127.0.0.1",
            created_at: "2026-08-19T00:00:00Z",
            last_seen_at: "2026-11-11T07:00:00Z",
            expires_at: "2026-12-30T00:00:00Z",
            revoked_at: null,
            current: true,
          },
          {
            id: "session-other",
            user_agent: "Mobile Safari",
            ip_address: "10.0.0.2",
            created_at: "2026-08-19T00:00:00Z",
            last_seen_at: "2026-11-10T23:00:00Z",
            expires_at: "2026-12-30T00:00:00Z",
            revoked_at: null,
            current: false,
          },
        ],
      };
    else status = 404;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: body === undefined ? "" : JSON.stringify(body),
    });
  });
  return {
    requests,
    scheduled: () => scheduled,
    emit: (frame: { [key: string]: unknown }) =>
      page.evaluate(
        (value) =>
          (
            window as unknown as { __emitComaEvent(frame: unknown): void }
          ).__emitComaEvent(value),
        frame,
      ),
  };
}

const isPhone = () => test.info().project.name === "phone";
const shot = { animations: "disabled" as const };

async function openChat(page: Page) {
  await page.goto(`/chat/${chatID}`);
  await expect(
    page.locator(".message-feed").getByText("Макеты готовы"),
  ).toBeVisible();
}

/** Moves inside the single-page app without reloading it. */
async function spaNavigate(page: Page, to: string) {
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, to);
}

/** The arrow next to send on desktop, a long press on send on phones. */
async function openSendMenu(page: Page) {
  if (!isPhone()) {
    await page.getByRole("button", { name: "Настройки отправки" }).click();
    return;
  }
  const send = page.getByRole("button", { name: "Отправить", exact: true });
  await send.dispatchEvent("pointerdown", { pointerType: "touch" });
  await expect(
    page.getByRole("menu", { name: "Настройки отправки" }),
  ).toBeVisible();
  await send.dispatchEvent("pointerup", { pointerType: "touch" });
  await send.dispatchEvent("click");
}

test("a message is scheduled from the composer and shows in the strip", async ({
  page,
}) => {
  const api = await mockScheduled(page, { scheduled: [] });
  await openChat(page);
  // No strip while nothing waits in this chat.
  await expect(page.locator(".scheduled-bar")).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: /Сообщение|Напишите/ });
  await composer.fill("Доброе утро, команда!");
  await openSendMenu(page);
  const later = page.getByRole("menuitem", { name: /Отправить позже/ });
  await expect(later).toBeEnabled();
  await later.click();

  const dialog = page.getByRole("dialog", { name: "Отправить позже" });
  await expect(dialog.getByRole("radio")).toHaveCount(5);
  await expect(dialog.getByText("Через час")).toBeVisible();
  await expect(dialog.getByText("В понедельник, 9:00")).toBeVisible();
  await dialog.getByText("Завтра утром, 9:00").click();
  await expect(page).toHaveScreenshot("schedule-dialog.png", shot);
  await dialog
    .getByRole("button", { name: "Запланировать: завтра в 09:00" })
    .click();

  await expect(dialog).toHaveCount(0);
  await expect(composer).toHaveValue("");
  const created = api.requests.find(
    (item) =>
      item.method === "POST" && item.path.endsWith("/scheduled-messages"),
  );
  expect(created?.body).toMatchObject({
    body: "Доброе утро, команда!",
    body_format: "markdown",
    send_at: "2026-11-12T06:00:00.000Z",
    silent: false,
  });
  const bar = page.getByRole("button", {
    name: /Открыть отложенные сообщения этого чата/,
  });
  await expect(bar).toHaveText(/Отложено: 1 · ближайшее завтра в 09:00/);
  await expect(page).toHaveScreenshot("scheduled-strip.png", shot);
  await bar.click();
  await expect(page).toHaveURL(new RegExp(`/scheduled\\?chat=${chatID}`));
  await expect(page.getByText("Доброе утро, команда!")).toBeVisible();
});

test("a thread reply is scheduled as text in its thread", async ({ page }) => {
  test.skip(isPhone(), "the thread opens as its own page on phones");
  const api = await mockScheduled(page, { scheduled: [] });
  await page.goto(`/chat/${chatID}/thread/${message.id}`);
  const thread = page.getByRole("complementary", { name: /Тред/ });
  const reply = thread.getByRole("textbox", { name: "Ответить в треде…" });
  await reply.fill("Ответ утром");
  await thread.getByRole("button", { name: "Настройки отправки" }).click();
  await page.getByRole("menuitem", { name: /Отправить позже/ }).click();
  const dialog = page.getByRole("dialog", { name: "Отправить позже" });
  await dialog.getByText("Через час").click();
  await dialog.getByRole("switch", { name: "Без звука" }).click();
  await dialog
    .getByRole("button", { name: /Запланировать: сегодня в 11:15/ })
    .click();
  await expect(reply).toHaveValue("");
  const created = api.requests.find(
    (item) =>
      item.method === "POST" && item.path.endsWith("/scheduled-messages"),
  );
  expect(created?.body).toMatchObject({
    body: "Ответ утром",
    thread_root_id: message.id,
    silent: true,
    send_at: "2026-11-11T08:15:00.000Z",
  });
  expect(created?.body).not.toHaveProperty("file_ids");
});

test("past presets are hidden and a custom time is checked", async ({
  page,
}) => {
  await mockScheduled(page, { scheduled: [] });
  await page.clock.setFixedTime(new Date("2026-11-11T17:59:30+03:00"));
  await openChat(page);
  await page
    .getByRole("textbox", { name: /Сообщение|Напишите/ })
    .fill("Вечернее сообщение");
  await openSendMenu(page);
  await page.getByRole("menuitem", { name: /Отправить позже/ }).click();
  const dialog = page.getByRole("dialog", { name: "Отправить позже" });
  await expect(dialog.getByText("Сегодня вечером, 18:00")).toHaveCount(0);
  await dialog.getByText("Своё время").click();
  const input = dialog.getByLabel("Дата и время");
  await input.fill("2026-11-11T17:00");
  await expect(
    dialog.getByText("Выберите время не раньше чем через минуту"),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Запланировать", exact: true }),
  ).toBeDisabled();
  await input.fill("2026-11-11T21:30");
  await expect(
    dialog.getByRole("button", { name: "Запланировать: сегодня в 21:30" }),
  ).toBeEnabled();
});

test("shortcuts and right click open the send options", async ({ page }) => {
  test.skip(isPhone(), "keyboard and right click are desktop gestures");
  const api = await mockScheduled(page, { scheduled: [] });
  await openChat(page);
  const composer = page.getByRole("textbox", { name: /Сообщение|Напишите/ });
  await composer.fill("Тихое сообщение");
  await composer.press("Control+Alt+Enter");
  await expect(composer).toHaveValue("");
  await expect
    .poll(
      () =>
        api.requests.find(
          (item) => item.method === "POST" && item.path.endsWith("/messages"),
        )?.body,
    )
    .toMatchObject({ body: "Тихое сообщение", silent: true });

  await composer.fill("Позже");
  await composer.press("Control+Shift+Enter");
  await expect(
    page.getByRole("dialog", { name: "Отправить позже" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(composer).toHaveValue("Позже");

  await page.getByRole("button", { name: "Отправить", exact: true }).click({
    button: "right",
  });
  const menu = page.getByRole("menu", { name: "Настройки отправки" });
  await expect(
    menu.getByRole("menuitem", { name: /Отправить без звука/ }),
  ).toHaveAttribute("aria-keyshortcuts", /Control\+Alt\+Enter/);
  await expect(page).toHaveScreenshot("send-menu.png", shot);
  await menu.getByRole("menuitem", { name: /Отправить без звука/ }).click();
  await expect(composer).toHaveValue("");
});

for (const theme of ["light", "dark"] as const) {
  test(`scheduled page groups by day and marks failures (${theme})`, async ({
    page,
  }) => {
    await mockScheduled(page, { theme });
    await page.goto("/scheduled");
    await expect(
      page.getByRole("heading", { name: "Отложенные", level: 1 }),
    ).toBeVisible();
    const headings = page.locator(".scheduled-group > h2");
    await expect(headings).toHaveText([
      "Не отправлены",
      "Сегодня",
      "Завтра",
      /16 ноября/,
    ]);
    await expect(page.getByText("Вы больше не участник чата")).toBeVisible();
    await expect(page.getByText("Чат удалён или в архиве")).toBeVisible();
    await expect(
      page.locator(".scheduled-card__chat--gone", {
        hasText: "Недоступный чат",
      }),
    ).toBeVisible();
    await expect(page.getByText("plan-week-46.pdf")).toBeVisible();
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
    await expect(page).toHaveScreenshot(`scheduled-page-${theme}.png`, {
      ...shot,
      fullPage: true,
    });
    if (!isPhone()) {
      await expect(
        page
          .getByRole("navigation", { name: "Основная навигация" })
          .getByRole("button", { name: "Отложенные" }),
      ).toHaveAttribute("aria-current", "page");
    }
  });
}

test("editing keeps the text through a version conflict", async ({ page }) => {
  const api = await mockScheduled(page, { conflictOnce: true });
  await page.goto("/scheduled");
  const card = page.locator(".scheduled-card", {
    hasText: "Напоминание: созвон",
  });
  await card.getByRole("button", { name: "Изменить" }).click();
  const editor = page.getByRole("dialog", {
    name: "Изменить отложенное сообщение",
  });
  const text = editor.getByLabel("Текст сообщения");
  await text.fill("Созвон переносится на 19:00");
  await editor.getByRole("button", { name: "Сохранить" }).click();
  await expect(editor.getByRole("alert")).toHaveText(
    /Сообщение изменили на другом устройстве/,
  );
  await expect(text).toHaveValue("Созвон переносится на 19:00");
  await expect(page).toHaveScreenshot("scheduled-editor-conflict.png", shot);
  await editor.getByRole("button", { name: "Сохранить" }).click();
  await expect(editor).toHaveCount(0);
  const patches = api.requests.filter((item) => item.method === "PATCH");
  expect(patches.map((item) => item.body)).toEqual([
    expect.objectContaining({ expected_version: 1 }),
    expect.objectContaining({
      expected_version: 2,
      body: "Созвон переносится на 19:00",
    }),
  ]);
  await expect(
    page.locator(".scheduled-card", { hasText: "Созвон переносится на 19:00" }),
  ).toBeVisible();

  // Removing the attachment sends the new list of files.
  const withFile = page.locator(".scheduled-card", {
    hasText: "plan-week-46.pdf",
  });
  await withFile.getByRole("button", { name: "Изменить" }).click();
  await editor.getByRole("button", { name: "Убрать plan-week-46.pdf" }).click();
  await editor.getByRole("button", { name: "Сохранить" }).click();
  await expect(editor).toHaveCount(0);
  expect(
    api.requests.filter((item) => item.method === "PATCH").at(-1)?.body,
  ).toMatchObject({ file_ids: [] });
  await expect(page.getByText("plan-week-46.pdf")).toHaveCount(0);
});

test("time, send now and delete act on a pending message", async ({ page }) => {
  const api = await mockScheduled(page);
  await page.goto("/scheduled");
  const card = page.locator(".scheduled-card", { hasText: "Итоги ретро" });
  await card.getByRole("button", { name: "Время" }).click();
  const dialog = page.getByRole("dialog", { name: "Перенести отправку" });
  await dialog.getByText("Сегодня вечером, 18:00").click();
  await dialog
    .getByRole("button", { name: "Перенести: сегодня в 18:00" })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    api.requests.filter((item) => item.method === "PATCH").at(-1)?.body,
  ).toEqual({ expected_version: 1, send_at: "2026-11-11T15:00:00.000Z" });

  const morning = page.locator(".scheduled-card", { hasText: "Доброе утро!" });
  await morning.getByRole("button", { name: "Отправить сейчас" }).click();
  await expect(page.getByText("Сообщение отправлено")).toBeVisible();
  await expect(morning).toHaveCount(0);

  const reminder = page.locator(".scheduled-card", {
    hasText: "Напоминание: созвон",
  });
  await reminder.getByRole("button", { name: "Удалить" }).click();
  const confirm = page.getByRole("dialog", {
    name: "Удалить отложенное сообщение?",
  });
  await expect(confirm).toContainText("Отменить это нельзя");
  await confirm.getByRole("button", { name: "Удалить" }).click();
  await expect(reminder).toHaveCount(0);
  expect(
    api.requests.some(
      (item) => item.method === "DELETE" && item.path.endsWith("0501"),
    ),
  ).toBe(true);
});

test("a failed message names its reason and can be sent again", async ({
  page,
}) => {
  const api = await mockScheduled(page);
  await page.goto("/scheduled");
  const failed = page.locator(".scheduled-card--failed", {
    hasText: "Отчёт за неделю",
  });
  await expect(failed).toContainText("Не отправлено");
  await expect(failed).toContainText("Вы больше не участник чата");
  // The cause still holds: the server refuses and says why.
  await failed.getByRole("button", { name: "Отправить сейчас" }).click();
  await expect(
    page.getByText("Отправить не получится: Вы больше не участник чата"),
  ).toBeVisible();
  await expect(failed).toBeVisible();

  // The other one is rescheduled through the editor: a new time is required.
  const gone = page.locator(".scheduled-card--failed", {
    hasText: "Поздравляю с запуском!",
  });
  await gone.getByRole("button", { name: "Изменить" }).click();
  const editor = page.getByRole("dialog", {
    name: "Изменить отложенное сообщение",
  });
  await expect(editor).toContainText("Не отправлено: Чат удалён или в архиве");
  await editor.getByText("Завтра утром, 9:00").click();
  await editor
    .getByRole("button", { name: "Сохранить и запланировать" })
    .click();
  await expect(editor).toHaveCount(0);
  expect(
    api.requests.filter((item) => item.method === "PATCH").at(-1)?.body,
  ).toEqual({ expected_version: 2, send_at: "2026-11-12T06:00:00.000Z" });
  await expect(page.locator(".scheduled-card--failed")).toHaveCount(1);
});

test("realtime events refresh the list without carrying text", async ({
  page,
}) => {
  const api = await mockScheduled(page);
  await page.goto("/scheduled");
  const reminder = page.locator(".scheduled-card", {
    hasText: "Напоминание: созвон",
  });
  await expect(reminder).toBeVisible();
  const target = api.scheduled()[0]!;
  Object.assign(target, {
    status: "failed",
    failure_reason: "security_reset",
    failed_at: now.toISOString(),
    version: 2,
  });
  await api.emit({
    op: "event",
    seq: 10,
    type: "scheduled_message.failed",
    occurred_at: now.toISOString(),
    actor_id: user.id,
    chat_id: null,
    subject_id: target.id,
    data: {
      id: target.id,
      chat_id: chatID,
      status: "failed",
      version: 2,
      send_at: target.send_at,
      failure_reason: "security_reset",
    },
  });
  await expect(
    page.locator(".scheduled-card--failed", { hasText: "Напоминание" }),
  ).toContainText("Изменились пароль или почта");
  await api.emit({
    op: "event",
    seq: 11,
    type: "scheduled_message.deleted",
    occurred_at: now.toISOString(),
    actor_id: user.id,
    chat_id: null,
    subject_id: target.id,
    data: {
      id: target.id,
      chat_id: chatID,
      status: "deleted",
      version: 2,
      send_at: target.send_at,
      failure_reason: "security_reset",
    },
  });
  await expect(reminder).toHaveCount(0);
});

test("security actions warn that pending messages will stop", async ({
  page,
}) => {
  const api = await mockScheduled(page);
  await page.goto("/settings/security");
  const warnings = page.getByText("3 отложенных сообщения не будут отправлены");
  await expect(warnings).toHaveCount(3);
  await page
    .getByRole("button", { name: "Выйти на остальных устройствах" })
    .click();
  const confirm = page.getByRole("dialog", {
    name: "Выйти на других устройствах?",
  });
  await expect(confirm).toContainText(
    "3 отложенных сообщения не будут отправлены. Их можно будет отправить снова",
  );
  await expect(page).toHaveScreenshot("security-warning.png", shot);
  await confirm.getByRole("button", { name: "Отмена" }).click();
  expect(
    api.requests.some((item) => item.path === "/sessions/revoke-others"),
  ).toBe(false);
  await page
    .getByRole("button", { name: "Выйти на остальных устройствах" })
    .click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await expect
    .poll(() =>
      api.requests.some((item) => item.path === "/sessions/revoke-others"),
    )
    .toBe(true);
});

test("a message stopped by a security event is read before it goes again", async ({
  page,
}) => {
  const stopped = record(6, {
    body: "Переведите 300 000 ₽ по новым реквизитам до вечера",
    status: "failed",
    failure_reason: "security_reset",
    send_at: "2026-11-11T05:00:00Z",
    failed_at: "2026-11-11T05:00:02Z",
    version: 2,
  });
  const api = await mockScheduled(page, {
    scheduled: [...fixtures(), stopped],
  });
  await page.goto("/scheduled");
  const card = page.locator(".scheduled-card--failed", {
    hasText: "Переведите 300 000",
  });
  await expect(card).toContainText("возможно, запланировали не вы");
  const sendNow = card.getByRole("button", { name: "Отправить сейчас" });
  // Not the main action here: an ordinary failure keeps the primary button.
  await expect(sendNow).not.toHaveClass(/ui-button--primary/);
  await expect(
    page
      .locator(".scheduled-card--failed", { hasText: "Отчёт за неделю" })
      .getByRole("button", { name: "Отправить сейчас" }),
  ).toHaveClass(/ui-button--primary/);

  await sendNow.click();
  const check = page.getByRole("dialog", { name: "Проверьте сообщение" });
  await expect(check).toContainText(
    "Сообщение остановлено после смены пароля или отключения устройства. Возможно, его запланировали не вы — проверьте текст.",
  );
  await expect(check.locator("blockquote")).toHaveText(
    "Переведите 300 000 ₽ по новым реквизитам до вечера",
  );
  await expect(page).toHaveScreenshot("scheduled-verify.png", shot);
  await check.getByRole("button", { name: "Отмена" }).click();
  expect(api.requests.some((item) => item.path.endsWith("/send"))).toBe(false);

  // Moving it asks first too, then opens the time picker.
  await card.getByRole("button", { name: "Время" }).click();
  await check.getByRole("button", { name: "Выбрать время" }).click();
  await expect(
    page.getByRole("dialog", { name: "Перенести отправку" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  expect(api.requests.some((item) => item.method === "PATCH")).toBe(false);

  await sendNow.click();
  await check.getByRole("button", { name: "Отправить сейчас" }).click();
  await expect(page.getByText("Сообщение отправлено")).toBeVisible();
  expect(
    api.requests.filter((item) => item.path.endsWith("/send")),
  ).toHaveLength(1);
});

test("the next person in the tab never sees the previous one's scheduled messages", async ({
  page,
}) => {
  test.skip(isPhone(), "sign-out lives in the More page on phones");
  const api = await mockScheduled(page, { switchUser: true });
  await openChat(page);
  // Anna has a message waiting here, failures in the sidebar and warnings.
  await expect(page.locator(".scheduled-bar")).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Основная навигация" })
      .getByRole("button", { name: "Отложенные" }),
  ).toContainText("2");

  await page.getByRole("button", { name: /Меню пространства/ }).click();
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  await page.getByLabel("Почта").fill("boris@example.com");
  await page.getByLabel("Пароль", { exact: true }).fill("correct horse battery");
  await page.getByRole("button", { name: "Войти" }).click();

  // Everything below navigates inside the app: a reload would empty the
  // cache by itself and prove nothing.
  await expect(page.getByRole("button", { name: "Борис" })).toBeVisible();
  await spaNavigate(page, `/chat/${chatID}`);
  await expect(
    page.locator(".message-feed").getByText("Макеты готовы"),
  ).toBeVisible();
  await expect
    .poll(() =>
      api.requests.some((item) => item.path === "second:/scheduled-messages"),
    )
    .toBe(true);
  await expect(page.locator(".scheduled-bar")).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation", { name: "Основная навигация" })
      .getByRole("button", { name: "Отложенные" }),
  ).not.toContainText("2");
  await spaNavigate(page, "/scheduled");
  await expect(
    page.getByRole("heading", { name: "Отложенные", level: 1 }),
  ).toBeVisible();
  await expect(page.locator(".scheduled-card")).toHaveCount(0);
  await expect(page.getByText("Отчёт за неделю")).toHaveCount(0);
  await spaNavigate(page, "/settings/security");
  await expect(
    page.getByRole("button", { name: "Выйти на остальных устройствах" }),
  ).toBeVisible();
  await expect(
    page.getByText(/отложенн\S* сообщени\S* не будут отправлены/),
  ).toHaveCount(0);
});
