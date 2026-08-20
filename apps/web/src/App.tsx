import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { EmojiStyle, Theme as EmojiTheme } from "emoji-picker-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  AtSign,
  Bell,
  BellOff,
  BookOpen,
  Bookmark,
  Bot,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Camera,
  Car,
  Cat,
  ChartNoAxesCombined,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  Circle,
  Clock3,
  Cloud,
  Code2,
  Coffee,
  Copy,
  CornerUpLeft,
  Forward,
  Folder,
  FolderPlus,
  Flower2,
  Flame,
  Gamepad2,
  Gift,
  Globe2,
  GraduationCap,
  Hash,
  Heart,
  Home,
  Image,
  Inbox,
  Info,
  Link2,
  Languages,
  Leaf,
  Lightbulb,
  LogOut,
  Map as MapIcon,
  Menu,
  Megaphone,
  MessageCircle,
  MessageSquareReply,
  MessagesSquare,
  Moon,
  Mountain,
  Music,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  PartyPopper,
  Plane,
  Search,
  ShoppingBag,
  SendHorizontal,
  Settings,
  Smile,
  SmilePlus,
  Star,
  Sun,
  Target,
  Terminal,
  Trophy,
  Trash2,
  Umbrella,
  UserRound,
  UserPlus,
  Users,
  VolumeX,
  Wallet,
  Waves,
  X,
  Zap,
  Rocket,
  Dumbbell,
  Database,
  HardDrive,
  History,
  KeyRound,
  Mail,
  MonitorSmartphone,
  Paintbrush,
  RefreshCw,
  Server,
  ShieldCheck,
  Upload,
  ExternalLink,
  Dog,
  type LucideIcon,
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
  type ChatFolder,
  type ChatMember,
  type ClientMessage,
  type Draft,
  type Message,
  type Reaction,
  type MessageReceipt,
  type InfrastructureSettings,
  type OrganizationSettings,
  type OrganizationMember,
  type PublicBranding,
  type Session,
  type TokenResponse,
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
  RadioOption,
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
import { BrowserSessionCoordinator } from "./session";

const EmojiPicker = lazy(() => import("emoji-picker-react"));

type Screen = "loading" | "bootstrap" | "login" | "messenger" | "invite";
type SystemChatFilter = "all" | "direct" | "grouped" | "channel";
type ChatFilter = SystemChatFilter | `folder:${string}`;
type OverlayPlacement = {
  side: "above" | "below";
  top?: number;
  bottom?: number;
  right: number;
  maxHeight: number;
};

const folderIconOptions: Array<{
  id: ChatFolder["icon"];
  icon: LucideIcon;
  labelKey: string;
  terms: string;
}> = [
  {
    id: "folder",
    icon: Folder,
    labelKey: "folderIconFolder",
    terms: "folder directory",
  },
  {
    id: "briefcase",
    icon: BriefcaseBusiness,
    labelKey: "folderIconWork",
    terms: "work office briefcase",
  },
  {
    id: "heart",
    icon: Heart,
    labelKey: "folderIconHeart",
    terms: "heart love favorite",
  },
  {
    id: "star",
    icon: Star,
    labelKey: "folderIconStar",
    terms: "star important favorite",
  },
  {
    id: "users",
    icon: Users,
    labelKey: "folderIconPeople",
    terms: "users people team family group",
  },
  {
    id: "hash",
    icon: Hash,
    labelKey: "folderIconChannel",
    terms: "hash channel topic",
  },
  {
    id: "bookmark",
    icon: Bookmark,
    labelKey: "folderIconBookmark",
    terms: "bookmark save",
  },
  { id: "home", icon: Home, labelKey: "folderIconHome", terms: "home family" },
  {
    id: "rocket",
    icon: Rocket,
    labelKey: "folderIconRocket",
    terms: "rocket launch startup",
  },
  { id: "zap", icon: Zap, labelKey: "folderIconZap", terms: "zap fast energy" },
  {
    id: "flame",
    icon: Flame,
    labelKey: "folderIconFlame",
    terms: "flame hot urgent",
  },
  { id: "sun", icon: Sun, labelKey: "folderIconSun", terms: "sun day" },
  { id: "moon", icon: Moon, labelKey: "folderIconMoon", terms: "moon night" },
  {
    id: "cloud",
    icon: Cloud,
    labelKey: "folderIconCloud",
    terms: "cloud infrastructure",
  },
  {
    id: "umbrella",
    icon: Umbrella,
    labelKey: "folderIconUmbrella",
    terms: "umbrella vacation rest",
  },
  {
    id: "coffee",
    icon: Coffee,
    labelKey: "folderIconCoffee",
    terms: "coffee break",
  },
  {
    id: "music",
    icon: Music,
    labelKey: "folderIconMusic",
    terms: "music audio",
  },
  {
    id: "camera",
    icon: Camera,
    labelKey: "folderIconCamera",
    terms: "camera photo",
  },
  {
    id: "image",
    icon: Image,
    labelKey: "folderIconImage",
    terms: "image design photo",
  },
  {
    id: "gamepad",
    icon: Gamepad2,
    labelKey: "folderIconGamepad",
    terms: "game play",
  },
  {
    id: "dumbbell",
    icon: Dumbbell,
    labelKey: "folderIconSport",
    terms: "sport fitness gym",
  },
  {
    id: "trophy",
    icon: Trophy,
    labelKey: "folderIconTrophy",
    terms: "trophy win achievement",
  },
  {
    id: "target",
    icon: Target,
    labelKey: "folderIconTarget",
    terms: "target goal plan",
  },
  { id: "gift", icon: Gift, labelKey: "folderIconGift", terms: "gift holiday" },
  {
    id: "shopping-bag",
    icon: ShoppingBag,
    labelKey: "folderIconShopping",
    terms: "shopping store",
  },
  {
    id: "wallet",
    icon: Wallet,
    labelKey: "folderIconWallet",
    terms: "wallet finance money",
  },
  {
    id: "plane",
    icon: Plane,
    labelKey: "folderIconTravel",
    terms: "plane travel vacation",
  },
  { id: "car", icon: Car, labelKey: "folderIconCar", terms: "car auto" },
  {
    id: "map",
    icon: MapIcon,
    labelKey: "folderIconMap",
    terms: "map place geography",
  },
  {
    id: "globe",
    icon: Globe2,
    labelKey: "folderIconGlobe",
    terms: "globe world internet international",
  },
  {
    id: "book",
    icon: BookOpen,
    labelKey: "folderIconBook",
    terms: "book knowledge read",
  },
  {
    id: "graduation",
    icon: GraduationCap,
    labelKey: "folderIconEducation",
    terms: "education university study",
  },
  {
    id: "code",
    icon: Code2,
    labelKey: "folderIconCode",
    terms: "code development engineering",
  },
  {
    id: "terminal",
    icon: Terminal,
    labelKey: "folderIconTerminal",
    terms: "terminal console devops",
  },
  {
    id: "database",
    icon: Database,
    labelKey: "folderIconDatabase",
    terms: "database data sql",
  },
  {
    id: "chart",
    icon: ChartNoAxesCombined,
    labelKey: "folderIconAnalytics",
    terms: "chart analytics metrics",
  },
  {
    id: "calendar",
    icon: CalendarDays,
    labelKey: "folderIconCalendar",
    terms: "calendar meeting date",
  },
  {
    id: "clock",
    icon: Clock3,
    labelKey: "folderIconClock",
    terms: "clock time deadline",
  },
  {
    id: "check",
    icon: CheckCircle2,
    labelKey: "folderIconTasks",
    terms: "check task done todo",
  },
  {
    id: "lightbulb",
    icon: Lightbulb,
    labelKey: "folderIconIdeas",
    terms: "idea lightbulb",
  },
  {
    id: "palette",
    icon: Palette,
    labelKey: "folderIconDesign",
    terms: "palette design creative",
  },
  {
    id: "smile",
    icon: Smile,
    labelKey: "folderIconSocial",
    terms: "smile social chat",
  },
  { id: "bot", icon: Bot, labelKey: "folderIconBots", terms: "bot agent ai" },
  { id: "cat", icon: Cat, labelKey: "folderIconCats", terms: "cat pet" },
  { id: "dog", icon: Dog, labelKey: "folderIconDogs", terms: "dog pet" },
  {
    id: "leaf",
    icon: Leaf,
    labelKey: "folderIconNature",
    terms: "leaf nature ecology",
  },
  {
    id: "flower",
    icon: Flower2,
    labelKey: "folderIconFlowers",
    terms: "flower garden",
  },
  {
    id: "mountain",
    icon: Mountain,
    labelKey: "folderIconMountain",
    terms: "mountain hiking",
  },
  {
    id: "waves",
    icon: Waves,
    labelKey: "folderIconSea",
    terms: "waves sea water",
  },
  {
    id: "party",
    icon: PartyPopper,
    labelKey: "folderIconParty",
    terms: "party holiday",
  },
];
const folderColors: ChatFolder["color"][] = [
  "blue",
  "violet",
  "pink",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "cyan",
  "slate",
];
const apiURL = import.meta.env.VITE_API_URL ?? window.location.origin;
const emptyMessages: ClientMessage[] = [];
const emptyActorIDs: string[] = [];

function useDismissable(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  secondaryRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    function pointer(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !ref.current?.contains(target) &&
        !secondaryRef?.current?.contains(target)
      )
        onClose();
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
  }, [onClose, open, ref, secondaryRef]);
}

function placeMessageOverlay(
  anchor: HTMLElement | null,
  desiredHeight: number,
  width: number,
): OverlayPlacement {
  const bounds = anchor?.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const edge = 8;
  const gap = 4;
  if (!bounds)
    return {
      side: "below",
      top: edge,
      right: edge,
      maxHeight: Math.max(160, Math.min(desiredHeight, viewportHeight - 16)),
    };
  const above = Math.max(0, bounds.top - edge - gap);
  const below = Math.max(0, viewportHeight - bounds.bottom - edge - gap);
  const side = below >= desiredHeight ? "below" : "above";
  const available = side === "below" ? below : above;
  const right = Math.max(
    edge,
    Math.min(viewportWidth - width - edge, viewportWidth - bounds.right),
  );
  return {
    side,
    ...(side === "below"
      ? { top: Math.min(bounds.bottom + gap, viewportHeight - edge) }
      : {
          bottom: Math.min(
            viewportHeight - bounds.top + gap,
            viewportHeight - edge,
          ),
        }),
    right,
    maxHeight: Math.max(120, Math.min(desiredHeight, available)),
  };
}

export function App() {
  const { t } = useTranslation();
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
  useTheme();

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void api
        .branding()
        .then((branding) => {
          if (active) applyPublicBranding(branding, api.apiURL);
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
              search: { filter: "all", folder: undefined },
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

  const authenticated = async (session: TokenResponse) => {
    sessions.publishTokens(session);
    if (path === "/" || path.startsWith("/invite/"))
      await navigate({
        to: "/chats",
        search: { filter: "all", folder: undefined },
        replace: true,
      });
  };
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
      navigate={navigateTo}
      onLogout={logout}
      onUserUpdated={setUser}
    />
  );
}

type AuthProps = {
  api: MessengerAPI;
  error: string;
  onError(value: string): void;
  onAuthenticated(session: TokenResponse): void;
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
        await api.login({
          email: value(data, "email"),
          password: value(data, "password"),
        }),
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
        await api.bootstrap(input, value(data, "bootstrap_token")),
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
      onAuthenticated(await api.acceptInvitation(token, input));
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
  onUserUpdated,
}: {
  api: MessengerAPI;
  user: User;
  path: string;
  navigate(to: string): void;
  onLogout(): void;
  onUserUpdated(user: User): void;
}) {
  const { t } = useTranslation();
  const store = useMemo(() => createMessengerStore(), []);
  const chatMap = useStore(store, (state) => state.chats);
  const chats = useMemo(() => Object.values(chatMap), [chatMap]);
  const unread = useStore(store, (state) => state.unread);
  const realtime = useStore(store, (state) => state.realtime);
  const [filter, setFilter] = useState<ChatFilter>(chatFilterFromURL);
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [pinnedChatIDs, setPinnedChatIDs] = useState<string[]>([]);
  const [chatSearch, setChatSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("coma-sidebar-collapsed") === "true",
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const workspaceMenuRoot = useRef<HTMLDivElement>(null);
  const reloadTimer = useRef<number | null>(null);
  const [chatLoading, setChatLoading] = useState(true);
  const [chatError, setChatError] = useState("");
  const [modal, setModal] = useState<
    "new" | "folder" | "notify" | "pinned" | null
  >(null);
  const selectedID = /^\/chat\/([^/]+)/.exec(path)?.[1] ?? null;
  const threadID = /\/thread\/([^/]+)/.exec(path)?.[1] ?? null;
  const showThreads = path === "/threads";
  const showImportant = path === "/important";
  const showMembers = path === "/members";
  const showMore = path === "/more";
  const showProfileSettings = path === "/settings/profile";
  const showWorkspaceSettings = path === "/settings/workspace";
  const showCustomizationSettings = path === "/settings/customization";
  const showInfrastructureSettings = path === "/settings/infrastructure";
  const showSecuritySettings = path === "/settings/security";
  const showAuditSettings = path === "/settings/audit";
  const showAnySettings =
    showProfileSettings ||
    showWorkspaceSettings ||
    showCustomizationSettings ||
    showInfrastructureSettings ||
    showSecuritySettings ||
    showAuditSettings;
  const showChatList = Boolean(selectedID) || path === "/chats";
  useDismissable(workspaceMenuRoot, workspaceMenu, () =>
    setWorkspaceMenu(false),
  );
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
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      void reload();
    }, 120);
  }, [reload]);
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
                event.type.startsWith("member.") ||
                event.type.startsWith("message."))
            )
              scheduleReload();
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
    [api, onLogout, scheduleReload, store],
  );
  const outbox = useMemo(
    () =>
      new Outbox(api, outboxStorage, {
        optimistic: store.getState().optimistic,
        delivered: (message) => {
          store.getState().reconcile(message);
          scheduleReload();
        },
        retrying: store.getState().retrying,
        failed: store.getState().failed,
      }),
    [api, scheduleReload, store],
  );

  useEffect(() => {
    void reload();
    void api.drafts().then((drafts) => hydrateDrafts(drafts));
    void api
      .preferences()
      .then((preferences) => {
        setTheme(preferences.theme);
        setFolders(preferences.chat_folders);
        setPinnedChatIDs(preferences.pinned_chat_ids);
        void setLocale(preferences.locale);
      })
      .catch(() => undefined);
    coordinator.start();
    void outbox.flush();
    return () => {
      coordinator.stop();
      if (reloadTimer.current !== null)
        window.clearTimeout(reloadTimer.current);
    };
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

  const activeFolder = filter.startsWith("folder:")
    ? folders.find((folder) => `folder:${folder.id}` === filter)
    : undefined;
  const normalizedChatSearch = chatSearch.trim().toLocaleLowerCase();
  const pinnedOrder = new Map(
    pinnedChatIDs.map((chatID, index) => [chatID, index]),
  );
  const filtered = chats
    .filter((chat) => {
      const inFilter =
        filter === "all"
          ? true
          : filter === "direct"
            ? chat.kind === "direct"
            : filter === "grouped"
              ? chat.kind === "group"
              : filter === "channel"
                ? chat.kind === "channel"
                : (activeFolder?.chat_ids.includes(chat.id) ?? false);
      if (!inFilter || !normalizedChatSearch) return inFilter;
      return `${titleOf(chat, [], user.id)} ${chat.last_message?.body ?? ""}`
        .toLocaleLowerCase()
        .includes(normalizedChatSearch);
    })
    .sort((left, right) => {
      const leftPin = pinnedOrder.get(left.id);
      const rightPin = pinnedOrder.get(right.id);
      if (leftPin !== undefined && rightPin !== undefined)
        return leftPin - rightPin;
      if (leftPin !== undefined) return -1;
      if (rightPin !== undefined) return 1;
      return 0;
    });
  async function logout() {
    await api.logout();
    onLogout();
  }
  function selectFilter(next: ChatFilter) {
    setFilter(next);
    const url = new URL(window.location.href);
    url.searchParams.delete("folder");
    if (next.startsWith("folder:")) {
      url.searchParams.delete("filter");
      url.searchParams.set("folder", next.slice("folder:".length));
    } else if (next === "all") url.searchParams.delete("filter");
    else url.searchParams.set("filter", next);
    window.history.replaceState(window.history.state, "", url);
  }
  async function saveFolders(next: ChatFolder[]) {
    const preferences = await api.preferences();
    const updated = await api.updatePreferences({
      ...preferences,
      chat_folders: next,
    });
    setFolders(updated.chat_folders);
  }
  async function savePinnedChats(next: string[]) {
    const preferences = await api.preferences();
    const updated = await api.updatePreferences({
      ...preferences,
      pinned_chat_ids: next,
    });
    setPinnedChatIDs(updated.pinned_chat_ids);
  }
  async function togglePinnedChat(chatID: string) {
    if (pinnedChatIDs.includes(chatID)) {
      await savePinnedChats(pinnedChatIDs.filter((id) => id !== chatID));
      return;
    }
    if (pinnedChatIDs.length >= 10) {
      setChatError(t("pinLimit"));
      return;
    }
    await savePinnedChats([...pinnedChatIDs, chatID]);
  }
  function toggleSidebar() {
    setSidebarCollapsed((collapsed) => {
      localStorage.setItem("coma-sidebar-collapsed", String(!collapsed));
      return !collapsed;
    });
  }
  async function toggleChatFolder(folderID: string, chatID: string) {
    await saveFolders(
      folders.map((folder) =>
        folder.id !== folderID
          ? folder
          : {
              ...folder,
              chat_ids: folder.chat_ids.includes(chatID)
                ? folder.chat_ids.filter((id) => id !== chatID)
                : [...folder.chat_ids, chatID],
            },
      ),
    );
  }
  return (
    <div
      className={cx(
        "messenger",
        sidebarCollapsed && "messenger--sidebar-collapsed",
        !showChatList && "messenger--utility",
        selectedID && "messenger--chat-open",
        threadID && "messenger--thread-open",
      )}
    >
      <aside className="global-sidebar" aria-label={t("primaryNavigation")}>
        <div className="workspace-menu-root" ref={workspaceMenuRoot}>
          <button
            className="workspace-switcher"
            aria-expanded={workspaceMenu}
            onClick={() => {
              if (sidebarCollapsed) {
                localStorage.setItem("coma-sidebar-collapsed", "false");
                setSidebarCollapsed(false);
              }
              setWorkspaceMenu((open) => !open);
            }}
          >
            <Logo size="small" />
            <strong title={user.organization_name}>
              {user.organization_name}
            </strong>
            <ChevronDown />
          </button>
          {workspaceMenu && (
            <div className="workspace-menu" role="menu">
              <span>{user.email}</span>
              <div className="workspace-menu__current">
                <Building2 />
                <strong>{user.organization_name}</strong>
                <Check />
              </div>
              {user.role !== "member" && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setWorkspaceMenu(false);
                    navigate("/settings/workspace");
                  }}
                >
                  <Settings />
                  <span>{t("workspaceSettings")}</span>
                </button>
              )}
              <button role="menuitem" onClick={() => void logout()}>
                <LogOut />
                <span>{t("logout")}</span>
              </button>
            </div>
          )}
        </div>
        <div className="search-actions">
          <button className="search-field" onClick={() => setSearchOpen(true)}>
            <Search size={16} />
            <span>{t("search")}</span>
          </button>
          <IconButton
            className="new-chat-action"
            label={t("newChat")}
            onClick={() => setModal("new")}
          >
            <Plus />
          </IconButton>
        </div>
        <nav className="sidebar-nav" aria-label={t("primaryNavigation")}>
          <button
            className={showChatList ? "active" : ""}
            onClick={() => navigate("/chats")}
          >
            <MessageCircle />
            <span>{t("chats")}</span>
          </button>
          <button
            className={showThreads ? "active" : ""}
            onClick={() => navigate("/threads")}
          >
            <Inbox />
            <span>{t("threads")}</span>
          </button>
          <button
            className={showImportant ? "active" : ""}
            onClick={() => navigate("/important")}
          >
            <Star />
            <span>{t("important")}</span>
          </button>
          <button
            className={showMembers ? "active" : ""}
            onClick={() => navigate("/members")}
          >
            <Users />
            <span>{t("members")}</span>
          </button>
        </nav>
        <IconButton
          className="sidebar-collapse"
          label={sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar")}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </IconButton>
        <footer className="sidebar-profile">
          <Avatar name={user.display_name} size="sm" online />
          <button onClick={() => navigate("/settings/profile")}>
            <strong>{user.display_name}</strong>
            <span>@{user.handle}</span>
          </button>
          <IconButton
            label={t("notifications")}
            onClick={() => setModal("notify")}
          >
            <Bell />
          </IconButton>
        </footer>
      </aside>
      {showChatList && (
        <aside className="chat-list-pane" aria-label={t("chatNavigation")}>
          <header className="chat-list-head">
            <div className="chat-list-head__workspace">
              <Logo size="small" />
              <strong>{user.organization_name}</strong>
            </div>
            <div>
              <h1>{t("chats")}</h1>
              <span>{t("chatCount", { count: chats.length })}</span>
            </div>
            <IconButton label={t("newChat")} onClick={() => setModal("new")}>
              <Plus />
            </IconButton>
          </header>
          <label className="chat-list-search">
            <Search />
            <input
              type="search"
              value={chatSearch}
              onChange={(event) => setChatSearch(event.currentTarget.value)}
              placeholder={t("searchChats")}
              aria-label={t("searchChats")}
            />
          </label>
          <div className="filter-chips" role="group" aria-label={t("chats")}>
            {(["all", "direct", "grouped", "channel"] as const).map((item) => (
              <button
                key={item}
                className={filter === item ? "active" : ""}
                onClick={() => selectFilter(item)}
              >
                {t(item)}
              </button>
            ))}
            {folders.map((folder) => (
              <button
                key={folder.id}
                className={filter === `folder:${folder.id}` ? "active" : ""}
                data-folder-color={folder.color}
                onClick={() => selectFilter(`folder:${folder.id}`)}
              >
                <FolderGlyph icon={folder.icon} />
                {folder.name}
              </button>
            ))}
            <button
              className="filter-chips__add"
              aria-label={t("newFolder")}
              onClick={() => setModal("folder")}
            >
              <FolderPlus />
            </button>
          </div>
          <div className="chat-list">
            {chatError && <FormError message={chatError} />}
            {chatLoading ? (
              <Skeleton />
            ) : filtered.length ? (
              <div className="chat-stream">
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
                    folders={folders}
                    pinned={pinnedChatIDs.includes(chat.id)}
                    canPin={
                      pinnedChatIDs.includes(chat.id) ||
                      pinnedChatIDs.length < 10
                    }
                    onToggleFolder={(folderID) =>
                      void toggleChatFolder(folderID, chat.id)
                    }
                    onTogglePin={() => void togglePinnedChat(chat.id)}
                    onMarkRead={() =>
                      void api
                        .markRead(chat.id, chat.last_activity_seq)
                        .then(reload)
                    }
                    onNotificationChanged={() => void reload()}
                    onLeave={() =>
                      void api.removeMember(chat.id, user.id).then(async () => {
                        await reload();
                        if (selectedID === chat.id) navigate("/chats");
                      })
                    }
                    onClick={() => navigate(`/chat/${chat.id}`)}
                  />
                ))}
              </div>
            ) : (
              <Empty label={t("emptyChats")} />
            )}
          </div>
        </aside>
      )}
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
            onSummaryChanged={scheduleReload}
          />
        ) : showThreads ? (
          <ThreadDirectory
            api={api}
            navigate={navigate}
            onBack={() => navigate("/chats")}
          />
        ) : showImportant ? (
          <ImportantDirectory
            api={api}
            chats={chats}
            navigate={navigate}
            onBack={() => navigate("/chats")}
          />
        ) : showMembers ? (
          <MembersDirectory api={api} onBack={() => navigate("/chats")} />
        ) : showMore ? (
          <MobileMorePage
            user={user}
            navigate={navigate}
            onLogout={() => void logout()}
            onNotify={() => setModal("notify")}
          />
        ) : showProfileSettings ? (
          <ProfileSettingsPage
            api={api}
            user={user}
            navigate={navigate}
            onLogout={() => void logout()}
            onNotify={() => setModal("notify")}
            onUserUpdated={onUserUpdated}
          />
        ) : showWorkspaceSettings ? (
          <WorkspaceSettingsPage api={api} user={user} navigate={navigate} />
        ) : showCustomizationSettings ? (
          <CustomizationSettingsPage
            api={api}
            user={user}
            navigate={navigate}
          />
        ) : showInfrastructureSettings ? (
          <InfrastructureSettingsPage
            api={api}
            user={user}
            navigate={navigate}
          />
        ) : showSecuritySettings ? (
          <SecuritySettingsPage api={api} user={user} navigate={navigate} />
        ) : showAuditSettings ? (
          <AuditSettingsPage api={api} user={user} navigate={navigate} />
        ) : (
          <Welcome />
        )}
      </main>
      <MobileTabBar
        active={
          showThreads
            ? "threads"
            : showImportant
              ? "important"
              : showMembers
                ? "members"
                : showMore || showAnySettings
                  ? "more"
                  : "chats"
        }
        navigate={navigate}
      />
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
      {modal === "folder" && (
        <ChatFolderDialog
          chats={chats}
          onClose={() => setModal(null)}
          onSave={(folder) =>
            void saveFolders([...folders, folder]).then(() => {
              setModal(null);
              selectFilter(`folder:${folder.id}`);
            })
          }
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
  folders = [],
  pinned,
  canPin,
  onToggleFolder,
  onTogglePin,
  onMarkRead,
  onNotificationChanged,
  onLeave,
  onClick,
}: {
  api: MessengerAPI;
  chat: Chat;
  title: string;
  selected: boolean;
  unread?: { unread_count: number; mention_count: number };
  folders?: ChatFolder[];
  pinned: boolean;
  canPin: boolean;
  onToggleFolder?(folderID: string): void;
  onTogglePin(): void;
  onMarkRead(): void;
  onNotificationChanged(): void;
  onLeave(): void;
  onClick(): void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const longPress = useRef<number | null>(null);
  const longPressed = useRef(false);
  useDismissable(menuRoot, Boolean(menu), () => setMenu(null));
  const muted =
    chat.notify_level === "none" ||
    Boolean(
      chat.muted_until && new Date(chat.muted_until).getTime() > Date.now(),
    );
  function openMenuAt(clientX: number, clientY: number) {
    setMenu({
      x: Math.max(8, Math.min(clientX, window.innerWidth - 250)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - 360)),
    });
  }
  function openContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    openMenuAt(event.clientX, event.clientY);
  }
  function clearLongPress() {
    if (longPress.current !== null) window.clearTimeout(longPress.current);
    longPress.current = null;
  }
  return (
    <div className="chat-card-wrap" ref={menuRoot}>
      <button
        className={cx(
          "chat-card",
          selected && "selected",
          muted && "chat-card--muted",
        )}
        onClick={(event) => {
          if (longPressed.current) {
            event.preventDefault();
            longPressed.current = false;
            return;
          }
          onClick();
        }}
        onContextMenu={openContextMenu}
        onKeyDown={(event) => {
          if (
            event.key !== "ContextMenu" &&
            !(event.shiftKey && event.key === "F10")
          )
            return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          openMenuAt(bounds.left + 28, bounds.top + 28);
        }}
        onPointerDown={(event) => {
          if (event.pointerType !== "touch") return;
          const { clientX, clientY } = event;
          longPress.current = window.setTimeout(() => {
            longPressed.current = true;
            openMenuAt(clientX, clientY);
          }, 520);
        }}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        onPointerMove={clearLongPress}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
      >
        <Avatar name={title} size="lg" online={chat.kind === "direct"} />
        <span className="chat-card__body">
          <span className="chat-card__top">
            <strong>
              <span>{title}</span>
              {muted && <BellOff className="chat-card__muted" />}
            </strong>
            <time>
              {chat.last_message_at
                ? formatTime(chat.last_message_at)
                : formatDay(chat.created_at)}
            </time>
          </span>
          <span className="chat-card__bottom">
            <span className="chat-card__preview">
              {chat.last_message && !chat.last_message.deleted
                ? `${chat.kind === "direct" ? "" : `${chat.last_message.actor_display_name}: `}${messagePlainText(chat.last_message.body)}`
                : chat.topic ||
                  (chat.kind === "direct" ? t("direct") : t(chat.kind))}
            </span>
            {Boolean(unread?.unread_count) ? (
              <Badge tone={unread?.mention_count ? "primary" : "neutral"}>
                {unread!.unread_count > 99 ? "99+" : unread!.unread_count}
              </Badge>
            ) : (
              pinned && <Pin className="chat-card__pin" fill="currentColor" />
            )}
          </span>
        </span>
      </button>
      {menu && (
        <div
          className="chat-context-menu"
          role="menu"
          style={{ insetInlineStart: menu.x, top: menu.y }}
        >
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              window.open(
                new URL(`/chat/${chat.id}`, window.location.origin),
                "_blank",
                "noopener,noreferrer",
              );
            }}
          >
            <ExternalLink />
            <span>{t("openNewWindow")}</span>
          </button>
          <button
            role="menuitem"
            disabled={!canPin}
            onClick={() => {
              setMenu(null);
              onTogglePin();
            }}
          >
            <Pin />
            <span>{pinned ? t("unpinChat") : t("pinChat")}</span>
          </button>
          <button
            role="menuitem"
            onClick={() =>
              void api
                .updateChatNotifications(chat.id, {
                  notify_level: muted ? "all" : "none",
                  muted_until: null,
                })
                .then(onNotificationChanged)
                .then(() => setMenu(null))
            }
          >
            {muted ? <Bell /> : <BellOff />}
            <span>{muted ? t("unmuteChat") : t("muteChat")}</span>
          </button>
          {Boolean(unread?.unread_count) && (
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onMarkRead();
              }}
            >
              <MessageCircle />
              <span>{t("markAsRead")}</span>
            </button>
          )}
          {folders.length > 0 && (
            <span className="chat-context-menu__label">{t("folders")}</span>
          )}
          {folders.map((folder) => (
            <button
              key={folder.id}
              role="menuitemcheckbox"
              aria-checked={folder.chat_ids.includes(chat.id)}
              onClick={() => {
                onToggleFolder?.(folder.id);
                setMenu(null);
              }}
            >
              <span data-folder-color={folder.color}>
                <FolderGlyph icon={folder.icon} />
              </span>
              <span>{folder.name}</span>
              {folder.chat_ids.includes(chat.id) && <Check />}
            </button>
          ))}
          {chat.kind !== "direct" && (
            <button
              className="chat-context-menu__danger"
              role="menuitem"
              onClick={() => {
                if (!window.confirm(t("leaveChatConfirm"))) return;
                setMenu(null);
                onLeave();
              }}
            >
              <LogOut />
              <span>
                {t(chat.kind === "channel" ? "leaveChannel" : "leaveChat")}
              </span>
            </button>
          )}
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
  onSummaryChanged,
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
  onSummaryChanged(): void;
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
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [feedReady, setFeedReady] = useState(false);
  const [info, setInfo] = useState(false);
  const [unreadAnchor, setUnreadAnchor] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const loadingPreviousRef = useRef(false);
  const atBottom = useRef(true);
  const initialPositioned = useRef(false);
  const pendingInitialPosition = useRef<{
    chatID: string;
    hasUnread: boolean;
    lastReadSeq: number;
  } | null>(null);
  const previousVisibleLength = useRef(0);
  const lastReadRequested = useRef(0);
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
    const unread = store
      .getState()
      .unread.chats.find((item) => item.chat_id === chat.id);
    const lastReadSeq = unread?.last_read_seq ?? 0;
    setUnreadAnchor(lastReadSeq);
    lastReadRequested.current = lastReadSeq;
    initialPositioned.current = false;
    previousVisibleLength.current = 0;
    pendingInitialPosition.current = null;
    atBottom.current = true;
    setNewBelow(0);
    setShowScrollDown(false);
    setFeedReady(false);
    let active = true;
    setHasMore(true);
    void api
      .messages(chat.id, { limit: 50 })
      .then((page) => {
        if (!active) return;
        pendingInitialPosition.current = {
          chatID: chat.id,
          hasUnread: Boolean(unread?.unread_count),
          lastReadSeq,
        };
        store.getState().replaceMessages(chat.id, page.messages);
        setHasMore(page.next_before_seq != null);
        if (page.messages.length === 0) {
          initialPositioned.current = true;
          setFeedReady(true);
        }
      })
      .catch(() => setFeedReady(true));
    return () => {
      active = false;
    };
  }, [api, chat?.id, store]);
  useEffect(() => {
    if (!chat) return;
    const timer = setTimeout(() => {
      setLocalDraft(chat.id, null, body);
      void syncDraft(api, chat.id, null, body);
    }, 600);
    return () => clearTimeout(timer);
  }, [api, body, chat]);
  const latestSeq = visible.at(-1)?.created_seq ?? 0;
  const markLatestRead = useCallback(() => {
    if (
      !chat ||
      !latestSeq ||
      latestSeq >= Number.MAX_SAFE_INTEGER ||
      latestSeq <= lastReadRequested.current
    )
      return;
    lastReadRequested.current = latestSeq;
    void api
      .markRead(chat.id, latestSeq)
      .then(() =>
        store.getState().setUnread({
          ...store.getState().unread,
          chats: store.getState().unread.chats.map((item) =>
            item.chat_id === chat.id
              ? {
                  ...item,
                  unread_count: 0,
                  mention_count: 0,
                  last_read_seq: latestSeq,
                }
              : item,
          ),
        }),
      )
      .catch(() => {
        if (lastReadRequested.current === latestSeq)
          lastReadRequested.current = unreadAnchor;
      });
  }, [api, chat, latestSeq, store, unreadAnchor]);
  useEffect(() => {
    const pending = pendingInitialPosition.current;
    if (!chat || !pending || pending.chatID !== chat.id || !visible.length)
      return;
    pendingInitialPosition.current = null;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const element = scroller.current;
        if (!element) return;
        const finishPositioning = () => {
          const distance =
            element.scrollHeight - element.scrollTop - element.clientHeight;
          atBottom.current = distance < 64;
          setShowScrollDown(!atBottom.current);
          initialPositioned.current = true;
          setFeedReady(true);
          if (atBottom.current) markLatestRead();
        };
        if (pending.hasUnread) {
          let lastReadIndex = -1;
          for (let index = visible.length - 1; index >= 0; index -= 1) {
            if (visible[index]!.created_seq <= pending.lastReadSeq) {
              lastReadIndex = index;
              break;
            }
          }
          const targetIndex = Math.max(0, lastReadIndex);
          const targetID = visible[targetIndex]!.id;
          virtual.scrollToIndex(targetIndex, {
            align: pending.lastReadSeq > 0 ? "center" : "start",
          });
          requestAnimationFrame(() => {
            document
              .getElementById(`message-${targetID}`)
              ?.scrollIntoView({ block: "center" });
            requestAnimationFrame(finishPositioning);
          });
        } else {
          element.scrollTop = element.scrollHeight;
          requestAnimationFrame(finishPositioning);
        }
      }),
    );
  }, [chat, markLatestRead, virtual, visible]);
  useEffect(() => {
    const previous = previousVisibleLength.current;
    previousVisibleLength.current = visible.length;
    if (!initialPositioned.current || visible.length <= previous) return;
    const added = visible.length - previous;
    if (atBottom.current)
      requestAnimationFrame(() => {
        const element = scroller.current;
        if (!element) return;
        element.scrollTo({ top: element.scrollHeight });
        markLatestRead();
      });
    else {
      setNewBelow((value) => value + added);
      setShowScrollDown(true);
    }
  }, [markLatestRead, visible.length]);
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
        className={cx("message-scroll", feedReady && "message-scroll--ready")}
        ref={scroller}
        aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollTop < 96) void loadPrevious();
          atBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            64;
          setShowScrollDown(!atBottom.current);
          if (atBottom.current) {
            setNewBelow(0);
            markLatestRead();
          }
        }}
      >
        <div className="message-feed">
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
                        ? messages.find(
                            (item) => item.id === message.reply_to_id,
                          )
                        : undefined
                    }
                    author={members.find(
                      (item) => item.actor_id === message.actor_id,
                    )}
                    currentActorID={user.id}
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
                    onChanged={(updated) => {
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
                      });
                      onSummaryChanged();
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {showScrollDown && (
        <button
          className="new-below"
          aria-label={t("scrollToBottom")}
          onClick={() => {
            scroller.current?.scrollTo({
              top: scroller.current.scrollHeight,
              behavior: "smooth",
            });
            setNewBelow(0);
          }}
        >
          <ArrowDown />
          {newBelow > 0 && <span>{newBelow}</span>}
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
  currentActorID,
  own,
  grouped,
  onReply,
  onJump,
  onRetry,
  onThread,
  onChanged,
  domIDPrefix = "message",
  showThreadIndicator = true,
}: {
  api: MessengerAPI;
  message: ClientMessage;
  chats: Chat[];
  members: ChatMember[];
  replyMessage?: ClientMessage;
  author?: ChatMember;
  currentActorID: string;
  own: boolean;
  grouped: boolean;
  onReply(): void;
  onJump(id: string): void;
  onRetry(): void;
  onThread(): void;
  onChanged(value: Message): void;
  domIDPrefix?: string;
  showThreadIndicator?: boolean;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<OverlayPlacement | null>(null);
  const [forwarding, setForwarding] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [reactionPicker, setReactionPicker] = useState<OverlayPlacement | null>(
    null,
  );
  const interactionRoot = useRef<HTMLElement>(null);
  const actionsRoot = useRef<HTMLDivElement>(null);
  const overlayRoot = useRef<HTMLDivElement>(null);
  useDismissable(
    actionsRoot,
    Boolean(menu || reactionPicker),
    () => {
      setMenu(null);
      setReactionPicker(null);
    },
    overlayRoot,
  );
  useLayoutEffect(() => {
    if (!menu) return;
    const overlay = overlayRoot.current;
    if (!overlay) return;
    const height = Math.ceil(overlay.scrollHeight);
    const width = Math.ceil(overlay.getBoundingClientRect().width);
    setMenu(placeMessageOverlay(actionsRoot.current, height, width));
  }, [Boolean(menu)]);
  useEffect(() => {
    if (!menu && !reactionPicker) return;
    const scroller = interactionRoot.current?.closest<HTMLElement>(
      ".message-scroll, .thread-panel__messages",
    );
    if (!scroller) return;
    const previousOverflow = scroller.style.overflowY;
    scroller.style.overflowY = "hidden";
    return () => {
      scroller.style.overflowY = previousOverflow;
    };
  }, [Boolean(menu), Boolean(reactionPicker)]);
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
    setMenu(null);
  }
  async function remove() {
    if (!confirm(t("deleteConfirm"))) return;
    onChanged(await api.deleteMessage(message.id));
    setMenu(null);
  }
  async function toggleReaction(emoji: string) {
    const ownReaction = (reactionsQuery.data ?? []).some(
      (reaction) =>
        reaction.emoji === emoji && reaction.actor_id === currentActorID,
    );
    if (ownReaction) await api.unreact(message.id, emoji);
    else await api.react(message.id, emoji);
    await reactionsQuery.refetch();
    setMenu(null);
    setReactionPicker(null);
  }
  function openReactionPicker() {
    setMenu(null);
    setReactionPicker(placeMessageOverlay(actionsRoot.current, 410, 352));
  }
  function openMessageMenu() {
    setReactionPicker(null);
    setMenu(placeMessageOverlay(actionsRoot.current, 430, 228));
  }
  function openThread() {
    setMenu(null);
    setReactionPicker(null);
    onThread();
  }
  function reply() {
    setMenu(null);
    setReactionPicker(null);
    onReply();
  }
  const reactionGroups = Object.entries(
    (reactionsQuery.data ?? []).reduce<
      Record<string, { count: number; own: boolean }>
    >((groups, reaction) => {
      const current = groups[reaction.emoji] ?? { count: 0, own: false };
      groups[reaction.emoji] = {
        count: current.count + 1,
        own: current.own || reaction.actor_id === currentActorID,
      };
      return groups;
    }, {}),
  );
  return (
    <article
      ref={interactionRoot}
      id={`${domIDPrefix}-${message.id}`}
      className={cx(
        "message",
        grouped && "message--grouped",
        message.delivery === "failed" && "message--failed",
        (menu || reactionPicker) && "message--overlay-open",
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
          {reactionGroups.map(([emoji, group]) => (
            <button
              key={emoji}
              aria-pressed={group.own}
              onClick={() => void toggleReaction(emoji)}
            >
              <span>{emoji}</span>
              <strong>{group.count}</strong>
            </button>
          ))}
        </div>
        {showThreadIndicator && message.thread_reply_count > 0 && (
          <button className="message__thread-link" onClick={openThread}>
            <MessageSquareReply />
            {t("commentCount", { count: message.thread_reply_count })}
          </button>
        )}
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
      <div
        ref={actionsRoot}
        className="message__actions"
        aria-label={t("messageActions")}
      >
        <IconButton
          label={t("addReaction")}
          onClick={() => {
            setMenu(null);
            if (reactionPicker) setReactionPicker(null);
            else openReactionPicker();
          }}
        >
          <SmilePlus />
        </IconButton>
        <IconButton label={t("thread")} onClick={openThread}>
          <MessageSquareReply />
        </IconButton>
        <IconButton
          label={t("openMenu")}
          onClick={() => {
            setReactionPicker(null);
            if (menu) setMenu(null);
            else openMessageMenu();
          }}
        >
          <MoreHorizontal />
        </IconButton>
      </div>
      {reactionPicker &&
        createPortal(
          <div
            ref={overlayRoot}
            className={cx(
              "reaction-picker",
              `reaction-picker--${reactionPicker.side}`,
            )}
            role="dialog"
            aria-label={t("emoji")}
            style={{
              top: reactionPicker.top,
              bottom: reactionPicker.bottom,
              right: reactionPicker.right,
              maxHeight: reactionPicker.maxHeight,
            }}
          >
            <Suspense fallback={<Skeleton />}>
              <EmojiPicker
                width="100%"
                height={reactionPicker.maxHeight}
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
                onEmojiClick={(emoji) => void toggleReaction(emoji.emoji)}
              />
            </Suspense>
          </div>,
          document.body,
        )}
      {menu &&
        createPortal(
          <div
            ref={overlayRoot}
            className={cx("message-menu", `message-menu--${menu.side}`)}
            role="menu"
            style={{
              top: menu.top,
              bottom: menu.bottom,
              right: menu.right,
              maxHeight: menu.maxHeight,
            }}
          >
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                openReactionPicker();
              }}
            >
              <SmilePlus />
              <span>{t("addReaction")}</span>
            </button>
            <button role="menuitem" onClick={reply}>
              <CornerUpLeft />
              <span>{t("reply")}</span>
            </button>
            <button role="menuitem" onClick={openThread}>
              <MessageSquareReply />
              <span>{t("thread")}</span>
            </button>
            <div className="message-menu__divider" />
            <button
              role="menuitem"
              onClick={() => void api.pin(message.id).then(() => setMenu(null))}
            >
              <Pin />
              <span>{t("pin")}</span>
            </button>
            <button
              role="menuitem"
              onClick={() =>
                void navigator.clipboard
                  .writeText(`${location.origin}/m/${compactUUID(message.id)}`)
                  .then(() => setMenu(null))
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
                  .then(() => setMenu(null))
              }
            >
              <Copy />
              <span>{t("copyText")}</span>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setForwarding(true);
              }}
            >
              <Forward />
              <span>{t("forward")}</span>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setDetailsOpen(true);
              }}
            >
              <CheckCheck />
              <span>{t("readAndReactions")}</span>
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
          </div>,
          document.body,
        )}
      {forwarding && (
        <ForwardMessageDialog
          api={api}
          message={message}
          chats={chats}
          authorName={name}
          onClose={() => setForwarding(false)}
        />
      )}
      {detailsOpen && (
        <MessageDetailsDialog
          api={api}
          message={message}
          members={members}
          onClose={() => setDetailsOpen(false)}
        />
      )}
    </article>
  );
}

function ForwardMessageDialog({
  api,
  message,
  chats,
  authorName,
  onClose,
}: {
  api: MessengerAPI;
  message: ClientMessage;
  chats: Chat[];
  authorName: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const filtered = chats.filter((chat) =>
    chat.display_name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  async function submit() {
    if (!selected.size || sending) return;
    setSending(true);
    setError("");
    try {
      await Promise.all(
        [...selected].map(async (chatID) => {
          await api.forward(message.id, chatID, crypto.randomUUID());
          if (comment.trim())
            await api.createMessage(chatID, {
              client_msg_id: crypto.randomUUID(),
              body: comment.trim(),
              body_format: "markdown",
              mentioned_actor_ids: [],
            });
        }),
      );
      onClose();
    } catch {
      setError(t("error"));
      setSending(false);
    }
  }
  return createPortal(
    <Dialog
      title={t("forward")}
      onClose={onClose}
      className="message-modal message-forward-dialog"
    >
      <label className="message-modal__search">
        <Search />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchChats")}
          aria-label={t("searchChats")}
        />
      </label>
      <div className="forward-picker" role="listbox" aria-multiselectable>
        {filtered.map((chat) => {
          const checked = selected.has(chat.id);
          return (
            <button
              key={chat.id}
              role="option"
              aria-selected={checked}
              onClick={() =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(chat.id)) next.delete(chat.id);
                  else next.add(chat.id);
                  return next;
                })
              }
            >
              <Avatar name={chat.display_name} size="sm" />
              <span>{chat.display_name}</span>
              <span className="forward-picker__check" aria-hidden="true">
                {checked && <Check />}
              </span>
            </button>
          );
        })}
        {filtered.length === 0 && <Empty label={t("nothingFound")} />}
      </div>
      <div className="forward-preview">
        <span>{t("forwardedMessage")}</span>
        <strong>{authorName}</strong>
        <p>{messagePlainText(message.body)}</p>
      </div>
      <label className="forward-comment">
        <span>{t("forwardComment")}</span>
        <textarea
          rows={2}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={t("forwardCommentPlaceholder")}
        />
      </label>
      {error && <FormError message={error} />}
      <div className="dialog-actions">
        <Button onClick={onClose}>{t("cancel")}</Button>
        <Button
          variant="primary"
          disabled={!selected.size || sending}
          onClick={() => void submit()}
        >
          {sending
            ? t("loading")
            : t("forwardSelected", { count: selected.size })}
        </Button>
      </div>
    </Dialog>,
    document.body,
  );
}

function MessageDetailsDialog({
  api,
  message,
  members,
  onClose,
}: {
  api: MessengerAPI;
  message: ClientMessage;
  members: ChatMember[];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"receipts" | "reactions">("receipts");
  const receipts = useQuery<MessageReceipt[]>({
    queryKey: ["message-receipts", message.id],
    queryFn: () => api.receipts(message.id),
  });
  const reactions = useQuery<Reaction[]>({
    queryKey: ["message-reactions", message.id],
    queryFn: () => api.reactions(message.id),
  });
  const reactionActors = Object.values(
    (reactions.data ?? []).reduce<
      Record<string, { actorID: string; emojis: string[]; at: string }>
    >((result, reaction) => {
      const current = result[reaction.actor_id] ?? {
        actorID: reaction.actor_id,
        emojis: [],
        at: reaction.created_at,
      };
      current.emojis.push(reaction.emoji);
      result[reaction.actor_id] = current;
      return result;
    }, {}),
  );
  function memberName(actorID: string) {
    return (
      members.find((member) => member.actor_id === actorID)?.display_name ??
      t("participant")
    );
  }
  return createPortal(
    <Dialog
      title={t("viewsAndReactions")}
      onClose={onClose}
      className="message-modal message-details-dialog"
    >
      <div className="message-details__tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "receipts"}
          aria-label={t("readBy")}
          onClick={() => setTab("receipts")}
        >
          <CheckCheck />
        </button>
        <button
          role="tab"
          aria-selected={tab === "reactions"}
          aria-label={t("reactions")}
          onClick={() => setTab("reactions")}
        >
          <Smile />
        </button>
      </div>
      <div className="message-details__body" role="tabpanel">
        {tab === "receipts" && receipts.isLoading && <Skeleton />}
        {tab === "receipts" &&
          !receipts.isLoading &&
          !receipts.data?.length && <Empty label={t("nobodyRead")} />}
        {tab === "receipts" &&
          receipts.data?.map((receipt) => {
            const name = memberName(receipt.actor_id);
            return (
              <div className="message-details__person" key={receipt.actor_id}>
                <Avatar name={name} size="sm" />
                <strong>{name}</strong>
                <time>{formatTime(receipt.read_at)}</time>
              </div>
            );
          })}
        {tab === "reactions" && reactions.isLoading && <Skeleton />}
        {tab === "reactions" &&
          !reactions.isLoading &&
          reactionActors.length === 0 && <Empty label={t("noReactions")} />}
        {tab === "reactions" &&
          reactionActors.map((entry) => {
            const name = memberName(entry.actorID);
            return (
              <div className="message-details__person" key={entry.actorID}>
                <Avatar name={name} size="sm" />
                <strong>{name}</strong>
                <span className="message-details__emojis">
                  {entry.emojis.join(" ")}
                </span>
              </div>
            );
          })}
      </div>
    </Dialog>,
    document.body,
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
  const canSend = Boolean(body.trim());
  useEffect(() => {
    if (!canSend) setSendSettings(false);
  }, [canSend]);
  useDismissable(composerRoot, formatOpen || emojiOpen || sendSettings, () => {
    setFormatOpen(false);
    setEmojiOpen(false);
    setSendSettings(false);
  });
  const draft = useMemo(() => decodeMentions(body), [body]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    const styles = getComputedStyle(element);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 21;
    const verticalPadding =
      (Number.parseFloat(styles.paddingTop) || 0) +
      (Number.parseFloat(styles.paddingBottom) || 0);
    const maxHeight = lineHeight * 6 + verticalPadding;
    const nextHeight = Math.min(element.scrollHeight, maxHeight);
    element.style.height = `${nextHeight}px`;
    element.style.overflowY =
      element.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft.text]);
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
          <div
            className={cx(
              "composer__send",
              canSend && "composer__send--active",
            )}
          >
            <Button
              size="icon"
              variant="primary"
              aria-label={t("send")}
              onClick={onSend}
              disabled={!canSend}
            >
              <SendHorizontal />
            </Button>
            <IconButton
              label={t("sendSettings")}
              onClick={() => {
                setSendSettings((open) => !open);
                setEmojiOpen(false);
              }}
              disabled={!canSend}
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
            <RadioOption
              name="send-mode"
              checked={sendOnEnter}
              label={t("enterSends")}
              description={t("shiftEnterNewLine")}
              onChange={() => {
                setSendOnEnter(true);
                localStorage.setItem("coma-send-on-enter", "true");
              }}
            />
            <RadioOption
              name="send-mode"
              checked={!sendOnEnter}
              label={t("shiftEnterSends")}
              description={t("enterNewLine")}
              onChange={() => {
                setSendOnEnter(false);
                localStorage.setItem("coma-send-on-enter", "false");
              }}
            />
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
        <span>
          {sendOnEnter ? t("composerHint") : t("composerHintReverse")}
        </span>
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
            currentActorID={user.id}
            own={root.actor_id === user.id}
            grouped={false}
            onReply={() => setReply(root)}
            onJump={() => undefined}
            onRetry={() => void outbox.flush()}
            onThread={() => undefined}
            onChanged={() => void query.refetch()}
            domIDPrefix="thread-message"
            showThreadIndicator={false}
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
              currentActorID={user.id}
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
              showThreadIndicator={false}
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
  onBack,
}: {
  api: MessengerAPI;
  navigate(value: string): void;
  onBack(): void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["threads"],
    queryFn: () => api.threads(),
  });
  const threads = query.data?.threads ?? [];
  return (
    <section className="utility-page">
      <UtilityPageHeader title={t("threads")} onBack={onBack} />
      <div className="utility-page__lead">{t("followedThreads")}</div>
      <div className="utility-list">
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
                <strong>{messagePlainText(item.root.body).slice(0, 90)}</strong>
                <small>{t("replyCount", { count: item.reply_count })}</small>
              </span>
              <ChevronDown className="utility-list__open" />
            </button>
          ))
        ) : (
          <Empty label={t("noThreads")} />
        )}
      </div>
    </section>
  );
}

function ImportantDirectory({
  api,
  chats,
  navigate,
  onBack,
}: {
  api: MessengerAPI;
  chats: Chat[];
  navigate(value: string): void;
  onBack(): void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["important", chats.map((chat) => chat.id).join(":")],
    enabled: chats.length > 0,
    queryFn: async () => {
      const pinned = (
        await Promise.all(
          chats.map(async (chat) =>
            (await api.pins(chat.id)).map((pin) => ({ chat, pin })),
          ),
        )
      ).flat();
      return Promise.all(
        pinned.map(async ({ chat, pin }) => {
          const context = await api.messageContext(pin.message_id, 1);
          return {
            chat,
            message: context.messages.find(
              (message) => message.id === pin.message_id,
            ),
          };
        }),
      );
    },
  });
  const items = (query.data ?? []).filter(
    (item): item is { chat: Chat; message: Message } => Boolean(item.message),
  );
  return (
    <section className="utility-page">
      <UtilityPageHeader title={t("important")} onBack={onBack} />
      <div className="utility-page__lead">{t("importantHint")}</div>
      <div className="utility-list">
        {query.isLoading ? (
          <Skeleton />
        ) : query.isError ? (
          <FormError message={t("errorNetwork")} />
        ) : items.length ? (
          items.map(({ chat, message }) => (
            <button
              key={message.id}
              onClick={() => navigate(`/chat/${chat.id}?message=${message.id}`)}
            >
              <Avatar name={chat.display_name} />
              <span>
                <strong>{messagePlainText(message.body).slice(0, 120)}</strong>
                <small>{chat.display_name}</small>
              </span>
              <Star className="utility-list__important" fill="currentColor" />
            </button>
          ))
        ) : (
          <Empty label={t("noImportant")} />
        )}
      </div>
    </section>
  );
}

function MembersDirectory({
  api,
  onBack,
}: {
  api: MessengerAPI;
  onBack(): void;
}) {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ["actors"], queryFn: () => api.actors() });
  const actors = query.data?.actors ?? [];
  return (
    <section className="utility-page">
      <UtilityPageHeader title={t("members")} onBack={onBack} />
      <div className="utility-page__lead">
        {t("memberCount", { count: actors.length })}
      </div>
      <div className="member-directory">
        {query.isLoading ? (
          <Skeleton />
        ) : query.isError ? (
          <FormError message={t("errorNetwork")} />
        ) : (
          actors.map((actor) => (
            <article key={actor.actor_id}>
              <Avatar name={actor.display_name} size="lg" online />
              <span>
                <strong>{actor.display_name}</strong>
                <small>@{actor.handle}</small>
              </span>
              <Badge>{actor.type}</Badge>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function UtilityPageHeader({
  title,
  onBack,
}: {
  title: string;
  onBack(): void;
}) {
  const { t } = useTranslation();
  return (
    <header className="utility-page__header">
      <IconButton className="mobile-back" label={t("back")} onClick={onBack}>
        <ChevronLeft />
      </IconButton>
      <h1>{title}</h1>
    </header>
  );
}

function FolderGlyph({ icon }: { icon: ChatFolder["icon"] }) {
  const Glyph =
    folderIconOptions.find((option) => option.id === icon)?.icon ?? Folder;
  return <Glyph />;
}

function ChatFolderDialog({
  chats,
  onClose,
  onSave,
}: {
  chats: Chat[];
  onClose(): void;
  onSave(folder: ChatFolder): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<ChatFolder["icon"]>("folder");
  const [color, setColor] = useState<ChatFolder["color"]>("blue");
  const [iconQuery, setIconQuery] = useState("");
  const [chatQuery, setChatQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const localizedIconTerms = new Map(
    t("folderIconSearchTerms")
      .split("|")
      .map((entry) => {
        const separator = entry.indexOf(":");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
  const visibleIcons = folderIconOptions.filter((option) =>
    `${t(option.labelKey)} ${option.terms} ${localizedIconTerms.get(option.id) ?? ""}`
      .toLocaleLowerCase()
      .includes(iconQuery.trim().toLocaleLowerCase()),
  );
  const visibleChats = chats.filter((chat) =>
    chat.display_name
      .toLocaleLowerCase()
      .includes(chatQuery.trim().toLocaleLowerCase()),
  );
  return (
    <Dialog
      title={t("newFolder")}
      description={t("folderHint")}
      onClose={onClose}
    >
      <div className="dialog-form">
        <Field
          label={t("folderName")}
          name="folder_name"
          defaultValue=""
          maxLength={40}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <fieldset className="folder-icon-picker" data-folder-color={color}>
          <legend>{t("folderIcon")}</legend>
          <label className="folder-picker-search">
            <Search />
            <input
              type="search"
              value={iconQuery}
              onChange={(event) => setIconQuery(event.currentTarget.value)}
              placeholder={t("searchIcons")}
              aria-label={t("searchIcons")}
            />
          </label>
          <div className="folder-icon-grid">
            {visibleIcons.map((option) => {
              const Glyph = option.icon;
              const label = t(option.labelKey);
              return (
                <button
                  type="button"
                  key={option.id}
                  className={icon === option.id ? "active" : ""}
                  aria-pressed={icon === option.id}
                  aria-label={label}
                  title={label}
                  onClick={() => setIcon(option.id)}
                >
                  <Glyph />
                </button>
              );
            })}
          </div>
        </fieldset>
        <fieldset className="folder-color-picker">
          <legend>{t("folderColor")}</legend>
          <div>
            {folderColors.map((value) => (
              <button
                type="button"
                key={value}
                data-folder-color={value}
                className={color === value ? "active" : ""}
                aria-pressed={color === value}
                aria-label={t("chooseFolderColor", { color: value })}
                onClick={() => setColor(value)}
              >
                {color === value && <Check />}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="folder-chat-picker">
          <strong>{t("folderChats")}</strong>
          <label className="folder-picker-search">
            <Search />
            <input
              type="search"
              value={chatQuery}
              onChange={(event) => setChatQuery(event.currentTarget.value)}
              placeholder={t("searchChats")}
              aria-label={t("searchChats")}
            />
          </label>
          {visibleChats.map((chat) => (
            <button
              type="button"
              role="checkbox"
              aria-checked={selected.includes(chat.id)}
              aria-label={chat.display_name}
              key={chat.id}
              onClick={() =>
                setSelected((items) =>
                  items.includes(chat.id)
                    ? items.filter((id) => id !== chat.id)
                    : [...items, chat.id],
                )
              }
            >
              <span className="folder-chat-picker__check" aria-hidden="true">
                {selected.includes(chat.id) && <Check />}
              </span>
              <Avatar name={chat.display_name} size="sm" />
              <span>{chat.display_name}</span>
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={() =>
              onSave({
                id: crypto.randomUUID(),
                name: name.trim(),
                icon,
                color,
                chat_ids: selected,
              })
            }
          >
            {t("create")}
          </Button>
        </div>
      </div>
    </Dialog>
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
function MobileTabBar({
  active,
  navigate,
}: {
  active: "chats" | "threads" | "important" | "members" | "more";
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const items = [
    {
      id: "chats" as const,
      path: "/chats",
      label: t("chats"),
      icon: MessageCircle,
    },
    {
      id: "threads" as const,
      path: "/threads",
      label: t("threads"),
      icon: MessagesSquare,
    },
    {
      id: "important" as const,
      path: "/important",
      label: t("important"),
      icon: Star,
    },
    {
      id: "members" as const,
      path: "/members",
      label: t("members"),
      icon: Users,
    },
    { id: "more" as const, path: "/more", label: t("more"), icon: Menu },
  ];
  return (
    <nav className="mobile-tabbar" aria-label={t("primaryNavigation")}>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            className={active === item.id ? "active" : ""}
            aria-current={active === item.id ? "page" : undefined}
            aria-label={item.label}
            title={item.label}
            onClick={() => navigate(item.path)}
          >
            <Icon />
          </button>
        );
      })}
    </nav>
  );
}

function MobileMorePage({
  user,
  navigate,
  onLogout,
  onNotify,
}: {
  user: User;
  navigate(to: string): void;
  onLogout(): void;
  onNotify(): void;
}) {
  const { t } = useTranslation();
  return (
    <section className="mobile-more-page utility-page">
      <header className="mobile-more-page__identity">
        <Avatar name={user.display_name} size="lg" online />
        <span>
          <strong>{user.display_name}</strong>
          <small>@{user.handle}</small>
        </span>
      </header>
      <div className="mobile-more-page__workspace">
        <Logo size="small" />
        <span>
          <strong title={user.organization_name}>
            {user.organization_name}
          </strong>
          <small>{t("currentWorkspace")}</small>
        </span>
      </div>
      <div className="mobile-more-list">
        <button onClick={() => navigate("/settings/profile")}>
          <UserRound />
          <span>
            <strong>{t("profileSettings")}</strong>
            <small>{t("profileSettingsHint")}</small>
          </span>
        </button>
        {user.role !== "member" && (
          <button onClick={() => navigate("/settings/workspace")}>
            <Building2 />
            <span>
              <strong>{t("workspaceSettings")}</strong>
              <small>{t("workspaceSettingsHint")}</small>
            </span>
          </button>
        )}
        <button onClick={() => navigate("/members")}>
          <Users />
          <span>
            <strong>{t("members")}</strong>
            <small>{t("membersHint")}</small>
          </span>
        </button>
        <button onClick={onNotify}>
          <Bell />
          <span>
            <strong>{t("notifications")}</strong>
            <small>{t("notificationsHint")}</small>
          </span>
        </button>
        <button className="danger" onClick={onLogout}>
          <LogOut />
          <span>
            <strong>{t("logout")}</strong>
            <small>{user.email}</small>
          </span>
        </button>
      </div>
    </section>
  );
}

function ProfileSettingsPage({
  api,
  user,
  navigate,
  onLogout,
  onNotify,
  onUserUpdated,
}: {
  api: MessengerAPI;
  user: User;
  navigate(to: string): void;
  onLogout(): void;
  onNotify(): void;
  onUserUpdated(user: User): void;
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
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    setThemeValue(query.data.theme);
    setPushPreview(query.data.push_preview);
  }, [query.data]);
  async function save() {
    const [updatedUser] = await Promise.all([
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
        chat_folders: query.data?.chat_folders ?? [],
        pinned_chat_ids: query.data?.pinned_chat_ids ?? [],
      }),
    ]);
    setTheme(theme);
    onUserUpdated(updatedUser);
    setSaved(true);
  }
  return (
    <section className="settings-page utility-page">
      <UtilityPageHeader
        title={t("profileSettings")}
        onBack={() => navigate("/more")}
      />
      <SettingsNavigation user={user} active="profile" navigate={navigate} />
      <div className="settings-page__body">
        <p className="settings-page__email">{user.email}</p>
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
          <button className="settings-list__save" onClick={() => void save()}>
            <Check />
            {saved ? t("changesSaved") : t("save")}
          </button>
          <button className="danger" onClick={onLogout}>
            <LogOut />
            {t("logout")}
          </button>
        </div>
      </div>
    </section>
  );
}

function WorkspaceSettingsPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const allowed = user.role !== "member";
  const query = useQuery({
    queryKey: ["organization-settings"],
    queryFn: () => api.organization(),
    enabled: allowed,
  });
  const members = useQuery({
    queryKey: ["organization-members"],
    queryFn: () => api.organizationMembers(),
    enabled: allowed,
  });
  const [draft, setDraft] = useState<OrganizationSettings | null>(null);
  const [message, setMessage] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteURL, setInviteURL] = useState("");
  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);
  async function save() {
    if (!draft) return;
    try {
      const updated = await api.updateOrganization({
        name: draft.name,
        slug: draft.slug,
        expected_version: draft.version,
        invitation_default_role: draft.invitation_default_role,
        invitation_ttl_hours: draft.invitation_ttl_hours,
        allow_public_chat_creation: draft.allow_public_chat_creation,
        allow_channel_creation: draft.allow_channel_creation,
        accent_color: draft.accent_color,
      });
      setDraft(updated);
      setMessage(t("changesSaved"));
      window.dispatchEvent(new Event("coma-branding-changed"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  async function updateMember(
    member: OrganizationMember,
    patch: {
      role?: "owner" | "admin" | "member";
      status?: "active" | "deactivated";
    },
  ) {
    setMessage("");
    try {
      await api.updateOrganizationMember(member.actor_id, patch);
      await members.refetch();
      setMessage(t("changesSaved"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  async function invite() {
    try {
      const invitation = await api.createInvitation({
        email: inviteEmail,
        role: inviteRole,
      });
      setInviteURL(invitation.accept_url ?? "");
      setInviteEmail("");
      setMessage(t("invitationCreated"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  return (
    <section className="settings-page utility-page">
      <UtilityPageHeader
        title={t("workspaceSettings")}
        onBack={() => navigate("/more")}
      />
      <SettingsNavigation user={user} active="workspace" navigate={navigate} />
      {!allowed ? (
        <SettingsAccessDenied />
      ) : query.isLoading || !draft ? (
        <Skeleton />
      ) : (
        <div className="settings-page__body">
          <article className="workspace-settings-card">
            <Logo size="small" />
            <span>
              <strong>{user.organization_name}</strong>
              <small>{t("workspaceRole", { role: user.role })}</small>
            </span>
          </article>
          <SettingsSection
            title={t("workspaceGeneral")}
            description={t("workspaceGeneralHint")}
          >
            <div className="settings-form-grid">
              <Field
                label={t("organization")}
                name="workspace-name"
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
              <Field
                label={t("slug")}
                name="workspace-slug"
                value={draft.slug}
                onChange={(event) =>
                  setDraft({ ...draft, slug: event.target.value.toLowerCase() })
                }
              />
            </div>
          </SettingsSection>
          <SettingsSection
            title={t("invitationPolicy")}
            description={t("invitationPolicyHint")}
          >
            <div className="settings-form-grid">
              <SelectField
                label={t("defaultRole")}
                name="default-role"
                value={draft.invitation_default_role}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    invitation_default_role: event.target.value as
                      | "admin"
                      | "member",
                  })
                }
              >
                <option value="member">{t("roleMember")}</option>
                <option value="admin">{t("roleAdmin")}</option>
              </SelectField>
              <Field
                label={t("invitationTTL")}
                name="invitation-ttl"
                type="number"
                min={1}
                max={720}
                value={String(draft.invitation_ttl_hours)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    invitation_ttl_hours: Number(event.target.value),
                  })
                }
              />
            </div>
          </SettingsSection>
          <SettingsSection
            title={t("creationPolicy")}
            description={t("creationPolicyHint")}
          >
            <SettingsToggle
              label={t("allowPublicChats")}
              hint={t("allowPublicChatsHint")}
              checked={draft.allow_public_chat_creation}
              onChange={(checked) =>
                setDraft({ ...draft, allow_public_chat_creation: checked })
              }
            />
            <SettingsToggle
              label={t("allowChannels")}
              hint={t("allowChannelsHint")}
              checked={draft.allow_channel_creation}
              onChange={(checked) =>
                setDraft({ ...draft, allow_channel_creation: checked })
              }
            />
          </SettingsSection>
          <div className="settings-actions">
            <Button variant="primary" onClick={() => void save()}>
              <Check />
              {t("save")}
            </Button>
            <FormError
              message={message && message !== t("changesSaved") ? message : ""}
            />
            {message === t("changesSaved") && (
              <span className="settings-success">{message}</span>
            )}
          </div>
          <SettingsSection
            title={t("membersAndAccess")}
            description={t("membersAccessHint")}
          >
            <div className="invitation-form">
              <Field
                label={t("inviteEmail")}
                name="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
              <SelectField
                label={t("defaultRole")}
                name="invite-role"
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(event.target.value as "member" | "admin")
                }
              >
                <option value="member">{t("roleMember")}</option>
                <option value="admin">{t("roleAdmin")}</option>
              </SelectField>
              <Button
                variant="primary"
                disabled={!inviteEmail}
                onClick={() => void invite()}
              >
                <UserPlus />
                {t("createInvitation")}
              </Button>
            </div>
            {inviteURL && (
              <div className="invitation-result">
                <span>
                  <strong>{t("invitationLink")}</strong>
                  <small>{t("invitationLinkHint")}</small>
                </span>
                <input
                  readOnly
                  value={inviteURL}
                  aria-label={t("invitationLink")}
                />
                <Button
                  onClick={() => void navigator.clipboard.writeText(inviteURL)}
                >
                  <Copy />
                  {t("copyLink")}
                </Button>
              </div>
            )}
            <div className="organization-members">
              {(members.data ?? []).map((member) => (
                <article key={member.actor_id} className="organization-member">
                  <Avatar
                    name={member.display_name}
                    size="md"
                    online={member.status === "active"}
                  />
                  <span>
                    <strong>{member.display_name}</strong>
                    <small>
                      @{member.handle} · {member.email}
                    </small>
                  </span>
                  <select
                    aria-label={t("defaultRole")}
                    value={member.role}
                    disabled={
                      member.actor_id === user.id ||
                      (user.role !== "owner" && member.role !== "member")
                    }
                    onChange={(event) =>
                      void updateMember(member, {
                        role: event.target.value as
                          | "owner"
                          | "admin"
                          | "member",
                      })
                    }
                  >
                    <option value="owner">{t("roleOwner")}</option>
                    <option value="admin">{t("roleAdmin")}</option>
                    <option value="member">{t("roleMember")}</option>
                  </select>
                  <Button
                    size="sm"
                    disabled={member.actor_id === user.id}
                    onClick={() =>
                      void updateMember(member, {
                        status:
                          member.status === "active" ? "deactivated" : "active",
                      })
                    }
                  >
                    {member.status === "active"
                      ? t("deactivate")
                      : t("activate")}
                  </Button>
                </article>
              ))}
            </div>
          </SettingsSection>
        </div>
      )}
    </section>
  );
}

function CustomizationSettingsPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const allowed = user.role !== "member";
  const query = useQuery({
    queryKey: ["organization-settings"],
    queryFn: () => api.organization(),
    enabled: allowed,
  });
  const [settings, setSettings] = useState<OrganizationSettings | null>(null);
  const [message, setMessage] = useState("");
  const [assetVersion, setAssetVersion] = useState(Date.now());
  useEffect(() => {
    if (query.data) setSettings(query.data);
  }, [query.data]);
  async function saveAccent() {
    if (!settings) return;
    try {
      const updated = await api.updateOrganization({
        name: settings.name,
        slug: settings.slug,
        expected_version: settings.version,
        invitation_default_role: settings.invitation_default_role,
        invitation_ttl_hours: settings.invitation_ttl_hours,
        allow_public_chat_creation: settings.allow_public_chat_creation,
        allow_channel_creation: settings.allow_channel_creation,
        accent_color: settings.accent_color,
      });
      setSettings(updated);
      setMessage(t("changesSaved"));
      window.dispatchEvent(new Event("coma-branding-changed"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  async function upload(kind: "logo" | "favicon", files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      await api.putBrandingAsset(kind, file);
      setAssetVersion(Date.now());
      await query.refetch();
      setMessage(t("assetSaved"));
      window.dispatchEvent(new Event("coma-branding-changed"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  async function removeAsset(kind: "logo" | "favicon") {
    try {
      await api.deleteBrandingAsset(kind);
      setAssetVersion(Date.now());
      await query.refetch();
      setMessage(t("assetRemoved"));
      window.dispatchEvent(new Event("coma-branding-changed"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  return (
    <section className="settings-page utility-page">
      <UtilityPageHeader
        title={t("customizationSettings")}
        onBack={() => navigate("/more")}
      />
      <SettingsNavigation
        user={user}
        active="customization"
        navigate={navigate}
      />
      {!allowed ? (
        <SettingsAccessDenied />
      ) : !settings ? (
        <Skeleton />
      ) : (
        <div className="settings-page__body">
          <SettingsSection
            title={t("brandIdentity")}
            description={t("brandIdentityHint")}
          >
            <div className="branding-assets">
              <BrandingAssetCard
                title={t("workspaceLogo")}
                hint={t("workspaceLogoHint")}
                imageURL={
                  settings.has_logo
                    ? `${api.apiURL}/api/v1/branding/logo?v=${assetVersion}`
                    : ""
                }
                accept="image/png,image/jpeg,image/webp"
                onUpload={(files) => void upload("logo", files)}
                onRemove={
                  settings.has_logo ? () => void removeAsset("logo") : undefined
                }
              />
              <BrandingAssetCard
                title={t("workspaceFavicon")}
                hint={t("workspaceFaviconHint")}
                imageURL={
                  settings.has_favicon
                    ? `${api.apiURL}/api/v1/branding/favicon?v=${assetVersion}`
                    : ""
                }
                accept="image/png,image/x-icon,image/vnd.microsoft.icon"
                onUpload={(files) => void upload("favicon", files)}
                onRemove={
                  settings.has_favicon
                    ? () => void removeAsset("favicon")
                    : undefined
                }
              />
            </div>
          </SettingsSection>
          <SettingsSection
            title={t("accentColor")}
            description={t("accentColorHint")}
          >
            <div className="accent-editor">
              <input
                type="color"
                aria-label={t("accentColor")}
                value={settings.accent_color}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    accent_color: event.target.value.toUpperCase(),
                  })
                }
              />
              <Field
                label={t("hexColor")}
                name="accent-hex"
                value={settings.accent_color}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    accent_color: event.target.value.toUpperCase(),
                  })
                }
              />
              <div
                className="accent-preview"
                style={
                  { "--preview-accent": settings.accent_color } as CSSProperties
                }
              >
                <Logo size="small" />
                <button>{t("previewAction")}</button>
              </div>
            </div>
          </SettingsSection>
          <div className="settings-actions">
            <Button variant="primary" onClick={() => void saveAccent()}>
              <Check />
              {t("save")}
            </Button>
            <span className="settings-success">{message}</span>
          </div>
        </div>
      )}
    </section>
  );
}

function InfrastructureSettingsPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const allowed = user.role !== "member";
  const query = useQuery({
    queryKey: ["infrastructure-settings"],
    queryFn: () => api.infrastructure(),
    enabled: allowed,
  });
  const [value, setValue] = useState<InfrastructureSettings | null>(null);
  const [s3AccessKey, setS3AccessKey] = useState("");
  const [s3SecretKey, setS3SecretKey] = useState("");
  const [smtpPassword, setSMTPPassword] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (query.data)
      setValue({
        ...query.data,
        smtp: {
          ...query.data.smtp,
          security: query.data.smtp.security || "starttls",
          port: query.data.smtp.port || 587,
        },
      });
  }, [query.data]);
  async function save() {
    if (!value) return;
    try {
      const updated = await api.updateInfrastructure({
        expected_version: value.version,
        s3: {
          endpoint: value.s3.endpoint,
          region: value.s3.region,
          bucket: value.s3.bucket,
          prefix: value.s3.prefix,
          force_path_style: value.s3.force_path_style,
          access_key: s3AccessKey || null,
          secret_key: s3SecretKey || null,
          clear_credentials: false,
        },
        smtp: {
          host: value.smtp.host,
          port: value.smtp.port,
          username: value.smtp.username,
          password: smtpPassword || null,
          from_address: value.smtp.from_address,
          from_name: value.smtp.from_name,
          security: value.smtp.security,
          clear_credentials: false,
        },
      });
      setValue(updated);
      setS3AccessKey("");
      setS3SecretKey("");
      setSMTPPassword("");
      setMessage(t("changesSaved"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  async function test(kind: "s3" | "smtp") {
    try {
      const result = await api.testInfrastructure(kind);
      setMessage(result.ok ? t("connectionSuccessful") : result.message);
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  return (
    <section className="settings-page utility-page">
      <UtilityPageHeader
        title={t("infrastructureSettings")}
        onBack={() => navigate("/more")}
      />
      <SettingsNavigation
        user={user}
        active="infrastructure"
        navigate={navigate}
      />
      {!allowed ? (
        <SettingsAccessDenied />
      ) : !value ? (
        <Skeleton />
      ) : (
        <div className="settings-page__body">
          <SettingsSection
            title={t("s3Storage")}
            description={t("s3StorageHint")}
            icon={<HardDrive />}
          >
            <div className="settings-form-grid">
              <Field
                label={t("endpoint")}
                name="s3-endpoint"
                placeholder="https://s3.example.com"
                value={value.s3.endpoint}
                onChange={(e) =>
                  setValue({
                    ...value,
                    s3: { ...value.s3, endpoint: e.target.value },
                  })
                }
              />
              <Field
                label={t("region")}
                name="s3-region"
                placeholder="ru-central1"
                value={value.s3.region}
                onChange={(e) =>
                  setValue({
                    ...value,
                    s3: { ...value.s3, region: e.target.value },
                  })
                }
              />
              <Field
                label={t("bucket")}
                name="s3-bucket"
                value={value.s3.bucket}
                onChange={(e) =>
                  setValue({
                    ...value,
                    s3: { ...value.s3, bucket: e.target.value },
                  })
                }
              />
              <Field
                label={t("prefix")}
                name="s3-prefix"
                placeholder="coma"
                value={value.s3.prefix}
                onChange={(e) =>
                  setValue({
                    ...value,
                    s3: { ...value.s3, prefix: e.target.value },
                  })
                }
              />
              <Field
                label={t("accessKey")}
                name="s3-access"
                placeholder={value.s3.access_key_hint || t("notConfigured")}
                value={s3AccessKey}
                onChange={(e) => setS3AccessKey(e.target.value)}
              />
              <Field
                label={t("secretKey")}
                name="s3-secret"
                type="password"
                placeholder={
                  value.s3.credentials_configured
                    ? "••••••••"
                    : t("notConfigured")
                }
                value={s3SecretKey}
                onChange={(e) => setS3SecretKey(e.target.value)}
              />
            </div>
            <SettingsToggle
              label={t("forcePathStyle")}
              hint={t("forcePathStyleHint")}
              checked={value.s3.force_path_style}
              onChange={(checked) =>
                setValue({
                  ...value,
                  s3: { ...value.s3, force_path_style: checked },
                })
              }
            />
            <Button onClick={() => void test("s3")}>
              <RefreshCw />
              {t("testConnection")}
            </Button>
          </SettingsSection>
          <SettingsSection
            title={t("smtpDelivery")}
            description={t("smtpDeliveryHint")}
            icon={<Mail />}
          >
            <div className="settings-form-grid">
              <Field
                label={t("host")}
                name="smtp-host"
                value={value.smtp.host}
                onChange={(e) =>
                  setValue({
                    ...value,
                    smtp: { ...value.smtp, host: e.target.value },
                  })
                }
              />
              <Field
                label={t("port")}
                name="smtp-port"
                type="number"
                min={1}
                max={65535}
                value={String(value.smtp.port)}
                onChange={(e) =>
                  setValue({
                    ...value,
                    smtp: { ...value.smtp, port: Number(e.target.value) },
                  })
                }
              />
              <Field
                label={t("username")}
                name="smtp-user"
                value={value.smtp.username}
                onChange={(e) =>
                  setValue({
                    ...value,
                    smtp: { ...value.smtp, username: e.target.value },
                  })
                }
              />
              <Field
                label={t("password")}
                name="smtp-password"
                type="password"
                placeholder={
                  value.smtp.credentials_configured
                    ? "••••••••"
                    : t("notConfigured")
                }
                value={smtpPassword}
                onChange={(e) => setSMTPPassword(e.target.value)}
              />
              <Field
                label={t("fromAddress")}
                name="smtp-from"
                value={value.smtp.from_address}
                onChange={(e) =>
                  setValue({
                    ...value,
                    smtp: { ...value.smtp, from_address: e.target.value },
                  })
                }
              />
              <Field
                label={t("fromName")}
                name="smtp-name"
                value={value.smtp.from_name}
                onChange={(e) =>
                  setValue({
                    ...value,
                    smtp: { ...value.smtp, from_name: e.target.value },
                  })
                }
              />
              <SelectField
                label={t("security")}
                name="smtp-security"
                value={value.smtp.security}
                onChange={(e) =>
                  setValue({
                    ...value,
                    smtp: {
                      ...value.smtp,
                      security: e.target.value as "none" | "starttls" | "tls",
                    },
                  })
                }
              >
                <option value="starttls">STARTTLS</option>
                <option value="tls">TLS</option>
                <option value="none">{t("noEncryption")}</option>
              </SelectField>
            </div>
            <Button onClick={() => void test("smtp")}>
              <RefreshCw />
              {t("testConnection")}
            </Button>
          </SettingsSection>
          <div className="settings-actions">
            <Button variant="primary" onClick={() => void save()}>
              <Check />
              {t("saveInfrastructure")}
            </Button>
            <span className="settings-success">{message}</span>
          </div>
        </div>
      )}
    </section>
  );
}

function SecuritySettingsPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.sessions(),
  });
  const [message, setMessage] = useState("");
  async function revoke(session: Session) {
    try {
      await api.revokeSession(session.id);
      await query.refetch();
      setMessage(t("sessionRevoked"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  async function revokeOthers() {
    try {
      await api.revokeOtherSessions();
      await query.refetch();
      setMessage(t("otherSessionsRevoked"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  return (
    <section className="settings-page utility-page">
      <UtilityPageHeader
        title={t("securitySettings")}
        onBack={() => navigate("/more")}
      />
      <SettingsNavigation user={user} active="security" navigate={navigate} />
      <div className="settings-page__body">
        <SettingsSection
          title={t("activeSessions")}
          description={t("activeSessionsHint")}
          icon={<MonitorSmartphone />}
        >
          <div className="session-list">
            {(query.data ?? []).map((session) => (
              <article key={session.id} className="session-card">
                <MonitorSmartphone />
                <span>
                  <strong>
                    {session.current
                      ? t("currentSession")
                      : session.user_agent || t("unknownDevice")}
                  </strong>
                  <small>
                    {new Date(session.last_seen_at).toLocaleString()} ·{" "}
                    {session.ip_address || t("unknownAddress")}
                  </small>
                </span>
                {session.current ? (
                  <Badge tone="primary">{t("current")}</Badge>
                ) : (
                  <Button size="sm" onClick={() => void revoke(session)}>
                    {t("revoke")}
                  </Button>
                )}
              </article>
            ))}
          </div>
          <Button onClick={() => void revokeOthers()}>
            <KeyRound />
            {t("logoutOtherDevices")}
          </Button>
        </SettingsSection>
        <span className="settings-success">{message}</span>
      </div>
    </section>
  );
}

function AuditSettingsPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const allowed = user.role !== "member";
  const query = useQuery({
    queryKey: ["organization-audit"],
    queryFn: () => api.organizationAudit(),
    enabled: allowed,
  });
  return (
    <section className="settings-page utility-page">
      <UtilityPageHeader
        title={t("auditSettings")}
        onBack={() => navigate("/more")}
      />
      <SettingsNavigation user={user} active="audit" navigate={navigate} />
      {!allowed ? (
        <SettingsAccessDenied />
      ) : (
        <div className="settings-page__body">
          <SettingsSection
            title={t("auditLog")}
            description={t("auditLogHint")}
            icon={<History />}
          >
            <div className="audit-list">
              {(query.data?.events ?? []).map((entry) => (
                <article key={entry.id}>
                  <span>
                    <strong>{entry.action}</strong>
                    <small>
                      {entry.actor_name || t("systemActor")} ·{" "}
                      {entry.target_type}
                    </small>
                  </span>
                  <time>{new Date(entry.created_at).toLocaleString()}</time>
                </article>
              ))}
            </div>
          </SettingsSection>
        </div>
      )}
    </section>
  );
}

type SettingsPageID =
  | "profile"
  | "workspace"
  | "customization"
  | "infrastructure"
  | "security"
  | "audit";
function SettingsNavigation({
  user,
  active,
  navigate,
}: {
  user: User;
  active: SettingsPageID;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const admin = user.role !== "member";
  const items: {
    id: SettingsPageID;
    path: string;
    label: string;
    icon: LucideIcon;
    admin?: boolean;
  }[] = [
    {
      id: "profile",
      path: "/settings/profile",
      label: t("profile"),
      icon: UserRound,
    },
    {
      id: "security",
      path: "/settings/security",
      label: t("security"),
      icon: ShieldCheck,
    },
    {
      id: "workspace",
      path: "/settings/workspace",
      label: t("workspace"),
      icon: Building2,
      admin: true,
    },
    {
      id: "customization",
      path: "/settings/customization",
      label: t("customization"),
      icon: Paintbrush,
      admin: true,
    },
    {
      id: "infrastructure",
      path: "/settings/infrastructure",
      label: t("connections"),
      icon: Server,
      admin: true,
    },
    {
      id: "audit",
      path: "/settings/audit",
      label: t("audit"),
      icon: History,
      admin: true,
    },
  ];
  return (
    <nav className="settings-navigation" aria-label={t("settingsNavigation")}>
      {items
        .filter((item) => !item.admin || admin)
        .map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={active === item.id ? "active" : ""}
              onClick={() => navigate(item.path)}
            >
              <Icon />
              {item.label}
            </button>
          );
        })}
    </nav>
  );
}
function SettingsSection({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <header>
        {icon}
        <span>
          <h2>{title}</h2>
          <p>{description}</p>
        </span>
      </header>
      <div className="settings-section__content">{children}</div>
    </section>
  );
}
function SettingsToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className="settings-toggle">
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
function SettingsAccessDenied() {
  const { t } = useTranslation();
  return (
    <div className="settings-access-denied">
      <ShieldCheck />
      <h2>{t("adminOnly")}</h2>
      <p>{t("adminOnlyHint")}</p>
    </div>
  );
}
function BrandingAssetCard({
  title,
  hint,
  imageURL,
  accept,
  onUpload,
  onRemove,
}: {
  title: string;
  hint: string;
  imageURL: string;
  accept: string;
  onUpload(files: FileList | null): void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article className="branding-asset-card">
      <div className="branding-asset-preview">
        {imageURL ? <img src={imageURL} alt="" /> : <Image />}
      </div>
      <span>
        <strong>{title}</strong>
        <small>{hint}</small>
      </span>
      <label className="ui-button ui-button--sm">
        <Upload />
        {t("upload")}
        <input
          type="file"
          accept={accept}
          onChange={(event) => onUpload(event.target.files)}
        />
      </label>
      {onRemove && (
        <Button size="sm" onClick={onRemove}>
          <Trash2 />
          {t("remove")}
        </Button>
      )}
    </article>
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
  const [source, setSource] = useState(
    `${apiURL}/api/v1/branding/logo?v=${Date.now()}`,
  );
  useEffect(() => {
    const refresh = () =>
      setSource(`${apiURL}/api/v1/branding/logo?v=${Date.now()}`);
    window.addEventListener("coma-branding-changed", refresh);
    return () => window.removeEventListener("coma-branding-changed", refresh);
  }, []);
  return (
    <div className={cx("brand-logo", `brand-logo--${size}`)}>
      <img
        src={source}
        alt=""
        onError={(event) => {
          if (!event.currentTarget.src.endsWith(comaLogo))
            event.currentTarget.src = comaLogo;
        }}
      />
      <span>Coma</span>
    </div>
  );
}
function applyPublicBranding(branding: PublicBranding, baseURL: string) {
  if (/^#[0-9A-Fa-f]{6}$/.test(branding.accent_color)) {
    const root = document.documentElement.style;
    root.setProperty("--coma-primary", branding.accent_color);
    root.setProperty(
      "--coma-primary-hover",
      `color-mix(in srgb, ${branding.accent_color} 82%, black)`,
    );
    root.setProperty(
      "--coma-primary-soft",
      `color-mix(in srgb, ${branding.accent_color} 16%, transparent)`,
    );
    root.setProperty("--coma-avatar-start", branding.accent_color);
  }
  document.title = branding.workspace_name
    ? `${branding.workspace_name} — Coma`
    : "Coma";
  let favicon = document.querySelector<HTMLLinkElement>(
    "link[rel='icon'][data-coma-branding]",
  );
  if (!favicon) {
    favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.dataset.comaBranding = "true";
    document.head.append(favicon);
  }
  favicon.href = branding.favicon_url
    ? `${baseURL}${branding.favicon_url}`
    : comaLogo;
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
  const resolved =
    value === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : value;
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "dark" ? "#181a1f" : "#f3f6fa");
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
function chatFilterFromURL(): ChatFilter {
  const search = new URLSearchParams(window.location.search);
  const folder = search.get("folder");
  if (folder) return `folder:${folder}`;
  const value = search.get("filter");
  return value === "direct" || value === "grouped" || value === "channel"
    ? value
    : "all";
}
