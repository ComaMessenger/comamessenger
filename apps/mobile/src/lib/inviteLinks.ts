import { normalizeServerURL, type ServerTarget } from "./server";

/** Parses `coma://invite?server=<address>&token=<token>` from a system link. */
export function parseInviteDeepLink(url: string): ServerTarget | null {
  const match = /^coma:\/\/invite\/?\?(.*)$/i.exec(url.trim());
  if (!match) return null;
  const params = new URLSearchParams(match[1]);
  const serverURL = normalizeServerURL(params.get("server") ?? "");
  const inviteToken = params.get("token") ?? "";
  if (!serverURL || !/^[A-Za-z0-9_-]+$/.test(inviteToken)) return null;
  return { serverURL, inviteToken };
}

// Links arrive before the session has loaded, so they wait here until
// SessionProvider can act on them.
let pending: ServerTarget | null = null;
const listeners = new Set<() => void>();

export const pendingInvite = {
  set(target: ServerTarget) {
    pending = target;
    for (const listener of listeners) listener();
  },
  take(): ServerTarget | null {
    const value = pending;
    pending = null;
    return value;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
