import { useEffect, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { ArrowUpRight, MessageSquareMore } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  filterWaitingRows,
  formatRequestDue,
  hasTask,
  importantCounts,
  requestKeys,
  taskInboxModeLabelKeys,
  waitingFilterLabelKeys,
  waitingFilters,
  waitingList,
  waitingSections,
  type RequestInboxItem,
  type TaskInboxMode,
  type WaitingFilter,
  type WaitingTaskRow,
} from "@comamessenger/core";
import {
  Avatar,
  Button,
  Chip,
  EmptyState,
  InlineError,
  Segmented,
  SkeletonRow,
} from "../ui";
import { hasPermission } from "../settings";
import { MyTasks, useWaitingInbox } from "../tasks/MyTasks";
import { TaskRow } from "../tasks/TaskRow";
import { formatListTime } from "../lib/format";
import { titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";
import { calendarLocale } from "./format";
import { RequestCard } from "./RequestCard";
import { useRequestActions } from "./useRequest";

function useInbox(state: "waiting" | "answered", enabled = true) {
  const { api, user } = useMessenger();
  return useInfiniteQuery({
    queryKey: requestKeys.inbox(user.id, state),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.requestInbox({ state, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled,
  });
}

/** The inbox carries the reader's viewer: the store keeps the one source. */
function useSyncViewers(items: readonly RequestInboxItem[]) {
  const { store } = useMessenger();
  useEffect(() => {
    for (const item of items)
      store
        .getState()
        .setRequestState(
          item.message.id,
          { request: item.request, viewer: item.viewer },
          item.chat_id,
        );
  }, [items, store]);
}

const filterOf = (value: unknown): WaitingFilter =>
  value === "requests" || value === "tasks" ? value : "all";
const modeOf = (value: unknown): TaskInboxMode =>
  value === "authored" ? "authored" : "assigned";

/**
 * Important → Waiting for you. With tasks on the server: chips All ·
 * Requests · Tasks over one list in due order, On me / Set by me
 * inside Tasks. Without them: requests as in wave 1.
 */
export function WaitingInbox() {
  const { store } = useMessenger();
  const features = useStore(store, (state) => state.features);
  const filters = waitingFilters(features);
  return filters.length ? (
    <WaitingWithTasks filters={filters} />
  ) : (
    <RequestInbox />
  );
}

function WaitingWithTasks({ filters }: { filters: WaitingFilter[] }) {
  const { t } = useTranslation();
  const { store, user, navigate } = useMessenger();
  const search = useRouterState({
    select: (state) => state.location.search as Record<string, unknown>,
  });
  const filter = filters.includes(filterOf(search.kind))
    ? filterOf(search.kind)
    : "all";
  const mode = modeOf(search.role);
  const features = useStore(store, (state) => state.features);
  const unread = useStore(store, (state) => state.unread);
  const viewers = useStore(store, (state) => state.requestViewers);
  const chats = useStore(store, (state) => state.chats);
  const counts = importantCounts(unread, features);
  const chipCounts: Record<WaitingFilter, number> = {
    all: counts.waiting,
    requests: Math.max(0, unread.requests_waiting_total ?? 0),
    tasks: Math.max(0, unread.tasks_mine_open_total ?? 0),
    polls: 0,
  };
  const listKind = filter === "requests" ? "requests" : "all";
  const waiting = useWaitingInbox(listKind, filter !== "tasks");
  const answered = useInbox("answered", filter !== "tasks");
  const pageItems = useMemo(
    () => waiting.data?.pages.flatMap((page) => page.items) ?? [],
    [waiting.data],
  );
  const answeredItems = useMemo(
    () => answered.data?.pages.flatMap((page) => page.items) ?? [],
    [answered.data],
  );
  const requestItems = useMemo(
    () =>
      pageItems.flatMap((item) =>
        item.kind === "request" && item.request && item.viewer
          ? [
              {
                message: item.message,
                chat_id: item.chat_id,
                author: item.author,
                chat: item.chat,
                request: item.request,
                viewer: item.viewer,
              },
            ]
          : [],
      ),
    [pageItems],
  );
  useSyncViewers(requestItems);
  useSyncViewers(answeredItems);
  const go = (next: { kind?: WaitingFilter; role?: TaskInboxMode }) => {
    const kind = next.kind ?? filter;
    const role = next.role ?? mode;
    navigate(
      `/important?tab=waiting${kind !== "all" ? `&kind=${kind}` : ""}${
        kind === "tasks" && role === "authored" ? "&role=authored" : ""
      }`,
    );
  };

  const head = (
    <div className="waiting-filters">
      <div
        className="waiting-filters__chips"
        role="group"
        aria-label={t("importantFilters")}
      >
        {filters.map((id) => (
          <Chip
            key={id}
            active={filter === id}
            onClick={() => go({ kind: id })}
          >
            {t(waitingFilterLabelKeys[id])}
            {chipCounts[id] > 0 && (
              <span className="important-tabs__count tabular">
                {chipCounts[id]}
              </span>
            )}
          </Chip>
        ))}
      </div>
      {filter === "tasks" && (
        <Segmented<TaskInboxMode>
          label={t("importantTasksRole")}
          value={mode}
          onChange={(role) => go({ role })}
          items={(["assigned", "authored"] as const).map((id) => ({
            id,
            label: t(taskInboxModeLabelKeys[id]),
          }))}
        />
      )}
    </div>
  );

  if (filter === "tasks")
    return (
      <div className="inbox">
        {head}
        <MyTasks mode={mode} />
      </div>
    );

  const list = waitingList(pageItems, answeredItems, user.id, {
    viewers,
    tasks: Object.fromEntries(
      pageItems.flatMap((item) => {
        const fresh = store
          .getState()
          .messages[item.chat_id]?.find((m) => m.id === item.message.id)?.task;
        return fresh ? [[item.message.id, fresh]] : [];
      }),
    ),
  });
  const rows = filterWaitingRows(list.waiting, filter);
  const body = waiting.isLoading ? (
    <>
      <SkeletonRow avatar={36} lines={["60%", "90%"]} />
      <SkeletonRow avatar={36} lines={["50%", "80%"]} />
    </>
  ) : waiting.isError ? (
    <InlineError
      center
      title={t("importantWaitingLoadFailed")}
      retryLabel={t("retry")}
      onRetry={() => void waiting.refetch()}
    />
  ) : !rows.length && !list.answered.length ? (
    <EmptyState
      icon={<MessageSquareMore />}
      title={t("importantWaitingEmpty")}
      hint={t("importantWaitingEmptyHintTasks")}
    />
  ) : (
    <>
      {rows.map((row) =>
        row.kind === "request" ? (
          <InboxRequest key={row.item.message.id} item={row.item} />
        ) : (
          <InboxTask
            key={row.item.message.id}
            row={row}
            chatName={
              chats[row.item.chat.id]
                ? titleOf(chats[row.item.chat.id]!, [], user.id)
                : row.item.chat.display_name
            }
          />
        ),
      )}
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
      {list.answered.length > 0 && (
        <>
          <h2 className="inbox__section">{t("importantAnswered")}</h2>
          {list.answered.map((item) => (
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
    </>
  );
  return (
    <div className="inbox">
      {head}
      {body}
    </div>
  );
}

/** A task waiting for the reader, in the list with the requests. */
function InboxTask({ row, chatName }: { row: WaitingTaskRow; chatName: string }) {
  const { store, user, navigate } = useMessenger();
  const chat = useStore(store, (state) => state.chats[row.item.chat.id]);
  const message = row.item.message;
  if (!hasTask(message)) return null;
  return (
    <div className="inbox-task">
      <TaskRow
        message={message}
        viewer={{
          actorID: user.id,
          chatRole: chat?.role ?? "member",
          moderator: hasPermission(user, "chats.moderate"),
        }}
        chatName={chatName}
        authorName={
          row.item.author.actor_id !== user.id
            ? row.item.author.display_name
            : undefined
        }
        mine
        onOpen={() =>
          navigate(`/chat/${row.item.chat.id}?message=${message.id}`)
        }
      />
    </div>
  );
}

/**
 * Requests waiting for the reader's answer, with the buttons right in the
 * list, and below them Answered — open requests the reader answered, which
 * may still change. A server without tasks shows only this.
 */
function RequestInbox() {
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
  useSyncViewers(waitingItems);
  useSyncViewers(answeredItems);
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
