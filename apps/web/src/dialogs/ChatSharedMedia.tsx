import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, FileText, Image as ImageIcon, Link2, MessageSquare, Mic } from "lucide-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  groupSharedByMonth,
  isSharedVideo,
  isVoiceFile,
  messagePlainText,
  sharedItemKey,
  sharedItems,
  sharedKeys,
  sharedNextCursor,
  sharedPageSize,
  type ChatSharedAttachment,
  type ChatSharedAttachmentPage,
  type ChatSharedLink,
  type ChatSharedLinkPage,
  type SharedAttachmentKind,
} from "@comamessenger/core";
import { Avatar, Button, EmptyState, InlineError, Skeleton, SkeletonRow, cx } from "../ui";
import { activeLocale, formatBytes, formatListTime } from "../lib/format";
import { useMessenger } from "../shell/MessengerContext";
import { VoiceMessage } from "../conversation/VoiceMessage";
import { MediaViewer } from "./MediaViewer";
import { downloadToDisk, useObjectURL } from "./useObjectURL";

/** Numbers on the tabs, from the server: they do not depend on loaded pages. */
export function useSharedCounts(chatID: string) {
  const { api } = useMessenger();
  return useQuery({
    queryKey: sharedKeys.counts(chatID),
    queryFn: () => api.sharedCounts(chatID),
    retry: false,
  });
}

function useSharedAttachments(chatID: string, kind: SharedAttachmentKind) {
  const { api } = useMessenger();
  return useInfiniteQuery({
    queryKey: sharedKeys.tab(chatID, kind),
    queryFn: ({ pageParam }): Promise<ChatSharedAttachmentPage> =>
      api.sharedAttachments(chatID, kind, { cursor: pageParam, limit: sharedPageSize }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: sharedNextCursor,
    retry: false,
  });
}

function useSharedLinks(chatID: string) {
  const { api } = useMessenger();
  return useInfiniteQuery({
    queryKey: sharedKeys.tab(chatID, "links"),
    queryFn: ({ pageParam }): Promise<ChatSharedLinkPage> =>
      api.sharedLinks(chatID, { cursor: pageParam, limit: sharedPageSize }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: sharedNextCursor,
    retry: false,
  });
}

type Paged = {
  isLoading: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage(): unknown;
  refetch(): unknown;
};

/**
 * Loading, error, empty and «more» states shared by every tab. The next page
 * loads when its sentinel scrolls into view, or with the button.
 */
function TabState({
  query,
  empty,
  skeleton,
  children,
}: {
  query: Paged;
  empty: ReactNode | null;
  skeleton: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  if (query.isLoading) return <>{skeleton}</>;
  if (query.isError)
    return <InlineError title={t("attachmentsError")} onRetry={() => void query.refetch()} retryLabel={t("retry")} center />;
  if (empty) return <>{empty}</>;
  return (
    <>
      {children}
      {hasNextPage && (
        <div ref={sentinel} className="chat-shared__more">
          <Button size="sm" variant="ghost" pending={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            {t("sharedLoadMore")}
          </Button>
        </div>
      )}
    </>
  );
}

export function SharedMediaTab({
  chatID,
  onOpenMessage,
}: {
  chatID: string;
  onOpenMessage(messageID: string): void;
}) {
  const { t } = useTranslation();
  const query = useSharedAttachments(chatID, "media");
  const items = useMemo(() => sharedItems(query.data?.pages), [query.data]);
  const months = useMemo(() => groupSharedByMonth(items, activeLocale()), [items]);
  const [open, setOpen] = useState<number | null>(null);
  const indexOf = useMemo(() => new Map(items.map((item, index) => [sharedItemKey(item), index])), [items]);
  return (
    <TabState
      query={query}
      skeleton={
        <div className="chat-info__media-grid" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} shape="rect" className="chat-info__media-skeleton" />
          ))}
        </div>
      }
      empty={items.length === 0 ? <EmptyState compact icon={<ImageIcon />} title={t("mediaEmpty")} hint={t("mediaEmptyHint")} /> : null}
    >
      <div className="chat-shared__months">
        {months.map((month) => (
          <section key={month.key} className="chat-shared__month" aria-label={month.label}>
            <h3 className="chat-shared__month-label">{month.label}</h3>
            <div className="chat-info__media-grid">
              {month.items.map((item) => (
                <MediaTile key={sharedItemKey(item)} item={item} onOpen={() => setOpen(indexOf.get(sharedItemKey(item)) ?? 0)} />
              ))}
            </div>
          </section>
        ))}
      </div>
      {open !== null && (
        <MediaViewer
          items={items}
          index={open}
          onIndex={(index) => {
            setOpen(index);
            // Stepping to the last loaded item brings the next page.
            if (index >= items.length - 2 && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
          }}
          onClose={() => setOpen(null)}
          onOpenMessage={(item) => {
            setOpen(null);
            onOpenMessage(item.message_id);
          }}
        />
      )}
    </TabState>
  );
}

function MediaTile({ item, onOpen }: { item: ChatSharedAttachment; onOpen(): void }) {
  const { api } = useMessenger();
  const video = isSharedVideo(item);
  // A video shows its generated preview; a photo, its preview or itself.
  const previewID = item.file.preview_file_id ?? (video ? undefined : item.file.id);
  const preview = useObjectURL(api, previewID);
  return (
    <button
      type="button"
      className={cx("chat-info__media", video && "chat-info__media--video")}
      onClick={onOpen}
      title={item.file.name}
    >
      {preview ? <img src={preview} alt="" /> : <ImageIcon aria-hidden="true" />}
      {video && <span className="chat-info__play" aria-hidden="true" />}
      <span className="visually-hidden">{item.file.name}</span>
    </button>
  );
}

function extensionOf(name: string, mime: string) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name);
  return match ? match[1]!.toUpperCase() : (mime.split("/").pop() ?? "").toUpperCase();
}

export function SharedFilesTab({
  chatID,
  onOpenMessage,
}: {
  chatID: string;
  onOpenMessage(messageID: string): void;
}) {
  const { t } = useTranslation();
  const { api } = useMessenger();
  const query = useSharedAttachments(chatID, "files");
  const items = useMemo(() => sharedItems(query.data?.pages), [query.data]);
  return (
    <TabState
      query={query}
      skeleton={
        <>
          <SkeletonRow avatar={36} />
          <SkeletonRow avatar={36} />
        </>
      }
      empty={items.length === 0 ? <EmptyState compact icon={<FileText />} title={t("filesEmpty")} hint={t("filesEmptyHint")} /> : null}
    >
      <div className="chat-info__files">
        {items.map((item) => (
          <div key={sharedItemKey(item)} className="chat-info__file">
            <button type="button" className="chat-info__file-main" onClick={() => onOpenMessage(item.message_id)}>
              <span className="chat-info__file-icon" aria-hidden="true">
                <FileText />
              </span>
              <span className="chat-info__file-copy">
                <strong className="truncate">{item.file.name}</strong>
                <small className="truncate">
                  {[extensionOf(item.file.name, item.file.mime), formatBytes(item.file.size), item.author.display_name, formatListTime(item.created_at)]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
            </button>
            <button
              type="button"
              className="chat-info__download"
              aria-label={t("download")}
              onClick={() => void downloadToDisk(api, item.file.id, item.file.name)}
            >
              <Download aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </TabState>
  );
}

export function SharedVoiceTab({
  chatID,
  onOpenMessage,
}: {
  chatID: string;
  onOpenMessage(messageID: string): void;
}) {
  const { t } = useTranslation();
  const { api } = useMessenger();
  const query = useSharedAttachments(chatID, "voice");
  const items = useMemo(() => sharedItems(query.data?.pages), [query.data]);
  return (
    <TabState
      query={query}
      skeleton={
        <>
          <SkeletonRow avatar={28} />
          <SkeletonRow avatar={28} />
        </>
      }
      empty={items.length === 0 ? <EmptyState compact icon={<Mic />} title={t("voiceEmpty")} hint={t("voiceEmptyHint")} /> : null}
    >
      <div className="chat-shared__voices">
        {items.map((item) => (
          <div key={sharedItemKey(item)} className="chat-shared__voice">
            <div className="chat-shared__voice-head">
              <Avatar
                name={item.author.display_name}
                seed={item.author.actor_id}
                actorID={item.author.actor_id}
                avatarVersion={item.author.avatar_version}
                square={item.author.type === "agent"}
                size="xs"
              />
              <strong className="truncate">{item.author.display_name}</strong>
              <small>{formatListTime(item.created_at)}</small>
              <button
                type="button"
                className="chat-shared__goto"
                aria-label={t("sharedGoToMessage")}
                title={t("sharedGoToMessage")}
                onClick={() => onOpenMessage(item.message_id)}
              >
                <MessageSquare aria-hidden="true" />
              </button>
            </div>
            {isVoiceFile(item.file) ? (
              <VoiceMessage api={api} file={item.file} />
            ) : (
              <span className="chat-info__file-copy">{item.file.name}</span>
            )}
          </div>
        ))}
      </div>
    </TabState>
  );
}

/** Only http(s) ever becomes a link, whatever the server sends. */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

export function SharedLinksTab({
  chatID,
  onOpenMessage,
}: {
  chatID: string;
  onOpenMessage(messageID: string): void;
}) {
  const { t } = useTranslation();
  const query = useSharedLinks(chatID);
  const items = useMemo(() => sharedItems(query.data?.pages), [query.data]);
  return (
    <TabState
      query={query}
      skeleton={
        <>
          <SkeletonRow avatar={36} />
          <SkeletonRow avatar={36} />
        </>
      }
      empty={items.length === 0 ? <EmptyState compact icon={<Link2 />} title={t("linksEmpty")} hint={t("linksEmptyHint")} /> : null}
    >
      <div className="chat-shared__links">
        {items.map((item) => (
          <LinkRow key={sharedItemKey(item)} item={item} onOpenMessage={() => onOpenMessage(item.message_id)} />
        ))}
      </div>
    </TabState>
  );
}

function LinkRow({ item, onOpenMessage }: { item: ChatSharedLink; onOpenMessage(): void }) {
  const { t } = useTranslation();
  const href = safeHref(item.url);
  return (
    <div className="chat-shared__link">
      <span className="chat-shared__link-icon" aria-hidden="true">
        {(item.domain[0] ?? "#").toUpperCase()}
      </span>
      <span className="chat-shared__link-copy">
        {href ? (
          <a
            className="chat-shared__link-title truncate"
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={t("sharedOpenLink", { domain: item.domain })}
          >
            {item.label ?? item.domain}
          </a>
        ) : (
          <strong className="truncate">{item.label ?? item.domain}</strong>
        )}
        <small className="chat-shared__link-url truncate">{item.url}</small>
        {item.snippet && <span className="chat-shared__link-snippet clamp-2">{messagePlainText(item.snippet)}</span>}
        <small className="chat-shared__link-meta">
          {item.author.display_name} · {formatListTime(item.created_at)}
        </small>
      </span>
      <button
        type="button"
        className="chat-shared__goto"
        aria-label={t("sharedGoToMessage")}
        title={t("sharedGoToMessage")}
        onClick={onOpenMessage}
      >
        <MessageSquare aria-hidden="true" />
      </button>
    </div>
  );
}
