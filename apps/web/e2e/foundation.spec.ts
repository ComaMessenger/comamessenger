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
  actor_id: "00000000-0000-4000-8000-000000000002",
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
  } = {},
) {
  const { messageCount = 1, chatPatch = {}, sendFailures = 0 } = options;
  const runtimeChat = { ...chat, ...chatPatch };
  let remainingSendFailures = sendFailures;
  const history =
    messageCount === 1
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
        }));
  await page.addInitScript(() => {
    localStorage.setItem("coma-locale", "ru");
    localStorage.setItem("coma-theme", "light");
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: null | (() => void) = null;
      onmessage: null | ((event: { data: string }) => void) = null;
      onclose = null;
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
    Object.assign(window, { WebSocket: FakeSocket });
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let status = 200;
    let body: unknown = {};
    if (path.endsWith("/bootstrap/status")) body = { bootstrapped: true };
    else if (path.endsWith("/auth/refresh"))
      body = {
        access_token: "test",
        access_expires_at: "2026-08-20T00:00:00Z",
        user,
      };
    else if (path.endsWith("/chats")) body = { chats: [runtimeChat] };
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
        ],
      };
    else if (
      path.endsWith(`/chats/${chat.id}/messages`) &&
      route.request().method() === "POST"
    ) {
      if (remainingSendFailures > 0) {
        remainingSendFailures -= 1;
        status = 503;
        body = { code: "service_unavailable", message: "offline" };
      } else {
        const input = route.request().postDataJSON();
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
    } else if (path.endsWith(`/chats/${chat.id}/messages`))
      body = { messages: history, next_before_seq: null };
    else if (path.endsWith(`/chats/${chat.id}/read`))
      body = {
        chat_id: chat.id,
        last_read_seq: 3,
        last_read_at: "2026-08-19T06:31:00Z",
      };
    else status = 404;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

test("responsive chat list opens a channel with a read-only composer", async ({
  page,
}) => {
  await mockMessenger(page);
  await page.goto("/chats");
  await expect(page.getByRole("button", { name: /Объявления/ })).toBeVisible();
  await page.getByRole("button", { name: "Личные" }).click();
  await expect(page).toHaveURL(/filter=direct/);
  await expect(page.getByRole("button", { name: /Объявления/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Все" }).click();
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
