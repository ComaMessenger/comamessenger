import { useEffect, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowUpRight, MessageSquareMore } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  formatRequestDue,
  requestKeys,
  waitingSections,
  type RequestInboxItem,
} from "@comamessenger/core";
import { Avatar, Button, EmptyState, InlineError, SkeletonRow } from "../ui";
import { formatListTime } from "../lib/format";
import { titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";
import { calendarLocale } from "./format";
import { RequestCard } from "./RequestCard";
import { useRequestActions } from "./useRequest";

function useInbox(state: "waiting" | "answered") {
  const { api, user } = useMessenger();
  return useInfiniteQuery({
    queryKey: requestKeys.inbox(user.id, state),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.requestInbox({ state, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

/**
 * Important → Waiting for you: requests waiting for the reader's answer, with the
 * buttons right in the list, and below them Answered — open requests the
 * reader answered, which may still change.
 */
export function WaitingInbox() {
  const { t } = useTranslation();
  const { store } = useMessenger();
  const waiting = useInbox("waiting");
  const answered = useInbox("answered");
  const viewers = useStore(store, (state) => state.requestViewers);
  const waitingItems = useMemo(
    () => waiting.data?.pages.flatMap((page) => page.items) ?? [],
    [waiting.data],
  );
  const answeredItems = useMemo(
    () => answered.data?.pages.flatMap((page) => page.items) ?? [],
    [answered.data],
  );
  // The inbox carries the reader's viewer: the store keeps the one source.
  useEffect(() => {
    for (const item of [...waitingItems, ...answeredItems])
      store
        .getState()
        .setRequestState(
          item.message.id,
          { request: item.request, viewer: item.viewer },
          item.chat_id,
        );
  }, [answeredItems, store, waitingItems]);
  const sections = waitingSections(waitingItems, answeredItems, viewers);

  if (waiting.isLoading)
    return (
      <>
        <SkeletonRow avatar={36} lines={["60%", "90%"]} />
        <SkeletonRow avatar={36} lines={["50%", "80%"]} />
      </>
    );
  if (waiting.isError)
    return (
      <InlineError
        center
        title={t("importantWaitingLoadFailed")}
        retryLabel={t("retry")}
        onRetry={() => void waiting.refetch()}
      />
    );
  if (!sections.waiting.length && !sections.answered.length)
    return (
      <EmptyState
        icon={<MessageSquareMore />}
        title={t("importantWaitingEmpty")}
        hint={t("importantWaitingEmptyHint")}
      />
    );
  return (
    <div className="inbox">
      {sections.waiting.map((item) => (
        <InboxRequest key={item.message.id} item={item} />
      ))}
      {waiting.hasNextPage && (
        <div className="directory-list__more">
          <Button
            variant="ghost"
            size="sm"
            pending={waiting.isFetchingNextPage}
            onClick={() => void waiting.fetchNextPage()}
          >
            {t("importantLoadMore")}
          </Button>
        </div>
      )}
      {sections.answered.length > 0 && (
        <>
          <h2 className="inbox__section">{t("importantAnswered")}</h2>
          {sections.answered.map((item) => (
            <InboxRequest key={item.message.id} item={item} />
          ))}
          {answered.hasNextPage && (
            <div className="directory-list__more">
              <Button
                variant="ghost"
                size="sm"
                pending={answered.isFetchingNextPage}
                onClick={() => void answered.fetchNextPage()}
              >
                {t("importantLoadMore")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function InboxRequest({ item }: { item: RequestInboxItem }) {
  const { t } = useTranslation();
  const { store, user, navigate } = useMessenger();
  const chat = useStore(store, (state) => state.chats[item.chat_id]);
  const actions = useRequestActions(item.message.id, item.chat_id);
  const chatName = chat ? titleOf(chat, [], user.id) : item.chat.display_name;
  const due = item.request.due_at ? new Date(item.request.due_at) : null;
  return (
    <article className="inbox-card" aria-label={t("importantRequestFrom", { name: item.author.display_name })}>
      <header className="inbox-card__head">
        <Avatar
          name={item.author.display_name}
          seed={item.author.actor_id}
          actorID={item.author.actor_id}
          avatarVersion={item.author.avatar_version}
          agent={item.author.type === "agent"}
          size="sm"
        />
        <span className="inbox-card__title">
          <strong className="truncate">
            {t("importantRequestFrom", { name: item.author.display_name })}
          </strong>
          <span className="truncate">
            {[
              chatName,
              due
                ? t("importantRequestDue", {
                    when: formatRequestDue(due, new Date(), calendarLocale()),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <time className="inbox-card__time" dateTime={item.message.created_at}>
          {formatListTime(item.message.created_at)}
        </time>
      </header>
      <RequestCard
        message={{ ...item.message, request: item.request }}
        viewer={item.viewer}
        selfID={user.id}
        actions={actions}
      />
      <button
        type="button"
        className="inbox-card__open"
        onClick={() =>
          navigate(`/chat/${item.chat_id}?message=${item.message.id}`)
        }
      >
        {t("importantOpenRequest")}
        <ArrowUpRight aria-hidden="true" />
      </button>
    </article>
  );
}
