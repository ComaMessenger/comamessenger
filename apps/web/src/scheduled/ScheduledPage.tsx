import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  AlertCircle,
  BellOff,
  Clock3,
  CornerUpLeft,
  MessagesSquare,
  Paperclip,
  Pencil,
  Send,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  APIError,
  groupScheduled,
  messagePlainText,
  type ScheduledMessage,
} from "@comamessenger/core";
import { Button, Chip, EmptyState, InlineError, SkeletonRow, cx } from "../ui";
import { titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { ScheduleDialog } from "./ScheduleDialog";
import { ScheduledEditor } from "./ScheduledEditor";
import {
  clockTime,
  formatDayName,
  formatScheduledWhen,
  reasonText,
  scheduledErrorText,
} from "./format";
import {
  forgetScheduled,
  scheduledQueryKey,
  storeScheduled,
  useScheduledMessages,
} from "./useScheduled";

function chatFromURL() {
  return new URLSearchParams(window.location.search).get("chat");
}

/** `/scheduled`: the author's scheduled and failed messages, by day. */
export function ScheduledPage() {
  const { t } = useTranslation();
  const { api, user, store, navigate } = useMessenger();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const query = useScheduledMessages(api);
  const chats = useStore(store, (state) => state.chats);
  const [chatFilter, setChatFilter] = useState<string | null>(chatFromURL);
  const [now, setNow] = useState(() => new Date());
  const [editing, setEditing] = useState<ScheduledMessage | null>(null);
  const [moving, setMoving] = useState<ScheduledMessage | null>(null);
  const [moveError, setMoveError] = useState("");
  const [deleting, setDeleting] = useState<ScheduledMessage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // "Today" and "tomorrow" move with the clock.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const items = useMemo(() => query.data ?? [], [query.data]);
  const chatName = (chatID: string) => {
    const chat = chats[chatID];
    return chat ? titleOf(chat, [], user.id) : t("scheduledChatUnavailable");
  };
  const chatChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items)
      counts.set(item.chat_id, (counts.get(item.chat_id) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [items]);
  const visible = chatFilter
    ? items.filter((item) => item.chat_id === chatFilter)
    : items;
  const groups = groupScheduled(visible, now);

  function filterBy(chatID: string | null) {
    setChatFilter(chatID);
    window.history.replaceState(
      window.history.state,
      "",
      chatID ? `/scheduled?chat=${encodeURIComponent(chatID)}` : "/scheduled",
    );
  }

  function gone(cause: unknown, id: string) {
    if (cause instanceof APIError && cause.status === 404)
      forgetScheduled(queryClient, id);
    else void queryClient.invalidateQueries({ queryKey: scheduledQueryKey });
  }

  async function sendNow(item: ScheduledMessage) {
    setBusy(item.id);
    try {
      const record = await api.sendScheduledMessageNow(item.id);
      if (record.status === "sent") {
        forgetScheduled(queryClient, item.id);
        toast({ message: t("scheduledSent") });
      } else {
        storeScheduled(queryClient, record);
        toast({
          tone: "danger",
          message: t("scheduledSendFailed", {
            reason: reasonText(record.failure_reason),
          }),
        });
      }
    } catch (cause) {
      gone(cause, item.id);
      toast({ tone: "danger", message: scheduledErrorText(cause) });
    } finally {
      setBusy(null);
    }
  }

  async function move(item: ScheduledMessage, at: Date, silent: boolean) {
    setBusy(item.id);
    setMoveError("");
    try {
      const record = await api.updateScheduledMessage(item.id, {
        expected_version: item.version,
        send_at: at.toISOString(),
        ...(silent !== item.silent ? { silent } : {}),
      });
      storeScheduled(queryClient, record);
      setMoving(null);
      toast({
        message: t("scheduleCreated", {
          time: formatScheduledWhen(record.send_at),
        }),
      });
    } catch (cause) {
      if (cause instanceof APIError && cause.code === "version_conflict") {
        // Moving only the time: pick up the newer version and let the
        // person confirm again.
        const fresh = await api.scheduledMessage(item.id).catch(() => null);
        if (fresh) {
          storeScheduled(queryClient, fresh);
          setMoving(fresh);
          setMoveError(t("scheduledEditorConflict"));
        } else {
          gone(cause, item.id);
          setMoving(null);
          toast({ tone: "danger", message: t("scheduledClosed") });
        }
      } else setMoveError(scheduledErrorText(cause));
    } finally {
      setBusy(null);
    }
  }

  async function remove(item: ScheduledMessage) {
    setBusy(item.id);
    try {
      await api.deleteScheduledMessage(item.id);
      forgetScheduled(queryClient, item.id);
      toast({ message: t("scheduledDeleted") });
    } catch (cause) {
      gone(cause, item.id);
      if (!(cause instanceof APIError && cause.status === 404))
        toast({ tone: "danger", message: scheduledErrorText(cause) });
    } finally {
      setBusy(null);
      setDeleting(null);
    }
  }

  const card = (item: ScheduledMessage) => (
    <ScheduledCard
      key={item.id}
      item={item}
      chatName={chatName(item.chat_id)}
      chatAvailable={Boolean(chats[item.chat_id])}
      busy={busy === item.id}
      onOpenChat={() =>
        navigate(
          item.thread_root_id
            ? `/chat/${item.chat_id}/thread/${item.thread_root_id}`
            : `/chat/${item.chat_id}`,
        )
      }
      onEdit={() => setEditing(item)}
      onMove={() => {
        setMoveError("");
        setMoving(item);
      }}
      onSendNow={() => void sendNow(item)}
      onDelete={() => setDeleting(item)}
    />
  );

  return (
    <section className="scheduled-page" aria-labelledby="scheduled-title">
      <div className="scheduled-page__column">
        <header className="scheduled-page__head">
          <h1 id="scheduled-title">{t("scheduledTitle")}</h1>
          <p>{t("scheduledLead")}</p>
          {(chatChips.length > 1 || chatFilter) && (
            <div
              className="scheduled-page__chips"
              role="group"
              aria-label={t("scheduledAllChats")}
            >
              <Chip active={chatFilter === null} onClick={() => filterBy(null)}>
                {t("scheduledAllChats")}
              </Chip>
              {[
                ...chatChips,
                ...(chatFilter && !chatChips.includes(chatFilter)
                  ? [chatFilter]
                  : []),
              ].map((chatID) => (
                <Chip
                  key={chatID}
                  active={chatFilter === chatID}
                  onClick={() =>
                    filterBy(chatFilter === chatID ? null : chatID)
                  }
                >
                  {chatName(chatID)}
                </Chip>
              ))}
            </div>
          )}
        </header>

        {query.isLoading ? (
          <div className="scheduled-page__loading" aria-busy="true">
            <SkeletonRow lines={["30%", "85%"]} />
            <SkeletonRow lines={["25%", "70%"]} />
          </div>
        ) : query.isError ? (
          <InlineError
            center
            title={t("scheduledLoadFailed")}
            retryLabel={t("retry")}
            onRetry={() => void query.refetch()}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Clock3 />}
            title={chatFilter ? t("scheduledEmptyChat") : t("scheduledEmpty")}
            hint={t("scheduledEmptyHint")}
          />
        ) : (
          <>
            {groups.failed.length > 0 && (
              <section
                className="scheduled-group scheduled-group--failed"
                aria-labelledby="scheduled-failed"
              >
                <h2 id="scheduled-failed">
                  <AlertCircle aria-hidden="true" />
                  {t("scheduledFailedGroup")}
                </h2>
                {groups.failed.map(card)}
              </section>
            )}
            {groups.days.map((day) => (
              <section
                key={day.key}
                className="scheduled-group"
                aria-labelledby={`scheduled-day-${day.key}`}
              >
                <h2 id={`scheduled-day-${day.key}`}>
                  {day.kind === "today"
                    ? t("scheduledDayToday")
                    : day.kind === "tomorrow"
                      ? t("scheduledDayTomorrow")
                      : formatDayName(day.day, now)}
                </h2>
                {day.items.map(card)}
              </section>
            ))}
          </>
        )}
      </div>

      {editing && (
        <ScheduledEditor
          key={editing.id}
          item={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {moving && (
        <ScheduleDialog
          key={`${moving.id}:${moving.version}`}
          title={t("scheduleDialogRescheduleTitle")}
          initial={
            moving.status === "pending" ? new Date(moving.send_at) : undefined
          }
          silent={moving.silent}
          move
          pending={busy === moving.id}
          error={moveError}
          onConfirm={(at, silent) => void move(moving, at, silent)}
          onClose={() => setMoving(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title={t("scheduledDeleteTitle")}
          description={
            deleting.status === "failed"
              ? t("scheduledDeleteFailedText")
              : t("scheduledDeleteText")
          }
          confirmLabel={t("scheduledDelete")}
          pending={busy === deleting.id}
          icon={<Trash2 />}
          onConfirm={() => void remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

function ScheduledCard({
  item,
  chatName,
  chatAvailable,
  busy,
  onOpenChat,
  onEdit,
  onMove,
  onSendNow,
  onDelete,
}: {
  item: ScheduledMessage;
  chatName: string;
  chatAvailable: boolean;
  busy: boolean;
  onOpenChat(): void;
  onEdit(): void;
  onMove(): void;
  onSendNow(): void;
  onDelete(): void;
}) {
  const { t } = useTranslation();
  const failed = item.status === "failed";
  const text = messagePlainText(item.body).trim();
  const titleID = `scheduled-${item.id}`;
  return (
    <article
      className={cx("scheduled-card", failed && "scheduled-card--failed")}
      aria-labelledby={titleID}
      aria-busy={busy || undefined}
    >
      <header className="scheduled-card__head" id={titleID}>
        <span className="scheduled-card__time">
          {failed ? (
            <>
              <AlertCircle aria-hidden="true" />
              {t("scheduledNotSent")}
            </>
          ) : (
            <>
              <Clock3 aria-hidden="true" />
              {clockTime(new Date(item.send_at))}
            </>
          )}
        </span>
        {chatAvailable ? (
          <button
            type="button"
            className="scheduled-card__chat truncate"
            onClick={onOpenChat}
          >
            {chatName}
          </button>
        ) : (
          <span className="scheduled-card__chat scheduled-card__chat--gone truncate">
            {chatName}
          </span>
        )}
        <span className="scheduled-card__tags">
          {item.reply_to_id && (
            <span className="scheduled-tag">
              <CornerUpLeft aria-hidden="true" />
              {t("scheduledReply")}
            </span>
          )}
          {item.thread_root_id && (
            <span className="scheduled-tag">
              <MessagesSquare aria-hidden="true" />
              {t("scheduledInThread")}
            </span>
          )}
          {item.silent && (
            <span className="scheduled-tag">
              <BellOff aria-hidden="true" />
              {t("scheduledSilent")}
            </span>
          )}
        </span>
      </header>
      {failed && (
        <p className="scheduled-card__reason">
          {reasonText(item.failure_reason)}
          <span className="scheduled-card__was">
            {" · "}
            {formatScheduledWhen(item.send_at)}
          </span>
        </p>
      )}
      <p
        className={cx(
          "scheduled-card__body",
          !text && "scheduled-card__body--empty",
        )}
      >
        {text || t("scheduledEmptyBody")}
      </p>
      {item.files.length > 0 && (
        <ul className="scheduled-card__files">
          {item.files.map((file) => (
            <li key={file.id}>
              <Paperclip aria-hidden="true" />
              <span className="truncate">{file.name}</span>
            </li>
          ))}
        </ul>
      )}
      <div
        className="scheduled-card__actions"
        role="group"
        aria-label={t("scheduledActions")}
      >
        <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
          <Pencil aria-hidden="true" />
          {t("scheduledEdit")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onMove}>
          <Clock3 aria-hidden="true" />
          {t("scheduledReschedule")}
        </Button>
        <Button
          size="sm"
          variant={failed ? "primary" : "ghost"}
          pending={busy}
          onClick={onSendNow}
        >
          {!busy && <Send aria-hidden="true" />}
          {t("scheduledSendNow")}
        </Button>
        <Button
          size="sm"
          variant="danger-ghost"
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" />
          {t("scheduledDelete")}
        </Button>
      </div>
    </article>
  );
}
