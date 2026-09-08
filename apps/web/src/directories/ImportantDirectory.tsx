import { useMemo, useState } from "react";
import { ArrowUpRight, Pin, PinOff, Star } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { messagePlainText, type Chat, type Message, type MessagePin } from "@comamessenger/core";
import { hasPermission } from "../settings";
import { Avatar, Chip, EmptyState, InlineError, SkeletonRow, cx } from "../ui";
import { formatDay, formatListTime, minuteGap } from "../lib/format";
import { canManageChat, titleOf } from "../lib/chats";
import { useIsMobile, useIsNarrowDesktop } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { MessageRow } from "../conversation/MessageRow";
import { DirectoryDetailHead, DirectoryList, DirectoryRow, DirectorySplit } from "./DirectoryPage";
import { useChatMembers } from "./useChatMembers";

type ImportantItem = { chat: Chat; message: Message; pin: MessagePin };

const visibleChatChips = 3;

export function ImportantDirectory({ selectedID }: { selectedID?: string }) {
  const { t } = useTranslation();
  const { api, user, store, navigate } = useMessenger();
  const isMobile = useIsMobile();
  const narrow = useIsNarrowDesktop();
  const chatMap = useStore(store, (state) => state.chats);
  const chats = useMemo(() => Object.values(chatMap), [chatMap]);
  const chatKey = chats.map((chat) => chat.id).sort().join(":");
  const [chatFilter, setChatFilter] = useState<string | null>(null);
  const [moreChips, setMoreChips] = useState(false);
  const query = useQuery({
    queryKey: ["important", chatKey],
    enabled: chats.length > 0,
    queryFn: async (): Promise<ImportantItem[]> => {
      const pinned = (
        await Promise.all(
          chats.map(async (chat) => (await api.pins(chat.id)).map((pin) => ({ chat, pin }))),
        )
      ).flat();
      const resolved = await Promise.all(
        pinned.map(async ({ chat, pin }) => {
          const context = await api.messageContext(pin.message_id, 1);
          const message = context.messages.find((item) => item.id === pin.message_id);
          return message ? { chat, message, pin } : null;
        }),
      );
      const seen = new Set<string>();
      return resolved
        .filter((item): item is ImportantItem => Boolean(item))
        .filter((item) => {
          if (seen.has(item.message.id)) return false;
          seen.add(item.message.id);
          return true;
        })
        .sort((left, right) => right.pin.pinned_at.localeCompare(left.pin.pinned_at));
    },
  });
  const items = useMemo(() => query.data ?? [], [query.data]);
  const loading = query.isLoading || (chats.length === 0 && !query.data);
  const chatsWithPins = useMemo(() => {
    const counts = new Map<string, { chat: Chat; count: number }>();
    for (const item of items) {
      const entry = counts.get(item.chat.id) ?? { chat: item.chat, count: 0 };
      entry.count += 1;
      counts.set(item.chat.id, entry);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [items]);
  const visible = chatFilter ? items.filter((item) => item.chat.id === chatFilter) : items;
  const activeID = selectedID ?? (!isMobile && !narrow ? visible[0]?.message.id : undefined);
  const active = items.find((item) => item.message.id === activeID);
  const shownChips = moreChips ? chatsWithPins : chatsWithPins.slice(0, visibleChatChips);

  const list = (
    <DirectoryList
      title={t("important")}
      lead={t("importantLead")}
      chips={
        chatsWithPins.length > 1 && (
          <>
            <Chip active={chatFilter === null} onClick={() => setChatFilter(null)}>
              {t("importantAllChats")}
            </Chip>
            {shownChips.map(({ chat }) => (
              <Chip
                key={chat.id}
                active={chatFilter === chat.id}
                onClick={() => setChatFilter(chatFilter === chat.id ? null : chat.id)}
              >
                {titleOf(chat, [], user.id)}
              </Chip>
            ))}
            {!moreChips && chatsWithPins.length > visibleChatChips && (
              <Chip onClick={() => setMoreChips(true)}>
                {t("importantMoreChats", { count: chatsWithPins.length - visibleChatChips })}
              </Chip>
            )}
          </>
        )
      }
    >
      {loading && chats.length > 0 ? (
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
        <EmptyState icon={<Star />} title={t("importantEmpty")} hint={t("importantEmptyHint")} />
      ) : (
        visible.map((item) => (
          <ImportantRow
            key={item.message.id}
            item={item}
            selected={!isMobile && item.message.id === activeID}
            onOpen={() =>
              navigate(
                isMobile
                  ? `/chat/${item.chat.id}?message=${item.message.id}`
                  : `/important/${item.message.id}`,
              )
            }
          />
        ))
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
            pinnedInChat={items.filter((item) => item.chat.id === active.chat.id).length}
            onBack={() => navigate("/important")}
            onUnpinned={() => {
              void query.refetch();
              navigate("/important");
            }}
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

function ImportantRow({
  item,
  selected,
  onOpen,
}: {
  item: ImportantItem;
  selected: boolean;
  onOpen(): void;
}) {
  const { t } = useTranslation();
  const { user } = useMessenger();
  const { members } = useChatMembers(item.chat.id);
  const chatName = titleOf(item.chat, [], user.id);
  const pinnedByName = members.find((member) => member.actor_id === item.pin.pinned_by)?.display_name;
  const pinnedBy =
    item.pin.pinned_by === user.id
      ? t("importantPinnedByYou")
      : pinnedByName && t("importantPinnedBy", { name: pinnedByName });
  return (
    <DirectoryRow
      className="directory-row--important"
      selected={selected}
      leading={
        <Avatar
          name={chatName}
          seed={item.chat.avatar_seed}
          actorID={item.chat.direct_peer?.actor_id}
          avatarVersion={item.chat.direct_peer?.avatar_version}
          size="md"
        />
      }
      top={
        <>
          <span className="truncate">{chatName}</span>
          <Pin className="directory-row__pin" aria-hidden="true" />
        </>
      }
      text={
        item.message.deleted_at ? (
          <em className="directory-row__deleted">{t("threadRootDeleted")}</em>
        ) : (
          messagePlainText(item.message.body)
        )
      }
      meta={
        <span className="truncate">
          {[pinnedBy, formatListTime(item.pin.pinned_at)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      }
      onClick={onOpen}
    />
  );
}

/** The pinned message in its chat context: two messages before and after. */
function ImportantDetail({
  item,
  pinnedInChat,
  onBack,
  onUnpinned,
}: {
  item: ImportantItem;
  pinnedInChat: number;
  onBack(): void;
  onUnpinned(): void;
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
  const chatName = titleOf(item.chat, members, user.id);
  const canModerate = hasPermission(user, "chats.moderate") || canManageChat(item.chat);
  const pinnedByName = members.find((member) => member.actor_id === item.pin.pinned_by)?.display_name;
  const pinnedBy =
    item.pin.pinned_by === user.id
      ? t("importantPinnedByYou")
      : pinnedByName && t("importantPinnedBy", { name: pinnedByName });
  const messages = context.data?.messages ?? [item.message];

  async function unpin() {
    setBusy(true);
    try {
      await api.unpin(item.message.id);
      toast({
        message: t("messageUnpinned"),
        action: { label: t("undo"), onClick: () => void api.pin(item.message.id).then(onUnpinned) },
      });
      void queryClient.invalidateQueries({ queryKey: ["pins", item.chat.id] });
      onUnpinned();
    } catch {
      toast({ message: t("actionFailed"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }
  const jump = () => navigate(`/chat/${item.chat.id}?message=${item.message.id}`);

  return (
    <div className="important-detail">
      <DirectoryDetailHead
        onBack={onBack}
        leading={
          <Avatar
            name={chatName}
            seed={item.chat.avatar_seed}
            actorID={item.chat.direct_peer?.actor_id}
            avatarVersion={item.chat.direct_peer?.avatar_version}
            size="md"
          />
        }
        title={chatName}
        meta={[
          pinnedBy,
          formatDay(item.pin.pinned_at),
          t("importantPinnedInChat", { count: pinnedInChat }),
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <Chip size="lg" onClick={jump}>
              {t("threadJumpToMessage")}
            </Chip>
            {(canModerate || item.pin.pinned_by === user.id) && (
              <Chip size="lg" disabled={busy} onClick={() => void unpin()}>
                <PinOff aria-hidden="true" />
                {t("unpinMessage")}
              </Chip>
            )}
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
                <div className="important-detail__hint">{t("importantContextHint")}</div>
              )}
              {messages.map((message, index) => {
                const previous = messages[index - 1];
                const isTarget = message.id === item.message.id;
                return (
                  <div
                    key={message.id}
                    className={cx(
                      "important-detail__message",
                      isTarget ? "important-detail__message--pinned" : "important-detail__message--context",
                    )}
                  >
                    {isTarget && (
                      <span className="important-detail__label">
                        <Pin aria-hidden="true" />
                        {t("pinnedLabel")}
                      </span>
                    )}
                    <MessageRow
                      message={message}
                      members={members}
                      author={members.find((member) => member.actor_id === message.actor_id)}
                      own={message.actor_id === user.id}
                      canModerate={canModerate}
                      grouped={
                        !isTarget &&
                        previous?.actor_id === message.actor_id &&
                        previous.id !== item.message.id &&
                        minuteGap(previous.created_at, message.created_at) < 5
                      }
                      chatName={chatName}
                      pinned={isTarget}
                      compact
                      onReply={jump}
                      onJump={jump}
                      onRetry={() => undefined}
                      onThread={() => navigate(`/chat/${item.chat.id}/thread/${message.thread_root_id ?? message.id}`)}
                      onChanged={() => void context.refetch()}
                      onPinnedChanged={onUnpinned}
                      domIDPrefix="important-message"
                    />
                  </div>
                );
              })}
              <div className="important-detail__footer">
                <button type="button" className="important-detail__open" onClick={() => navigate(`/chat/${item.chat.id}`)}>
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
