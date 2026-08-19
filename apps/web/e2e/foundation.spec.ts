import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("component catalog supports light, dark and phone", async ({ page }) => {
  await page.goto("/dev/components");
  await expect(page.getByRole("heading", { name: "Coma UI" })).toBeVisible();
  await expect(page).toHaveScreenshot("component-catalog-light.png", {
    animations: "disabled",
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect(page.getByRole("button", { name: "Primary" })).toBeVisible();
  await expect(page).toHaveScreenshot("component-catalog-dark.png", {
    animations: "disabled",
  });
});

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  org_id: "00000000-0000-4000-8000-000000000010",
  role: "owner",
  email: "owner@example.com",
  display_name: "Анна",
  handle: "anna",
  timezone: "UTC",
  status: "active",
  created_at: "2026-08-19T00:00:00Z",
};
const lev = {
  actor_id: "01a01612-85e4-7145-bda3-82db7b4a3075",
  display_name: "Лев",
  handle: "lev",
  role: "member",
  joined_at: "2026-08-19T00:00:00Z",
};
const chat = {
  id: "00000000-0000-4000-8000-000000000020",
  kind: "channel",
  visibility: "private",
  name: "Объявления",
  topic: "Важное для команды",
  role: "member",
  created_at: "2026-08-19T00:00:00Z",
  display_name: "Объявления",
  avatar_seed: "announcements",
  last_activity_seq: 3,
  last_message_at: "2026-08-19T06:30:00Z",
  last_message: {
    id: "00000000-0000-4000-8000-000000000030",
    actor_id: "00000000-0000-4000-8000-000000000002",
    actor_display_name: "Илья",
    body: "Добро пожаловать в Coma",
    created_seq: 3,
    created_at: "2026-08-19T06:30:00Z",
    deleted: false,
  },
};
const message = {
  id: "00000000-0000-4000-8000-000000000030",
  chat_id: chat.id,
  actor_id: lev.actor_id,
  client_msg_id: "00000000-0000-4000-8000-000000000031",
  type: "text",
  body: "Добро пожаловать в **Coma**",
  body_format: "markdown",
  version: 1,
  created_seq: 3,
  created_at: "2026-08-19T06:30:00Z",
  mentioned_actor_ids: [],
};

async function mockMessenger(
  page: import("@playwright/test").Page,
  options: {
    messageCount?: number;
    chatPatch?: Record<string, unknown>;
    sendFailures?: number;
    history?: Array<Record<string, unknown>>;
    paginate?: boolean;
  } = {},
) {
  const {
    messageCount = 1,
    chatPatch = {},
    sendFailures = 0,
    history: suppliedHistory,
    paginate = false,
  } = options;
  const runtimeChat = { ...chat, ...chatPatch };
  let remainingSendFailures = sendFailures;
  let paginationRequests = 0;
  let refreshRequests = 0;
  const sent: Array<Record<string, unknown>> = [];
  const history =
    suppliedHistory ??
    (messageCount === 1
      ? [message]
      : Array.from({ length: messageCount }, (_, index) => ({
          ...message,
          id: `message-${index + 1}`,
          client_msg_id: `client-${index + 1}`,
          body: `Message ${index + 1}`,
          created_seq: index + 1,
          created_at: new Date(
            Date.UTC(2026, 7, 19, 0, 0, index),
          ).toISOString(),
        })));
  await page.addInitScript(() => {
    localStorage.setItem("coma-locale", "ru");
    localStorage.setItem("coma-theme", "light");
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
                  current_seq: 3,
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
      __expireComaSocket: () => FakeSocket.latest?.onclose?.({ code: 4001 }),
    });
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let status = 200;
    let body: unknown = {};
    if (path.endsWith("/bootstrap/status")) body = { bootstrapped: true };
    else if (path.endsWith("/auth/refresh")) {
      refreshRequests += 1;
      body = {
        access_token: "test",
        access_expires_at: "2026-08-20T00:00:00Z",
        user,
      };
    } else if (path.endsWith("/chats")) body = { chats: [runtimeChat] };
    else if (path.endsWith("/unread"))
      body = {
        chats: [
          {
            chat_id: chat.id,
            last_read_seq: 0,
            unread_count: 3,
            mention_count: 1,
          },
        ],
        threads: [],
      };
    else if (path.endsWith("/drafts")) body = { drafts: [] };
    else if (path.endsWith(`/chats/${chat.id}/members`))
      body = {
        members: [
          {
            actor_id: user.id,
            display_name: user.display_name,
            handle: user.handle,
            role: "member",
            joined_at: "2026-08-19T00:00:00Z",
          },
          lev,
        ],
      };
    else if (path.endsWith(`/chats/${chat.id}/notification-preferences`))
      body =
        route.request().method() === "PATCH"
          ? route.request().postDataJSON()
          : { notify_level: "all", muted_until: null };
    else if (
      path.endsWith(`/chats/${chat.id}/messages`) &&
      route.request().method() === "POST"
    ) {
      if (remainingSendFailures > 0) {
        remainingSendFailures -= 1;
        status = 503;
        body = { code: "service_unavailable", message: "offline" };
      } else {
        const input = route.request().postDataJSON() as Record<string, unknown>;
        sent.push(input);
        status = 201;
        body = {
          ...message,
          id: "00000000-0000-4000-8000-000000000040",
          actor_id: user.id,
          client_msg_id: input.client_msg_id,
          body: input.body,
          created_seq: 4,
          created_at: "2026-08-19T06:32:00Z",
        };
      }
    } else if (/\/messages\/[^/]+\/context$/.test(path))
      body = {
        messages: history,
        target_id: path.split("/").at(-2),
        has_earlier: false,
        has_later: false,
      };
    else if (/\/messages\/[^/]+\/thread$/.test(path)) {
      const rootID = path.split("/").at(-2);
      const root = history.find((item) => item.id === rootID) ?? history[0];
      body = {
        messages: [
          root,
          {
            ...message,
            id: "thread-reply-1",
            client_msg_id: "thread-client-1",
            body: "Ответ внутри треда",
            thread_root_id: rootID,
            created_seq: 100,
            created_at: "2026-08-19T06:35:00Z",
          },
        ],
        next_before_seq: null,
      };
    } else if (path.endsWith(`/chats/${chat.id}/messages`)) {
      if (paginate) {
        const middle = Math.floor(history.length / 2);
        if (url.searchParams.has("before_seq")) {
          paginationRequests += 1;
          body = { messages: history.slice(0, middle), next_before_seq: null };
        } else
          body = {
            messages: history.slice(middle),
            next_before_seq: history[middle]?.created_seq ?? null,
          };
      } else body = { messages: history, next_before_seq: null };
    } else if (path.endsWith(`/chats/${chat.id}/read`))
      body = {
        chat_id: chat.id,
        last_read_seq: 3,
        last_read_at: "2026-08-19T06:31:00Z",
      };
    else if (/\/messages\/[^/]+\/reactions$/.test(path))
      body = { reactions: [] };
    else if (/\/messages\/[^/]+\/reactions\/.+/.test(path))
      body = {
        message_id: message.id,
        actor_id: user.id,
        emoji: decodeURIComponent(path.split("/").at(-1) ?? ""),
        created_at: "2026-08-19T06:34:00Z",
      };
    else status = 404;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return {
    sent,
    paginationRequests: () => paginationRequests,
    refreshRequests: () => refreshRequests,
  };
}

test("responsive chat list opens a channel with a read-only composer", async ({
  page,
}) => {
  await mockMessenger(page);
  await page.goto("/chats");
  await expect(page.getByRole("button", { name: /Объявления/ })).toBeVisible();
  if (test.info().project.name === "phone") {
    const header = await page.locator(".workspace-switcher").boundingBox();
    expect(header?.y).toBeLessThan(4);
    await expect(page).toHaveScreenshot("chat-list.png", {
      animations: "disabled",
    });
  }
  if (test.info().project.name === "phone") {
    await page.getByRole("button", { name: "Личные" }).click();
    await expect(page).toHaveURL(/filter=direct/);
    await expect(page.getByRole("button", { name: /Объявления/ })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Все" }).click();
  }
  await page.getByRole("button", { name: /Объявления/ }).click();
  await expect(
    page.getByText("Добро пожаловать в Coma", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("В канале публикуют только администраторы"),
  ).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await expect(page).toHaveScreenshot("channel-readonly.png", {
    animations: "disabled",
  });
  if (test.info().project.name === "phone") {
    await expect(page.getByRole("button", { name: "Назад" })).toBeVisible();
    await page.getByRole("button", { name: "Назад" }).click();
    await expect(
      page.getByRole("button", { name: /Объявления/ }),
    ).toBeVisible();
  }
});

test("mentions and reply previews never expose actor or message IDs", async ({
  page,
}) => {
  const reply = {
    ...message,
    id: "00000000-0000-4000-8000-000000000041",
    client_msg_id: "00000000-0000-4000-8000-000000000042",
    actor_id: user.id,
    body: `@[Лев](${lev.actor_id}) ты как`,
    reply_to_id: message.id,
    mentioned_actor_ids: [lev.actor_id],
    created_seq: 4,
    created_at: "2026-08-19T06:31:00Z",
  };
  const { sent } = await mockMessenger(page, {
    chatPatch: {
      kind: "group",
      role: "owner",
      last_message: {
        ...chat.last_message,
        actor_display_name: "Лев",
        body: `@[Лев](${lev.actor_id}) привет`,
      },
    },
    history: [message, reply],
  });
  await page.goto("/chats");
  if (test.info().project.name === "phone")
    await expect(
      page.locator(".mobile-chat-list .chat-card__preview"),
    ).toContainText("Лев: @Лев привет");
  await expect(page.getByText(lev.actor_id)).toHaveCount(0);
  await page.getByRole("button", { name: /Объявления/ }).click();
  await expect(page.locator(".message__quote")).toContainText(
    "Добро пожаловать в Coma",
  );
  await expect(page.locator(".message__quote")).not.toContainText(
    message.id.slice(0, 8),
  );
  const composer = page.getByRole("textbox", { name: "Напишите сообщение…" });
  await composer.fill("@ле");
  await page.getByRole("button", { name: /Лев.*@lev/ }).click();
  await expect(composer).toHaveValue("@Лев ");
  await expect(page).toHaveScreenshot("mention-reply.png", {
    animations: "disabled",
  });
  await composer.pressSequentially("привет");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]?.body).toBe(`@[Лев](${lev.actor_id}) привет`);
  expect(sent[0]?.mentioned_actor_ids).toEqual([lev.actor_id]);
});

test("chat and message actions stay contextual", async ({ page }) => {
  await mockMessenger(page, { chatPatch: { kind: "group", role: "admin" } });
  await page.goto("/chats");
  await page.getByRole("button", { name: "Поиск" }).click();
  await expect(page.getByRole("dialog", { name: "Поиск" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Поиск" })).toHaveCount(0);
  const chatButton = page.getByRole("button", { name: /Объявления/ });
  await chatButton.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Открыть чат" }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Открыть чат" }).click();
  const messageRow = page.locator("article.message").first();
  await messageRow.hover();
  await page.getByRole("button", { name: "Действия с сообщением" }).click();
  await page.getByRole("menuitem", { name: "Добавить реакцию" }).click();
  await expect(page.getByRole("dialog", { name: "Эмодзи" })).toBeVisible();
  await expect(page.getByPlaceholder("Поиск эмодзи…")).toBeVisible();
  await page.locator(".conversation-head").click();
  await expect(page.getByRole("dialog", { name: "Эмодзи" })).toHaveCount(0);
  await messageRow.hover();
  await page.getByRole("button", { name: "Действия с сообщением" }).click();
  await expect(page.getByRole("menuitem", { name: "Ответить" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Копировать ссылку" }),
  ).toBeVisible();
  await page.locator(".conversation-head").click();
  await expect(
    page.getByRole("menuitem", { name: "Копировать ссылку" }),
  ).toHaveCount(0);
});

test("a thread opens beside an unchanged main feed", async ({ page }) => {
  await mockMessenger(page, {
    messageCount: 2,
    chatPatch: { kind: "group", role: "admin" },
  });
  await page.goto(`/chat/${chat.id}`);
  await expect(page.locator("#message-message-1")).toBeVisible();
  await expect(page.locator("#message-message-2")).toBeVisible();
  await page.locator("#message-message-1").hover();
  if (test.info().project.name === "phone") {
    await page
      .locator("#message-message-1")
      .getByRole("button", { name: "Действия с сообщением" })
      .click();
    await page.getByRole("menuitem", { name: "В тред" }).click();
  } else
    await page
      .locator("#message-message-1")
      .getByRole("button", { name: "В тред" })
      .click();
  await expect(page.getByRole("complementary", { name: "Тред" })).toBeVisible();
  await expect(page.locator("#thread-message-message-1")).toBeVisible();
  await expect(page.getByText("Ответ внутри треда")).toBeVisible();
  await expect(page.locator("#message-message-1")).toBeVisible();
  await expect(page.locator("#message-message-2")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Напишите сообщение…" }),
  ).toHaveCount(2);
  await expect(page).toHaveScreenshot("thread-panel.png", {
    animations: "disabled",
  });
  if (test.info().project.name === "phone") {
    const panel = await page
      .getByRole("complementary", { name: "Тред" })
      .boundingBox();
    expect(panel?.x).toBe(0);
    expect(panel?.width).toBe(page.viewportSize()?.width);
  }
  await page
    .getByRole("complementary", { name: "Тред" })
    .getByRole("button", { name: "Закрыть" })
    .click();
  await expect(page.getByRole("complementary", { name: "Тред" })).toHaveCount(
    0,
  );
});

test("history uses automatic cursor pagination", async ({ page }) => {
  const mock = await mockMessenger(page, {
    messageCount: 60,
    paginate: true,
    chatPatch: { kind: "group", role: "admin" },
  });
  await page.goto(`/chat/${chat.id}`);
  await expect(page.locator("article.message").first()).toBeVisible();
  await page.locator(".message-scroll").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(mock.paginationRequests).toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "Загрузить предыдущие" }),
  ).toHaveCount(0);
});

test("the formatting toolbar writes markdown source", async ({ page }) => {
  const { sent } = await mockMessenger(page, {
    chatPatch: { kind: "group", role: "admin" },
  });
  await page.goto(`/chat/${chat.id}`);
  const composer = page.getByRole("textbox", { name: "Напишите сообщение…" });
  await composer.fill("План");
  await composer.selectText();
  await page.getByRole("button", { name: "Форматирование" }).click();
  await page.getByRole("button", { name: "Заголовок" }).click();
  await expect(composer).toHaveValue("## План");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]?.body).toBe("## План");
});

test("composer send controls activate only when there is content", async ({
  page,
}) => {
  await mockMessenger(page, {
    chatPatch: { kind: "group", role: "admin" },
  });
  await page.goto(`/chat/${chat.id}`);
  const composer = page.getByRole("textbox", { name: "Напишите сообщение…" });
  const send = page.getByRole("button", { name: "Отправить" });
  const settings = page.getByRole("button", { name: "Настройки отправки" });
  const controls = page.locator(".composer__send");

  await expect(send).toBeDisabled();
  await expect(settings).toBeDisabled();
  await expect(controls).not.toHaveClass(/composer__send--active/);

  await composer.fill("Сообщение");
  await expect(send).toBeEnabled();
  await expect(settings).toBeEnabled();
  await expect(controls).toHaveClass(/composer__send--active/);
  await settings.click();
  await expect(
    page.getByRole("radio", {
      name: "Enter — отправка сообщения Shift + Enter — перенос строки",
      exact: true,
    }),
  ).toBeChecked();

  await composer.fill("");
  await expect(send).toBeDisabled();
  await expect(settings).toBeDisabled();
  await expect(page.getByRole("radio")).toHaveCount(0);
});

test("an expired websocket token refreshes without leaving the messenger", async ({
  page,
}) => {
  const mock = await mockMessenger(page, {
    chatPatch: { kind: "group", role: "admin" },
  });
  await page.goto(`/chat/${chat.id}`);
  await expect(
    page.getByRole("heading", { name: "Объявления", level: 1 }),
  ).toBeVisible();
  const before = mock.refreshRequests();
  await page.evaluate(() =>
    (window as Window & { __expireComaSocket(): void }).__expireComaSocket(),
  );
  await expect.poll(mock.refreshRequests).toBeGreaterThan(before);
  await expect(
    page.getByRole("heading", { name: "Объявления", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Войти" })).toHaveCount(0);
});

test("a 10k-message history stays virtualized", async ({ page }) => {
  test.skip(test.info().project.name === "phone", "desktop performance probe");
  await mockMessenger(page, { messageCount: 10_000 });
  await page.goto(`/chat/${chat.id}`);
  await expect(page.getByRole("main")).toBeVisible();
  await expect
    .poll(() => page.locator("article.message").count())
    .toBeGreaterThan(0);
  expect(await page.locator("article.message").count()).toBeLessThan(100);
});

test("an optimistic message retries with the same client command", async ({
  page,
}) => {
  await mockMessenger(page, {
    chatPatch: {
      kind: "group",
      role: "owner",
      name: "Команда",
      display_name: "Команда",
    },
    sendFailures: 1,
  });
  await page.goto(`/chat/${chat.id}`);
  const composer = page.getByRole("textbox", { name: "Напишите сообщение…" });
  await composer.fill("Сообщение из outbox");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.getByRole("button", { name: "Повторить" })).toBeVisible();
  await page.getByRole("button", { name: "Повторить" }).click();
  await expect(
    page.getByText("Сообщение из outbox", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Повторить" })).toHaveCount(0);
});
