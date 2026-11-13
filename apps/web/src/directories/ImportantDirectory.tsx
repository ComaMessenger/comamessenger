import { useMemo, useState } from "react";
import { ArrowUpRight, Star, StarOff } from "lucide-react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  applySavedChange,
  chatAvatarSource,
  messagePlainText,
  savedKeys,
  type Chat,
  type SavedMessage,
} from "@comamessenger/core";
import { hasPermission } from "../settings";
import {
  Avatar,
  Button,
  Chip,
  EmptyState,
  InlineError,
  SkeletonRow,
  cx,
} from "../ui";
import { formatDay, formatListTime, minuteGap } from "../lib/format";
import { canManageChat, titleOf } from "../lib/chats";
import { useIsMobile, useIsNarrowDesktop } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { MessageRow } from "../conversation/MessageRow";
import {
  DirectoryDetailHead,
  DirectoryList,
  DirectoryRow,
  DirectorySplit,
} from "./DirectoryPage";
import { useChatMembers } from "./useChatMembers";

const visibleChatChips = 3;

/** The reader's saved messages, newest save first, page by page. */
function useSavedPages(chatID: string | null) {
  const { api, user } = useMessenger();
  return useInfiniteQuery({
    queryKey: savedKeys.list(user.id, chatID),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.savedMessages({ chatID: chatID ?? undefined, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

/** Chats with saves and how many, counted by the server over every save. */
function useSavedChats() {
  const { api, user } = useMessenger();
  return useQuery({
    queryKey: savedKeys.chats(user.id),
    queryFn: () => api.savedChats(),
  });
}

/**
 * «Important»: messages the reader saved for themselves. Nobody else sees
 * them; chat pins live in the chat's info instead.
 */
export function ImportantDirectory({ selectedID }: { selectedID?: string }) {
  const { t } = useTranslation();
  const { user, store, navigate } = useMessenger();
  const isMobile = useIsMobile();
  const narrow = useIsNarrowDesktop();
  const chatMap = useStore(store, (state) => state.chats);
  const [chatFilter, setChatFilter] = useState<string | null>(null);
  const [moreChips, setMoreChips] = useState(false);
  const all = useSavedPages(null);
  const filtered = useSavedPages(chatFilter);
  const query = chatFilter ? filtered : all;
  const allItems = useMemo(
    () => all.data?.pages.flatMap((page) => page.items) ?? [],
    [all.data],
  );
  const visible = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  const savedChats = useSavedChats();
  const chatFilters = savedChats.data ?? [];
  const activeID =
    selectedID ?? (!isMobile && !narrow ? visible[0]?.message.id : undefined);
  const active =
    visible.find((item) => item.message.id === activeID) ??
    allItems.find((item) => item.message.id === activeID);
  const shownChips = moreChips
    ? chatFilters
    : chatFilters.slice(0, visibleChatChips);
  const chatName = (item: SavedMessage) => {
    const chat = chatMap[item.chat.id];
    return chat ? titleOf(chat, [], user.id) : item.chat.display_name;
  };

  const list = (
    <DirectoryList
      title={t("important")}
      lead={t("importantLead")}
      chips={
        chatFilters.length > 1 && (
          <>
            <Chip
              active={chatFilter === null}
              onClick={() => setChatFilter(null)}
            >
              {t("importantAllChats")}
            </Chip>
            {shownChips.map(({ chat }) => (
              <Chip
                key={chat.id}
                active={chatFilter === chat.id}
                onClick={() =>
                  setChatFilter(chatFilter === chat.id ? null : chat.id)
                }
              >
                {chatMap[chat.id]
                  ? titleOf(chatMap[chat.id]!, [], user.id)
                  : chat.display_name}
              </Chip>
            ))}
            {!moreChips && chatFilters.length > visibleChatChips && (
              <Chip onClick={() => setMoreChips(true)}>
                {t("importantMoreChats", {
                  count: chatFilters.length - visibleChatChips,
                })}
              </Chip>
            )}
          </>
        )
      }
    >
      {query.isLoading ? (
        <>
          <SkeletonRow lines={["85%", "40%"]} />
          <SkeletonRow lines={["65%", "50%"]} />
          <SkeletonRow lines={["75%", "35%"]} />
        </>
      ) : query.isError ? (
        <InlineError
          center
          title={t("threadsLoadFailed")}
          onRetry={() => void query.refetch()}
          retryLabel={t("retry")}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Star />}
          title={t("importantEmpty")}
          hint={t("importantEmptyHint")}
        />
      ) : (
        <>
          {visible.map((item) => (
            <ImportantRow
              key={item.message.id}
              item={item}
              chat={chatMap[item.chat.id]}
              chatName={chatName(item)}
              selected={!isMobile && item.message.id === activeID}
              onOpen={() =>
                navigate(
                  isMobile
                    ? `/chat/${item.chat.id}?message=${item.message.id}`
                    : `/important/${item.message.id}`,
                )
              }
            />
          ))}
          {query.hasNextPage && (
            <div className="directory-list__more">
              <Button
                variant="ghost"
                size="sm"
                pending={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t("importantLoadMore")}
              </Button>
            </div>
          )}
        </>
      )}
    </DirectoryList>
  );

  if (isMobile) return list;
  return (
    <DirectorySplit
      list={list}
      detailOpen={Boolean(selectedID)}
      detail={
        active ? (
          <ImportantDetail
            key={active.message.id}
            item={active}
            chat={chatMap[active.chat.id]}
            savedInChat={
              chatFilters.find((entry) => entry.chat.id === active.chat.id)
                ?.count ?? 1
            }
            onBack={() => navigate("/important")}
            onRemoved={() => navigate("/important")}
          />
        ) : (
          <EmptyState
            className="directory-detail__empty"
            icon={<Star />}
            title={t("importantPickTitle")}
            hint={t("importantPickHint")}
          />
        )
      }
    />
  );
}

function ChatAvatar({
  item,
  chat,
  name,
}: {
  item: SavedMessage;
  chat?: Chat;
  name: string;
}) {
  return chat ? (
    <Avatar
      name={name}
      seed={chat.avatar_seed}
      {...chatAvatarSource(chat)}
      size="md"
    />
  ) : (
    <Avatar name={name} seed={item.chat.id} size="md" />
  );
}

function ImportantRow({
  item,
  chat,
  chatName,
  selected,
  onOpen,
}: {
  item: SavedMessage;
  chat?: Chat;
  chatName: string;
  selected: boolean;
  onOpen(): void;
}) {
  const { t } = useTranslation();
  const files = item.message.files.length;
  const text = messagePlainText(item.message.body).trim();
  return (
    <DirectoryRow
      className="directory-row--important"
      selected={selected}
      leading={<ChatAvatar item={item} chat={chat} name={chatName} />}
      top={
        <>
          <span className="truncate">{chatName}</span>
          <Star className="directory-row__star" aria-hidden="true" />
        </>
      }
      text={
        <>
          <strong className="directory-row__author">
            {item.author.display_name}:{" "}
          </strong>
          {text || (files > 0 ? t("importantFiles", { count: files }) : "")}
        </>
      }
      meta={
        <span className="truncate">
          {[
            formatListTime(item.message.created_at),
            t("importantSavedAt", { date: formatDay(item.saved_at) }),
          ].join(" · ")}
        </span>
      }
      onClick={onOpen}
    />
  );
}

/** The saved message in its chat context: two messages before and after. */
function ImportantDetail({
  item,
  chat,
  savedInChat,
  onBack,
  onRemoved,
}: {
  item: SavedMessage;
  chat?: Chat;
  savedInChat: number;
  onBack(): void;
  onRemoved(): void;
}) {
  const { t } = useTranslation();
  const { api, user, navigate } = useMessenger();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { members } = useChatMembers(item.chat.id);
  const [busy, setBusy] = useState(false);
  const context = useQuery({
    queryKey: ["message-context", item.message.id, 5],
    queryFn: () => api.messageContext(item.message.id, 5),
    staleTime: 60_000,
  });
  const chatName = chat
    ? titleOf(chat, members, user.id)
    : item.chat.display_name;
  const canModerate =
    hasPermission(user, "chats.moderate") ||
    (chat ? canManageChat(chat) : false);
  const messages = context.data?.messages ?? [item.message];
  const change = (saved: boolean) =>
    applySavedChange(queryClient, user.id, {
      messageID: item.message.id,
      chatID: item.chat.id,
      saved,
    });

  async function remove() {
    setBusy(true);
    try {
      await api.unsaveMessage(item.message.id);
      change(false);
      toast({
        message: t("importantRemoved"),
        action: {
          label: t("undo"),
          onClick: () =>
            void api.saveMessage(item.message.id).then(() => change(true)),
        },
      });
      onRemoved();
    } catch {
      toast({ message: t("actionFailed"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }
  const jump = () =>
    navigate(`/chat/${item.chat.id}?message=${item.message.id}`);

  return (
    <div className="important-detail">
      <DirectoryDetailHead
        onBack={onBack}
        leading={<ChatAvatar item={item} chat={chat} name={chatName} />}
        title={chatName}
        meta={[
          t("importantSavedAt", { date: formatDay(item.saved_at) }),
          t("importantInChat", { count: savedInChat }),
        ].join(" · ")}
        actions={
          <>
            <Chip size="lg" onClick={jump}>
              {t("threadJumpToMessage")}
            </Chip>
            <Chip size="lg" disabled={busy} onClick={() => void remove()}>
              <StarOff aria-hidden="true" />
              {t("importantRemove")}
            </Chip>
          </>
        }
      />
      <div className="important-detail__scroll">
        <div className="important-detail__column">
          {context.isLoading ? (
            <>
              <SkeletonRow avatar={36} lines={["40%", "100%"]} />
              <SkeletonRow avatar={36} lines={["30%", "70%"]} />
            </>
          ) : (
            <>
              {messages.length > 1 && (
                <div className="important-detail__hint">
                  {t("importantContextHint")}
                </div>
              )}
              {messages.map((message, index) => {
                const previous = messages[index - 1];
                const isTarget = message.id === item.message.id;
                return (
                  <div
                    key={message.id}
                    className={cx(
                      "important-detail__message",
                      isTarget
                        ? "important-detail__message--pinned"
                        : "important-detail__message--context",
                    )}
                  >
                    {isTarget && (
                      <span className="important-detail__label">
                        <Star aria-hidden="true" />
                        {t("savedLabel")}
                      </span>
                    )}
                    <MessageRow
                      message={message}
                      members={members}
                      author={members.find(
                        (member) => member.actor_id === message.actor_id,
                      )}
                      own={message.actor_id === user.id}
                      canModerate={canModerate}
                      grouped={
                        !isTarget &&
                        previous?.actor_id === message.actor_id &&
                        previous.id !== item.message.id &&
                        minuteGap(previous.created_at, message.created_at) < 5
                      }
                      chatName={chatName}
                      canPin={chat ? canManageChat(chat) : false}
                      compact
                      onReply={jump}
                      onJump={jump}
                      onRetry={() => undefined}
                      onThread={() =>
                        navigate(
                          `/chat/${item.chat.id}/thread/${message.thread_root_id ?? message.id}`,
                        )
                      }
                      onChanged={() => void context.refetch()}
                      domIDPrefix="important-message"
                    />
                  </div>
                );
              })}
              <div className="important-detail__footer">
                <button
                  type="button"
                  className="important-detail__open"
                  onClick={() => navigate(`/chat/${item.chat.id}`)}
                >
                  {t("importantOpenChat", { chat: chatName })}
                  <ArrowUpRight aria-hidden="true" />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
