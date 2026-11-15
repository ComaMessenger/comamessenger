import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Bell, ChevronLeft, Clock3, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  formatRequestDue,
  requestAnswerNote,
  requestAnswerTabs,
  requestAudienceText,
  requestKeys,
  requestView,
  type ChatMember,
  type RequestAnswer,
  type RequestAnswerFilter,
} from "@comamessenger/core";
import {
  Button,
  EmptyState,
  IconButton,
  InlineError,
  SkeletonRow,
  cx,
} from "../ui";
import { Markdown } from "../markdown";
import { formatTime } from "../lib/format";
import { useIsMobile } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { calendarLocale } from "./format";
import { RequestPill } from "./RequestCard";
import { useRequestActions } from "./useRequest";
import { awayNote, withCurrentAway } from "@comamessenger/core";
import { AwayAvatar } from "../status/AwayAvatar";
import { useAwayOverrides } from "../status/useAway";

/**
 * Answers: who answered what, for the author and chat admins. Tabs by
 * option and No answer, comments, read, not answered against
 * not opened the chat, Remind those who haven't answered and Close. Lives where
 * the thread panel does; a page of its own on phones.
 */
export function RequestAnswersPanel({
  chatID,
  messageID,
  members,
  onClose,
}: {
  chatID: string;
  messageID: string;
  members: ChatMember[];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { api, store, user } = useMessenger();
  const isMobile = useIsMobile();
  const locale = calendarLocale();
  const [filter, setFilter] = useState<RequestAnswerFilter>("waiting");
  const [confirmClose, setConfirmClose] = useState(false);
  const loaded = useStore(store, (state) =>
    state.messages[chatID]?.find((item) => item.id === messageID),
  );
  const entry = useStore(store, (state) => state.requestViewers[messageID]);
  const context = useQuery({
    queryKey: ["message-context", messageID, 0],
    queryFn: () => api.messageContext(messageID, 0),
    enabled: !loaded,
    staleTime: 60_000,
  });
  const message =
    loaded ?? context.data?.messages.find((item) => item.id === messageID);
  // The viewer decides what the reader may see here; read it fresh.
  const state = useQuery({
    queryKey: requestKeys.state(user.id, messageID),
    queryFn: () => api.messageRequest(messageID),
  });
  useEffect(() => {
    if (state.data)
      store.getState().setRequestState(messageID, state.data, chatID);
  }, [chatID, messageID, state.data, store]);
  const request = message?.request ?? state.data?.request ?? null;
  const viewer = entry?.viewer ?? state.data?.viewer ?? null;
  const view =
    message && request
      ? requestView({ ...message, request }, viewer, {
          selfID: user.id,
          now: new Date(),
          t,
        })
      : null;
  const actions = useRequestActions(messageID, chatID);
  const canView = Boolean(viewer?.can_view_answers);

  const answers = useInfiniteQuery({
    queryKey: requestKeys.answers(user.id, messageID, filter),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.requestAnswers(messageID, { filter, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: canView,
  });
  const counts = answers.data?.pages[0]?.counts;
  const tabs = useMemo(
    () =>
      view && counts
        ? requestAnswerTabs(counts, view.options)
        : view
          ? requestAnswerTabs(
              {
                waiting: view.waiting,
                options: view.tally?.map((row) => row.count) ?? [],
              },
              view.options,
            )
          : [],
    [counts, view],
  );
  const items = answers.data?.pages.flatMap((page) => page.items) ?? [];
  const due = (at: Date) => formatRequestDue(at, new Date(), locale);

  return (
    <aside
      className={cx("thread-panel", "request-panel")}
      aria-label={t("requestAnswersTitle")}
    >
      <header className="thread-panel__head">
        {isMobile && (
          <IconButton size="icon-lg" label={t("back")} onClick={onClose}>
            <ChevronLeft />
          </IconButton>
        )}
        <div className="thread-panel__title">
          <strong className="truncate">{t("requestAnswersTitle")}</strong>
          <span className="truncate">
            {view
              ? t("requestAnswersSubtitle", {
                  audience: requestAudienceText(view.audience, locale),
                })
              : ""}
          </span>
        </div>
        {view && !view.open && <RequestPill view={view} due={due} />}
        {view?.canClose && view.open && (
          <Button
            size="sm"
            variant="ghost"
            pending={actions.busy === "close"}
            onClick={() => setConfirmClose(true)}
          >
            {t("requestClose")}
          </Button>
        )}
        {!isMobile && (
          <IconButton
            size="icon-sm"
            label={t("requestAnswersClose")}
            onClick={onClose}
          >
            <X />
          </IconButton>
        )}
      </header>
      <div className="thread-panel__scroll request-panel__scroll">
        {!message || state.isLoading ? (
          <div className="thread-panel__skeleton">
            <SkeletonRow lines={["60%", "100%"]} />
            <SkeletonRow avatar={36} lines={["40%", "30%"]} />
          </div>
        ) : state.isError && !viewer ? (
          <InlineError
            center
            title={t("requestAnswersLoadFailed")}
            retryLabel={t("retry")}
            onRetry={() => void state.refetch()}
          />
        ) : !view || !canView ? (
          <EmptyState compact title={t("requestFailForbidden")} />
        ) : (
          <>
            <div className="request-panel__question">
              <small>
                {t("requestAnswersYou", {
                  due: view.dueAt
                    ? t("requestDueBy", { when: due(view.dueAt) })
                    : t("requestNoDue"),
                })}
              </small>
              <Markdown source={message.body} />
            </div>
            <div
              className="request-panel__tabs"
              role="tablist"
              aria-label={t("requestAnswersTabs")}
            >
              {tabs.map((tab) => (
                <button
                  key={tab.filter}
                  type="button"
                  role="tab"
                  aria-selected={tab.filter === filter}
                  className="request-panel__tab"
                  onClick={() => setFilter(tab.filter)}
                >
                  <span className="truncate">
                    {tab.label ?? t("requestNoAnswer")}
                  </span>
                  <span className="request-panel__count tabular">
                    {tab.count}
                  </span>
                </button>
              ))}
            </div>
            <div className="request-panel__list" role="tabpanel">
              {answers.isLoading ? (
                <>
                  <SkeletonRow avatar={36} lines={["40%", "30%"]} />
                  <SkeletonRow avatar={36} lines={["50%", "25%"]} />
                </>
              ) : answers.isError ? (
                <InlineError
                  title={t("requestAnswersLoadFailed")}
                  retryLabel={t("retry")}
                  onRetry={() => void answers.refetch()}
                />
              ) : items.length === 0 ? (
                <p className="request-panel__empty">{t("requestAnswersEmpty")}</p>
              ) : (
                items.map((item) => (
                  <AnswerRow
                    key={item.actor_id}
                    item={item}
                    member={members.find(
                      (member) => member.actor_id === item.actor_id,
                    )}
                  />
                ))
              )}
              {answers.hasNextPage && (
                <Button
                  variant="ghost"
                  size="sm"
                  pending={answers.isFetchingNextPage}
                  onClick={() => void answers.fetchNextPage()}
                >
                  {t("requestAnswersMore")}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
      {view && canView && view.open && view.role === "author" && (
        <footer className="request-panel__foot">
          {view.remind.kind === "ready" ? (
            <Button
              variant="primary"
              pending={actions.busy === "remind"}
              onClick={() =>
                void actions.remind().then(() => void answers.refetch())
              }
            >
              <Bell aria-hidden="true" />
              {t("requestRemindAll", { count: view.remind.count })}
            </Button>
          ) : view.remind.kind === "cooldown" ? (
            <Button disabled>
              {t("requestRemindCooldown", { when: due(view.remind.until) })}
            </Button>
          ) : view.remind.kind === "allAnswered" ? (
            <Button disabled>{t("requestAllAnswered")}</Button>
          ) : null}
          {view.autoRemindAt && (
            <small>
              <Clock3 aria-hidden="true" />
              {t("requestAutoRemindAt", { when: due(view.autoRemindAt) })}
            </small>
          )}
        </footer>
      )}
      {confirmClose && (
        <ConfirmDialog
          title={t("requestCloseTitle")}
          description={t("requestCloseHint")}
          confirmLabel={t("requestClose")}
          pending={actions.busy === "close"}
          onConfirm={() =>
            void actions.close().then(() => {
              setConfirmClose(false);
              void answers.refetch();
            })
          }
          onClose={() => setConfirmClose(false)}
        />
      )}
    </aside>
  );
}

function AnswerRow({
  item,
  member,
}: {
  item: RequestAnswer;
  member?: ChatMember;
}) {
  const { t } = useTranslation();
  const note = requestAnswerNote(item);
  const name = member?.display_name ?? t("requestUnknownPerson");
  const overrides = useAwayOverrides();
  const now = new Date();
  const person = member ? withCurrentAway(member, overrides) : null;
  // Someone away who has not answered gets the mark (decision 6).
  const away =
    person && !item.answered_at
      ? awayNote(person, now, calendarLocale())
      : null;
  return (
    <div className="request-answer">
      <AwayAvatar
        away={person?.away}
        now={now}
        name={name}
        seed={item.actor_id}
        actorID={item.actor_id}
        avatarVersion={member?.avatar_version}
        size="md"
      />
      <span className="request-answer__body">
        <strong className="truncate">{name}</strong>
        <span
          className={cx(
            "request-answer__note",
            note === "readNotAnswered" && "request-answer__note--warning",
            note === "comment" && "request-answer__note--comment",
          )}
        >
          {note === "comment"
            ? `«${item.comment}»`
            : note === "readNotAnswered"
              ? t("requestAnswerReadNotAnswered")
              : note === "notOpened"
                ? t("requestAnswerNotOpened")
                : note === "left"
                  ? t("requestAnswerLeft")
                  : (member?.title ?? "")}
          {away && <span className="away-note"> · {away}</span>}
          {item.late && note !== "readNotAnswered" && note !== "notOpened" && (
            <span className="request-card__late"> · {t("requestLate")}</span>
          )}
        </span>
      </span>
      {item.answered_at && (
        <time className="request-answer__time" dateTime={item.answered_at}>
          {formatTime(item.answered_at)}
        </time>
      )}
    </div>
  );
}
