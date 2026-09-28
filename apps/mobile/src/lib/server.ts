// RN's URL polyfill does not implement every getter, so the address is parsed
// explicitly instead of through `new URL`.
const address =
  /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?(\/[^?#\s]*)?$/i;

// Plain HTTP is accepted only for development servers on this machine or the
// Android emulator host; release builds also block it through ATS/cleartext policy.
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "10.0.2.2"]);

/**
 * Turns what a user types into the instance base URL the API client expects:
 * `chat.acme.ru` → `https://chat.acme.ru`, `https://acme.ru/coma/` → `https://acme.ru/coma`.
 */
export function normalizeServerURL(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const match = address.exec(candidate);
  if (!match) return null;
  const [, scheme, host, port, path = ""] = match;
  const protocol = scheme!.toLowerCase();
  const hostname = host!.toLowerCase();
  if (protocol === "http" && !localHosts.has(hostname)) return null;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535))
    return null;
  const portSuffix =
    port === undefined ||
    (protocol === "https" && port === "443") ||
    (protocol === "http" && port === "80")
      ? ""
      : `:${port}`;
  return `${protocol}://${hostname}${portSuffix}${path.replace(/\/+$/, "")}`;
}

export type ServerTarget = { serverURL: string; inviteToken?: string };

/**
 * Accepts either an instance address or a full invitation link
 * (`https://chat.acme.ru/invite/<token>`), which carries both.
 */
export function parseServerInput(input: string): ServerTarget | null {
  const invite = /^(.*?)\/invite\/([A-Za-z0-9_-]+)\/?$/.exec(input.trim());
  if (invite) {
    const serverURL = normalizeServerURL(invite[1]!);
    return serverURL ? { serverURL, inviteToken: invite[2]! } : null;
  }
  const serverURL = normalizeServerURL(input);
  return serverURL ? { serverURL } : null;
}

/** Host shown to people: `https://chat.acme.ru/coma` → `chat.acme.ru/coma`. */
export function displayServer(serverURL: string): string {
  return serverURL.replace(/^https?:\/\//, "");
}
