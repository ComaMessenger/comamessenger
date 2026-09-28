import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  MessengerAPI,
  PublicBranding,
  TokenResponse,
  User,
} from "@comamessenger/core";
import { createMessengerAPI } from "@/lib/api";
import { claimUserData, clearUserData, serverStorage } from "@/lib/database";
import { isNetworkError } from "@/lib/errors";
import { pendingInvite } from "@/lib/inviteLinks";
import type { ServerTarget } from "@/lib/server";
import { refreshTokenStore } from "@/lib/session";

export type SessionPhase =
  | { kind: "loading" }
  | { kind: "server" }
  | { kind: "offline"; server: string }
  | { kind: "signed-out"; server: string; inviteToken?: string }
  | { kind: "signed-in"; server: string; user: User };

export class ServerUnreachableError extends Error {}

type SessionValue = {
  phase: SessionPhase;
  api: MessengerAPI | null;
  branding: PublicBranding | null;
  /** Checks that the address is a Coma server and switches to it. */
  connect(target: ServerTarget): Promise<void>;
  authenticated(tokens: TokenResponse): Promise<void>;
  retry(): void;
  signOut(): Promise<void>;
  sessionExpired(): void;
  forgetServer(): Promise<void>;
  updateUser(user: User): void;
  dismissInvite(): void;
};

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value)
    throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

/** Signed-in only: the API client and user of the active session. */
export function useSignedIn(): { api: MessengerAPI; user: User } {
  const { phase, api } = useSession();
  if (phase.kind !== "signed-in" || !api)
    throw new Error("useSignedIn requires a signed-in session");
  return { api, user: phase.user };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<SessionPhase>({ kind: "loading" });
  const [api, setAPI] = useState<MessengerAPI | null>(null);
  const [branding, setBranding] = useState<PublicBranding | null>(null);

  const resume = useCallback(async (server: string, client: MessengerAPI) => {
    setAPI(client);
    void client
      .branding()
      .then(setBranding)
      .catch(() => undefined);
    if (!(await refreshTokenStore.load())) {
      setPhase({ kind: "signed-out", server });
      return;
    }
    try {
      const tokens = await client.refresh();
      await claimUserData(tokens.user.id);
      setPhase({ kind: "signed-in", server, user: tokens.user });
    } catch (cause) {
      // Without network the stored session is still valid; asking for the
      // password again would needlessly create a second session.
      setPhase(
        isNetworkError(cause)
          ? { kind: "offline", server }
          : { kind: "signed-out", server },
      );
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const server = await serverStorage.get();
      if (!server) setPhase({ kind: "server" });
      else await resume(server, createMessengerAPI(server));
    })();
  }, [resume]);

  const connect = useCallback(
    async ({ serverURL, inviteToken }: ServerTarget) => {
      const client = createMessengerAPI(serverURL);
      // The public branding endpoint doubles as a check that this is Coma.
      const value = await client.branding().catch(() => {
        throw new ServerUnreachableError(serverURL);
      });
      if ((await serverStorage.get()) !== serverURL) {
        await refreshTokenStore.save(null);
        await clearUserData();
      }
      await serverStorage.set(serverURL);
      setAPI(client);
      setBranding(value);
      setPhase({ kind: "signed-out", server: serverURL, inviteToken });
    },
    [],
  );

  // A signed-in user following an invitation keeps the current session.
  useEffect(() => {
    if (phase.kind === "loading" || phase.kind === "signed-in") return;
    const consume = () => {
      const target = pendingInvite.take();
      if (target) void connect(target).catch(() => undefined);
    };
    consume();
    return pendingInvite.subscribe(consume);
  }, [connect, phase.kind]);

  const authenticated = useCallback(
    async (tokens: TokenResponse) => {
      if (phase.kind === "loading" || phase.kind === "server") return;
      await claimUserData(tokens.user.id);
      setPhase({ kind: "signed-in", server: phase.server, user: tokens.user });
    },
    [phase],
  );

  const retry = useCallback(() => {
    if (phase.kind !== "offline" || !api) return;
    setPhase({ kind: "loading" });
    void resume(phase.server, api);
  }, [api, phase, resume]);

  const signOut = useCallback(async () => {
    if (phase.kind !== "signed-in" || !api) return;
    await api.logout().catch(() => refreshTokenStore.save(null));
    await clearUserData();
    setPhase({ kind: "signed-out", server: phase.server });
  }, [api, phase]);

  const sessionExpired = useCallback(() => {
    setPhase((current) =>
      current.kind === "signed-in"
        ? { kind: "signed-out", server: current.server }
        : current,
    );
  }, []);

  const forgetServer = useCallback(async () => {
    await refreshTokenStore.save(null);
    await clearUserData();
    await serverStorage.set(null);
    setAPI(null);
    setBranding(null);
    setPhase({ kind: "server" });
  }, []);

  const updateUser = useCallback((user: User) => {
    setPhase((current) =>
      current.kind === "signed-in" ? { ...current, user } : current,
    );
  }, []);

  const dismissInvite = useCallback(() => {
    setPhase((current) =>
      current.kind === "signed-out"
        ? { kind: "signed-out", server: current.server }
        : current,
    );
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      phase,
      api,
      branding,
      connect,
      authenticated,
      retry,
      signOut,
      sessionExpired,
      forgetServer,
      updateUser,
      dismissInvite,
    }),
    [
      phase,
      api,
      branding,
      connect,
      authenticated,
      retry,
      signOut,
      sessionExpired,
      forgetServer,
      updateUser,
      dismissInvite,
    ],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
