import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  AtSign,
  ChevronDown,
  Circle,
  Compass,
  FilePenLine,
  Globe2,
  Hash,
  Info,
  Lock,
  LogOut,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Search,
  Send,
  Settings,
  Smile,
  Star,
  Users,
} from "lucide-react";
import {
  APIError,
  MessengerAPI,
  type AcceptInvitationRequest,
  type BootstrapRequest,
  type Chat,
  type DirectoryChat,
  type User,
} from "@comamessenger/core";
import { Avatar, Badge, Button, Dialog, Field, FormError, IconButton, SelectField, TextareaField, cx } from "./ui";

type Screen = "loading" | "bootstrap" | "login" | "messenger" | "invite";
const apiURL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

export function App() {
  const api = useMemo(() => new MessengerAPI(apiURL), []);
  const [screen, setScreen] = useState<Screen>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (window.location.pathname.startsWith("/invite/")) {
      setScreen("invite");
      return;
    }
    api.bootstrapStatus().then(async (bootstrapped) => {
      if (!bootstrapped) {
        setScreen("bootstrap");
        return;
      }
      try {
        const session = await api.refresh();
        setUser(session.user);
        setScreen("messenger");
      } catch {
        setScreen("login");
      }
    }).catch((cause) => {
      setError(messageOf(cause));
      setScreen("login");
    });
  }, [api]);

  const authenticated = (nextUser: User) => {
    window.history.replaceState({}, "", "/");
    setUser(nextUser);
    setError("");
    setScreen("messenger");
  };

  if (screen === "loading") return <LoadingScreen />;
  if (screen === "bootstrap") return <BootstrapScreen api={api} error={error} onError={setError} onAuthenticated={authenticated} />;
  if (screen === "invite") return <InviteScreen api={api} error={error} onError={setError} onAuthenticated={authenticated} />;
  if (screen === "login" || !user) return <LoginScreen api={api} error={error} onError={setError} onAuthenticated={authenticated} />;
  return <MessengerScreen api={api} user={user} onLogout={() => { setUser(null); setScreen("login"); }} />;
}

function LoadingScreen() {
  return <main className="auth-shell"><Logo size="large" /><p className="loading-label">Запускаем пространство…</p></main>;
}

type AuthProps = {
  api: MessengerAPI;
  error: string;
  onError: (message: string) => void;
  onAuthenticated: (user: User) => void;
};

function LoginScreen({ api, error, onError, onAuthenticated }: AuthProps) {
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); onError("");
    const values = new FormData(event.currentTarget);
    try {
      const result = await api.login({ email: stringValue(values, "email"), password: stringValue(values, "password") });
      onAuthenticated(result.user);
    } catch (cause) { onError(messageOf(cause)); } finally { setPending(false); }
  }
  return (
    <AuthLayout title="Вход в ComaMessenger" lead="Введите данные рабочего аккаунта">
      <form className="auth-form" onSubmit={submit}>
        <Field label="Почта" name="email" type="email" autoComplete="email" placeholder="you@company.ru" />
        <Field label="Пароль" name="password" type="password" autoComplete="current-password" placeholder="Ваш пароль" />
        <FormError message={error} />
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Входим…" : "Войти"}</Button>
      </form>
    </AuthLayout>
  );
}

function BootstrapScreen({ api, error, onError, onAuthenticated }: AuthProps) {
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); onError("");
    const values = new FormData(event.currentTarget);
    const input: BootstrapRequest = {
      organization_name: stringValue(values, "organization_name"),
      organization_slug: stringValue(values, "organization_slug").toLowerCase(),
      display_name: stringValue(values, "display_name"),
      handle: stringValue(values, "handle").toLowerCase(),
      email: stringValue(values, "email"),
      password: stringValue(values, "password"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
    try { onAuthenticated((await api.bootstrap(input)).user); } catch (cause) { onError(messageOf(cause)); } finally { setPending(false); }
  }
  return (
    <AuthLayout title="Создайте пространство" lead="Первый аккаунт получит права владельца">
      <form className="auth-form auth-form--grid" onSubmit={submit}>
        <Field label="Название организации" name="organization_name" placeholder="Acme" />
        <Field label="Короткий адрес" name="organization_slug" placeholder="acme" pattern="[a-z0-9][a-z0-9-]{1,62}" />
        <Field label="Ваше имя" name="display_name" placeholder="Анна Смирнова" />
        <Field label="Никнейм" name="handle" placeholder="anna" pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{1,31}" />
        <Field label="Почта" name="email" type="email" autoComplete="email" placeholder="anna@company.ru" />
        <Field label="Пароль" hint="Минимум 10 символов" name="password" type="password" autoComplete="new-password" minLength={10} placeholder="Надёжный пароль" />
        <FormError message={error} />
        <Button className="form-span" type="submit" variant="primary" disabled={pending}>{pending ? "Создаём…" : "Создать пространство"}</Button>
      </form>
    </AuthLayout>
  );
}

function InviteScreen({ api, error, onError, onAuthenticated }: AuthProps) {
  const [pending, setPending] = useState(false);
  const token = decodeURIComponent(window.location.pathname.slice("/invite/".length));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); onError("");
    const values = new FormData(event.currentTarget);
    const input: AcceptInvitationRequest = {
      display_name: stringValue(values, "display_name"), handle: stringValue(values, "handle").toLowerCase(),
      password: stringValue(values, "password"), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
    try { onAuthenticated((await api.acceptInvitation(token, input)).user); } catch (cause) { onError(messageOf(cause)); } finally { setPending(false); }
  }
  return (
    <AuthLayout title="Присоединиться к команде" lead="Заполните профиль рабочего аккаунта">
      <form className="auth-form" onSubmit={submit}>
        <Field label="Ваше имя" name="display_name" placeholder="Анна Смирнова" />
        <Field label="Никнейм" name="handle" placeholder="anna" pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{1,31}" />
        <Field label="Пароль" hint="Минимум 10 символов" name="password" type="password" minLength={10} autoComplete="new-password" placeholder="Надёжный пароль" />
        <FormError message={error} />
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Присоединяем…" : "Присоединиться"}</Button>
      </form>
    </AuthLayout>
  );
}

function AuthLayout({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
  return <main className="auth-shell"><section className="auth-panel"><Logo /><h1>{title}</h1><p>{lead}</p>{children}</section><small className="auth-footer">Open source · Self-hosted</small></main>;
}

function Logo({ size = "normal" }: { size?: "normal" | "large" }) {
  return <div className={cx("brand", size === "large" && "brand--large")}><span className="brand__mark"><MessagesSquare size={size === "large" ? 24 : 18} /></span><strong>ComaMessenger</strong></div>;
}

function MessengerScreen({ api, user, onLogout }: { api: MessengerAPI; user: User; onLogout: () => void }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "discover" | null>(null);
  const [directory, setDirectory] = useState<DirectoryChat[]>([]);
  const [error, setError] = useState("");

  const loadChats = useCallback(async () => {
    try {
      const result = await api.chats(); setChats(result); setSelectedID((current) => current ?? result[0]?.id ?? null);
    } catch (cause) { setError(messageOf(cause)); }
  }, [api]);
  useEffect(() => { void loadChats(); }, [loadChats]);

  const selected = chats.find((chat) => chat.id === selectedID) ?? null;
  const sharedChats = chats.filter((chat) => chat.kind !== "direct");
  const directChats = chats.filter((chat) => chat.kind === "direct");

  async function openDirectory() {
    setError(""); setDialog("discover");
    try { setDirectory(await api.discoverChats()); } catch (cause) { setError(messageOf(cause)); }
  }
  async function logout() { try { await api.logout(); } finally { onLogout(); } }

  return (
    <main className="messenger-shell">
      <aside className="sidebar">
        <button className="workspace-switcher"><Logo /><ChevronDown size={14} /><span className="workspace-switcher__grow" /><Settings size={16} /></button>
        <div className="search-actions">
          <Button className="search-button" size="sm"><Search size={17} /><span>Поиск</span><kbd>⌘ K</kbd></Button>
          <IconButton className="create-button" label="Создать чат" onClick={() => setDialog("create")}><Plus size={19} /></IconButton>
        </div>
        <nav className="sidebar-nav" aria-label="Рабочие разделы">
          <SidebarShortcut icon={<MessageCircle size={18} />} label="Треды" />
          <SidebarShortcut icon={<Star size={18} />} label="Важное" />
          <SidebarShortcut icon={<Bell size={18} />} label="Напоминания" />
          <SidebarShortcut icon={<Users size={18} />} label="Участники" />
          <SidebarShortcut icon={<FilePenLine size={18} />} label="Черновики" />
        </nav>
        <div className="chat-scroll">
          <ChatFolder title="Чаты и каналы" count={sharedChats.length} action={openDirectory} actionLabel="Обзор">
            {sharedChats.map((chat) => <ChatRow key={chat.id} chat={chat} active={selectedID === chat.id} onClick={() => setSelectedID(chat.id)} />)}
            {!sharedChats.length && <button className="folder-add" onClick={() => setDialog("create")}><Plus size={16} /> Добавить</button>}
          </ChatFolder>
          <ChatFolder title="Личные сообщения" count={directChats.length}>
            {directChats.map((chat) => <ChatRow key={chat.id} chat={chat} active={selectedID === chat.id} onClick={() => setSelectedID(chat.id)} />)}
            {!directChats.length && <div className="folder-hint">Пока нет диалогов</div>}
          </ChatFolder>
        </div>
        <div className="sidebar-profile">
          <Avatar name={user.display_name} size="sm" online />
          <div><strong>{user.display_name}</strong><span>@{user.handle}</span></div>
          <IconButton label="Уведомления"><Bell size={17} /></IconButton>
          <IconButton label="Выйти" onClick={logout}><LogOut size={17} /></IconButton>
        </div>
      </aside>

      <section className="conversation">
        {selected ? <Conversation chat={selected} /> : <WorkspaceEmpty onCreate={() => setDialog("create")} />}
      </section>

      {dialog === "create" && <CreateChatDialog api={api} canCreateChannel={user.role !== "member"} onClose={() => setDialog(null)} onCreated={(chat) => { setChats((items) => [chat, ...items]); setSelectedID(chat.id); setDialog(null); }} />}
      {dialog === "discover" && <DirectoryDialog chats={directory} error={error} onClose={() => setDialog(null)} onJoin={async (id) => { const chat = await api.joinChat(id); setChats((items) => [chat, ...items]); setSelectedID(chat.id); setDirectory((items) => items.filter((item) => item.id !== id)); }} />}
    </main>
  );
}

function SidebarShortcut({ icon, label }: { icon: React.ReactNode; label: string }) {
  return <button className="sidebar-shortcut" disabled title={`${label} появится в следующих фазах`}>{icon}<span>{label}</span></button>;
}

function ChatFolder({ title, count, action, actionLabel, children }: { title: string; count: number; action?: () => void; actionLabel?: string; children: React.ReactNode }) {
  return <section className="chat-folder"><div className="chat-folder__head"><button><ChevronDown size={14} />{title}</button><span>{count || ""}</span>{action && <button className="chat-folder__action" onClick={action}>{actionLabel}</button>}</div><div className="chat-folder__items">{children}</div></section>;
}

function ChatRow({ chat, active, onClick }: { chat: Chat; active: boolean; onClick: () => void }) {
  return <button className={cx("chat-row", active && "chat-row--active")} onClick={onClick}><ChatGlyph kind={chat.kind} /><span>{chatTitle(chat)}</span>{chat.visibility === "private" && chat.kind !== "direct" && <Lock size={12} />}</button>;
}

function ChatGlyph({ kind, size = 16 }: { kind: string; size?: number }) {
  if (kind === "channel") return <Megaphone size={size} />;
  if (kind === "direct") return <Circle size={size} fill="currentColor" />;
  return <Hash size={size} />;
}

function Conversation({ chat }: { chat: Chat }) {
  return <>
    <header className="conversation-header">
      <span className="conversation-header__glyph"><ChatGlyph kind={chat.kind} size={18} /></span>
      <div><h2>{chatTitle(chat)}</h2><p>{chat.topic || (chat.kind === "channel" ? "Канал для объявлений" : "Рабочий чат")}</p></div>
      <span className="conversation-header__grow" />
      <button className="chat-search"><Search size={16} /><span>Поиск по чату…</span></button>
      {chat.kind === "channel" && <Badge tone="primary">Канал</Badge>}
      <IconButton label="Участники"><Users size={18} /></IconButton>
      <IconButton label="Информация о чате"><Info size={18} /></IconButton>
      <IconButton label="Ещё"><MoreHorizontal size={18} /></IconButton>
    </header>
    <div className="conversation-body">
      <div className="chat-start"><span><ChatGlyph kind={chat.kind} size={28} /></span><h1>{chatTitle(chat)}</h1><p>{chat.kind === "channel" ? "Здесь публикуют объявления владельцы и администраторы." : "Это начало чата. Сообщения появятся в следующем инкременте."}</p></div>
      <article className="message-row">
        <Avatar name="ComaMessenger" size="md" />
        <div className="message-row__content">
          <header><strong>ComaMessenger</strong><time>сейчас</time></header>
          <p>Чат создан. Здесь появятся сообщения команды, ответы в тредах и реакции.</p>
          <button className="thread-chip" disabled><MessageCircle size={15} /><span>Комментарии</span></button>
        </div>
        <div className="message-actions"><IconButton label="Реакция"><Smile size={16} /></IconButton><IconButton label="Обсудить"><MessageCircle size={16} /></IconButton><IconButton label="Ещё"><MoreHorizontal size={16} /></IconButton></div>
      </article>
    </div>
    <div className="composer-wrap"><div className="composer"><IconButton label="Прикрепить файл" disabled><Paperclip size={19} /></IconButton><span>Написать сообщение…</span><IconButton label="Упомянуть" disabled><AtSign size={19} /></IconButton><IconButton label="Эмодзи" disabled><Smile size={19} /></IconButton><IconButton className="composer-send" label="Отправить" disabled><Send size={18} /></IconButton></div></div>
  </>;
}

function WorkspaceEmpty({ onCreate }: { onCreate: () => void }) {
  return <div className="workspace-empty"><div className="empty-graphic"><MessagesSquare size={32} /></div><h1>Создайте первый чат</h1><p>Обсуждайте работу в чатах или публикуйте новости в каналах.</p><div><Button size="sm" onClick={onCreate}>Разработка</Button><Button size="sm" onClick={onCreate}>Маркетинг</Button><Button size="sm" onClick={onCreate}><Plus size={16} /> Свой чат</Button></div></div>;
}

function CreateChatDialog({ api, canCreateChannel, onClose, onCreated }: { api: MessengerAPI; canCreateChannel: boolean; onClose: () => void; onCreated: (chat: Chat) => void }) {
  const [kind, setKind] = useState<"group" | "channel">("group");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    const values = new FormData(event.currentTarget);
    try { onCreated(await api.createChat({ kind, visibility: stringValue(values, "visibility") as "private" | "public", name: stringValue(values, "name"), topic: stringValue(values, "topic") })); }
    catch (cause) { setError(messageOf(cause)); } finally { setPending(false); }
  }
  return <Dialog title="Создать чат" description="Выберите формат общения и доступ" onClose={onClose}>
    <div className="type-switch">
      <button className={cx(kind === "group" && "active")} onClick={() => setKind("group")}><MessagesSquare size={20} /><span><strong>Чат</strong><small>Все участники могут писать</small></span></button>
      <button className={cx(kind === "channel" && "active")} disabled={!canCreateChannel} onClick={() => setKind("channel")}><Megaphone size={20} /><span><strong>Канал</strong><small>Пишут только администраторы</small></span></button>
    </div>
    <form className="dialog-form" onSubmit={submit}>
      <Field label="Название" name="name" maxLength={120} placeholder={kind === "group" ? "Команда продукта" : "Важные объявления"} />
      <TextareaField label="Описание" name="topic" maxLength={500} placeholder="О чём здесь говорят" />
      <SelectField label="Доступ" name="visibility"><option value="private">Закрытый — по приглашению</option><option value="public">Открытый — можно найти и вступить</option></SelectField>
      <FormError message={error} />
      <div className="dialog-actions"><Button onClick={onClose}>Отмена</Button><Button type="submit" variant="primary" disabled={pending}>{pending ? "Создаём…" : "Создать"}</Button></div>
    </form>
  </Dialog>;
}

function DirectoryDialog({ chats, error, onClose, onJoin }: { chats: DirectoryChat[]; error: string; onClose: () => void; onJoin: (id: string) => Promise<void> }) {
  const [joining, setJoining] = useState<string | null>(null);
  const [localError, setLocalError] = useState("");
  return <Dialog title="Обзор чатов" description="Открытые чаты и каналы пространства" onClose={onClose}>
    <div className="directory-search"><Search size={17} /><span>Поиск по открытым чатам</span></div>
    <div className="directory-list">
      {chats.map((chat) => <div className="directory-row" key={chat.id}><span className="directory-row__icon"><ChatGlyph kind={chat.kind} /></span><div><strong>{chat.name}</strong><span>{chat.topic || (chat.kind === "channel" ? "Канал" : "Чат")}</span></div><Button size="sm" disabled={joining === chat.id} onClick={async () => { setJoining(chat.id); setLocalError(""); try { await onJoin(chat.id); } catch (cause) { setLocalError(messageOf(cause)); } finally { setJoining(null); } }}>Вступить</Button></div>)}
      {!chats.length && !error && <div className="dialog-empty"><Compass size={24} /><span>Новых открытых чатов пока нет</span></div>}
    </div><FormError message={localError || error} />
  </Dialog>;
}

function chatTitle(chat: Chat) { return chat.name ?? "Личный чат"; }
function stringValue(values: FormData, key: string) { return String(values.get(key) ?? "").trim(); }
function messageOf(cause: unknown) {
  if (cause instanceof APIError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "Не удалось выполнить запрос. Проверьте соединение и попробуйте ещё раз.";
}
