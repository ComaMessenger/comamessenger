import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  APIError,
  MessengerAPI,
  type AcceptInvitationRequest,
  type BootstrapRequest,
  type Chat,
  type DirectoryChat,
  type User,
} from "@comamessenger/core";

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
    api
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
        } catch {
          setScreen("login");
        }
      })
      .catch((cause) => {
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
  if (screen === "bootstrap") {
    return <BootstrapScreen api={api} error={error} onError={setError} onAuthenticated={authenticated} />;
  }
  if (screen === "invite") {
    return <InviteScreen api={api} error={error} onError={setError} onAuthenticated={authenticated} />;
  }
  if (screen === "login" || !user) {
    return <LoginScreen api={api} error={error} onError={setError} onAuthenticated={authenticated} />;
  }
  return (
    <MessengerScreen
      api={api}
      user={user}
      onLogout={() => {
        setUser(null);
        setScreen("login");
      }}
    />
  );
}

function LoadingScreen() {
  return (
    <main className="auth-shell">
      <div className="brand-mark" aria-hidden="true">C</div>
      <p className="loading-label">Запускаем рабочее пространство…</p>
    </main>
  );
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
    event.preventDefault();
    setPending(true);
    onError("");
    const values = new FormData(event.currentTarget);
    try {
      const result = await api.login({ email: stringValue(values, "email"), password: stringValue(values, "password") });
      onAuthenticated(result.user);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout eyebrow="С возвращением" title="Войдите в ComaMessenger" lead="Все рабочие чаты — в одном спокойном пространстве.">
      <form className="auth-form" onSubmit={submit}>
        <Field label="Почта" name="email" type="email" autoComplete="email" placeholder="you@company.ru" />
        <Field label="Пароль" name="password" type="password" autoComplete="current-password" placeholder="Ваш пароль" />
        <FormError message={error} />
        <button className="button button--primary" disabled={pending}>{pending ? "Входим…" : "Войти"}</button>
      </form>
    </AuthLayout>
  );
}

function BootstrapScreen({ api, error, onError, onAuthenticated }: AuthProps) {
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    onError("");
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
    try {
      const result = await api.bootstrap(input);
      onAuthenticated(result.user);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout eyebrow="Первый запуск" title="Создайте своё пространство" lead="Этот аккаунт станет первым владельцем инсталляции.">
      <form className="auth-form auth-form--grid" onSubmit={submit}>
        <Field label="Название организации" name="organization_name" placeholder="Acme" />
        <Field label="Короткий адрес" name="organization_slug" placeholder="acme" pattern="[a-z0-9][a-z0-9-]{1,62}" />
        <Field label="Ваше имя" name="display_name" placeholder="Анна Смирнова" />
        <Field label="Никнейм" name="handle" placeholder="anna" pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{1,31}" />
        <Field label="Почта" name="email" type="email" autoComplete="email" placeholder="anna@company.ru" />
        <Field label="Пароль · от 10 символов" name="password" type="password" autoComplete="new-password" minLength={10} placeholder="Надёжный пароль" />
        <FormError message={error} />
        <button className="button button--primary form-span" disabled={pending}>{pending ? "Создаём…" : "Создать пространство"}</button>
      </form>
    </AuthLayout>
  );
}

function InviteScreen({ api, error, onError, onAuthenticated }: AuthProps) {
  const [pending, setPending] = useState(false);
  const token = decodeURIComponent(window.location.pathname.slice("/invite/".length));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    onError("");
    const values = new FormData(event.currentTarget);
    const input: AcceptInvitationRequest = {
      display_name: stringValue(values, "display_name"),
      handle: stringValue(values, "handle").toLowerCase(),
      password: stringValue(values, "password"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
    try {
      const result = await api.acceptInvitation(token, input);
      onAuthenticated(result.user);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout eyebrow="Приглашение" title="Присоединяйтесь к команде" lead="Осталось выбрать имя и пароль для входа.">
      <form className="auth-form" onSubmit={submit}>
        <Field label="Ваше имя" name="display_name" placeholder="Анна Смирнова" />
        <Field label="Никнейм" name="handle" placeholder="anna" pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{1,31}" />
        <Field label="Пароль · от 10 символов" name="password" type="password" minLength={10} autoComplete="new-password" placeholder="Надёжный пароль" />
        <FormError message={error} />
        <button className="button button--primary" disabled={pending}>{pending ? "Присоединяем…" : "Присоединиться"}</button>
      </form>
    </AuthLayout>
  );
}

function AuthLayout({ eyebrow, title, lead, children }: { eyebrow: string; title: string; lead: string; children: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="brand"><span className="brand-mark">C</span><span>ComaMessenger</span></div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="lead">{lead}</p>
        {children}
      </section>
    </main>
  );
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string; name: string }) {
  const { label, ...inputProps } = props;
  return <label className="field"><span>{label}</span><input {...inputProps} required /></label>;
}

function FormError({ message }: { message: string }) {
  return message ? <div className="form-error form-span" role="alert">{message}</div> : null;
}

function MessengerScreen({ api, user, onLogout }: { api: MessengerAPI; user: User; onLogout: () => void }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "discover" | null>(null);
  const [directory, setDirectory] = useState<DirectoryChat[]>([]);
  const [error, setError] = useState("");

  const loadChats = useCallback(async () => {
    try {
      const result = await api.chats();
      setChats(result);
      setSelectedID((current) => current ?? result[0]?.id ?? null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [api]);

  useEffect(() => { void loadChats(); }, [loadChats]);
  const selected = chats.find((chat) => chat.id === selectedID) ?? null;

  async function openDirectory() {
    setError("");
    setDialog("discover");
    try { setDirectory(await api.discoverChats()); } catch (cause) { setError(messageOf(cause)); }
  }

  async function logout() {
    try { await api.logout(); } finally { onLogout(); }
  }

  return (
    <main className="messenger">
      <aside className="sidebar">
        <div className="workspace-head">
          <div className="workspace-logo">C</div>
          <div><strong>ComaMessenger</strong><span>Рабочее пространство</span></div>
          <button className="icon-button" aria-label="Настройки">•••</button>
        </div>
        <div className="sidebar-actions">
          <button className="button button--primary button--compact" onClick={() => setDialog("create")}>＋ Создать</button>
          <button className="icon-button icon-button--bordered" aria-label="Найти публичные чаты" onClick={openDirectory}>⌕</button>
        </div>
        <nav className="chat-list" aria-label="Чаты">
          <div className="nav-title"><span>Чаты</span><span>{chats.length}</span></div>
          {chats.map((chat) => (
            <button key={chat.id} className={`chat-row ${selectedID === chat.id ? "chat-row--active" : ""}`} onClick={() => setSelectedID(chat.id)}>
              <ChatIcon kind={chat.kind} />
              <span className="chat-row__copy"><strong>{chatTitle(chat)}</strong><small>{chat.kind === "channel" ? "Только администраторы пишут" : chat.topic || "Новый чат"}</small></span>
            </button>
          ))}
          {!chats.length && <div className="empty-sidebar">Пока тихо. Создайте первый чат.</div>}
        </nav>
        <div className="profile">
          <Avatar name={user.display_name} />
          <div><strong>{user.display_name}</strong><span>@{user.handle}</span></div>
          <button className="icon-button" onClick={logout} aria-label="Выйти">↗</button>
        </div>
      </aside>

      <section className="conversation">
        {selected ? (
          <>
            <header className="conversation-head">
              <ChatIcon kind={selected.kind} large />
              <div><h2>{chatTitle(selected)}</h2><p>{selected.topic || (selected.kind === "channel" ? "Информационный канал" : "Общий чат команды")}</p></div>
              <span className="role-pill">{selected.role}</span>
            </header>
            <div className="conversation-empty">
              <div className="empty-illustration"><span>✦</span></div>
              <h3>{selected.kind === "channel" ? "Канал готов к публикациям" : "Начало нового разговора"}</h3>
              <p>Состав, роли и доступ уже работают. Сообщения и realtime появятся в следующем вертикальном инкременте.</p>
            </div>
            <div className="composer composer--disabled"><span>＋</span><span>Сообщения — следующий этап</span><button disabled>↑</button></div>
          </>
        ) : (
          <div className="conversation-empty conversation-empty--full"><div className="empty-illustration"><span>✦</span></div><h2>Выберите или создайте чат</h2><p>Группы — для общения, каналы — для объявлений администраторов.</p></div>
        )}
      </section>

      {dialog === "create" && <CreateChatDialog api={api} canCreateChannel={user.role !== "member"} onClose={() => setDialog(null)} onCreated={(chat) => { setChats((items) => [chat, ...items]); setSelectedID(chat.id); setDialog(null); }} />}
      {dialog === "discover" && <DirectoryDialog chats={directory} error={error} onClose={() => setDialog(null)} onJoin={async (id) => { const chat = await api.joinChat(id); setChats((items) => [chat, ...items]); setSelectedID(chat.id); setDirectory((items) => items.filter((item) => item.id !== id)); }} />}
    </main>
  );
}

function CreateChatDialog({ api, canCreateChannel, onClose, onCreated }: { api: MessengerAPI; canCreateChannel: boolean; onClose: () => void; onCreated: (chat: Chat) => void }) {
  const [kind, setKind] = useState<"group" | "channel">("group");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const values = new FormData(event.currentTarget);
    try {
      onCreated(await api.createChat({ kind, visibility: stringValue(values, "visibility") as "private" | "public", name: stringValue(values, "name"), topic: stringValue(values, "topic") }));
    } catch (cause) { setError(messageOf(cause)); } finally { setPending(false); }
  }

  return (
    <Dialog title="Новое пространство для общения" onClose={onClose}>
      <div className="kind-switch">
        <button className={kind === "group" ? "active" : ""} onClick={() => setKind("group")}><strong>Чат</strong><span>Все участники могут писать</span></button>
        <button className={kind === "channel" ? "active" : ""} disabled={!canCreateChannel} onClick={() => setKind("channel")}><strong>Канал</strong><span>Пишут только администраторы</span></button>
      </div>
      <form className="auth-form" onSubmit={submit}>
        <Field label="Название" name="name" maxLength={120} placeholder={kind === "group" ? "Команда продукта" : "Важные объявления"} />
        <label className="field"><span>Описание</span><textarea name="topic" maxLength={500} placeholder="О чём здесь говорят" /></label>
        <label className="field"><span>Доступ</span><select name="visibility"><option value="private">Только по приглашению</option><option value="public">Можно найти и вступить</option></select></label>
        <FormError message={error} />
        <button className="button button--primary" disabled={pending}>{pending ? "Создаём…" : `Создать ${kind === "group" ? "чат" : "канал"}`}</button>
      </form>
    </Dialog>
  );
}

function DirectoryDialog({ chats, error, onClose, onJoin }: { chats: DirectoryChat[]; error: string; onClose: () => void; onJoin: (id: string) => Promise<void> }) {
  const [joining, setJoining] = useState<string | null>(null);
  const [localError, setLocalError] = useState("");
  return (
    <Dialog title="Публичные чаты" onClose={onClose}>
      <p className="dialog-lead">Открытые группы и каналы вашей организации.</p>
      <div className="directory-list">
        {chats.map((chat) => <div className="directory-row" key={chat.id}><ChatIcon kind={chat.kind} /><div><strong>{chat.name}</strong><span>{chat.topic || (chat.kind === "channel" ? "Канал" : "Чат")}</span></div><button className="button button--ghost button--compact" disabled={joining === chat.id} onClick={async () => { setJoining(chat.id); setLocalError(""); try { await onJoin(chat.id); } catch (cause) { setLocalError(messageOf(cause)); } finally { setJoining(null); } }}>Вступить</button></div>)}
        {!chats.length && !error && <div className="dialog-empty">Новых публичных чатов пока нет.</div>}
      </div>
      <FormError message={localError || error} />
    </Dialog>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-label={title}><div className="dialog-head"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть">×</button></div>{children}</section></div>;
}

function ChatIcon({ kind, large = false }: { kind: string; large?: boolean }) {
  return <span className={`chat-icon chat-icon--${kind} ${large ? "chat-icon--large" : ""}`}>{kind === "channel" ? "◉" : kind === "direct" ? "●" : "#"}</span>;
}

function Avatar({ name }: { name: string }) {
  const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return <span className="avatar">{initials || "U"}</span>;
}

function chatTitle(chat: Chat): string {
  return chat.name ?? "Личный чат";
}

function stringValue(values: FormData, key: string): string {
  return String(values.get(key) ?? "").trim();
}

function messageOf(cause: unknown): string {
  if (cause instanceof APIError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "Не удалось выполнить запрос. Проверьте соединение и попробуйте ещё раз.";
}
