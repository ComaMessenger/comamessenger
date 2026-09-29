import type { MessengerAPI } from "@comamessenger/core";

/** Bearer header for native transfers that bypass MessengerAPI.request. */
export async function authorization(api: MessengerAPI): Promise<string> {
  if (!api.token()) await api.refresh();
  return `Bearer ${api.token()}`;
}

/**
 * Runs a native transfer with the bearer token and retries once with a
 * refreshed token when the access token expired mid-way.
 */
export async function withAuthorization<T extends { status: number }>(
  api: MessengerAPI,
  run: (authorization: string) => Promise<T>,
): Promise<T> {
  const first = await run(await authorization(api));
  if (first.status !== 401) return first;
  api.clearToken();
  await api.refresh();
  return run(await authorization(api));
}

export function absoluteURL(api: MessengerAPI, url: string): string {
  return url.startsWith("/") ? `${api.apiURL}${url}` : url;
}
