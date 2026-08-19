import {
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { EmojiStyle, Theme as EmojiTheme } from "emoji-picker-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import {
  AtSign,
  Bell,
  Bookmark,
  ChevronLeft,
  ChevronDown,
  Circle,
  Clock3,
  Copy,
  CornerUpLeft,
  Forward,
  Inbox,
  Info,
  Link2,
  Languages,
  LogOut,
  Megaphone,
  MessageCircle,
  MessageSquareReply,
  MessagesSquare,
  Moon,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  Search,
  SendHorizontal,
  Settings,
  Smile,
  SmilePlus,
  Sun,
  Trash2,
  UserPlus,
  VolumeX,
  X,
} from "lucide-react";
import {
  APIError,
  MessengerAPI,
  Outbox,
  RealtimeCoordinator,
  compactUUID,
  createMessengerStore,
  decodeMentions,
  encodeMentions,
  expandUUID,
  insertMention,
  messagePlainText,
  mentionedActorIDs,
  updateMentionText,
  type AcceptInvitationRequest,
  type BootstrapRequest,
  type Chat,
  type ChatMember,
  type ClientMessage,
  type Draft,
  type Message,
  type User,
  type UserPreferences,
} from "@comamessenger/core";
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Field,
  FormError,
  IconButton,
  Menu as UIMenu,
  Popover,
  SelectField,
  Skeleton,
  TextareaField,
  Toast,
  Tooltip,
  cx,
} from "./ui";
import { Markdown } from "./markdown";
import { checkpointStorage, outboxStorage } from "./persistence";
import i18n, { setLocale } from "./i18n";
import comaLogo from "./assets/coma-logo.svg";

const EmojiPicker = lazy(() => import("emoji-picker-react"));

type Screen = "loading" | "bootstrap" | "login" | "messenger" | "invite";
const apiURL = import.meta.env.VITE_API_URL ?? window.location.origin;
const emptyMessages: ClientMessage[] = [];
const emptyActorIDs: string[] = [];

function useDismissable(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    function pointer(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) onClose();
    }
    function keyboard(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", keyboard);
    };
  }, [onClose, open, ref]);
}

export function App() {
  const { t } = useTranslation();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const initialPath = useRef(path).current;
  const navigate = useNavigate();
  const api = useMemo(() => new MessengerAPI(apiURL), []);
  const [screen, setScreen] = useState<Screen>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");
  useTheme();

  useEffect(() => {
    if (initialPath.startsWith("/invite/")) {
      setScreen("invite");
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
          if (initialPath === "/")
            await navigate({
              to: "/chats",
              search: { filter: "all" },
              replace: true,
            });
        } catch {
          setScreen("login");
        }
      })
      .catch((cause) => {
        setError(messageOf(cause));
        setScreen("login");
      });
  }, [api, initialPath, navigate]);

  const authenticated = async (next: User) => {
    setUser(next);
    setError("");
    setScreen("messenger");
    const signal = new BroadcastChannel("coma-session");
    signal.postMessage("auth_changed");
    signal.close();
    if (path === "/" || path.startsWith("/invite/"))
      await navigate({
        to: "/chats",
        search: { filter: "all" },
        replace: true,
      });
  };
  const signedOut = useCallback(() => {
    setUser(null);
    setScreen("login");
  }, []);
  if (path === "/dev/components" && import.meta.env.DEV)
    return <ComponentCatalog />;
  if (screen === "loading")
    return (
      <main className="auth-shell">
        <Logo size="large" />
        <p className="loading-label">{t("loading")}</p>
      </main>
    );
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
      />
    );
  if (screen === "login" || !user)
    return (
      <LoginScreen
        api={api}
        error={error}
        onError={setError}
        onAuthenticated={authenticated}
      />
    );
  return (
    <Messenger
      api={api}
      user={user}
      path={path}
      navigate={(to) => void navigate({ to })}
      onLogout={signedOut}
    />
  );
}

type AuthProps = {
  api: MessengerAPI;
  error: string;
  onError(value: string): void;
  onAuthenticated(user: User): void;
};
function LoginScreen({ api, error, onError, onAuthenticated }: AuthProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    onError("");
    const data = new FormData(event.currentTarget);
    try {
      onAuthenticated(
        (
          await api.login({
            email: value(data, "email"),
            password: value(data, "password"),
          })
        ).user,
      );
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <AuthLayout title={t("loginTitle")} lead={t("loginLead")}>
      <form className="auth-form" onSubmit={submit}>
        <Field
          label={t("email")}
          name="email"
          type="email"
          autoComplete="email"
        />
        <Field
          label={t("password")}
          name="password"
          type="password"
          autoComplete="current-password"
        />
        <FormError message={error} />
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? t("loggingIn") : t("login")}
        </Button>
      </form>
    </AuthLayout>
  );
}
function BootstrapScreen({ api, error, onError, onAuthenticated }: AuthProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    onError("");
    const data = new FormData(event.currentTarget);
    const input: BootstrapRequest = {
      organization_name: value(data, "organization_name"),
      organization_slug: value(data, "organization_slug").toLowerCase(),
      display_name: value(data, "display_name"),
      handle: value(data, "handle").toLowerCase(),
      email: value(data, "email"),
      password: value(data, "password"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
    try {
      onAuthenticated(
        (await api.bootstrap(input, value(data, "bootstrap_token"))).user,
      );
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <AuthLayout title={t("bootstrapTitle")} lead={t("bootstrapLead")}>
      <form className="auth-form auth-form--grid" onSubmit={submit}>
        <div className="form-span">
          <Field
            label={t("bootstrapToken")}
            name="bootstrap_token"
            type="password"
            required={false}
          />
        </div>
        <Field label={t("organization")} name="organization_name" />
        <Field
          label={t("slug")}
          name="organization_slug"
          pattern="[a-z0-9][a-z0-9-]{1,62}"
        />
        <Field label={t("name")} name="display_name" />
        <Field label={t("handle")} name="handle" />
        <Field label={t("email")} name="email" type="email" />
        <Field
          label={t("password")}
          name="password"
          type="password"
          minLength={10}
        />
        <FormError message={error} />
        <Button
          className="form-span"
          type="submit"
          variant="primary"
          disabled={pending}
        >
          {t("createSpace")}
        </Button>
      </form>
    </AuthLayout>
  );
}
function InviteScreen({
  api,
  error,
  onError,
  onAuthenticated,
  token,
}: AuthProps & { token: string }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const data = new FormData(event.currentTarget);
    const input: AcceptInvitationRequest = {
      display_name: value(data, "display_name"),
      handle: value(data, "handle"),
      password: value(data, "password"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
    try {
      onAuthenticated((await api.acceptInvitation(token, input)).user);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <AuthLayout title={t("inviteTitle")} lead="Coma">
      <form className="auth-form" onSubmit={submit}>
        <Field label={t("name")} name="display_name" />
        <Field label={t("handle")} name="handle" />
        <Field
          label={t("password")}
          name="password"
          type="password"
          minLength={10}
          hint={t("passwordHint")}
        />
        <FormError message={error} />
        <Button type="submit" variant="primary" disabled={pending}>
          {t("accept")}
        </Button>
      </form>
    </AuthLayout>
  );
}
function AuthLayout({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <Logo size="large" />
        <div className="auth-card__heading">
          <h1>{title}</h1>
          <p>{lead}</p>
        </div>
        {children}
      </section>
    </main>
  );
}

function Messenger({
  api,
  user,
  path,
  navigate,
  onLogout,
}: {
  api: MessengerAPI;
  user: User;
  path: string;
  navigate(to: string): void;
  onLogout(): void;
}) {
  const { t } = useTranslation();
  const store = useMemo(() => createMessengerStore(), []);
  const chatMap = useStore(store, (state) => state.chats);
  const chats = useMemo(() => Object.values(chatMap), [chatMap]);
  const unread = useStore(store, (state) => state.unread);
  const realtime = useStore(store, (state) => state.realtime);
  const [filter, setFilter] = useState<"all" | "direct" | "grouped">(
    chatFilterFromURL,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatLoading, setChatLoading] = useState(true);
  const [chatError, setChatError] = useState("");
  const [modal, setModal] = useState<
    "new" | "settings" | "notify" | "pinned" | null
  >(null);
  const selectedID = /^\/chat\/([^/]+)/.exec(path)?.[1] ?? null;
  const threadID = /\/thread\/([^/]+)/.exec(path)?.[1] ?? null;
  const showThreads = path === "/threads";
  const channel = useMemo(() => new BroadcastChannel("coma-session"), []);
  const membersQuery = useQuery({
    queryKey: ["chat-members", selectedID],
    queryFn: () => api.members(selectedID!),
    enabled: Boolean(selectedID),
  });

  const reload = useCallback(async () => {
    try {
      const [chatList, counts] = await Promise.all([api.chats(), api.unread()]);
      store.getState().replaceChats(chatList);
      store.getState().setUnread(counts);
      setChatError("");
    } catch (cause) {
      setChatError(messageOf(cause));
    } finally {
      setChatLoading(false);
    }
  }, [api, store]);
  const coordinator = useMemo(
    () =>
      new RealtimeCoordinator(
        api,
        checkpointStorage,
        (url) => new WebSocket(url),
        {
          state: store.getState().setRealtime,
          event: (event) => {
            const applied = store.getState().apply(event);
            if (
              applied &&
              (event.type.startsWith("chat.") ||
                event.type.startsWith("member."))
            )
              void reload();
            return applied;
          },
          resync: async (watermark) => {
            const active = store.getState().activeChatID;
            store.getState().resetDurable(watermark);
            await reload();
            if (active) await loadMessages(api, store, active);
          },
          typing: (frame) =>
            store
              .getState()
              .setTyping(
                String(frame.chat_id),
                String(frame.actor_id),
                Boolean(frame.active),
              ),
          presence: (frame) =>
            store
              .getState()
              .setPresence(
                String(frame.actor_id),
                frame.state as "online" | "away" | "offline",
              ),
          sessionExpired: onLogout,
        },
      ),
    [api, reload, onLogout, store],
  );
  const outbox = useMemo(
    () =>
      new Outbox(api, outboxStorage, {
        optimistic: store.getState().optimistic,
        delivered: store.getState().reconcile,
        retrying: store.getState().retrying,
        failed: store.getState().failed,
      }),
    [api, store],
  );

  useEffect(() => {
    void reload();
    void api.drafts().then((drafts) => hydrateDrafts(drafts));
    void api
      .preferences()
      .then((preferences) => {
        setTheme(preferences.theme);
        void setLocale(preferences.locale);
      })
      .catch(() => undefined);
    coordinator.start();
    void outbox.flush();
    return () => coordinator.stop();
  }, [api, coordinator, outbox, reload]);
  useEffect(() => {
    store.getState().setActive(selectedID);
    coordinator.subscribe(selectedID, threadID);
  }, [api, coordinator, selectedID, store, threadID]);
  useEffect(() => {
    const key = /^\/m\/([^/]+)$/.exec(path)?.[1];
    if (!key) return;
    try {
      const messageID = expandUUID(key);
      void api
        .messageContext(messageID, 3)
        .then((context) => {
          const target = context.messages.find((item) => item.id === messageID);
          if (!target) throw new Error("message not found");
          navigate(`/chat/${target.chat_id}?message=${messageID}`);
        })
        .catch((cause) => setChatError(messageOf(cause)));
    } catch (cause) {
      setChatError(messageOf(cause));
    }
  }, [api, navigate, path]);
  useEffect(() => {
    channel.onmessage = (event) => {
      if (event.data === "logout") {
        api.clearToken();
        onLogout();
      } else if (event.data === "auth_changed") {
        void api.refresh().catch(onLogout);
      }
    };
    return () => channel.close();
  }, [api, channel, onLogout]);
  useEffect(() => {
    const visible = () =>
      coordinator.presence(document.hidden ? "away" : "active");
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [coordinator]);
  useEffect(() => {
    const flush = () => void outbox.flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [outbox]);

  const searched = chats;
  const filtered = searched.filter(
    (chat) =>
      filter === "all" ||
      (filter === "direct" ? chat.kind === "direct" : chat.kind !== "direct"),
  );
  const sections = (["direct", "group", "channel"] as const).map((kind) => ({
    kind,
    label:
      kind === "direct"
        ? t("direct")
        : kind === "group"
          ? t("chats")
          : t("channels"),
    chats: searched.filter((chat) => chat.kind === kind),
  }));
  async function logout() {
    await api.logout();
    channel.postMessage("logout");
    onLogout();
  }
  function selectFilter(next: "all" | "direct" | "grouped") {
    setFilter(next);
    const url = new URL(window.location.href);
    if (next === "all") url.searchParams.delete("filter");
    else url.searchParams.set("filter", next);
    window.history.replaceState(window.history.state, "", url);
  }
  return (
    <div
      className={cx(
        "messenger",
        selectedID && "messenger--chat-open",
        threadID && "messenger--thread-open",
      )}
    >
      <aside className="chat-sidebar" aria-label={t("chatNavigation")}>
        <header className="workspace-switcher">
          <Logo size="small" />
          <div className="workspace-copy">
            <span>Coma</span>
            <strong>{showThreads ? t("threads") : t("chats")}</strong>
          </div>
          <IconButton label={t("newChat")} onClick={() => setModal("new")}>
            <Plus />
          </IconButton>
        </header>
        {!showThreads && (
          <>
            <div className="search-actions">
              <button
                className="search-field"
                onClick={() => setSearchOpen(true)}
              >
                <Search size={16} />
                <span>{t("search")}</span>
              </button>
              <IconButton label={t("newChat")} onClick={() => setModal("new")}>
                <Plus />
              </IconButton>
            </div>
            <nav className="sidebar-nav" aria-label={t("primaryNavigation")}>
              <button className="active" onClick={() => navigate("/chats")}>
                <MessageCircle />
                <span>{t("chats")}</span>
              </button>
              <button onClick={() => navigate("/threads")}>
                <Inbox />
                <span>{t("threads")}</span>
              </button>
              <button
                disabled={!selectedID}
                onClick={() => selectedID && setModal("pinned")}
              >
                <Bookmark />
                <span>{t("saved")}</span>
              </button>
              <button onClick={() => setModal("settings")}>
                <Settings />
                <span>{t("settings")}</span>
              </button>
            </nav>
            <div className="filter-chips" role="group" aria-label={t("chats")}>
              {(["all", "direct", "grouped"] as const).map((item) => (
                <button
                  key={item}
                  className={filter === item ? "active" : ""}
                  onClick={() => selectFilter(item)}
                >
                  {t(item)}
                </button>
              ))}
            </div>
            <div className="chat-list">
              {chatError && <FormError message={chatError} />}
              {chatLoading ? (
                <Skeleton />
              ) : searched.length ? (
                <>
                  <div className="desktop-chat-groups">
                    {sections.map((section) => (
                      <section className="chat-folder" key={section.kind}>
                        <header className="chat-folder__head">
                          <ChevronDown size={13} />
                          <span>{section.label}</span>
                          <small>{section.chats.length}</small>
                        </header>
                        <div className="chat-folder__items">
                          {section.chats.map((chat) => (
                            <ChatCard
                              key={chat.id}
                              api={api}
                              chat={chat}
                              title={titleOf(chat, [], user.id)}
                              selected={chat.id === selectedID}
                              unread={unread.chats.find(
                                (item) => item.chat_id === chat.id,
                              )}
                              onClick={() => navigate(`/chat/${chat.id}`)}
                            />
                          ))}
                          <button
                            className="chat-folder__add"
                            onClick={() => setModal("new")}
                          >
                            <Plus size={15} />
                            <span>{t("create")}</span>
                          </button>
                        </div>
                      </section>
                    ))}
                  </div>
                  <div className="mobile-chat-list">
                    {filtered.map((chat) => (
                      <ChatCard
                        key={chat.id}
                        api={api}
                        chat={chat}
                        title={titleOf(chat, [], user.id)}
                        selected={chat.id === selectedID}
                        unread={unread.chats.find(
                          (item) => item.chat_id === chat.id,
                        )}
                        onClick={() => navigate(`/chat/${chat.id}`)}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <Empty label={t("emptyChats")} />
              )}
            </div>
          </>
        )}
        {showThreads && (
          <>
            <button
              className="sidebar-return"
              onClick={() => navigate("/chats")}
            >
              <ChevronLeft /> {t("chats")}
            </button>
            <ThreadDirectory api={api} navigate={navigate} />
          </>
        )}
        <footer className="sidebar-profile">
          <Avatar name={user.display_name} size="sm" online />
          <div>
            <strong>{user.display_name}</strong>
            <span>@{user.handle}</span>
          </div>
          <IconButton
            label={t("notifications")}
            onClick={() => setModal("notify")}
          >
            <Bell />
          </IconButton>
          <IconButton
            label={t("settings")}
            onClick={() => setModal("settings")}
          >
            <Settings />
          </IconButton>
        </footer>
      </aside>
      <main className="conversation">
        {selectedID ? (
          <Conversation
            api={api}
            store={store}
            user={user}
            chat={store.getState().chats[selectedID]}
            members={membersQuery.data ?? []}
            threadID={threadID}
            coordinator={coordinator}
            outbox={outbox}
            onBack={() => navigate("/chats")}
            onOpenThread={(id) => navigate(`/chat/${selectedID}/thread/${id}`)}
            onCloseThread={() => navigate(`/chat/${selectedID}`)}
          />
        ) : (
          <Welcome />
        )}
      </main>
      {modal === "new" && (
        <CreateChatDialog
          api={api}
          onClose={() => setModal(null)}
          onCreated={(chat) => {
            store.setState((state) => ({
              chats: { ...state.chats, [chat.id]: chat },
            }));
            setModal(null);
            navigate(`/chat/${chat.id}`);
          }}
        />
      )}
      {modal === "settings" && (
        <SettingsDialog
          api={api}
          user={user}
          onClose={() => setModal(null)}
          onLogout={() => void logout()}
          onNotify={() => setModal("notify")}
        />
      )}
      {modal === "notify" && (
        <NotificationDialog api={api} onClose={() => setModal(null)} />
      )}
      {modal === "pinned" && selectedID && (
        <PinnedDialog
          api={api}
          chatID={selectedID}
          onClose={() => setModal(null)}
          onOpen={(messageID) => {
            setModal(null);
            navigate(`/chat/${selectedID}?message=${messageID}`);
          }}
        />
      )}
      {searchOpen && (
        <SearchPalette
          chats={chats}
          members={membersQuery.data ?? []}
          ownID={user.id}
          onClose={() => setSearchOpen(false)}
          onOpen={(chatID) => {
            setSearchOpen(false);
            navigate(`/chat/${chatID}`);
          }}
        />
      )}
      <div
        className={cx("connection-pill", realtime === "live" && "live")}
        role="status"
      >
        <Circle size={8} fill="currentColor" />
        {realtime === "live" ? t("connectionLive") : t("connectionOffline")}
      </div>
    </div>
  );
}

function ChatCard({
  api,
  chat,
  title,
  selected,
  unread,
  onClick,
}: {
  api: MessengerAPI;
  chat: Chat;
  title: string;
  selected: boolean;
  unread?: { unread_count: number; mention_count: number };
  onClick(): void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  useDismissable(menuRoot, menu, () => setMenu(false));
  const notificationQuery = useQuery({
    queryKey: ["chat-notifications", chat.id],
    queryFn: () => api.chatNotifications(chat.id),
    enabled: menu,
    staleTime: 30_000,
  });
  const muted = notificationQuery.data?.notify_level === "none";
  function toggleMenu(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setMenu((open) => !open);
  }
  return (
    <div className="chat-card-wrap" ref={menuRoot}>
      <button
        className={cx(
          "chat-card",
          selected && "selected",
          muted && "chat-card--muted",
        )}
        onClick={onClick}
        onContextMenu={toggleMenu}
      >
        <Avatar name={title} size="lg" online={chat.kind === "direct"} />
        <span className="chat-card__body">
          <span className="chat-card__top">
            <strong>
              {chat.kind === "channel" && <Megaphone size={14} />}
              {title}
            </strong>
            <time>
              {chat.last_message_at
                ? formatTime(chat.last_message_at)
                : formatDay(chat.created_at)}
            </time>
          </span>
          <span className="chat-card__preview">
            {chat.last_message
              ? `${chat.last_message.actor_display_name}: ${chat.last_message.deleted ? t("remove") : messagePlainText(chat.last_message.body)}`
              : chat.topic ||
                (chat.kind === "direct" ? t("direct") : t(chat.kind))}
          </span>
        </span>
        {Boolean(unread?.unread_count) && (
          <Badge tone={unread?.mention_count ? "primary" : "neutral"}>
            {unread!.unread_count > 99 ? "99+" : unread!.unread_count}
          </Badge>
        )}
      </button>
      <button
        className="chat-card__more"
        aria-label={t("chatActions")}
        aria-expanded={menu}
        onClick={toggleMenu}
      >
        <MoreHorizontal size={16} />
      </button>
      {menu && (
        <div className="chat-context-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              onClick();
            }}
          >
            <MessageCircle />
            <span>{t("openChat")}</span>
          </button>
          <button
            role="menuitem"
            onClick={() =>
              void api
                .updateChatNotifications(chat.id, {
                  notify_level: muted ? "all" : "none",
                  muted_until: null,
                })
                .then(() => notificationQuery.refetch())
                .then(() => setMenu(false))
            }
          >
            <VolumeX />
            <span>{muted ? t("unmuteChat") : t("muteChat")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function SearchPalette({
  chats,
  members,
  ownID,
  onClose,
  onOpen,
}: {
  chats: Chat[];
  members: ChatMember[];
  ownID: string;
  onClose(): void;
  onOpen(chatID: string): void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"people" | "messages">("people");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    function keyboard(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [onClose]);
  const value = query.trim().toLowerCase();
  const chatResults = chats.filter((chat) =>
    titleOf(chat, members, ownID).toLowerCase().includes(value),
  );
  const memberResults = members.filter(
    (member) =>
      member.actor_id !== ownID &&
      (member.display_name.toLowerCase().includes(value) ||
        member.handle.toLowerCase().includes(value)),
  );
  return (
    <div
      className="search-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="search-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("search")}
      >
        <label className="search-palette__field">
          <Search />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchInWorkspace")}
          />
        </label>
        <div className="search-palette__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "people"}
            onClick={() => setTab("people")}
          >
            {t("chatsAndPeople")}
          </button>
          <button
            role="tab"
            aria-selected={tab === "messages"}
            onClick={() => setTab("messages")}
          >
            {t("messagesAndThreads")}
          </button>
        </div>
        <div className="search-palette__results">
          {tab === "people" ? (
            <>
              {chatResults.map((chat) => (
                <button key={chat.id} onClick={() => onOpen(chat.id)}>
                  <Avatar name={titleOf(chat, members, ownID)} size="sm" />
                  <span>
                    <strong>{titleOf(chat, members, ownID)}</strong>
                    <small>
                      {chat.kind === "direct"
                        ? t("direct")
                        : chat.topic || t(chat.kind)}
                    </small>
                  </span>
                </button>
              ))}
              {memberResults.map((member) => {
                const direct = chats.find(
                  (chat) =>
                    chat.kind === "direct" &&
                    titleOf(chat, members, ownID) === member.display_name,
                );
                return (
                  <button
                    key={member.actor_id}
                    disabled={!direct}
                    onClick={() => direct && onOpen(direct.id)}
                  >
                    <Avatar name={member.display_name} size="sm" online />
                    <span>
                      <strong>{member.display_name}</strong>
                      <small>@{member.handle}</small>
                    </span>
                  </button>
                );
              })}
              {!chatResults.length && !memberResults.length && (
                <Empty label={t("nothingFound")} />
              )}
            </>
          ) : (
            <Empty label={t("searchMessagesUnavailable")} />
          )}
        </div>
        <footer className="search-palette__footer" aria-hidden="true">
          <span>↑ ↓ {t("choose")}</span>
          <span>↵ {t("open")}</span>
          <span>Esc {t("close")}</span>
        </footer>
      </section>
    </div>
  );
}

function Conversation({
  api,
  store,
  user,
  chat,
  members,
  threadID,
  coordinator,
  outbox,
  onBack,
  onOpenThread,
  onCloseThread,
}: {
  api: MessengerAPI;
  store: ReturnType<typeof createMessengerStore>;
  user: User;
  chat?: Chat;
  members: ChatMember[];
  threadID: string | null;
  coordinator: RealtimeCoordinator;
  outbox: Outbox;
  onBack(): void;
  onOpenThread(id: string): void;
  onCloseThread(): void;
}) {
  const { t } = useTranslation();
  const messages = useStore(
    store,
    (state) => state.messages[chat?.id ?? ""] ?? emptyMessages,
  );
  const typing = useStore(
    store,
    (state) => state.typing[chat?.id ?? ""] ?? emptyActorIDs,
  );
  const presence = useStore(store, (state) => state.presence);
  const [reply, setReply] = useState<Message | null>(null);
  const [body, setBody] = useState("");
  const [hasMore, setHasMore] = useState(true);
  const [loadingPrevious, setLoadingPrevious] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const [info, setInfo] = useState(false);
  const [unreadAnchor, setUnreadAnchor] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const loadingPreviousRef = useRef(false);
  const atBottom = useRef(true);
  const title = titleOf(chat, members, user.id);
  const readonly = chat?.kind === "channel" && chat.role === "member";
  const visible = messages.filter((item) => !item.thread_root_id);
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 68,
    overscan: 12,
  });
  useEffect(() => {
    if (!chat) return;
    const saved = getLocalDraft(chat.id, null);
    setBody(saved);
  }, [chat]);
  useEffect(() => {
    if (!chat) return;
    let active = true;
    setHasMore(true);
    void api
      .messages(chat.id, { limit: 50 })
      .then((page) => {
        if (!active) return;
        store.getState().replaceMessages(chat.id, page.messages);
        setHasMore(page.next_before_seq != null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, chat?.id, store]);
  useEffect(() => {
    if (chat)
      setUnreadAnchor(
        store.getState().unread.chats.find((item) => item.chat_id === chat.id)
          ?.last_read_seq ?? 0,
      );
  }, [chat?.id, store]);
  useEffect(() => {
    if (!chat) return;
    const timer = setTimeout(() => {
      setLocalDraft(chat.id, null, body);
      void syncDraft(api, chat.id, null, body);
    }, 600);
    return () => clearTimeout(timer);
  }, [api, body, chat]);
  useEffect(() => {
    const max = visible.at(-1)?.created_seq;
    if (max && max < Number.MAX_SAFE_INTEGER)
      void api.markRead(chat!.id, max).then(() =>
        store.getState().setUnread({
          ...store.getState().unread,
          chats: store.getState().unread.chats.map((item) =>
            item.chat_id === chat!.id
              ? {
                  ...item,
                  unread_count: 0,
                  mention_count: 0,
                  last_read_seq: max,
                }
              : item,
          ),
        }),
      );
    if (atBottom.current)
      requestAnimationFrame(() =>
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight }),
      );
    else setNewBelow((value) => value + 1);
  }, [api, chat, store, visible.length]);
  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get("message");
    if (!target || !chat) return;
    void api.messageContext(target).then((window) => {
      store.getState().replaceMessages(chat.id, window.messages);
      requestAnimationFrame(() =>
        document
          .getElementById(`message-${target}`)
          ?.scrollIntoView({ block: "center" }),
      );
    });
  }, [api, chat?.id, store]);
  if (!chat) return <Welcome />;
  const activeChat = chat;
  async function send() {
    const content = body.trim();
    if (!content || readonly) return;
    const client_msg_id = crypto.randomUUID();
    setBody("");
    setReply(null);
    setLocalDraft(activeChat.id, null, "");
    coordinator.typing(activeChat.id, false, null);
    await outbox.enqueue(activeChat.id, {
      client_msg_id,
      body: content,
      body_format: "markdown",
      reply_to_id: reply?.id,
      mentioned_actor_ids: resolvedMentionActorIDs(content, members, presence),
    });
  }
  async function loadPrevious() {
    if (loadingPreviousRef.current || !hasMore) return;
    const first = visible.find(
      (item) => item.created_seq < Number.MAX_SAFE_INTEGER,
    );
    if (!first) return;
    loadingPreviousRef.current = true;
    setLoadingPrevious(true);
    const previousHeight = scroller.current?.scrollHeight ?? 0;
    try {
      const page = await api.messages(activeChat.id, {
        beforeSeq: first.created_seq,
      });
      store.getState().prependMessages(activeChat.id, page.messages);
      setHasMore(page.next_before_seq != null);
      requestAnimationFrame(() => {
        if (scroller.current)
          scroller.current.scrollTop +=
            scroller.current.scrollHeight - previousHeight;
      });
    } finally {
      loadingPreviousRef.current = false;
      setLoadingPrevious(false);
    }
  }
  async function jump(messageID: string) {
    const window = await api.messageContext(messageID);
    store.getState().replaceMessages(activeChat.id, window.messages);
    requestAnimationFrame(() =>
      document
        .getElementById(`message-${messageID}`)
        ?.scrollIntoView({ block: "center" }),
    );
  }
  return (
    <>
      <header className="conversation-head">
        <IconButton className="mobile-back" label={t("back")} onClick={onBack}>
          <ChevronLeft />
        </IconButton>
        <Avatar name={title} />
        <div className="conversation-head__title">
          <h1>{title}</h1>
          <span>
            {typing.length
              ? `${typing.length} ${t("typing")}`
              : chat.topic || t("memberCount", { count: members.length })}
          </span>
        </div>
        <div className="conversation-head__actions">
          <IconButton label={t("search")}>
            <Search />
          </IconButton>
          <IconButton label={t("members")} onClick={() => setInfo(true)}>
            <Info />
          </IconButton>
        </div>
      </header>
      <div
        className="message-scroll"
        ref={scroller}
        aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollTop < 96) void loadPrevious();
          atBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            96;
          if (atBottom.current) setNewBelow(0);
        }}
      >
        {loadingPrevious && <span className="history-loader" aria-hidden />}
        {!hasMore && (
          <ChatIntro
            chat={activeChat}
            title={title}
            onAddMembers={() => setInfo(true)}
          />
        )}
        {visible.length === 0 && <Empty label={t("noMessages")} />}
        <div
          className="virtual-list"
          style={{ height: virtual.getTotalSize() }}
        >
          {virtual.getVirtualItems().map((row) => {
            const message = visible[row.index]!;
            const previous = visible[row.index - 1];
            const newDay =
              !previous ||
              new Date(previous.created_at).toDateString() !==
                new Date(message.created_at).toDateString();
            const firstUnread =
              unreadAnchor > 0 &&
              message.created_seq > unreadAnchor &&
              (!previous || previous.created_seq <= unreadAnchor);
            return (
              <div
                key={message.id}
                ref={virtual.measureElement}
                data-index={row.index}
                className="virtual-row"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {newDay && !(!hasMore && row.index === 0) && (
                  <div className="day-separator">
                    {new Intl.DateTimeFormat(activeLocale(), {
                      dateStyle: "long",
                    }).format(new Date(message.created_at))}
                  </div>
                )}
                {firstUnread && (
                  <div className="unread-separator">{t("newMessages")}</div>
                )}
                <MessageRow
                  api={api}
                  message={message}
                  chats={Object.values(store.getState().chats)}
                  members={members}
                  replyMessage={
                    message.reply_to_id
                      ? messages.find((item) => item.id === message.reply_to_id)
                      : undefined
                  }
                  author={members.find(
                    (item) => item.actor_id === message.actor_id,
                  )}
                  own={message.actor_id === user.id || !message.actor_id}
                  grouped={
                    !newDay &&
                    previous?.actor_id === message.actor_id &&
                    minuteGap(previous.created_at, message.created_at) < 5
                  }
                  onReply={() => setReply(message)}
                  onJump={(id) => void jump(id)}
                  onRetry={() => void outbox.flush()}
                  onThread={() =>
                    onOpenThread(message.thread_root_id ?? message.id)
                  }
                  onChanged={(updated) =>
                    store.getState().apply({
                      op: "event",
                      seq: Math.max(
                        store.getState().checkpoint + 1,
                        updated.created_seq,
                      ),
                      type: "message.updated",
                      occurred_at: updated.created_at,
                      actor_id: updated.actor_id,
                      chat_id: updated.chat_id,
                      subject_id: updated.id,
                      data: updated,
                    })
                  }
                />
              </div>
            );
          })}
        </div>
      </div>
      {newBelow > 0 && (
        <button
          className="new-below"
          onClick={() => {
            scroller.current?.scrollTo({
              top: scroller.current.scrollHeight,
              behavior: "smooth",
            });
            setNewBelow(0);
          }}
        >
          {t("newMessages")} · {newBelow}
        </button>
      )}
      <Composer
        members={members}
        body={body}
        setBody={(next) => {
          setBody(next);
          coordinator.typing(chat.id, Boolean(next), null);
        }}
        onBlur={() => void syncDraft(api, chat.id, null, body)}
        onSend={() => void send()}
        reply={reply}
        onCancelReply={() => setReply(null)}
        readonly={readonly}
      />
      {threadID && (
        <ThreadPanel
          api={api}
          store={store}
          user={user}
          chat={activeChat}
          members={members}
          coordinator={coordinator}
          outbox={outbox}
          rootID={threadID}
          onClose={onCloseThread}
        />
      )}
      {info && (
        <ChatInfoDialog
          api={api}
          chat={activeChat}
          members={members}
          onClose={() => setInfo(false)}
        />
      )}
    </>
  );
}

function MessageRow({
  api,
  message,
  chats,
  members,
  replyMessage,
  author,
  own,
  grouped,
  onReply,
  onJump,
  onRetry,
  onThread,
  onChanged,
  domIDPrefix = "message",
}: {
  api: MessengerAPI;
  message: ClientMessage;
  chats: Chat[];
  members: ChatMember[];
  replyMessage?: ClientMessage;
  author?: ChatMember;
  own: boolean;
  grouped: boolean;
  onReply(): void;
  onJump(id: string): void;
  onRetry(): void;
  onThread(): void;
  onChanged(value: Message): void;
  domIDPrefix?: string;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const [reactionPicker, setReactionPicker] = useState(false);
  const interactionRoot = useRef<HTMLElement>(null);
  useDismissable(interactionRoot, menu || reactionPicker, () => {
    setMenu(false);
    setReactionPicker(false);
  });
  const reactionsQuery = useQuery({
    queryKey: ["message-reactions", message.id],
    queryFn: () => api.reactions(message.id),
    staleTime: 15_000,
  });
  const replyQuery = useQuery({
    queryKey: ["message-context", message.reply_to_id],
    queryFn: () => api.messageContext(message.reply_to_id!),
    enabled: Boolean(message.reply_to_id && !replyMessage),
    staleTime: 5 * 60_000,
  });
  const resolvedReply =
    replyMessage ??
    replyQuery.data?.messages.find((item) => item.id === message.reply_to_id);
  const replyAuthor = members.find(
    (item) => item.actor_id === resolvedReply?.actor_id,
  );
  const name = own
    ? (author?.display_name ?? t("you"))
    : (author?.display_name ?? t("participant"));
  async function edit() {
    const original = decodeMentions(message.body);
    const visibleBody = prompt(t("edit"), original.text);
    if (!visibleBody || visibleBody === original.text) return;
    const body = encodeMentions(updateMentionText(original, visibleBody));
    onChanged(
      await api.updateMessage(message.id, {
        body,
        body_format: "markdown",
        expected_version: message.version,
        mentioned_actor_ids: mentionedActorIDs(body),
      }),
    );
    setMenu(false);
  }
  async function remove() {
    if (!confirm(t("deleteConfirm"))) return;
    onChanged(await api.deleteMessage(message.id));
    setMenu(false);
  }
  async function react(emoji: string) {
    await api.react(message.id, emoji);
    await reactionsQuery.refetch();
    setMenu(false);
    setReactionPicker(false);
  }
  const reactionGroups = Object.entries(
    (reactionsQuery.data ?? []).reduce<Record<string, number>>(
      (groups, reaction) => ({
        ...groups,
        [reaction.emoji]: (groups[reaction.emoji] ?? 0) + 1,
      }),
      {},
    ),
  );
  return (
    <article
      ref={interactionRoot}
      id={`${domIDPrefix}-${message.id}`}
      className={cx(
        "message",
        grouped && "message--grouped",
        message.delivery === "failed" && "message--failed",
      )}
    >
      <div className="message__avatar">
        {!grouped && <Avatar name={name} size="sm" />}
      </div>
      <div className="message__content">
        {!grouped && (
          <header>
            <strong>{name}</strong>
            <time>{formatTime(message.created_at)}</time>
            {message.edited_at && <span>· {t("edit")}</span>}
          </header>
        )}
        {message.reply_to_id && (
          <button
            className="message__quote"
            onClick={() => onJump(message.reply_to_id!)}
          >
            <strong>{replyAuthor?.display_name ?? t("reply")}</strong>
            <span>
              {resolvedReply
                ? messagePlainText(resolvedReply.body).slice(0, 120)
                : t("loading")}
            </span>
          </button>
        )}
        <div className="message__body">
          {message.deleted_at ? (
            <em>{t("remove")}</em>
          ) : (
            <Markdown source={message.body} />
          )}
        </div>
        {message.forwarded_from && (
          <span className="forwarded">
            ↪ {message.forwarded_from.author_name}
          </span>
        )}
        <div className="reaction-row">
          {reactionGroups.map(([emoji, count]) => (
            <button key={emoji} onClick={() => void react(emoji)}>
              <span>{emoji}</span>
              <strong>{count}</strong>
            </button>
          ))}
        </div>
        {message.delivery &&
          message.delivery !== "sent" &&
          (message.delivery === "sending" || message.delivery === "retrying" ? (
            <span className="delivery">
              {message.delivery === "retrying" ? t("retrying") : "…"}
            </span>
          ) : (
            <button className="delivery delivery--retry" onClick={onRetry}>
              {t("retry")}
            </button>
          ))}
      </div>
      <div className="message__actions" aria-label={t("messageActions")}>
        <IconButton
          label={t("addReaction")}
          onClick={() => {
            setMenu(false);
            setReactionPicker((open) => !open);
          }}
        >
          <SmilePlus />
        </IconButton>
        <IconButton label={t("thread")} onClick={onThread}>
          <MessageSquareReply />
        </IconButton>
        <IconButton
          label={t("openMenu")}
          onClick={() => {
            setReactionPicker(false);
            setMenu(!menu);
          }}
        >
          <MoreHorizontal />
        </IconButton>
      </div>
      {reactionPicker && (
        <div className="reaction-picker" role="dialog" aria-label={t("emoji")}>
          <Suspense fallback={<Skeleton />}>
            <EmojiPicker
              width="100%"
              height={410}
              theme={
                (document.documentElement.dataset.theme === "dark"
                  ? "dark"
                  : "light") as EmojiTheme
              }
              emojiStyle={"native" as EmojiStyle}
              lazyLoadEmojis
              searchPlaceholder={t("searchEmoji")}
              searchClearButtonLabel={t("clearSearch")}
              previewConfig={{ showPreview: false }}
              onEmojiClick={(emoji) => void react(emoji.emoji)}
            />
          </Suspense>
        </div>
      )}
      {menu && (
        <div className="message-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setReactionPicker(true);
            }}
          >
            <SmilePlus />
            <span>{t("addReaction")}</span>
          </button>
          <button role="menuitem" onClick={onReply}>
            <CornerUpLeft />
            <span>{t("reply")}</span>
          </button>
          <button role="menuitem" onClick={onThread}>
            <MessageSquareReply />
            <span>{t("thread")}</span>
          </button>
          <div className="message-menu__divider" />
          <button
            role="menuitem"
            onClick={() => void api.pin(message.id).then(() => setMenu(false))}
          >
            <Pin />
            <span>{t("pin")}</span>
          </button>
          <button
            role="menuitem"
            onClick={() =>
              void navigator.clipboard
                .writeText(`${location.origin}/m/${compactUUID(message.id)}`)
                .then(() => setMenu(false))
            }
          >
            <Link2 />
            <span>{t("copyLink")}</span>
          </button>
          <button
            role="menuitem"
            onClick={() =>
              void navigator.clipboard
                .writeText(messagePlainText(message.body))
                .then(() => setMenu(false))
            }
          >
            <Copy />
            <span>{t("copyText")}</span>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setForwarding(true);
            }}
          >
            <Forward />
            <span>{t("forward")}</span>
          </button>
          {own && <div className="message-menu__divider" />}
          {own && (
            <button role="menuitem" onClick={() => void edit()}>
              <Pencil />
              <span>{t("edit")}</span>
            </button>
          )}
          {own && (
            <button
              role="menuitem"
              className="danger"
              onClick={() => void remove()}
            >
              <Trash2 />
              <span>{t("remove")}</span>
            </button>
          )}
        </div>
      )}
      {forwarding && (
        <Dialog title={t("forward")} onClose={() => setForwarding(false)}>
          <div className="forward-picker">
            {chats.map((chat) => (
              <button
                key={chat.id}
                onClick={() =>
                  void api
                    .forward(message.id, chat.id, crypto.randomUUID())
                    .then(() => setForwarding(false))
                }
              >
                <Avatar name={chat.display_name} size="sm" />
                <span>{chat.display_name}</span>
              </button>
            ))}
          </div>
        </Dialog>
      )}
    </article>
  );
}

function Composer({
  members,
  body,
  setBody,
  onBlur,
  onSend,
  reply,
  onCancelReply,
  readonly,
}: {
  members: ChatMember[];
  body: string;
  setBody(value: string): void;
  onBlur(): void;
  onSend(): void;
  reply: Message | null;
  onCancelReply(): void;
  readonly: boolean;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLTextAreaElement>(null);
  const composerRoot = useRef<HTMLDivElement>(null);
  const [formatOpen, setFormatOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sendSettings, setSendSettings] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [sendOnEnter, setSendOnEnter] = useState(
    () => localStorage.getItem("coma-send-on-enter") !== "false",
  );
  useDismissable(composerRoot, formatOpen || emojiOpen || sendSettings, () => {
    setFormatOpen(false);
    setEmojiOpen(false);
    setSendSettings(false);
  });
  const draft = useMemo(() => decodeMentions(body), [body]);
  const mention = /@([\p{L}\p{N}_.-]*)$/u.exec(draft.text);
  const suggestions = mention
    ? members
        .filter(
          (member) =>
            member.display_name
              .toLowerCase()
              .includes(mention[1]!.toLowerCase()) ||
            member.handle.toLowerCase().includes(mention[1]!.toLowerCase()),
        )
        .slice(0, 6)
    : [];
  function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
    const shouldSend = sendOnEnter ? !event.shiftKey : event.shiftKey;
    if (event.key === "Enter" && shouldSend && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  }
  function setVisibleText(nextText: string, cursor: number) {
    setBody(encodeMentions(updateMentionText(draft, nextText)));
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(cursor, cursor);
    });
  }
  function wrap(prefix: string, suffix = prefix, fallback = t("formatText")) {
    const start = input.current?.selectionStart ?? draft.text.length;
    const end = input.current?.selectionEnd ?? start;
    const selected = draft.text.slice(start, end) || fallback;
    const replacement = `${prefix}${selected}${suffix}`;
    setVisibleText(
      draft.text.slice(0, start) + replacement + draft.text.slice(end),
      start + replacement.length,
    );
  }
  function prefixLines(prefix: string) {
    const start = input.current?.selectionStart ?? draft.text.length;
    const end = input.current?.selectionEnd ?? start;
    const lineStart = draft.text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const selected = draft.text.slice(lineStart, end) || t("formatText");
    const replacement = selected
      .split("\n")
      .map((line, index) =>
        prefix === "ordered" ? `${index + 1}. ${line}` : `${prefix}${line}`,
      )
      .join("\n");
    setVisibleText(
      draft.text.slice(0, lineStart) + replacement + draft.text.slice(end),
      lineStart + replacement.length,
    );
  }
  function insertEmoji(emoji: string) {
    const start = input.current?.selectionStart ?? draft.text.length;
    const end = input.current?.selectionEnd ?? start;
    setVisibleText(
      draft.text.slice(0, start) + emoji + draft.text.slice(end),
      start + emoji.length,
    );
    setEmojiOpen(false);
  }
  function insert(member: ChatMember) {
    const next = insertMention(
      draft,
      mention!.index,
      draft.text.length,
      member.actor_id,
      member.display_name,
    );
    setBody(encodeMentions(next));
    const cursor =
      (next.mentions.find((item) => item.start === mention!.index)?.end ??
        mention!.index) + 1;
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(cursor, cursor);
    });
  }
  function insertContextual(value: "all" | "here") {
    if (!mention) return;
    const replacement = `@${value} `;
    setVisibleText(
      draft.text.slice(0, mention.index) + replacement,
      mention.index + replacement.length,
    );
  }
  if (readonly)
    return (
      <div className="composer composer--readonly">
        <Megaphone />
        <span>{t("channelReadOnly")}</span>
      </div>
    );
  return (
    <div className="composer-wrap" ref={composerRoot}>
      {reply && (
        <div className="reply-strip">
          <span>
            <strong>{t("reply")}</strong>
            {messagePlainText(reply.body).slice(0, 120)}
          </span>
          <IconButton label={t("cancel")} onClick={onCancelReply}>
            <X />
          </IconButton>
        </div>
      )}
      {composerFocused && mention && (
        <div className="mention-menu">
          <span className="mention-menu__label">{t("participants")}</span>
          {suggestions.map((member) => (
            <button
              type="button"
              key={member.actor_id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(member)}
            >
              <Avatar name={member.display_name} size="sm" />
              <span>
                {member.display_name}
                <small>@{member.handle}</small>
              </span>
            </button>
          ))}
          <span className="mention-menu__label">{t("contextMentions")}</span>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insertContextual("all")}
          >
            <Megaphone />
            <span>
              @all
              <small>{t("mentionAllHint")}</small>
            </span>
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insertContextual("here")}
          >
            <Megaphone />
            <span>
              @here
              <small>{t("mentionHereHint")}</small>
            </span>
          </button>
        </div>
      )}
      <div className="composer">
        {formatOpen && (
          <div className="composer__formatbar" aria-label={t("formatting")}>
            <button aria-label={t("bold")} onClick={() => wrap("**")}>
              <strong>B</strong>
            </button>
            <button aria-label={t("italic")} onClick={() => wrap("_")}>
              <em>I</em>
            </button>
            <button aria-label={t("underline")} onClick={() => wrap("++")}>
              <span className="format-underline">U</span>
            </button>
            <button aria-label={t("strike")} onClick={() => wrap("~~")}>
              <s>S</s>
            </button>
            <span className="composer__format-divider" />
            <button
              aria-label={t("link")}
              onClick={() => wrap("[", "](https://)", t("linkText"))}
            >
              <Link2 />
            </button>
            <span className="composer__format-divider" />
            <button
              aria-label={t("heading")}
              onClick={() => prefixLines("## ")}
            >
              H
            </button>
            <button
              aria-label={t("orderedList")}
              onClick={() => prefixLines("ordered")}
            >
              1.
            </button>
            <button
              aria-label={t("bulletList")}
              onClick={() => prefixLines("- ")}
            >
              •
            </button>
          </div>
        )}
        <textarea
          ref={input}
          rows={1}
          value={draft.text}
          onChange={(event) =>
            setBody(
              encodeMentions(updateMentionText(draft, event.target.value)),
            )
          }
          onFocus={() => setComposerFocused(true)}
          onBlur={() => {
            onBlur();
            requestAnimationFrame(() => {
              if (!composerRoot.current?.contains(document.activeElement))
                setComposerFocused(false);
            });
          }}
          onKeyDown={keys}
          placeholder={t("messagePlaceholder")}
          aria-label={t("messagePlaceholder")}
        />
        <div className="composer__toolbar">
          <div className="composer__tools">
            <IconButton label={t("attach")} disabled>
              <Paperclip />
            </IconButton>
            <IconButton
              label={t("emoji")}
              onClick={() => {
                setEmojiOpen((open) => !open);
                setSendSettings(false);
              }}
            >
              <Smile />
            </IconButton>
            <IconButton
              label={t("mention")}
              onClick={() => {
                setBody(`${draft.text}@`);
                requestAnimationFrame(() => input.current?.focus());
              }}
            >
              <AtSign />
            </IconButton>
            <button
              className={cx("composer__format", formatOpen && "active")}
              aria-label={t("formatting")}
              onClick={() => {
                setFormatOpen((open) => !open);
                setSendSettings(false);
              }}
            >
              Aa
            </button>
          </div>
          <div className="composer__send">
            <Button
              size="icon"
              variant="primary"
              aria-label={t("send")}
              onClick={onSend}
              disabled={!body.trim()}
            >
              <SendHorizontal />
            </Button>
            <IconButton
              label={t("sendSettings")}
              onClick={() => {
                setSendSettings((open) => !open);
                setEmojiOpen(false);
              }}
            >
              <ChevronDown />
            </IconButton>
          </div>
        </div>
        {emojiOpen && (
          <div className="composer-emoji" role="dialog" aria-label={t("emoji")}>
            <Suspense fallback={<Skeleton />}>
              <EmojiPicker
                width="100%"
                height={380}
                theme={
                  (document.documentElement.dataset.theme === "dark"
                    ? "dark"
                    : "light") as EmojiTheme
                }
                emojiStyle={"native" as EmojiStyle}
                lazyLoadEmojis
                searchPlaceholder={t("searchEmoji")}
                searchClearButtonLabel={t("clearSearch")}
                previewConfig={{ showPreview: false }}
                onEmojiClick={(emoji) => insertEmoji(emoji.emoji)}
              />
            </Suspense>
          </div>
        )}
        {sendSettings && (
          <div
            className="send-settings"
            role="dialog"
            aria-label={t("sendSettings")}
          >
            <strong>{t("sendSettings")}</strong>
            <button
              className={sendOnEnter ? "selected" : ""}
              onClick={() => {
                setSendOnEnter(true);
                localStorage.setItem("coma-send-on-enter", "true");
              }}
            >
              <i>{sendOnEnter && <Circle fill="currentColor" />}</i>
              <span>
                <b>{t("enterSends")}</b>
                <small>{t("shiftEnterNewLine")}</small>
              </span>
            </button>
            <button
              className={!sendOnEnter ? "selected" : ""}
              onClick={() => {
                setSendOnEnter(false);
                localStorage.setItem("coma-send-on-enter", "false");
              }}
            >
              <i>{!sendOnEnter && <Circle fill="currentColor" />}</i>
              <span>
                <b>{t("shiftEnterSends")}</b>
                <small>{t("enterNewLine")}</small>
              </span>
            </button>
            <div className="send-settings__divider" />
            <button disabled>
              <Clock3 />
              <span>
                <b>{t("scheduleMessage")}</b>
                <small>{t("comingLater")}</small>
              </span>
            </button>
          </div>
        )}
      </div>
      <span className="composer-hint">
        {sendOnEnter ? t("composerHint") : t("composerHintReverse")}
      </span>
    </div>
  );
}

function ChatIntro({
  chat,
  title,
  onAddMembers,
}: {
  chat: Chat;
  title: string;
  onAddMembers(): void;
}) {
  const { t } = useTranslation();
  return (
    <section className="chat-intro">
      <Avatar name={title} size="xl" />
      <h2>{title}</h2>
      <p>{chat.topic || t("chatBeginning")}</p>
      {chat.kind !== "direct" && (
        <Button onClick={onAddMembers}>
          <UserPlus />
          {t("addMembers")}
        </Button>
      )}
      <time>{formatLongDate(chat.created_at)}</time>
      <span className="chat-intro__created">{t("chatCreated")}</span>
    </section>
  );
}

function ThreadPanel({
  api,
  store,
  user,
  chat,
  members,
  coordinator,
  outbox,
  rootID,
  onClose,
}: {
  api: MessengerAPI;
  store: ReturnType<typeof createMessengerStore>;
  user: User;
  chat: Chat;
  members: ChatMember[];
  coordinator: RealtimeCoordinator;
  outbox: Outbox;
  rootID: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const storedMessages = useStore(
    store,
    (state) => state.messages[chat.id] ?? emptyMessages,
  );
  const presence = useStore(store, (state) => state.presence);
  const query = useQuery({
    queryKey: ["thread", rootID],
    queryFn: () => api.thread(rootID),
  });
  const [following, setFollowing] = useState(false);
  const [body, setBody] = useState(() => getLocalDraft(chat.id, rootID));
  const [reply, setReply] = useState<Message | null>(null);
  const messages = useMemo(() => {
    const values = [
      ...(query.data?.messages ?? []),
      ...storedMessages.filter(
        (message) => message.id === rootID || message.thread_root_id === rootID,
      ),
    ];
    return [
      ...new Map(values.map((message) => [message.id, message])).values(),
    ].sort((left, right) => left.created_seq - right.created_seq);
  }, [query.data?.messages, rootID, storedMessages]);
  const root = messages.find((message) => message.id === rootID);
  const replies = messages.filter(
    (message) => message.thread_root_id === rootID,
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      setLocalDraft(chat.id, rootID, body);
      void syncDraft(api, chat.id, rootID, body);
    }, 600);
    return () => clearTimeout(timer);
  }, [api, body, chat.id, rootID]);
  async function toggle() {
    if (following) await api.unfollowThread(rootID);
    else await api.followThread(rootID);
    setFollowing(!following);
  }
  async function send() {
    const content = body.trim();
    if (!content) return;
    setBody("");
    setReply(null);
    setLocalDraft(chat.id, rootID, "");
    coordinator.typing(chat.id, false, rootID);
    await outbox.enqueue(chat.id, {
      client_msg_id: crypto.randomUUID(),
      body: content,
      body_format: "markdown",
      reply_to_id: reply?.id,
      thread_root_id: rootID,
      mentioned_actor_ids: resolvedMentionActorIDs(content, members, presence),
    });
  }
  return (
    <aside className="thread-panel" aria-label={t("threadTitle")}>
      <header>
        <div>
          <strong>{t("threadTitle")}</strong>
          <span>{t("replyCount", { count: replies.length })}</span>
        </div>
        <div className="thread-panel__actions">
          <Button size="sm" onClick={() => void toggle()}>
            {following ? t("unfollow") : t("follow")}
          </Button>
          <IconButton label={t("close")} onClick={onClose}>
            <X />
          </IconButton>
        </div>
      </header>
      <div className="thread-panel__messages">
        {query.isLoading && <Skeleton />}
        {root && (
          <MessageRow
            api={api}
            message={root}
            chats={Object.values(store.getState().chats)}
            members={members}
            author={members.find((item) => item.actor_id === root.actor_id)}
            own={root.actor_id === user.id}
            grouped={false}
            onReply={() => setReply(root)}
            onJump={() => undefined}
            onRetry={() => void outbox.flush()}
            onThread={() => undefined}
            onChanged={() => void query.refetch()}
            domIDPrefix="thread-message"
          />
        )}
        {root && replies.length > 0 && (
          <div className="thread-panel__separator">
            {t("replyCount", { count: replies.length })}
          </div>
        )}
        {replies.map((message, index) => {
          const previous = replies[index - 1];
          return (
            <MessageRow
              key={message.id}
              api={api}
              message={message}
              chats={Object.values(store.getState().chats)}
              members={members}
              replyMessage={messages.find(
                (item) => item.id === message.reply_to_id,
              )}
              author={members.find(
                (item) => item.actor_id === message.actor_id,
              )}
              own={message.actor_id === user.id}
              grouped={
                previous?.actor_id === message.actor_id &&
                minuteGap(previous.created_at, message.created_at) < 5
              }
              onReply={() => setReply(message)}
              onJump={(id) =>
                document
                  .getElementById(`thread-message-${id}`)
                  ?.scrollIntoView({ block: "center" })
              }
              onRetry={() => void outbox.flush()}
              onThread={() => undefined}
              onChanged={() => void query.refetch()}
              domIDPrefix="thread-message"
            />
          );
        })}
      </div>
      <Composer
        members={members}
        body={body}
        setBody={(next) => {
          setBody(next);
          coordinator.typing(chat.id, Boolean(next), rootID);
        }}
        onBlur={() => void syncDraft(api, chat.id, rootID, body)}
        onSend={() => void send()}
        reply={reply}
        onCancelReply={() => setReply(null)}
        readonly={chat.kind === "channel" && chat.role === "member"}
      />
    </aside>
  );
}
function ThreadDirectory({
  api,
  navigate,
}: {
  api: MessengerAPI;
  navigate(value: string): void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["threads"],
    queryFn: () => api.threads(),
  });
  const threads = query.data?.threads ?? [];
  return (
    <div className="thread-directory">
      <p>{t("followedThreads")}</p>
      {query.isLoading ? (
        <Skeleton />
      ) : query.isError ? (
        <FormError message={t("errorNetwork")} />
      ) : threads.length ? (
        threads.map((item) => (
          <button
            key={item.root.id}
            onClick={() =>
              navigate(`/chat/${item.root.chat_id}/thread/${item.root.id}`)
            }
          >
            <Avatar name={item.root.body} />
            <span>
              <strong>{item.root.body.slice(0, 60)}</strong>
              <small>{t("replyCount", { count: item.reply_count })}</small>
            </span>
          </button>
        ))
      ) : (
        <Empty label={t("noThreads")} />
      )}
    </div>
  );
}

function CreateChatDialog({
  api,
  onClose,
  onCreated,
}: {
  api: MessengerAPI;
  onClose(): void;
  onCreated(chat: Chat): void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const actorsQuery = useQuery({
    queryKey: ["actors"],
    queryFn: () => api.actors(),
  });
  const actors = actorsQuery.data?.actors ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const kind = value(data, "kind") as "direct" | "group" | "channel";
    try {
      onCreated(
        await api.createChat({
          kind,
          visibility:
            kind === "direct"
              ? "private"
              : (value(data, "visibility") as "private" | "public"),
          name: value(data, "name"),
          topic: value(data, "topic"),
          member_ids: kind === "direct" ? selected.slice(0, 1) : selected,
        }),
      );
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  return (
    <Dialog title={t("newChat")} onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <SelectField label={t("kind")} name="kind">
          <option value="group">{t("group")}</option>
          <option value="direct">{t("direct")}</option>
          <option value="channel">{t("channel")}</option>
        </SelectField>
        <Field label={t("title")} name="name" required={false} />
        <TextareaField label={t("topic")} name="topic" />
        <div className="actor-picker">
          {actorsQuery.isLoading ? (
            <Skeleton />
          ) : actorsQuery.isError ? (
            <FormError message={t("errorNetwork")} />
          ) : (
            actors.map((actor) => (
              <label key={actor.actor_id}>
                <input
                  type="checkbox"
                  checked={selected.includes(actor.actor_id)}
                  onChange={(event) =>
                    setSelected((items) =>
                      event.target.checked
                        ? [...items, actor.actor_id]
                        : items.filter((id) => id !== actor.actor_id),
                    )
                  }
                />
                <Avatar name={actor.display_name} size="sm" />
                <span>
                  <strong>{actor.display_name}</strong>
                  <small>@{actor.handle}</small>
                </span>
              </label>
            ))
          )}
        </div>
        <SelectField label={t("visibility")} name="visibility">
          <option value="private">{t("private")}</option>
          <option value="public">{t("public")}</option>
        </SelectField>
        <FormError message={error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" variant="primary">
            {t("create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function SettingsDialog({
  api,
  user,
  onClose,
  onLogout,
  onNotify,
}: {
  api: MessengerAPI;
  user: User;
  onClose(): void;
  onLogout(): void;
  onNotify(): void;
}) {
  const { t, i18n } = useTranslation();
  const query = useQuery({
    queryKey: ["preferences"],
    queryFn: () => api.preferences(),
  });
  const [theme, setThemeValue] = useState<UserPreferences["theme"]>(
    (localStorage.getItem("coma-theme") as UserPreferences["theme"] | null) ??
      "system",
  );
  const [name, setName] = useState(user.display_name);
  const [handle, setHandle] = useState(user.handle);
  const [pushPreview, setPushPreview] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    setThemeValue(query.data.theme);
    setPushPreview(query.data.push_preview);
  }, [query.data]);
  async function save() {
    await Promise.all([
      api.updateMe({
        display_name: name,
        handle,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
      api.updatePreferences({
        theme,
        locale: i18n.language === "ru" ? "ru" : "en",
        push_enabled: query.data?.push_enabled ?? false,
        push_preview: pushPreview,
      }),
    ]);
    setTheme(theme);
    onClose();
  }
  return (
    <Dialog title={t("settings")} description={user.email} onClose={onClose}>
      <div className="settings-list">
        <label>
          <span>{t("name")}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          <span>{t("handle")}</span>
          <input
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
          />
        </label>
        <label>
          <span>
            <Sun />
            {t("theme")}
          </span>
          <select
            value={theme}
            onChange={(event) => {
              const next = event.target.value as UserPreferences["theme"];
              setThemeValue(next);
              setTheme(next);
            }}
          >
            <option value="system">{t("system")}</option>
            <option value="light">{t("light")}</option>
            <option value="dark">{t("dark")}</option>
          </select>
        </label>
        <label>
          <span>
            <Languages />
            {t("language")}
          </span>
          <select
            value={i18n.language}
            onChange={(event) => void setLocale(event.target.value)}
          >
            <option value="ru">{t("russian")}</option>
            <option value="en">{t("english")}</option>
            <option value="pseudo">{t("pseudoLocale")}</option>
          </select>
        </label>
        <label>
          <span>
            <Bell />
            {t("notificationPreview")}
          </span>
          <input
            type="checkbox"
            checked={pushPreview}
            onChange={(event) => setPushPreview(event.target.checked)}
          />
        </label>
        <button onClick={onNotify}>
          <Bell />
          {t("notificationEnable")}
        </button>
        <button onClick={() => void save()}>{t("save")}</button>
        <button className="danger" onClick={onLogout}>
          <LogOut />
          {t("logout")}
        </button>
      </div>
    </Dialog>
  );
}
function NotificationDialog({
  api,
  onClose,
}: {
  api: MessengerAPI;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const supported =
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window;
  const [state, setState] = useState<NotificationPermission>(
    supported ? Notification.permission : "denied",
  );
  const [error, setError] = useState(
    supported ? "" : t("notificationUnavailable"),
  );
  async function enable() {
    try {
      const config = await api.pushConfig();
      if (!config.enabled) throw new Error(t("notificationUnavailable"));
      const registration = await navigator.serviceWorker.register("/sw.js");
      const result = await Notification.requestPermission();
      setState(result);
      if (result !== "granted") return;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64Key(config.public_key),
      });
      const json = subscription.toJSON();
      await api.registerPush({
        endpoint: subscription.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
      });
      const preferences = await api.preferences();
      await api.updatePreferences({ ...preferences, push_enabled: true });
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  return (
    <Dialog
      title={t("notificationEnable")}
      description={t("notifyPrompt")}
      onClose={onClose}
    >
      <div className="notification-card">
        <Bell size={32} />
        {state === "denied" && supported && <p>{t("notificationDenied")}</p>}
        <FormError message={error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{t("skip")}</Button>
          <Button
            variant="primary"
            onClick={() => void enable()}
            disabled={!supported || state === "denied"}
          >
            {t("notifyAction")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
function ChatInfoDialog({
  api,
  chat,
  members,
  onClose,
}: {
  api: MessengerAPI;
  chat: Chat;
  members: ChatMember[];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(chat.name ?? chat.display_name);
  const [topic, setTopic] = useState(chat.topic);
  const [notifyLevel, setNotifyLevel] = useState<"all" | "mentions" | "none">(
    "all",
  );
  const notificationQuery = useQuery({
    queryKey: ["chat-notifications", chat.id],
    queryFn: () => api.chatNotifications(chat.id),
  });
  useEffect(() => {
    if (notificationQuery.data)
      setNotifyLevel(notificationQuery.data.notify_level);
  }, [notificationQuery.data]);
  const manageable = chat.kind !== "direct" && chat.role !== "member";
  async function save() {
    await Promise.all([
      manageable ? api.updateChat(chat.id, { name, topic }) : Promise.resolve(),
      api.updateChatNotifications(chat.id, {
        notify_level: notifyLevel,
        muted_until: null,
      }),
    ]);
    onClose();
  }
  return (
    <Dialog
      title={t("members")}
      description={chat.display_name}
      onClose={onClose}
    >
      <div className="dialog-form">
        {manageable && (
          <>
            <Field
              label={t("title")}
              name="chat_name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <TextareaField
              label={t("topic")}
              name="chat_topic"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
            />
          </>
        )}
        <SelectField
          label={t("notificationLevel")}
          name="notification_level"
          value={notifyLevel}
          onChange={(event) =>
            setNotifyLevel(event.target.value as "all" | "mentions" | "none")
          }
        >
          <option value="all">{t("allMessages")}</option>
          <option value="mentions">{t("mentionsOnly")}</option>
          <option value="none">{t("notificationsOff")}</option>
        </SelectField>
        <div className="member-list">
          {members.map((member) => (
            <div key={member.actor_id}>
              <Avatar name={member.display_name} size="sm" />
              <span>
                <strong>{member.display_name}</strong>
                <small>
                  @{member.handle} · {member.role}
                </small>
              </span>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button variant="primary" onClick={() => void save()}>
            {t("save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function PinnedDialog({
  api,
  chatID,
  onClose,
  onOpen,
}: {
  api: MessengerAPI;
  chatID: string;
  onClose(): void;
  onOpen(messageID: string): void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["pins", chatID],
    queryFn: () => api.pins(chatID),
  });
  return (
    <Dialog title={t("saved")} onClose={onClose}>
      <div className="forward-picker">
        {query.isLoading ? (
          <Skeleton />
        ) : query.isError ? (
          <FormError message={t("errorNetwork")} />
        ) : query.data?.length ? (
          query.data.map((pin) => (
            <button key={pin.message_id} onClick={() => onOpen(pin.message_id)}>
              <Bookmark size={17} />
              <span>{pin.message_id.slice(0, 8)}</span>
            </button>
          ))
        ) : (
          <Empty label={t("noPins")} />
        )}
      </div>
    </Dialog>
  );
}

function Welcome() {
  const { t } = useTranslation();
  return (
    <section className="welcome">
      <Logo size="medium" />
      <h2>{t("selectChat")}</h2>
      <p>{t("selectChatHint")}</p>
    </section>
  );
}
function ComponentCatalog() {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState(false);
  return (
    <main className="component-catalog">
      <h1>Coma UI</h1>
      <section>
        <h2>Actions</h2>
        <Button variant="primary">Primary</Button>
        <Button>Secondary</Button>
        <Button variant="danger">Danger</Button>
        <Tooltip text="Helpful context">
          <Button>Tooltip</Button>
        </Tooltip>
        <Button onClick={() => setDialog(true)}>Dialog</Button>
      </section>
      <section>
        <h2>Identity</h2>
        <Avatar name={t("sampleName")} size="lg" online />
        <Badge tone="primary">99+</Badge>
      </section>
      <section>
        <h2>Form</h2>
        <Field
          label="Text field"
          name="catalog"
          placeholder="Long localized content"
        />
        <TextareaField label="Message" name="message" />
      </section>
      <section>
        <h2>States</h2>
        <Skeleton />
        <FormError message="Example error state" />
        <Toast tone="success">Saved successfully</Toast>
        <Popover>Popover content can wrap across lines.</Popover>
        <UIMenu label="Example menu">
          <button role="menuitem">Menu item</button>
        </UIMenu>
      </section>
      {dialog && (
        <Dialog title="Example dialog" onClose={() => setDialog(false)}>
          <Button onClick={() => setDialog(false)}>Close</Button>
        </Dialog>
      )}
    </main>
  );
}
function Empty({ label }: { label: string }) {
  return (
    <div className="empty">
      <MessagesSquare />
      <span>{label}</span>
    </div>
  );
}
function Logo({ size }: { size: "small" | "medium" | "large" }) {
  return (
    <div className={cx("brand-logo", `brand-logo--${size}`)}>
      <img src={comaLogo} alt="" />
      <span>Coma</span>
    </div>
  );
}
async function loadMessages(
  api: MessengerAPI,
  store: ReturnType<typeof createMessengerStore>,
  chatID: string,
) {
  const page = await api.messages(chatID, { limit: 50 });
  store.getState().replaceMessages(chatID, page.messages);
}
function titleOf(chat?: Chat, members: ChatMember[] = [], ownID = "") {
  if (!chat) return "Coma";
  return (
    chat.display_name ||
    chat.name ||
    members.find((item) => item.actor_id !== ownID)?.display_name ||
    i18n.t("directChat")
  );
}
function value(data: FormData, name: string) {
  return String(data.get(name) ?? "").trim();
}
function messageOf(cause: unknown) {
  if (cause instanceof APIError) {
    if (cause.status === 401) return i18n.t("errorUnauthorized");
    if (cause.status === 403) return i18n.t("errorForbidden");
    if (cause.status === 409) return i18n.t("errorConflict");
    if (cause.status === 422) return i18n.t("errorValidation");
    return i18n.t("error");
  }
  return cause instanceof Error ? cause.message : i18n.t("errorNetwork");
}
function formatTime(value: string) {
  return new Intl.DateTimeFormat(activeLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function formatDay(value: string) {
  return new Intl.DateTimeFormat(activeLocale(), {
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}
function formatLongDate(value: string) {
  return new Intl.DateTimeFormat(activeLocale(), { dateStyle: "long" }).format(
    new Date(value),
  );
}
function resolvedMentionActorIDs(
  source: string,
  members: ChatMember[],
  presence: Record<string, "online" | "away" | "offline">,
) {
  const ids = new Set(mentionedActorIDs(source));
  const text = decodeMentions(source).text;
  if (/(^|\s)@all\b/i.test(text))
    members.forEach((member) => ids.add(member.actor_id));
  if (/(^|\s)@here\b/i.test(text))
    members
      .filter((member) => presence[member.actor_id] === "online")
      .forEach((member) => ids.add(member.actor_id));
  return [...ids];
}
function activeLocale() {
  return i18n.language === "pseudo" ? "en" : i18n.language;
}
function minuteGap(a: string, b: string) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
}
function draftKey(chatID: string, threadID: string | null) {
  return `coma-draft:${chatID}:${threadID ?? "main"}`;
}
function getLocalDraft(chatID: string, threadID: string | null) {
  return localStorage.getItem(draftKey(chatID, threadID)) ?? "";
}
function setLocalDraft(chatID: string, threadID: string | null, body: string) {
  if (body) localStorage.setItem(draftKey(chatID, threadID), body);
  else localStorage.removeItem(draftKey(chatID, threadID));
}
function draftVersionKey(chatID: string, threadID: string | null) {
  return `coma-draft-version:${chatID}:${threadID ?? "main"}`;
}
function hydrateDrafts(drafts: Draft[]) {
  for (const draft of drafts) {
    const threadID = draft.thread_root_id ?? null;
    setLocalDraft(draft.chat_id, threadID, draft.body);
    localStorage.setItem(
      draftVersionKey(draft.chat_id, threadID),
      String(draft.version),
    );
  }
}
async function syncDraft(
  api: MessengerAPI,
  chatID: string,
  threadID: string | null,
  body: string,
) {
  setLocalDraft(chatID, threadID, body);
  if (!body) {
    await api.deleteDraft(chatID, threadID ?? undefined).catch(() => undefined);
    localStorage.removeItem(draftVersionKey(chatID, threadID));
    return;
  }
  let version = Number(
    localStorage.getItem(draftVersionKey(chatID, threadID)) ?? 0,
  );
  try {
    const saved = await api.putDraft(
      chatID,
      body,
      version,
      threadID ?? undefined,
    );
    localStorage.setItem(
      draftVersionKey(chatID, threadID),
      String(saved.version),
    );
  } catch (cause) {
    if (!(cause instanceof APIError) || cause.status !== 409) return;
    try {
      const current = (await api.drafts()).find(
        (item) =>
          item.chat_id === chatID && (item.thread_root_id ?? null) === threadID,
      );
      version = current?.version ?? 0;
      const saved = await api.putDraft(
        chatID,
        body,
        version,
        threadID ?? undefined,
      );
      localStorage.setItem(
        draftVersionKey(chatID, threadID),
        String(saved.version),
      );
    } catch {
      // Local draft remains authoritative until the next reconnect/blur retry.
    }
  }
}
function setTheme(value: string) {
  localStorage.setItem("coma-theme", value);
  document.documentElement.dataset.theme =
    value === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : value;
}
function useTheme() {
  useEffect(() => {
    setTheme(localStorage.getItem("coma-theme") ?? "light");
  }, []);
}
function base64Key(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}
function chatFilterFromURL(): "all" | "direct" | "grouped" {
  const value = new URLSearchParams(window.location.search).get("filter");
  return value === "direct" || value === "grouped" ? value : "all";
}
