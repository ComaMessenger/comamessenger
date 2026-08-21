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

test("content security policy permits blob image previews", async ({
  page,
}) => {
  const response = await page.goto("/dev/components");
  expect(response?.headers()["content-security-policy"]).toContain(
    "img-src 'self' data: blob:",
  );

  const dimensions = await page.evaluate(async () => {
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    );
    const objectURL = URL.createObjectURL(
      new Blob([png], { type: "image/png" }),
    );
    try {
      const image = new Image();
      image.src = objectURL;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    } finally {
      URL.revokeObjectURL(objectURL);
    }
  });

  expect(dimensions).toEqual({ width: 1, height: 1 });
});

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  org_id: "00000000-0000-4000-8000-000000000010",
  organization_name: "Test space",
  role: "owner",
  email: "owner@example.com",
  display_name: "Анна",
  handle: "anna",
  title: "Главный администратор",
  about: "",
  timezone: "UTC",
  status: "active",
  must_change_password: false,
  can_create_invitations: true,
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
  notify_level: "default",
  muted_until: null,
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
  files: [],
  thread_reply_count: 0,
};

async function mockMessenger(
  page: import("@playwright/test").Page,
  options: {
    messageCount?: number;
    chatPatch?: Record<string, unknown>;
    sendFailures?: number;
    history?: Array<Record<string, unknown>>;
    paginate?: boolean;
    theme?: "light" | "dark";
    mustChangePassword?: boolean;
    passwordRecoveryAvailable?: boolean;
    signedOut?: boolean;
    reactions?: Array<Record<string, unknown>>;
    threads?: Array<Record<string, unknown>>;
    userPatch?: Partial<typeof user>;
    organizationPatch?: Record<string, unknown>;
    preferencesPatch?: Record<string, unknown>;
    unread?: {
      last_read_seq: number;
      unread_count: number;
      mention_count: number;
    };
  } = {},
) {
  const {
    messageCount = 1,
    chatPatch = {},
    sendFailures = 0,
    history: suppliedHistory,
    paginate = false,
    theme = "light",
    mustChangePassword = false,
    passwordRecoveryAvailable = false,
    signedOut = false,
    reactions: suppliedReactions = [],
    threads = [],
    userPatch = {},
    organizationPatch = {},
    preferencesPatch = {},
    unread = { last_read_seq: 0, unread_count: 3, mention_count: 1 },
  } = options;
  let runtimeUser = {
    ...user,
    ...userPatch,
    must_change_password: mustChangePassword,
  };
  const runtimeChat = { ...chat, ...chatPatch };
  let runtimeReactions = [...suppliedReactions];
  const reactionMutations: string[] = [];
  const statusMutations: Array<Record<string, unknown>> = [];
  let chatRequests = 0;
  let remainingSendFailures = sendFailures;
  let paginationRequests = 0;
  let refreshRequests = 0;
  let preferences = {
    theme,
    locale: "ru",
    in_app_enabled: true,
    push_enabled: false,
    push_preview: false,
    notify_messages: "all" as const,
    notify_threads: "all" as const,
    notify_reactions: true,
    notify_invites: true,
    notify_system: true,
    sound_enabled: true,
    sound_id: "default" as const,
    schedule: null as null | {
      days: "all" | "weekdays" | number[];
      from: string;
      to: string;
    },
    snoozed_until: null as string | null,
    email_digest: false,
    ...preferencesPatch,
  };
  let chatFolders: Array<Record<string, unknown>> = [];
  let pinnedChatIDs: string[] = [];
  let organizationSettings = {
    id: user.org_id,
    name: user.organization_name,
    slug: "test-space",
    version: 1,
    invitation_default_role: "member",
    invitation_ttl_hours: 168,
    default_timezone: "UTC",
    allow_member_invitations: false,
    allow_public_chat_creation: true,
    allow_channel_creation: false,
    accent_color: "#174586",
    has_logo: false,
    has_favicon: false,
    ...organizationPatch,
  };
  let runtimeInvitations: Array<Record<string, unknown>> = [];
  let infrastructure = {
    version: 0,
    s3: {
      endpoint: "",
      region: "",
      bucket: "",
      prefix: "",
      force_path_style: false,
      credentials_configured: false,
      access_key_hint: "",
    },
    smtp: {
      host: "",
      port: 587,
      username: "",
      from_address: "",
      from_name: "",
      security: "starttls",
      credentials_configured: false,
    },
  };
  let runtimeSessions = [
    {
      id: "session-current",
      user_agent: "Playwright",
      ip_address: "127.0.0.1",
      created_at: "2026-08-19T00:00:00Z",
      last_seen_at: "2026-08-20T00:00:00Z",
      expires_at: "2026-09-20T00:00:00Z",
      revoked_at: null as string | null,
      current: true,
    },
    {
      id: "session-other",
      user_agent: "Mobile Safari",
      ip_address: "10.0.0.2",
      created_at: "2026-08-19T00:00:00Z",
      last_seen_at: "2026-08-19T23:00:00Z",
      expires_at: "2026-09-20T00:00:00Z",
      revoked_at: null as string | null,
      current: false,
    },
  ];
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
      __emitComaEvent: (frame: unknown) =>
        FakeSocket.latest?.onmessage?.({ data: JSON.stringify(frame) }),
    });
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let status = 200;
    let body: unknown = {};
    if (path.endsWith("/bootstrap/status")) body = { bootstrapped: true };
    else if (path.endsWith("/branding"))
      body = {
        workspace_name: organizationSettings.name,
        accent_color: organizationSettings.accent_color,
        version: organizationSettings.version,
        password_recovery_available: passwordRecoveryAvailable,
        email_delivery_available: passwordRecoveryAvailable,
      };
    else if (path.endsWith("/auth/refresh")) {
      refreshRequests += 1;
      if (signedOut) {
        status = 401;
        body = { code: "unauthorized", message: "signed out" };
      } else
        body = {
          access_token: "test",
          access_expires_at: "2026-08-20T00:00:00Z",
          user: runtimeUser,
        };
    } else if (path.endsWith("/auth/password/forgot")) {
      status = 202;
      body = undefined;
    } else if (path.endsWith("/auth/password/reset")) {
      status = 204;
      body = undefined;
    } else if (path.endsWith("/agents")) body = [];
    else if (path.endsWith("/chats")) {
      chatRequests += 1;
      body = { chats: [runtimeChat] };
    } else if (path.endsWith("/me/email/change")) {
      const input = route.request().postDataJSON() as { new_email: string };
      body = {
        pending_confirmation: false,
        user: { ...user, email: input.new_email },
      };
    } else if (path.endsWith("/me/password")) {
      runtimeUser = { ...runtimeUser, must_change_password: false };
      status = 204;
      body = undefined;
    } else if (path.endsWith("/me/status")) {
      if (route.request().method() === "DELETE") {
        runtimeUser = {
          ...runtimeUser,
          status_emoji: "",
          status_text: "",
          status_expires_at: null,
        };
      } else {
        const input = route.request().postDataJSON() as {
          emoji: string;
          text: string;
          expires_at: string | null;
        };
        runtimeUser = {
          ...runtimeUser,
          status_emoji: input.emoji,
          status_text: input.text,
          status_expires_at: input.expires_at,
        };
        statusMutations.push(input);
      }
      body = {
        emoji: runtimeUser.status_emoji,
        text: runtimeUser.status_text,
        expires_at: runtimeUser.status_expires_at,
      };
    } else if (path.endsWith("/me") && route.request().method() === "GET") {
      body = runtimeUser;
    } else if (path.endsWith("/me") && route.request().method() === "PATCH")
      body = runtimeUser = {
        ...runtimeUser,
        ...route.request().postDataJSON(),
      };
    else if (path.endsWith("/preferences/chat-folders")) {
      if (route.request().method() === "PUT")
        chatFolders = route.request().postDataJSON() as typeof chatFolders;
      body = chatFolders;
    } else if (path.endsWith("/preferences/pinned-chats")) {
      if (route.request().method() === "PUT")
        pinnedChatIDs = route.request().postDataJSON() as typeof pinnedChatIDs;
      body = pinnedChatIDs;
    } else if (path.endsWith("/preferences")) {
      if (route.request().method() === "PATCH")
        preferences = {
          ...preferences,
          ...(route.request().postDataJSON() as Partial<typeof preferences>),
        };
      body = preferences;
    } else if (path.endsWith("/push/config")) {
      body = { enabled: true, public_key: "test-public-key" };
    } else if (path.endsWith("/push/test")) {
      body = { sent: 1, failed: 0 };
    } else if (path.endsWith("/push/subscriptions")) {
      body = [
        {
          id: "00000000-0000-4000-8000-000000000090",
          user_agent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
          created_at: "2026-08-20T08:00:00Z",
          updated_at: "2026-08-21T08:00:00Z",
          current: true,
        },
      ];
    } else if (
      path.endsWith("/organization") &&
      route.request().method() === "PATCH"
    ) {
      const input = route
        .request()
        .postDataJSON() as typeof organizationSettings & {
        expected_version: number;
      };
      organizationSettings = {
        ...organizationSettings,
        ...input,
        version: input.expected_version + 1,
      };
      body = organizationSettings;
    } else if (path.endsWith("/organization")) body = organizationSettings;
    else if (path.endsWith("/organization/members"))
      body = {
        members: [
          {
            actor_id: runtimeUser.id,
            email: runtimeUser.email,
            display_name: runtimeUser.display_name,
            handle: runtimeUser.handle,
            title: runtimeUser.title,
            role: runtimeUser.role,
            status: "active",
            permissions: [],
            created_at: user.created_at,
            last_seen_at: "2026-08-20T00:00:00Z",
          },
        ],
      };
    else if (path.endsWith("/require-password-change")) {
      status = 204;
      body = undefined;
    } else if (/\/organization\/members\/[^/]+$/.test(path))
      body = {
        ...(route.request().postDataJSON() as object),
        actor_id: runtimeUser.id,
        email: runtimeUser.email,
        display_name: runtimeUser.display_name,
        handle: runtimeUser.handle,
        title: runtimeUser.title,
        created_at: user.created_at,
        last_seen_at: "2026-08-20T00:00:00Z",
      };
    else if (path.endsWith("/organization/infrastructure/test"))
      body = {
        ok: true,
        message: "connection successful",
        checked_at: "2026-08-20T00:00:00Z",
      };
    else if (
      path.endsWith("/organization/infrastructure") &&
      route.request().method() === "PATCH"
    ) {
      infrastructure = {
        version: infrastructure.version + 1,
        s3: {
          ...infrastructure.s3,
          endpoint: "https://storage.yandexcloud.net",
          region: "ru-central1",
          bucket: "coma-files",
          credentials_configured: true,
          access_key_hint: "••••1234",
        },
        smtp: {
          ...infrastructure.smtp,
          host: "smtp.example.com",
          from_address: "coma@example.com",
          credentials_configured: true,
        },
      };
      body = infrastructure;
    } else if (path.endsWith("/organization/infrastructure"))
      body = infrastructure;
    else if (path.endsWith("/organization/audit"))
      body = {
        events: [
          {
            id: "audit-1",
            actor_id: user.id,
            actor_name: user.display_name,
            actor_role: "owner",
            action: "organization.settings.update",
            category: "organization",
            target_type: "organization",
            target_id: user.org_id,
            target_name: organizationSettings.name,
            metadata: {},
            changes: {},
            created_at: "2026-08-20T00:00:00Z",
          },
        ],
        next_after_id: null,
      };
    else if (path.endsWith("/sessions/revoke-others")) {
      runtimeSessions = runtimeSessions.map((session) =>
        session.current
          ? session
          : { ...session, revoked_at: "2026-08-21T00:00:00Z" },
      );
      status = 204;
      body = undefined;
    } else if (
      /\/sessions\/[^/]+$/.test(path) &&
      route.request().method() === "DELETE"
    ) {
      const sessionID = path.split("/").at(-1);
      runtimeSessions = runtimeSessions.map((session) =>
        session.id === sessionID
          ? { ...session, revoked_at: "2026-08-21T00:00:00Z" }
          : session,
      );
      status = 204;
      body = undefined;
    } else if (path.endsWith("/sessions"))
      body = {
        sessions: runtimeSessions,
      };
    else if (path.endsWith("/invitations")) {
      if (route.request().method() === "GET") body = runtimeInvitations;
      else {
        const input = route.request().postDataJSON() as {
          email: string;
          role?: "admin" | "member";
        };
        const invitation = {
          id: "00000000-0000-4000-8000-000000000081",
          email: input.email,
          role: input.role ?? "member",
          expires_at: "2026-08-23T00:00:00Z",
          accept_url: "https://coma.example/invite/test-token",
          email_sent: false,
        };
        runtimeInvitations = [
          {
            ...invitation,
            created_by_id: user.id,
            created_by_name: user.display_name,
            created_at: "2026-08-21T00:00:00Z",
            email_sent_at: null,
            status: "active",
          },
        ];
        body = invitation;
        status = 201;
      }
    } else if (/\/invitations\/[^/]+\/rotate$/.test(path)) {
      const previous = runtimeInvitations[0];
      const replacement = {
        ...previous,
        id: "00000000-0000-4000-8000-000000000082",
      };
      runtimeInvitations = [replacement];
      body = {
        id: replacement.id,
        email: replacement.email,
        role: replacement.role,
        expires_at: replacement.expires_at,
        accept_url: "https://coma.example/invite/rotated-token",
        email_sent: false,
      };
      status = 201;
    } else if (
      /\/invitations\/[^/]+$/.test(path) &&
      route.request().method() === "DELETE"
    ) {
      runtimeInvitations = [];
      status = 204;
      body = undefined;
    } else if (/\/organization\/branding\/(logo|favicon)$/.test(path)) {
      const kind = path.endsWith("/logo") ? "logo" : "favicon";
      if (route.request().method() === "PUT") {
        organizationSettings = {
          ...organizationSettings,
          has_logo: kind === "logo" ? true : organizationSettings.has_logo,
          has_favicon:
            kind === "favicon" ? true : organizationSettings.has_favicon,
          version: organizationSettings.version + 1,
        };
      }
      status = 204;
      body = undefined;
    } else if (path.endsWith("/actors"))
      body = {
        actors: [
          {
            actor_id: user.id,
            display_name: user.display_name,
            handle: user.handle,
            title: user.title,
            about: user.about,
            type: "user",
          },
          { ...lev, about: "", type: "user" },
        ],
        next_after_id: null,
      };
    else if (path.endsWith("/threads"))
      body = { threads, next_before_seq: null };
    else if (path.endsWith(`/chats/${chat.id}/pins`)) body = { pins: [] };
    else if (path.endsWith("/unread"))
      body = {
        chats: [
          {
            chat_id: chat.id,
            ...unread,
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
            title: user.title,
            role: "member",
            joined_at: "2026-08-19T00:00:00Z",
          },
          lev,
        ],
      };
    else if (path.endsWith("/chats/notification-overrides"))
      body =
        runtimeChat.notify_level !== "default" || runtimeChat.muted_until
          ? [
              {
                chat_id: runtimeChat.id,
                name: runtimeChat.name,
                kind: runtimeChat.kind,
                notify_level: runtimeChat.notify_level,
                muted_until: runtimeChat.muted_until,
              },
            ]
          : [];
    else if (path.endsWith(`/chats/${chat.id}/notification-preferences`))
      if (route.request().method() === "PATCH") {
        body = route.request().postDataJSON();
        Object.assign(runtimeChat, body);
      } else if (route.request().method() === "DELETE") {
        runtimeChat.notify_level = "default";
        runtimeChat.muted_until = null;
        body = {
          notify_level: runtimeChat.notify_level,
          muted_until: runtimeChat.muted_until,
        };
      } else
        body = {
          notify_level: runtimeChat.notify_level,
          muted_until: runtimeChat.muted_until,
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
    } else if (path.endsWith(`/chats/${chat.id}/read`)) {
      const input = route.request().postDataJSON() as { last_read_seq: number };
      body = {
        chat_id: chat.id,
        last_read_seq: input.last_read_seq,
        last_read_at: "2026-08-19T06:31:00Z",
      };
    } else if (/\/messages\/[^/]+\/reactions$/.test(path))
      body = { reactions: runtimeReactions };
    else if (/\/messages\/[^/]+\/receipts$/.test(path))
      body = {
        receipts: [{ actor_id: user.id, read_at: "2026-08-19T06:40:00Z" }],
      };
    else if (/\/messages\/[^/]+\/forward$/.test(path)) {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      status = 201;
      body = {
        ...message,
        id: "00000000-0000-4000-8000-000000000041",
        actor_id: user.id,
        chat_id: input.chat_id,
        client_msg_id: input.client_msg_id,
        created_seq: 5,
        forwarded_from: {
          author_name: lev.display_name,
          author_handle: lev.handle,
          created_at: message.created_at,
        },
      };
    } else if (/\/messages\/[^/]+\/reactions\/.+/.test(path)) {
      const emoji = decodeURIComponent(path.split("/").at(-1) ?? "");
      reactionMutations.push(`${route.request().method()} ${emoji}`);
      if (route.request().method() === "DELETE") {
        runtimeReactions = runtimeReactions.filter(
          (reaction) =>
            reaction.emoji !== emoji || reaction.actor_id !== user.id,
        );
        status = 204;
        body = undefined;
      } else {
        const reaction = {
          message_id: message.id,
          actor_id: user.id,
          emoji,
          created_at: "2026-08-19T06:34:00Z",
        };
        runtimeReactions.push(reaction);
        body = reaction;
      }
    } else status = 404;
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
    chatRequests: () => chatRequests,
    reactionMutations,
    statusMutations,
    emitEvent: async (
      frame: Record<string, unknown>,
      chatState?: Record<string, unknown>,
    ) => {
      if (chatState) Object.assign(runtimeChat, chatState);
      await page.evaluate(
        (value) =>
          (
            window as unknown as {
              __emitComaEvent(frame: Record<string, unknown>): void;
            }
          ).__emitComaEvent(value),
        frame,
      );
    },
  };
}

test("thread directory keeps every avatar circular", async ({ page }) => {
  await mockMessenger(page, {
    threads: [
      {
        root: { ...message, id: "thread-root-1", body: "Всем привет!" },
        reply_count: 1,
      },
      {
        root: { ...message, id: "thread-root-2", body: "@лев" },
        reply_count: 1,
      },
    ],
  });
  await page.goto("/threads");

  const avatars = page.locator(".utility-list .ui-avatar");
  await expect(avatars).toHaveCount(2);
  for (const avatar of await avatars.all()) {
    const box = await avatar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBe(box!.height);
    expect(box!.width).toBeGreaterThanOrEqual(30);
  }
});

test("responsive chat list opens a channel with a read-only composer", async ({
  page,
}) => {
  await mockMessenger(page);
  await page.goto("/chats");
  await expect(page.getByRole("button", { name: /Объявления/ })).toBeVisible();
  const chatCard = page.getByRole("button", { name: /Объявления/ });
  const [chatCardBox, chatTimeBox] = await Promise.all([
    chatCard.boundingBox(),
    chatCard.locator("time").boundingBox(),
  ]);
  expect(chatCardBox).not.toBeNull();
  expect(chatTimeBox).not.toBeNull();
  expect(chatCardBox!.height).toBeLessThanOrEqual(
    test.info().project.name === "phone" ? 66 : 58,
  );
  expect(chatTimeBox!.y - chatCardBox!.y).toBeLessThanOrEqual(10);
  await chatCard.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Закрепить" }).click();
  await expect(chatCard.locator(".ui-badge")).toHaveText("3");
  await expect(chatCard.locator(".chat-card__pin")).toHaveCount(0);
  if (test.info().project.name === "phone") {
    const listPane = await page.locator(".chat-list-pane").boundingBox();
    expect(listPane?.y).toBeLessThan(1);
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

test("message events coalesce and refresh the chat card preview", async ({
  page,
}) => {
  const runtime = await mockMessenger(page);
  await page.goto("/chats");
  const preview = page.locator(".chat-card__preview");
  await expect(preview).toContainText("Добро пожаловать");
  const requestsBefore = runtime.chatRequests();
  const remoteMessage = {
    ...message,
    id: "00000000-0000-4000-8000-000000000050",
    client_msg_id: "00000000-0000-4000-8000-000000000051",
    body: "Со второго устройства",
    created_seq: 4,
    created_at: "2026-08-19T06:40:00Z",
  };
  await runtime.emitEvent(
    {
      op: "event",
      seq: 4,
      type: "message.created",
      occurred_at: remoteMessage.created_at,
      actor_id: remoteMessage.actor_id,
      chat_id: chat.id,
      subject_id: remoteMessage.id,
      data: remoteMessage,
    },
    {
      last_message: {
        ...chat.last_message,
        id: remoteMessage.id,
        actor_id: lev.actor_id,
        actor_display_name: lev.display_name,
        body: remoteMessage.body,
        created_seq: remoteMessage.created_seq,
        created_at: remoteMessage.created_at,
      },
      last_message_at: remoteMessage.created_at,
      last_activity_seq: 4,
    },
  );
  await runtime.emitEvent({
    op: "event",
    seq: 5,
    type: "message.updated",
    occurred_at: remoteMessage.created_at,
    actor_id: remoteMessage.actor_id,
    chat_id: chat.id,
    subject_id: remoteMessage.id,
    data: remoteMessage,
  });
  await expect(preview).toContainText("Лев: Со второго устройства");
  await expect.poll(runtime.chatRequests).toBe(requestsBefore + 1);

  await runtime.emitEvent(
    {
      op: "event",
      seq: 6,
      type: "message.deleted",
      occurred_at: "2026-08-19T06:41:00Z",
      actor_id: remoteMessage.actor_id,
      chat_id: chat.id,
      subject_id: remoteMessage.id,
      data: { ...remoteMessage, body: "", deleted_at: "2026-08-19T06:41:00Z" },
    },
    {
      last_message: chat.last_message,
      last_message_at: chat.last_message_at,
      last_activity_seq: chat.last_activity_seq,
    },
  );
  await expect(preview).toContainText("Добро пожаловать");
  await expect(preview).not.toContainText("Удалить");
});

test("visible inactive chats produce an in-app notification", async ({
  page,
}) => {
  const runtime = await mockMessenger(page);
  await page.goto("/threads");
  await expect(page.getByRole("heading", { name: "Треды" })).toBeVisible();
  await runtime.emitEvent({
    op: "event",
    seq: 4,
    type: "message.created",
    occurred_at: "2026-08-19T06:40:00Z",
    actor_id: lev.actor_id,
    chat_id: chat.id,
    subject_id: "00000000-0000-4000-8000-000000000050",
    data: { ...message, body: "Проверьте новый макет", created_seq: 4 },
  });
  const notification = page.locator(".in-app-notification");
  await expect(notification).toContainText("Новое сообщение · Объявления");
  await expect(notification).toContainText("Проверьте новый макет");
  await notification.locator(".in-app-notification__content").click();
  await expect(page).toHaveURL(new RegExp(`/chat/${chat.id}$`));
});

test("in-app notifications can be disabled without disabling push", async ({
  page,
}) => {
  await mockMessenger(page, {
    preferencesPatch: { in_app_enabled: true, push_enabled: true },
  });
  await page.goto("/settings/notifications");
  const inApp = page.getByRole("checkbox", {
    name: "Показывать уведомления в приложении",
  });
  const push = page.getByRole("checkbox", {
    name: "Уведомления Push",
  });
  await expect(inApp).toBeChecked();
  await expect(push).toBeChecked();
  await inApp.uncheck();
  await expect(page.getByText("Сохранено")).toBeVisible();
  await expect(push).toBeChecked();
});

test("global navigation stays stable while utility pages replace content", async ({
  page,
}) => {
  await mockMessenger(page);
  await page.goto("/chats");
  const phone = test.info().project.name === "phone";
  if (phone) await expect(page.locator(".global-sidebar")).toBeHidden();
  else await expect(page.locator(".global-sidebar")).toBeVisible();
  await expect(page.locator(".chat-list-pane")).toBeVisible();
  if (phone)
    await expect(
      page.locator(".chat-list-head__workspace").getByText("Test space"),
    ).toBeVisible();
  else {
    await expect(
      page.getByRole("button", { name: "Test space" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Test space" }).click();
    const workspaceMenu = page.getByRole("menu");
    await expect(
      workspaceMenu.getByRole("menuitem", {
        name: "Настройки пространства",
      }),
    ).toBeVisible();
    const workspaceButtonBox = await page
      .getByRole("button", { name: "Test space" })
      .boundingBox();
    const workspaceMenuBox = await workspaceMenu.boundingBox();
    expect(workspaceButtonBox).not.toBeNull();
    expect(workspaceMenuBox).not.toBeNull();
    expect(workspaceMenuBox!.width).toBe(320);
    expect(
      workspaceMenuBox!.y -
        (workspaceButtonBox!.y + workspaceButtonBox!.height),
    ).toBe(4);
    await page.locator(".chat-list-head").click();
    await expect(workspaceMenu).toHaveCount(0);
    await expect(
      page.locator(".sidebar-nav").getByText("Настройки", { exact: true }),
    ).toHaveCount(0);
    const profile = await page.locator(".sidebar-profile").boundingBox();
    const sidebar = await page.locator(".global-sidebar").boundingBox();
    const collapseButton = await page
      .getByRole("button", { name: "Свернуть боковую панель" })
      .boundingBox();
    const viewport = page.viewportSize();
    expect(profile).not.toBeNull();
    expect(sidebar).not.toBeNull();
    expect(collapseButton).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(profile!.y + profile!.height).toBeGreaterThan(viewport!.height - 20);
    expect(collapseButton!.y).toBeGreaterThan(viewport!.height - 130);
    expect(
      collapseButton!.x +
        collapseButton!.width / 2 -
        (sidebar!.x + sidebar!.width),
    ).toBeCloseTo(0, 0);
    await page.getByRole("button", { name: "Свернуть боковую панель" }).click();
    await expect(page.locator(".messenger")).toHaveClass(
      /messenger--sidebar-collapsed/,
    );
    await page
      .getByRole("button", { name: "Развернуть боковую панель" })
      .click();
  }

  await page.getByRole("button", { name: "Треды", exact: true }).click();
  await expect(page).toHaveURL(/\/threads$/);
  if (phone) await expect(page.locator(".global-sidebar")).toBeHidden();
  else await expect(page.locator(".global-sidebar")).toBeVisible();
  await expect(page.locator(".chat-list-pane")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Треды" })).toBeVisible();

  await page.getByRole("button", { name: "Важные", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Важные" })).toBeVisible();
  await page.getByRole("button", { name: "Участники", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Участники" })).toBeVisible();
});

test("phone tabbar keeps navigation and settings in the main field", async ({
  page,
}) => {
  test.skip(test.info().project.name !== "phone");
  await mockMessenger(page);
  await page.goto("/chats");
  const tabbar = page.locator(".mobile-tabbar");
  await expect(tabbar).toBeVisible();
  for (const label of ["Чаты", "Треды", "Важные", "Участники", "Ещё"])
    await expect(tabbar.getByRole("button", { name: label })).toBeVisible();
  await tabbar.getByRole("button", { name: "Ещё" }).click();
  await expect(page).toHaveURL(/\/more$/);
  await expect(page.getByText("Текущее пространство")).toBeVisible();
  await expect(page).toHaveScreenshot("mobile-more.png", {
    animations: "disabled",
  });
  await page.getByRole("button", { name: /Настройки профиля/ }).click();
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await expect(
    page.getByRole("heading", { name: "Настройки профиля" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("Ваше имя").fill("Анна Новая");
  await expect(page.getByText("Сохранено")).toBeVisible();
  await tabbar.getByRole("button", { name: "Ещё" }).click();
  await page.getByRole("button", { name: /Настройки пространства/ }).click();
  await expect(page).toHaveURL(/\/settings\/workspace$/);
  await expect(
    page.getByRole("heading", { name: "Настройки пространства" }),
  ).toBeVisible();
  const settingsBody = page.locator(".settings-page__body");
  if (test.info().project.name === "phone") {
    const scrollMetrics = await settingsBody.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(
      scrollMetrics.clientHeight,
    );
    await settingsBody.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => settingsBody.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("phase 3.1 settings cover workspace branding infrastructure sessions and audit", async ({
  page,
}) => {
  test.skip(
    test.info().project.name === "phone",
    "workspace settings use the mobile More routes",
  );
  await mockMessenger(page);
  await page.goto("/settings/workspace");
  await expect(
    page.getByRole("heading", { name: "Настройки пространства" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Основные сведения", exact: true })
    .click();
  await page.getByLabel("Название организации").fill("Новая команда");
  await expect(page.getByText("Сохранено")).toBeVisible();
  await page.getByRole("button", { name: "Приглашения", exact: true }).click();
  await page.getByLabel("Срок приглашения, часов").fill("72");
  await expect(page.getByText("Сохранено")).toBeVisible();
  await page.getByLabel("Почта участника").fill("new@example.com");
  await page.getByRole("button", { name: "Создать приглашение" }).click();
  await expect(page.getByLabel("Ссылка приглашения")).toHaveValue(
    /\/invite\/test-token$/,
  );
  await expect(page.getByText("new@example.com")).toBeVisible();
  await page.getByRole("button", { name: "Новая ссылка" }).click();
  await expect(page.getByLabel("Ссылка приглашения")).toHaveValue(
    /\/invite\/rotated-token$/,
  );
  await page.getByRole("button", { name: "Отозвать" }).click();
  await expect(page.getByText("Активных приглашений пока нет")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Разделы настроек" })
    .getByRole("button", { name: "Уведомления" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Настройки уведомлений" }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: /Показывать текст сообщения/ })
    .check();
  await expect(page.getByText("Сохранено")).toBeVisible();

  await page.getByRole("button", { name: "Оформление", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Оформление пространства" }),
  ).toBeVisible();
  await page.getByLabel("HEX-значение").fill("#6D5EF5");
  await expect(page.getByText("Сохранено")).toBeVisible();
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "logo.png",
      mimeType: "image/png",
      buffer: Buffer.from("test-logo"),
    });
  await expect(page.getByText("Изображение сохранено")).toBeVisible();

  await page.getByRole("button", { name: "Подключения", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Подключения" }),
  ).toBeVisible();
  await page.getByLabel("Endpoint").fill("https://storage.yandexcloud.net");
  await page.getByLabel("Регион").fill("ru-central1");
  await page.getByLabel("Bucket").fill("coma-files");
  await page.getByLabel("Access key").fill("ACCESS-1234");
  await page.getByLabel("Secret key").fill("secret");
  await page.getByLabel("Хост").fill("smtp.example.com");
  await page.getByLabel("Адрес отправителя").fill("coma@example.com");
  const saveConnections = page.getByRole("button", {
    name: "Сохранить подключения",
  });
  await expect(saveConnections).toBeEnabled();
  await saveConnections.click();
  await expect(page.getByText("Изменения сохранены")).toBeVisible();
  await page
    .getByRole("button", { name: "Проверить подключение" })
    .first()
    .click();
  await expect(page.getByText("Подключение успешно")).toBeVisible();

  await page.getByRole("button", { name: "Безопасность", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Безопасность и сессии" }),
  ).toBeVisible();
  const emailSection = page
    .locator(".settings-section")
    .filter({ has: page.getByRole("heading", { name: "Сменить email" }) });
  await emailSection.getByLabel("Новый email").fill("new@example.com");
  await emailSection.getByLabel("Текущий пароль").fill("current password");
  await emailSection.getByRole("button", { name: "Сменить email" }).click();
  await expect(
    page.getByText("Email изменён, остальные сессии завершены"),
  ).toBeVisible();
  const passwordSection = page
    .locator(".settings-section")
    .filter({ has: page.getByRole("heading", { name: "Сменить пароль" }) });
  await passwordSection.getByLabel("Текущий пароль").fill("current password");
  await passwordSection
    .getByLabel("Новый пароль", { exact: true })
    .fill("new secure password");
  await passwordSection
    .getByLabel("Повторите новый пароль")
    .fill("new secure password");
  await passwordSection.getByRole("button", { name: "Сменить пароль" }).click();
  await expect(
    page.getByText("Пароль изменён, остальные сессии завершены"),
  ).toBeVisible();
  await expect(page.getByText("Safari", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Выйти на остальных устройствах" })
    .click();
  await expect(page.getByText("Остальные сессии завершены")).toBeVisible();
  await expect(page.getByText("Safari", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Аудит", exact: true }).click();
  await expect(
    page.getByText(/Анна изменил\(а\) настройки пространства/),
  ).toBeVisible();
  await page
    .locator('select[name="audit-category"]')
    .selectOption("organization");
  await page.getByLabel("С даты").fill("2026-08-01");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("profile menu, status dialog and attachment picker expose the new flows", async ({
  page,
}) => {
  test.skip(
    test.info().project.name === "phone",
    "the desktop profile menu is replaced by the mobile More page",
  );
  await mockMessenger(page, { chatPatch: { kind: "group", role: "owner" } });
  await page.goto("/chats");

  await page.getByRole("button", { name: /Анна/ }).click();
  const profileMenu = page.getByRole("menu");
  const profileMenuBox = await profileMenu.boundingBox();
  expect(profileMenuBox).not.toBeNull();
  expect(profileMenuBox!.width).toBe(320);
  await expect(profileMenu.getByText("Анна")).toBeVisible();
  await expect(
    profileMenu.getByRole("menuitem", { name: "Настройки профиля" }),
  ).toBeVisible();
  await profileMenu.getByRole("menuitem", { name: "Чем заняты?" }).click();

  const statusDialog = page.getByRole("dialog", {
    name: "Установить статус",
  });
  await expect(statusDialog).toBeVisible();
  const cancelBox = await statusDialog
    .getByRole("button", { name: "Отмена" })
    .boundingBox();
  const saveBox = await statusDialog
    .getByRole("button", { name: "Сохранить" })
    .boundingBox();
  expect(cancelBox).not.toBeNull();
  expect(saveBox).not.toBeNull();
  expect(cancelBox!.width).toBeGreaterThan(saveBox!.width);
  await statusDialog.getByLabel("Текст статуса").fill("Проверяю интерфейс");
  await statusDialog.getByRole("button", { name: "Отмена" }).click();
  await expect(statusDialog).toBeHidden();

  await page.getByRole("button", { name: /Объявления/ }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${chat.id}$`));
  await page.getByRole("button", { name: "Прикрепить" }).click();
  const attachmentMenu = page.getByRole("menu", { name: "Прикрепить" });
  await expect(attachmentMenu.getByText("Фото или видео")).toBeVisible();
  await expect(attachmentMenu.getByText("Файл", { exact: true })).toBeVisible();
  await expect(attachmentMenu.getByText("Markdown")).toBeVisible();
});

test("member controls use a dialog and the agent editor scrolls in Russian", async ({
  page,
}) => {
  await mockMessenger(page);
  await page.goto("/settings/workspace/members");
  await page.getByRole("button", { name: "Управление участником" }).click();
  const memberDialog = page.getByRole("dialog", {
    name: "Управление участником",
  });
  await expect(memberDialog.getByText("Роль участника")).toBeVisible();
  await expect(memberDialog.getByText(/не более 10 МБ/)).toBeVisible();
  await memberDialog.getByRole("button", { name: "Закрыть" }).click();

  await page.goto("/settings/agents");
  await expect(page.getByRole("heading", { name: "Агенты" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Разрешения" })).toBeVisible();
  await expect(page.getByText("messages:read", { exact: true })).toHaveCount(0);
  const editor = page.locator(".agent-settings");
  await expect
    .poll(() =>
      editor.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  await editor.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect
    .poll(() => editor.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
});

test("member invitation self-service never exposes administrative controls", async ({
  page,
}) => {
  await mockMessenger(page, {
    userPatch: {
      role: "member",
      permissions: [],
      can_create_invitations: true,
    },
    organizationPatch: { allow_member_invitations: true },
  });
  await page.goto("/settings/workspace/invitations");
  await expect(page.getByLabel("Почта участника")).toBeVisible();
  await expect(page.getByLabel("Роль по умолчанию")).toHaveCount(0);
  await expect(page.getByText("Активные приглашения")).toHaveCount(0);
  await page.getByLabel("Почта участника").fill("friend@example.com");
  await page.getByRole("button", { name: "Создать приглашение" }).click();
  await expect(page.getByLabel("Ссылка приглашения")).toHaveValue(
    /\/invite\/test-token$/,
  );
});

test("dark messenger shell uses flat charcoal elevation without glow", async ({
  page,
}) => {
  test.skip(test.info().project.name === "phone", "desktop theme probe");
  await mockMessenger(page, { theme: "dark" });
  await page.goto("/chats");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#181a1f",
  );
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /viewport-fit=cover/,
  );
  await expect(page.getByRole("button", { name: /Объявления/ })).toBeVisible();
  const glowing = await page.locator(".messenger *").evaluateAll((elements) =>
    elements
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          tag: element.tagName,
          boxShadow: style.boxShadow,
          textShadow: style.textShadow,
        };
      })
      .filter(
        (style) => style.boxShadow !== "none" || style.textShadow !== "none",
      ),
  );
  expect(glowing).toEqual([]);
  await expect(page).toHaveScreenshot("messenger-dark.png", {
    animations: "disabled",
  });
});

test("chat folders are persisted in preferences and become filters", async ({
  page,
}) => {
  await mockMessenger(page);
  await page.goto("/chats");
  await expect(page.getByRole("button", { name: /Объявления/ })).toBeVisible();
  await page.getByRole("button", { name: "Создать папку" }).click();
  const dialog = page.getByRole("dialog", { name: "Создать папку" });
  await expect(dialog.locator(".folder-icon-grid button")).toHaveCount(50);
  await dialog.getByRole("checkbox", { name: /Объявления/ }).click();
  await expect(
    dialog.getByRole("checkbox", { name: /Объявления/ }),
  ).toHaveAttribute("aria-checked", "true");
  await dialog.getByLabel("Поиск иконок по смыслу").fill("ракета");
  await dialog.getByRole("button", { name: "Запуски" }).click();
  await dialog.getByRole("button", { name: "Цвет папки: violet" }).click();
  const folderName = dialog.getByLabel("Название папки");
  await folderName.pressSequentially("Работа");
  await expect(folderName).toHaveValue("Работа");
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByRole("button", { name: "Работа" })).toBeVisible();
  await expect(page).toHaveURL(/folder=/);
  await expect(page.getByRole("button", { name: /Объявления/ })).toBeVisible();
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
      page.locator(".chat-list-pane .chat-card__preview"),
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
  const runtime = await mockMessenger(page, {
    chatPatch: { kind: "group", role: "admin" },
    unread: { last_read_seq: 3, unread_count: 0, mention_count: 0 },
    reactions: [
      {
        message_id: message.id,
        actor_id: user.id,
        emoji: "👍",
        created_at: "2026-08-19T06:34:00Z",
      },
    ],
  });
  await page.goto("/chats");
  if (test.info().project.name === "desktop") {
    await page.getByRole("button", { name: "Поиск" }).click();
    await expect(page.getByRole("dialog", { name: "Поиск" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Поиск" })).toHaveCount(0);
  } else {
    await expect(page.getByPlaceholder("Поиск чатов")).toBeVisible();
  }
  const chatButton = page.getByRole("button", { name: /Объявления/ });
  await chatButton.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Открыть в новом окне" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Действия с чатом" }),
  ).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Закрепить" }).click();
  await expect(chatButton.locator(".chat-card__pin")).toBeVisible();
  await chatButton.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Открепить" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Отключить уведомления" }).click();
  const mutedIcon = chatButton.locator(".chat-card__muted");
  await expect(mutedIcon).toBeVisible();
  const mutedIconBox = await mutedIcon.boundingBox();
  expect(mutedIconBox).not.toBeNull();
  expect(mutedIconBox!.width).toBeLessThanOrEqual(12);
  await chatButton.click();
  const messageRow = page.locator("article.message").first();
  await expect(messageRow).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      ),
  );
  const ownReaction = messageRow.getByRole("button", { name: "👍 1" });
  await expect(ownReaction).toHaveAttribute("aria-pressed", "true");
  await ownReaction.click();
  await expect.poll(() => runtime.reactionMutations.at(-1)).toBe("DELETE 👍");
  await expect(ownReaction).toHaveCount(0);
  const messageActions = messageRow.locator(".message__actions");
  if (test.info().project.name === "desktop") {
    await page.mouse.move(0, 0);
    await expect
      .poll(() =>
        messageActions.evaluate((node) => getComputedStyle(node).opacity),
      )
      .toBe("0");
  }
  await messageRow.hover();
  await expect
    .poll(() =>
      messageActions.evaluate((node) => getComputedStyle(node).opacity),
    )
    .toBe("1");
  await page.getByRole("button", { name: "Действия с сообщением" }).click();
  await page.getByRole("menuitem", { name: "Добавить реакцию" }).click();
  const reactionPicker = page.getByRole("dialog", { name: "Эмодзи" });
  await expect(reactionPicker).toBeVisible();
  await expect(page.getByPlaceholder("Поиск эмодзи…")).toBeVisible();
  const [pickerBox, pickerActionsBox, pickerHeight] = await Promise.all([
    reactionPicker.boundingBox(),
    messageActions.boundingBox(),
    reactionPicker.evaluate((element) => element.scrollHeight),
  ]);
  const pickerViewport = page.viewportSize();
  expect(pickerBox).not.toBeNull();
  expect(pickerActionsBox).not.toBeNull();
  expect(pickerViewport).not.toBeNull();
  const pickerFitsBelow =
    pickerViewport!.height -
      (pickerActionsBox!.y + pickerActionsBox!.height) -
      8 -
      4 >=
    pickerHeight;
  await expect(reactionPicker).toHaveClass(
    pickerFitsBelow ? /reaction-picker--below/ : /reaction-picker--above/,
  );
  const pickerGap = pickerFitsBelow
    ? pickerBox!.y - (pickerActionsBox!.y + pickerActionsBox!.height)
    : pickerActionsBox!.y - (pickerBox!.y + pickerBox!.height);
  expect(pickerGap).toBeCloseTo(4, 0);
  await expect(reactionPicker).toHaveScreenshot("reaction-picker-up.png", {
    animations: "disabled",
    // Native emoji glyph rasterization varies slightly between WebKit runs.
    maxDiffPixels: 128,
  });
  if (test.info().project.name === "phone") await page.keyboard.press("Escape");
  else await page.locator(".conversation-head").click();
  await expect(page.getByRole("dialog", { name: "Эмодзи" })).toHaveCount(0);
  await messageRow.hover();
  await page.getByRole("button", { name: "Действия с сообщением" }).click();
  const messageMenu = page.getByRole("menu");
  await expect(messageActions).toBeVisible();
  await expect(messageRow).toHaveClass(/message--overlay-open/);
  await expect(page.getByRole("menuitem", { name: "Ответить" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Копировать ссылку" }),
  ).toBeVisible();
  const [menuBox, actionsBox, menuHeight] = await Promise.all([
    messageMenu.boundingBox(),
    messageActions.boundingBox(),
    messageMenu.evaluate((element) => element.scrollHeight),
  ]);
  const menuViewport = page.viewportSize();
  expect(menuBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(menuViewport).not.toBeNull();
  const menuFitsBelow =
    menuViewport!.height - (actionsBox!.y + actionsBox!.height) - 8 - 4 >=
    menuHeight;
  await expect(messageMenu).toHaveClass(
    menuFitsBelow ? /message-menu--below/ : /message-menu--above/,
  );
  const menuGap = menuFitsBelow
    ? menuBox!.y - (actionsBox!.y + actionsBox!.height)
    : actionsBox!.y - (menuBox!.y + menuBox!.height);
  expect(menuGap).toBeCloseTo(4, 0);
  await expect
    .poll(() =>
      page
        .locator(".message-scroll")
        .evaluate((element) => getComputedStyle(element).overflowY),
    )
    .toBe("hidden");
  const layers = await page.evaluate(() => ({
    menu: Number.parseInt(
      getComputedStyle(document.querySelector(".message-menu")!).zIndex,
      10,
    ),
    actions: Number.parseInt(
      getComputedStyle(document.querySelector(".message__actions")!).zIndex,
      10,
    ),
  }));
  expect(layers.menu).toBeGreaterThan(layers.actions);
  await expect(messageMenu).toHaveScreenshot("message-menu-up.png", {
    animations: "disabled",
  });
  await page.getByRole("menuitem", { name: "Прочитали и реакции" }).click();
  const details = page.getByRole("dialog", { name: "Просмотры и реакции" });
  await expect(details).toBeVisible();
  await expect(details.getByText(user.display_name)).toBeVisible();
  await details.getByRole("tab", { name: "Реакции" }).click();
  await expect(details.getByText("Реакций пока нет")).toBeVisible();
  if (test.info().project.name === "phone") {
    const box = await details.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box!.width).toBe(viewport!.width);
    expect(box!.height).toBe(viewport!.height);
  }
  await details.getByRole("button", { name: "Закрыть" }).click();
  await messageRow.hover();
  await page.getByRole("button", { name: "Действия с сообщением" }).click();
  await page.getByRole("menuitem", { name: "Переслать" }).click();
  const forward = page.getByRole("dialog", { name: "Переслать" });
  await expect(forward.getByText("Пересылаемое сообщение")).toBeVisible();
  await expect(forward.getByText("Добро пожаловать в Coma")).toBeVisible();
  const forwardSubmit = forward.locator(".dialog-actions .ui-button--primary");
  await expect(forwardSubmit).toBeDisabled();
  await forward.getByRole("option", { name: /Объявления/ }).click();
  await expect(forwardSubmit).toBeEnabled();
  if (test.info().project.name === "phone") {
    const box = await forward.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box!.width).toBe(viewport!.width);
    expect(box!.height).toBe(viewport!.height);
  }
  await forward.getByRole("button", { name: "Закрыть" }).click();
});

test("a thread opens beside an unchanged main feed", async ({ page }) => {
  await mockMessenger(page, {
    chatPatch: { kind: "group", role: "admin" },
    history: [
      {
        ...message,
        id: "message-1",
        client_msg_id: "client-1",
        body: "Message 1",
        thread_reply_count: 3,
      },
      {
        ...message,
        id: "message-2",
        client_msg_id: "client-2",
        body: "Message 2",
        created_seq: 4,
        created_at: "2026-08-19T06:31:00Z",
      },
    ],
  });
  await page.goto(`/chat/${chat.id}`);
  await expect(page.locator("#message-message-1")).toBeVisible();
  await expect(page.locator("#message-message-2")).toBeVisible();
  await page.getByRole("button", { name: "3 комментария" }).click();
  await expect(page.getByRole("complementary", { name: "Тред" })).toBeVisible();
  await expect(page.locator("#thread-message-message-1")).toBeVisible();
  await expect(page.getByText("Ответ внутри треда")).toBeVisible();
  await expect(page.locator("#message-message-1")).toBeVisible();
  await expect(page.locator("#message-message-2")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Напишите сообщение…" }),
  ).toHaveCount(test.info().project.name === "phone" ? 1 : 2);
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
  const topRow = page.locator("article.message").first();
  await topRow.scrollIntoViewIfNeeded();
  await topRow.hover();
  await topRow.getByRole("button", { name: "Действия с сообщением" }).click();
  const topMenu = page.getByRole("menu");
  const [topMenuBox, viewport, topMenuHeight] = await Promise.all([
    topMenu.boundingBox(),
    Promise.resolve(page.viewportSize()),
    topMenu.evaluate((element) => element.scrollHeight),
  ]);
  const topActionsBox = await page
    .locator(".message--overlay-open .message__actions")
    .boundingBox();
  expect(topMenuBox).not.toBeNull();
  expect(topActionsBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  const topMenuFitsBelow =
    viewport!.height - (topActionsBox!.y + topActionsBox!.height) - 8 - 4 >=
    topMenuHeight;
  await expect(topMenu).toHaveClass(
    topMenuFitsBelow ? /message-menu--below/ : /message-menu--above/,
  );
  const topMenuGap = topMenuFitsBelow
    ? topMenuBox!.y - (topActionsBox!.y + topActionsBox!.height)
    : topActionsBox!.y - (topMenuBox!.y + topMenuBox!.height);
  expect(topMenuGap).toBeCloseTo(4, 0);
  expect(topMenuBox!.y).toBeGreaterThanOrEqual(8);
  expect(topMenuBox!.y + topMenuBox!.height).toBeLessThanOrEqual(
    viewport!.height - 8,
  );
  if (test.info().project.name === "desktop") {
    const scrollTopBeforeWheel = await page
      .locator(".message-scroll")
      .evaluate((element) => element.scrollTop);
    await page.locator(".message-scroll").hover();
    await page.mouse.wheel(0, 500);
    await expect
      .poll(() =>
        page
          .locator(".message-scroll")
          .evaluate((element) => element.scrollTop),
      )
      .toBe(scrollTopBeforeWheel);
  }
  await page.mouse.click(8, 8);
  await expect(topMenu).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator(".message-scroll")
        .evaluate((element) => getComputedStyle(element).overflowY),
    )
    .toBe("auto");
});

test("conversation opens at the read boundary and always offers jump to latest", async ({
  page,
}) => {
  await mockMessenger(page, {
    messageCount: 24,
    chatPatch: { kind: "group", role: "admin" },
    unread: { last_read_seq: 10, unread_count: 14, mention_count: 0 },
  });
  await page.goto(`/chat/${chat.id}`);
  const scroller = page.locator(".message-scroll");
  const lastRead = page.locator("#message-message-10");
  await expect(lastRead).toBeVisible();
  const [scrollerBox, lastReadBox] = await Promise.all([
    scroller.boundingBox(),
    lastRead.boundingBox(),
  ]);
  expect(scrollerBox).not.toBeNull();
  expect(lastReadBox).not.toBeNull();
  expect(lastReadBox!.y).toBeGreaterThan(scrollerBox!.y);
  expect(lastReadBox!.y + lastReadBox!.height).toBeLessThan(
    scrollerBox!.y + scrollerBox!.height,
  );
  const jump = page.getByRole("button", { name: "К последнему сообщению" });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(2);
  await expect(jump).toHaveCount(0);
});

test("fully read conversation opens at latest and restores the jump button after scrolling", async ({
  page,
}) => {
  await mockMessenger(page, {
    messageCount: 24,
    chatPatch: { kind: "group", role: "admin" },
    unread: { last_read_seq: 24, unread_count: 0, mention_count: 0 },
  });
  await page.goto(`/chat/${chat.id}`);
  const scroller = page.locator(".message-scroll");
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(2);
  const jump = page.getByRole("button", { name: "К последнему сообщению" });
  await expect(jump).toHaveCount(0);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(jump).toBeVisible();
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
  if (test.info().project.name === "desktop") {
    const [fieldBox, hintBox, statusBox] = await Promise.all([
      page.locator(".conversation > .composer-wrap .composer").boundingBox(),
      page.locator(".composer-hint > span").boundingBox(),
      page.locator(".connection-pill").boundingBox(),
    ]);
    expect(fieldBox).not.toBeNull();
    expect(hintBox).not.toBeNull();
    expect(statusBox).not.toBeNull();
    expect(statusBox!.y - (fieldBox!.y + fieldBox!.height)).toBeCloseTo(8, 0);
    expect(
      Math.abs(
        hintBox!.y +
          hintBox!.height / 2 -
          (statusBox!.y + statusBox!.height / 2),
      ),
    ).toBeLessThanOrEqual(1);
  }
  const oneLineHeight = await composer.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await composer.fill("1\n2\n3\n4\n5\n6\n7\n8");
  const [sixLineHeight, lineHeight] = await Promise.all([
    composer.evaluate((element) => element.getBoundingClientRect().height),
    composer.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).lineHeight),
    ),
  ]);
  expect(sixLineHeight).toBeGreaterThan(oneLineHeight);
  expect(sixLineHeight).toBeLessThanOrEqual(lineHeight * 6 + 10);
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

test("mandatory password change blocks the messenger until completion", async ({
  page,
}) => {
  await mockMessenger(page, { mustChangePassword: true });
  await page.goto("/chats");
  await expect(
    page.getByText(
      "Администратор потребовал сменить пароль. Задайте новый пароль, чтобы продолжить работу.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Сменить email" }),
  ).toHaveCount(0);
  await expect(page.getByText("Активные сессии")).toHaveCount(0);

  await page.getByLabel("Текущий пароль").fill("current password");
  await page
    .getByLabel("Новый пароль", { exact: true })
    .fill("new secure password");
  await page.getByLabel("Повторите новый пароль").fill("new secure password");
  await page.getByRole("button", { name: "Сменить пароль" }).click();

  await expect(
    page.getByText(
      "Администратор потребовал сменить пароль. Задайте новый пароль, чтобы продолжить работу.",
    ),
  ).toHaveCount(0);
  await expect(page.getByText("Выберите чат")).toBeVisible();
});

test("password recovery uses email without exposing the token", async ({
  page,
}) => {
  await mockMessenger(page, {
    signedOut: true,
    passwordRecoveryAvailable: true,
  });
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/branding"),
    ),
    page.goto("/"),
  ]);
  await page.getByRole("button", { name: "Забыли пароль?" }).click();
  await page.getByLabel("Почта").fill("owner@example.com");
  await page.getByRole("button", { name: "Отправить ссылку" }).click();
  await expect(
    page.getByText(
      "Если аккаунт существует, ссылка для восстановления отправлена на его email",
    ),
  ).toBeVisible();

  await page.goto("/reset-password?token=one-use-token");
  await page
    .getByLabel("Новый пароль", { exact: true })
    .fill("new password 123");
  await page.getByLabel("Повторите новый пароль").fill("new password 123");
  await page.getByRole("button", { name: "Задать новый пароль" }).click();
  await expect(
    page.getByText("Пароль изменён. Все прежние сессии завершены."),
  ).toBeVisible();
});

test("password recovery explains the local operator path without SMTP", async ({
  page,
}) => {
  await mockMessenger(page, { signedOut: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Забыли пароль?" }).click();
  await expect(
    page.getByText(
      "Почтовая отправка не настроена. Обратитесь к администратору пространства или оператору сервера.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Почта")).toHaveCount(0);
});

test("custom status is edited from the profile menu", async ({ page }) => {
  const runtime = await mockMessenger(page);
  const phone = test.info().project.name === "phone";
  await page.goto(phone ? "/more" : "/chats");
  await page.getByRole("button", { name: phone ? /Статус/ : /Анна/ }).click();
  if (!phone) await page.getByRole("menuitem", { name: /Чем заняты/ }).click();
  await page.getByLabel("Эмодзи статуса").click();
  await page
    .locator(".status-dialog__emoji-picker")
    .getByRole("button", { name: "grinning face", exact: true })
    .click();
  await page.getByLabel("Текст статуса").fill("В отпуске");
  if (!phone)
    await page.locator('select[name="status-expiry"]').selectOption("week");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect.poll(() => runtime.statusMutations.length).toBe(1);
  if (phone) {
    await expect(
      page.getByRole("button", { name: "Статус 😀 В отпуске" }),
    ).toBeVisible();
  } else {
    await expect(page.getByText("😀 В отпуске").first()).toBeVisible();
  }

  await page.getByRole("button", { name: phone ? /Статус/ : /Анна/ }).click();
  if (!phone) await page.getByRole("menuitem", { name: /В отпуске/ }).click();
  await page.getByRole("button", { name: "Очистить статус" }).click();
  if (phone) {
    await expect(
      page.getByRole("button", { name: "Статус Чем заняты?" }),
    ).toBeVisible();
  } else {
    await expect(page.getByText("😀 В отпуске")).toHaveCount(0);
  }
});

test("notification snooze is shared by the profile menu", async ({ page }) => {
  await mockMessenger(page);
  const phone = test.info().project.name === "phone";
  await page.goto(phone ? "/more" : "/chats");
  if (phone) {
    await page.getByRole("button", { name: /Отключить уведомления/ }).click();
  } else {
    await page.getByRole("button", { name: /Анна/ }).click();
    await page.getByRole("menuitem", { name: "Отключить уведомления" }).click();
    const menuBox = await page.locator(".profile-menu").boundingBox();
    const snoozeBox = await page.locator(".profile-menu__snooze").boundingBox();
    expect(menuBox).not.toBeNull();
    expect(snoozeBox).not.toBeNull();
    expect(snoozeBox!.x - (menuBox!.x + menuBox!.width)).toBeGreaterThanOrEqual(
      7,
    );
  }
  await page.getByRole("button", { name: "На 30 минут" }).click();
  if (phone) {
    await expect(
      page.getByRole("button", {
        name: /Отключить уведомления Уведомления отключены до/,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Отключить уведомления/ }).click();
  } else {
    await expect(
      page.locator(".profile-menu").getByText(/Уведомления отключены до/),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Включить сейчас" }).click();
  if (phone) {
    await expect(
      page.getByRole("button", {
        name: /Отключить уведомления Пауза действует/,
      }),
    ).toBeVisible();
  } else {
    await expect(
      page
        .locator(".profile-menu")
        .getByText("Пауза действует на всех ваших устройствах"),
    ).toBeVisible();
  }
});

test("notification rules and schedule autosave", async ({ page }) => {
  await mockMessenger(page);
  await page.goto("/settings/notifications");
  await page
    .locator('select[name="notify-messages"]')
    .selectOption("direct_and_mentions");
  await page.locator('select[name="notify-threads"]').selectOption("mentions");
  await page
    .getByRole("checkbox", { name: "Реакции на мои сообщения" })
    .uncheck();
  await page.getByRole("checkbox", { name: "Использовать расписание" }).check();
  await page.getByRole("button", { name: "Выбрать дни" }).click();
  await page.getByRole("button", { name: "Вс" }).click();
  await page.locator('input[name="schedule-from"]').fill("10:00");
  await page.locator('input[name="schedule-to"]').fill("19:30");
  await expect(page.getByText("Сохранено")).toBeVisible();
  await expect(page.getByRole("button", { name: "Вс" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("Email-дайджест")).toHaveCount(0);
});

test("push diagnostics lists devices and resets chat overrides", async ({
  page,
}) => {
  await mockMessenger(page, { chatPatch: { notify_level: "mentions" } });
  await page.goto("/settings/notifications");
  await expect(page.getByText("Push-сервер настроен")).toBeVisible();
  await expect(page.getByText("Chrome · macOS")).toBeVisible();
  await page.getByRole("button", { name: "Отправить тест" }).click();
  await expect(page.getByText("Тест отправлен на устройств: 1")).toBeVisible();
  await expect(page.getByText(chat.name)).toBeVisible();
  await page.getByRole("button", { name: "Сбросить" }).click();
  await expect(page.getByText(/Исключений пока нет/)).toBeVisible();
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
