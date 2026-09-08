import { useMemo } from "react";
import { Star } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { messagePlainText, type Chat, type Message } from "@comamessenger/core";
import { Avatar, EmptyState, InlineError, SkeletonRow } from "../ui";
import { formatListTime } from "../lib/format";
import { titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";
import { DirectoryPage, DirectoryRow } from "./DirectoryPage";

type ImportantItem = { chat: Chat; message: Message };

export function ImportantDirectory() {
  const { t } = useTranslation();
  const { api, user, store, navigate } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const chats = useMemo(() => Object.values(chatMap), [chatMap]);
  const chatKey = chats
    .map((chat) => chat.id)
    .sort()
    .join(":");
  const query = useQuery({
    queryKey: ["important", chatKey],
    enabled: chats.length > 0,
    queryFn: async (): Promise<ImportantItem[]> => {
      const pinned = (
        await Promise.all(
          chats.map(async (chat) =>
            (await api.pins(chat.id)).map((pin) => ({ chat, pin })),
          ),
        )
      ).flat();
      const resolved = await Promise.all(
        pinned.map(async ({ chat, pin }) => {
          const context = await api.messageContext(pin.message_id, 1);
          const message = context.messages.find(
            (item) => item.id === pin.message_id,
          );
          return message ? { chat, message, pinnedAt: pin.pinned_at } : null;
        }),
      );
      const seen = new Set<string>();
      return resolved
        .filter((item): item is ImportantItem & { pinnedAt: string } =>
          Boolean(item),
        )
        .filter((item) => {
          if (seen.has(item.message.id)) return false;
          seen.add(item.message.id);
          return true;
        })
        .sort((left, right) => right.pinnedAt.localeCompare(left.pinnedAt))
        .map(({ chat, message }) => ({ chat, message }));
    },
  });
  const items = query.data ?? [];
  const loading = query.isLoading || (chats.length === 0 && !query.data);

  return (
    <DirectoryPage
      title={t("important")}
      lead={t("importantLead")}
      onBack={() => navigate("/chats")}
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
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Star />}
          title={t("importantEmpty")}
          hint={t("importantEmptyHint")}
        />
      ) : (
        items.map(({ chat, message }) => {
          const chatName = titleOf(chat, [], user.id);
          return (
            <DirectoryRow
              key={message.id}
              className="directory-row--important"
              leading={
                <Avatar
                  name={chatName}
                  seed={chat.avatar_seed}
                  actorID={chat.direct_peer?.actor_id}
                  avatarVersion={chat.direct_peer?.avatar_version}
                  size="lg"
                />
              }
              text={
                message.deleted_at ? (
                  <em className="directory-row__deleted">
                    {t("threadRootDeleted")}
                  </em>
                ) : (
                  messagePlainText(message.body)
                )
              }
              meta={`${chatName} · ${formatListTime(message.created_at)}`}
              trailing={
                <Star
                  className="directory-row__star"
                  fill="currentColor"
                  aria-hidden="true"
                />
              }
              onClick={() => navigate(`/chat/${chat.id}?message=${message.id}`)}
            />
          );
        })
      )}
    </DirectoryPage>
  );
}
