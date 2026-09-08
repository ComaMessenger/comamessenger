import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileText, Hash, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { ActorSummary, Chat, DirectoryChat, SearchPage } from "@comamessenger/core";
import {
  Avatar,
  Chip,
  EmptyState,
  InlineError,
  Kbd,
  SkeletonRow,
  Tabs,
  Tag,
  cx,
} from "../ui";
import { messageOf } from "../errors";
import { isReadOnly, titleOf } from "../lib/chats";
import { formatListTime } from "../lib/format";
import { useIsMobile } from "../lib/useMediaQuery";
import { useMessenger, type SearchRequest } from "../shell/MessengerContext";
import { Highlight } from "./ActorPicker";

type Tab = "people" | "messages";
type SearchType = "all" | "message" | "file";

type Row =
  | { kind: "person"; actor: ActorSummary }
  | { kind: "chat"; chat: Chat }
  | { kind: "directory"; chat: DirectoryChat }
  | { kind: "result"; result: SearchPage["results"][number] };

export function SearchPalette({
  request,
  onClose,
  onOpen,
}: {
  request?: SearchRequest;
  onClose(): void;
  onOpen(chatID: string, messageID?: string): void;
}) {
  const { t } = useTranslation();
  const { api, user, store } = useMessenger();
  const isMobile = useIsMobile();
  const chatMap = useStore(store, (state) => state.chats);
  const presence = useStore(store, (state) => state.presence);
  const [query, setQuery] = useState(request?.query ?? "");
  const [tab, setTab] = useState<Tab>(request?.tab ?? "people");
  const [deferredQuery, setDeferredQuery] = useState(query.trim());
  const [searchType, setSearchType] = useState<SearchType>("all");
  const [searchChat, setSearchChat] = useState(request?.chatID ?? "");
  const [results, setResults] = useState<SearchPage | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const [opening, setOpening] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDeferredQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => setActive(0), [deferredQuery, tab, searchType, searchChat]);

  const people = useQuery({
    queryKey: ["actors", deferredQuery],
    queryFn: () => api.actors(deferredQuery),
    enabled: tab === "people",
    staleTime: 30_000,
  });
  const directory = useQuery({
    queryKey: ["chat-directory"],
    queryFn: () => api.discoverChats(),
    enabled: tab === "people",
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (tab !== "messages" || deferredQuery.length < 2) {
      setResults(null);
      return;
    }
    let alive = true;
    setPending(true);
    setError("");
    void api
      .search({ q: deferredQuery, type: searchType, chat_id: searchChat || undefined, limit: 30 })
      .then((page) => {
        if (alive) setResults(page);
      })
      .catch((cause) => {
        if (alive) setError(messageOf(cause));
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
    };
  }, [api, attempt, deferredQuery, searchChat, searchType, tab]);

  async function loadMore() {
    if (!results?.next_cursor || pending) return;
    setPending(true);
    try {
      const next = await api.search({
        q: deferredQuery,
        type: searchType,
        chat_id: searchChat || undefined,
        cursor: results.next_cursor,
        limit: 30,
      });
      setResults({ results: [...results.results, ...next.results], next_cursor: next.next_cursor });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  const needle = deferredQuery.toLocaleLowerCase();
  const chats = useMemo(() => Object.values(chatMap), [chatMap]);
  const peopleRows: Row[] = (people.data?.actors ?? [])
    .filter((actor) => actor.actor_id !== user.id)
    .slice(0, 6)
    .map((actor) => ({ kind: "person", actor }));
  const chatRows: Row[] = chats
    .filter((chat) => chat.kind !== "direct" && titleOf(chat, [], user.id).toLocaleLowerCase().includes(needle))
    .slice(0, 8)
    .map((chat) => ({ kind: "chat", chat }));
  const joinedIDs = new Set(chats.map((chat) => chat.id));
  const directoryRows: Row[] = (directory.data ?? [])
    .filter((chat) => !joinedIDs.has(chat.id) && chat.name.toLocaleLowerCase().includes(needle))
    .slice(0, 4)
    .map((chat) => ({ kind: "directory", chat }));
  const resultRows: Row[] = (results?.results ?? []).map((result) => ({ kind: "result", result }));
  const rows: Row[] = tab === "people" ? [...peopleRows, ...chatRows, ...directoryRows] : resultRows;
  const count = rows.length;

  async function openRow(row: Row) {
    if (opening) return;
    try {
      if (row.kind === "person") {
        const existing = chats.find(
          (chat) => chat.kind === "direct" && chat.direct_peer?.actor_id === row.actor.actor_id,
        );
        if (existing) return onOpen(existing.id);
        setOpening(true);
        const created = await api.createChat({
          kind: "direct",
          visibility: "private",
          name: "",
          topic: "",
          member_ids: [row.actor.actor_id],
        });
        store.setState((state) => ({ chats: { ...state.chats, [created.id]: created } }));
        onOpen(created.id);
      } else if (row.kind === "chat") onOpen(row.chat.id);
      else if (row.kind === "directory") {
        setOpening(true);
        const joined = await api.joinChat(row.chat.id);
        store.setState((state) => ({ chats: { ...state.chats, [joined.id]: joined } }));
        onOpen(joined.id);
      } else onOpen(row.result.chat_id, row.result.message_id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setOpening(false);
    }
  }

  function keyboard(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, Math.max(0, count - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      const row = rows[active];
      if (row) {
        event.preventDefault();
        void openRow(row);
      }
    } else if (event.key === "Tab") {
      event.preventDefault();
      setTab((current) => (current === "people" ? "messages" : "people"));
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-row-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const chatFilterName = searchChat ? titleOf(chatMap[searchChat], [], user.id) : "";
  const memberChatName = (chatID: string) =>
    chatMap[chatID] ? titleOf(chatMap[chatID], [], user.id) : t("chat");
  const authorName = (chatID: string, actorID: string) =>
    actorID === user.id
      ? user.display_name
      : chatMap[chatID]?.direct_peer?.actor_id === actorID
        ? chatMap[chatID]!.direct_peer!.display_name
        : t("participant");

  let index = -1;
  const rowIndex = () => (index += 1);
  const renderRow = (row: Row, children: ReactNode, extraClass?: string) => {
    const current = rowIndex();
    return (
      <button
        key={current}
        type="button"
        data-row-index={current}
        className={cx("search-palette__row", current === active && "search-palette__row--active", extraClass)}
        aria-selected={current === active}
        role="option"
        onMouseEnter={() => setActive(current)}
        onClick={() => void openRow(row)}
      >
        {children}
        {current === active && !isMobile && <Kbd>↵</Kbd>}
      </button>
    );
  };

  return (
    <div
      className="search-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="search-palette" role="dialog" aria-modal="true" aria-label={t("search")}>
        <span className="search-palette__handle" aria-hidden="true" />
        <div className="search-palette__head">
          <label className="search-palette__field">
            <Search aria-hidden="true" />
            <input
              ref={input}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={keyboard}
              placeholder={t("searchInWorkspace")}
              aria-label={t("search")}
            />
          </label>
          {isMobile ? (
            <button type="button" className="search-palette__cancel" onClick={onClose}>
              {t("cancel")}
            </button>
          ) : (
            <Kbd>Esc</Kbd>
          )}
        </div>
        <div className="search-palette__tabs">
          <Tabs<Tab>
            label={t("search")}
            value={tab}
            onChange={setTab}
            items={[
              { id: "people", label: t("chatsAndPeople") },
              { id: "messages", label: t("messagesAndThreads") },
            ]}
          />
          {tab === "messages" && (
            <div className="search-palette__filters" role="group" aria-label={t("searchFiltersLabel")}>
              {(["all", "message", "file"] as const).map((type) => (
                <Chip key={type} active={searchType === type} onClick={() => setSearchType(type)}>
                  {type === "all" ? t("all") : type === "message" ? t("messages") : t("files")}
                </Chip>
              ))}
              {searchChat && (
                <Chip onRemove={() => setSearchChat("")} removeLabel={t("searchRemoveChatFilter")}>
                  {chatFilterName}
                </Chip>
              )}
            </div>
          )}
        </div>
        <div className="search-palette__results" ref={list} role="listbox" aria-label={t("search")}>
          {tab === "people" ? (
            people.isLoading && deferredQuery ? (
              <>
                <SkeletonRow avatar={30} />
                <SkeletonRow avatar={30} />
              </>
            ) : count === 0 ? (
              <EmptyState compact title={t("nothingFound")} hint={t("searchNothingHint")} />
            ) : (
              <>
                {peopleRows.length > 0 && <span className="search-palette__section">{t("searchPeople")}</span>}
                {peopleRows.map((row) =>
                  row.kind === "person"
                    ? renderRow(
                        row,
                        <>
                          <Avatar
                            name={row.actor.display_name}
                            seed={row.actor.actor_id}
                            actorID={row.actor.actor_id}
                            avatarVersion={row.actor.avatar_version}
                            agent={row.actor.type === "agent"}
                            presence={row.actor.type === "agent" ? undefined : presence[row.actor.actor_id] ?? "offline"}
                            size="sm"
                          />
                          <strong className="truncate">
                            <Highlight text={row.actor.display_name} query={deferredQuery} />
                          </strong>
                          <small className="truncate">
                            @{row.actor.handle}
                            {row.actor.title ? ` · ${row.actor.title}` : ""}
                          </small>
                          {row.actor.type === "agent" && <Tag tone="agent">{t("agent")}</Tag>}
                        </>,
                      )
                    : null,
                )}
                {(chatRows.length > 0 || directoryRows.length > 0) && (
                  <span className="search-palette__section">{t("searchChatsSection")}</span>
                )}
                {chatRows.map((row) =>
                  row.kind === "chat"
                    ? renderRow(
                        row,
                        <>
                          <Avatar name={titleOf(row.chat, [], user.id)} seed={row.chat.avatar_seed} size="sm" />
                          <strong className="truncate">
                            <Highlight text={titleOf(row.chat, [], user.id)} query={deferredQuery} />
                          </strong>
                          <small className="truncate">
                            {row.chat.kind === "group"
                              ? t("chatMetaGroup")
                              : isReadOnly(row.chat)
                                ? t("chatMetaReadOnly")
                                : t("chatMetaChannel")}
                            {row.chat.topic ? ` · ${row.chat.topic}` : ""}
                          </small>
                        </>,
                      )
                    : null,
                )}
                {directoryRows.map((row) =>
                  row.kind === "directory"
                    ? renderRow(
                        row,
                        <>
                          <span className="search-palette__glyph" aria-hidden="true">
                            <Hash />
                          </span>
                          <strong className="truncate">
                            <Highlight text={row.chat.name} query={deferredQuery} />
                          </strong>
                          <small className="truncate">{t("searchChannelNotJoined")}</small>
                        </>,
                      )
                    : null,
                )}
              </>
            )
          ) : deferredQuery.length < 2 ? (
            <div className="search-palette__hint">{t("searchTypeMore")}</div>
          ) : pending && !results ? (
            <>
              <SkeletonRow avatar={30} />
              <SkeletonRow avatar={30} />
            </>
          ) : error ? (
            <InlineError title={t("searchUnavailable")} hint={error} onRetry={() => setAttempt((value) => value + 1)} retryLabel={t("retry")} center />
          ) : count === 0 ? (
            <EmptyState compact title={t("searchNothingFor", { query: deferredQuery })} hint={t("searchNothingHint")} />
          ) : (
            <>
              {resultRows.map((row) =>
                row.kind === "result"
                  ? renderRow(
                      row,
                      <div className="search-palette__result">
                        {row.result.kind === "file" ? (
                          <span className="search-palette__glyph" aria-hidden="true">
                            <FileText />
                          </span>
                        ) : (
                          <Avatar name={authorName(row.result.chat_id, row.result.actor_id)} seed={row.result.actor_id} actorID={row.result.actor_id} size="sm" />
                        )}
                        <span className="search-palette__result-body">
                          <span className="search-palette__result-head">
                            <strong className="truncate">
                              {row.result.kind === "file" ? (
                                <Highlight text={row.result.file_name ?? ""} query={deferredQuery} />
                              ) : (
                                authorName(row.result.chat_id, row.result.actor_id)
                              )}
                            </strong>
                            <small className="truncate">
                              {[row.result.thread_root_id ? t("searchInThread") : "", memberChatName(row.result.chat_id), formatListTime(row.result.created_at)]
                                .filter(Boolean)
                                .join(" · ")}
                            </small>
                          </span>
                          <span className="search-palette__snippet clamp-2">
                            <Highlight text={row.result.snippet} query={deferredQuery} />
                          </span>
                        </span>
                      </div>,
                      "search-palette__row--result",
                    )
                  : null,
              )}
              {results?.next_cursor && (
                <button type="button" className="search-palette__more" disabled={pending} onClick={() => void loadMore()}>
                  {t("loadMore")}
                </button>
              )}
            </>
          )}
        </div>
        {!isMobile && (
          <footer className="search-palette__footer" aria-hidden="true">
            <span>
              <Kbd>↑↓</Kbd> {t("searchNavigate")}
            </span>
            <span>
              <Kbd>↵</Kbd> {tab === "messages" ? t("searchGoToMessage") : t("searchOpenHint")}
            </span>
            <span>
              <Kbd>Tab</Kbd> {t("searchTabHint")}
            </span>
            <span className="search-palette__count">{t("searchResultCount", { count })}</span>
          </footer>
        )}
      </section>
    </div>
  );
}
