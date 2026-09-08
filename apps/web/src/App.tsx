import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  MessengerAPI,
  type PublicBranding,
  type TokenResponse,
  type User,
} from "@comamessenger/core";
import { AvatarProvider } from "./ui";
import { BrowserSessionCoordinator } from "./session";
import { messageOf } from "./errors";
import { setTheme } from "./theme";
import { apiURL, applyPublicBranding } from "./lib/branding";
import {
  BootstrapScreen,
  InviteScreen,
  LoadingScreen,
  LoginScreen,
  ResetPasswordScreen,
} from "./auth";
import { Messenger } from "./shell/Messenger";
import { ComponentCatalog } from "./dev/ComponentCatalog";

type Screen =
  | "loading"
  | "bootstrap"
  | "login"
  | "messenger"
  | "invite"
  | "reset-password";

const chatsHome = {
  to: "/chats",
  search: { filter: "all" as const, folder: undefined },
  replace: true,
} as const;

/** Root: resolves the server state (bootstrap / session) and picks a screen. */
export function App() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const initialPath = useRef(path).current;
  const initialized = useRef(false);
  const navigate = useNavigate();
  const sessions = useMemo(() => new BrowserSessionCoordinator(), []);
  const api = useMemo(
    () => new MessengerAPI(apiURL, (request) => sessions.refresh(request)),
    [sessions],
  );
  const [screen, setScreen] = useState<Screen>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");
  const [branding, setBranding] = useState<PublicBranding | null>(null);

  useEffect(() => {
    setTheme(localStorage.getItem("coma-theme") ?? "light");
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void api
        .branding()
        .then((value) => {
          if (!active) return;
          applyPublicBranding(value, api.apiURL);
          setBranding(value);
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener("coma-branding-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("coma-branding-changed", refresh);
    };
  }, [api]);

  const signedOut = useCallback(() => {
    setUser(null);
    setScreen("login");
  }, []);
  const navigateTo = useCallback(
    (to: string) => void navigate({ to }),
    [navigate],
  );
  const logout = useCallback(() => sessions.publishLogout(), [sessions]);

  useEffect(() => {
    const unsubscribe = sessions.subscribe((message) => {
      if (message.type === "tokens") {
        api.adoptTokens(message.tokens);
        setUser(message.tokens.user);
        setError("");
        setScreen("messenger");
      } else {
        api.clearToken();
        signedOut();
      }
    });
    return unsubscribe;
  }, [api, sessions, signedOut]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (initialPath.startsWith("/invite/")) {
      setScreen("invite");
      return;
    }
    if (initialPath === "/reset-password") {
      setScreen("reset-password");
      return;
    }
    void api
      .bootstrapStatus()
      .then(async (bootstrapped) => {
        if (!bootstrapped) {
          setScreen("bootstrap");
          return;
        }
        try {
          const session = await api.refresh();
          setUser(session.user);
          setScreen("messenger");
          if (initialPath === "/") await navigate(chatsHome);
        } catch {
          setScreen("login");
        }
      })
      .catch((cause) => {
        setError(messageOf(cause));
        setScreen("login");
      });
  }, [api, initialPath, navigate]);

  const authenticated = async (session: TokenResponse) => {
    sessions.publishTokens(session);
    if (path === "/" || path.startsWith("/invite/")) await navigate(chatsHome);
  };

  if (path === "/dev/components" && import.meta.env.DEV)
    return <ComponentCatalog />;
  if (screen === "loading") return <LoadingScreen />;
  const workspaceName = branding?.workspace_name ?? "";
  if (screen === "bootstrap")
    return (
      <BootstrapScreen
        api={api}
        error={error}
        onError={setError}
        onAuthenticated={authenticated}
      />
    );
  if (screen === "invite")
    return (
      <InviteScreen
        api={api}
        error={error}
        onError={setError}
        onAuthenticated={authenticated}
        token={path.split("/").pop() ?? ""}
        workspaceName={workspaceName}
      />
    );
  if (screen === "reset-password")
    return (
      <ResetPasswordScreen
        api={api}
        token={new URLSearchParams(window.location.search).get("token") ?? ""}
        workspaceName={workspaceName}
        onComplete={() => {
          setError("");
          setScreen("login");
          void navigate({ to: "/" });
        }}
      />
    );
  if (screen === "login" || !user)
    return (
      <LoginScreen
        api={api}
        error={error}
        onError={setError}
        onAuthenticated={authenticated}
        passwordRecoveryAvailable={branding?.password_recovery_available ?? false}
        workspaceName={workspaceName}
      />
    );
  return (
    <AvatarProvider api={api}>
      <Messenger
        api={api}
        user={user}
        path={path}
        navigate={navigateTo}
        onLogout={logout}
        onUserUpdated={setUser}
      />
    </AvatarProvider>
  );
}
