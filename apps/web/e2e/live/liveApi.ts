import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * The live run of the org structure e2e: a real core server (main plus the
 * wave 2 server branches) with its own database. Set COMA_LIVE_API to the
 * API origin and start the web with VITE_API_URL pointing at it; without the
 * variable these specs are skipped. The workspace is bootstrapped on the
 * first run; every run adds its own people and departments, so a run never
 * depends on what the previous one left.
 */
export const liveAPI = process.env.COMA_LIVE_API ?? "";
export const skipWithoutServer = () =>
  test.skip(!liveAPI, "COMA_LIVE_API is not set: no live server");

const ownerEmail = "owner@w2-org.test";
const ownerPassword = "owner live password 2026";
/** A short tag of this run for unique emails, handles and names. */
export const run = Date.now().toString(36).slice(-5);

export type LiveUser = {
  id: string;
  email: string;
  password: string;
  token: string;
  name: string;
};

async function call<T>(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${liveAPI}/api/v1${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      Origin: process.env.COMA_LIVE_ORIGIN ?? "",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** Calls the API as `user`; fails the test on an unexpected status. */
export async function api<T = unknown>(
  user: LiveUser,
  path: string,
  init: { method?: string; body?: unknown; expect?: number } = {},
): Promise<T> {
  const result = await call<T>(path, { ...init, token: user.token });
  if (init.expect !== undefined) expect(result.status, path).toBe(init.expect);
  else expect(result.status, `${path}: ${JSON.stringify(result.body)}`).toBeLessThan(300);
  return result.body;
}

type AuthAnswer = { access_token: string; user: { id: string; display_name: string } };

/** The owner of the live workspace, bootstrapped on the very first run. */
export async function owner(): Promise<LiveUser> {
  const status = await call<{ bootstrapped: boolean }>("/bootstrap/status");
  if (!status.body.bootstrapped) {
    const created = await call<AuthAnswer>("/bootstrap", {
      body: {
        organization_name: "Реабцентр «Опора»",
        organization_slug: "opora",
        display_name: "Анна Петрова",
        handle: "anna",
        email: ownerEmail,
        password: ownerPassword,
        timezone: "Europe/Moscow",
      },
    });
    expect(created.status).toBe(201);
  }
  return login(ownerEmail, ownerPassword);
}

export async function login(email: string, password: string): Promise<LiveUser> {
  const result = await call<AuthAnswer>("/auth/login", { body: { email, password } });
  expect(result.status, `login ${email}`).toBe(200);
  return {
    id: result.body.user.id,
    email,
    password,
    token: result.body.access_token,
    name: result.body.user.display_name,
  };
}

/** A new member of the workspace, invited by the owner. */
export async function member(
  inviter: LiveUser,
  name: string,
  handle: string,
  title = "",
): Promise<LiveUser> {
  const email = `${handle}-${run}@w2-org.test`;
  const invite = await api<{ accept_url: string }>(inviter, "/invitations", {
    body: { email, role: "member" },
  });
  const token = invite.accept_url.split("/").pop()!;
  const password = `${handle} live password 2026`;
  const accepted = await call<AuthAnswer>(`/invitations/${token}/accept`, {
    body: {
      display_name: name,
      handle: `${handle}${run}`,
      password,
      timezone: "Europe/Moscow",
    },
  });
  expect(accepted.status, `accept ${handle}`).toBeLessThan(300);
  const user = await login(email, password);
  if (title) await api(user, "/me", { method: "PATCH", body: { title } });
  return user;
}

/** Signs the browser in as `user` through the real sign-in form. */
export async function signIn(page: Page, user: LiveUser) {
  await page.addInitScript(() => {
    localStorage.setItem("coma-locale", "ru");
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: "Почта" }).fill(user.email);
  await page.getByRole("textbox", { name: "Пароль" }).fill(user.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("navigation").first()).toBeVisible();
}

/** A page of its own browser context (own cookies) with the project base URL. */
export function livePage(browser: Browser): Promise<Page> {
  return browser.newPage({
    baseURL: test.info().project.use.baseURL,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
  });
}
