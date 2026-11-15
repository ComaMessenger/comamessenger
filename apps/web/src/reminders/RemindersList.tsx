import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Bell, BellRing, NotebookPen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  capitalize,
  clockTime,
  groupReminders,
  messagePlainText,
  reminderHref,
  reminderKeys,
  reminderMissed,
  type Reminder,
  type ReminderDayGroup,
} from "@comamessenger/core";
import { Button, EmptyState, InlineError, SkeletonRow, cx } from "../ui";
import { titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";
import { calendarLocale } from "../requests/format";
import { formatDayName } from "../scheduled/format";
import { ReminderPicker } from "./ReminderPicker";
import { reminderWhenText, useReminderActions } from "./useReminders";

function useReminderPages(state: "pending" | "fired") {
  const { api, user } = useMessenger();
  return useInfiniteQuery({
    queryKey: reminderKeys.list(user.id, state),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.reminders({ state, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

/**
 * Important → Reminders: fired ones first (Fired), then Today,
 * Tomorrow, the days of this week and Later. Each row has the note and
 * Move, Open, Done.
 */
export function RemindersList() {
  const { t } = useTranslation();
  const pending = useReminderPages("pending");
  const fired = useReminderPages("fired");
  const items = useMemo(
    () => [
      ...(fired.data?.pages.flatMap((page) => page.items) ?? []),
      ...(pending.data?.pages.flatMap((page) => page.items) ?? []),
    ],
    [fired.data, pending.data],
  );
  const now = new Date();
  const groups = groupReminders(items, now);

  if (pending.isLoading || fired.isLoading)
    return (
      <>
        <SkeletonRow lines={["40%", "90%"]} />
        <SkeletonRow lines={["30%", "80%"]} />
      </>
    );
  if (pending.isError || fired.isError)
    return (
      <InlineError
        center
        title={t("remindersLoadFailed")}
        retryLabel={t("retry")}
        onRetry={() => {
          void pending.refetch();
          void fired.refetch();
        }}
      />
    );
  if (!items.length)
    return (
      <EmptyState
        icon={<Bell />}
        title={t("remindersEmpty")}
        hint={t("remindersEmptyHint")}
      />
    );
  const dayTitle = (group: ReminderDayGroup) =>
    group.kind === "today"
      ? t("reminderToday")
      : group.kind === "tomorrow"
        ? t("reminderTomorrow")
        : group.kind === "later"
          ? t("reminderLater")
          : capitalize(formatDayName(group.day, now));
  return (
    <div className="inbox">
      {groups.fired.length > 0 && (
        <section aria-label={t("reminderFiredGroup")}>
          <h2 className="inbox__section">{t("reminderFiredGroup")}</h2>
          {groups.fired.map((item) => (
            <ReminderRow key={item.id} item={item} />
          ))}
          {fired.hasNextPage && (
            <MoreButton
              pending={fired.isFetchingNextPage}
              onClick={() => void fired.fetchNextPage()}
            />
          )}
        </section>
      )}
      {groups.days.map((group) => (
        <section key={group.key} aria-label={dayTitle(group)}>
          <h2 className="inbox__section">{dayTitle(group)}</h2>
          {group.items.map((item) => (
            <ReminderRow key={item.id} item={item} />
          ))}
        </section>
      ))}
      {pending.hasNextPage && (
        <MoreButton
          pending={pending.isFetchingNextPage}
          onClick={() => void pending.fetchNextPage()}
        />
      )}
    </div>
  );
}

function MoreButton({
  pending,
  onClick,
}: {
  pending: boolean;
  onClick(): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="directory-list__more">
      <Button variant="ghost" size="sm" pending={pending} onClick={onClick}>
        {t("remindersMore")}
      </Button>
    </div>
  );
}

function ReminderRow({ item }: { item: Reminder }) {
  const { t } = useTranslation();
  const { store, user, navigate } = useMessenger();
  const chat = useStore(store, (state) => state.chats[item.chat_id]);
  const { set, remove } = useReminderActions();
  const [moving, setMoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const fired = item.state === "fired";
  const message = item.access === "available" ? item.message : null;
  const chatName = chat
    ? titleOf(chat, [], user.id)
    : (message?.chat.display_name ?? "");
  const text = message ? messagePlainText(message.message.body).trim() : "";
  const target = {
    chatID: item.chat_id,
    messageID: item.message_id,
    reminderID: item.id,
  };
  const when = fired
    ? reminderMissed(item)
      ? t("reminderMissed", {
          when: clockTime(new Date(item.remind_at), calendarLocale()),
        })
      : t("reminderFiredAt", {
          when: reminderWhenText(item.fired_at ?? item.remind_at).toLowerCase(),
        })
    : clockTime(new Date(item.remind_at), calendarLocale());

  return (
    <article
      className={cx("reminder-row", fired && "reminder-row--fired")}
      aria-label={t("reminderStrip")}
    >
      <header className="reminder-row__head">
        {fired ? <BellRing aria-hidden="true" /> : <Bell aria-hidden="true" />}
        <span className="reminder-row__when">{when}</span>
        {chatName && <span className="reminder-row__chat truncate">{chatName}</span>}
      </header>
      {message ? (
        <p className="reminder-row__text">
          <strong>{message.author.display_name}:</strong> {text}
        </p>
      ) : (
        <p className="reminder-row__text reminder-row__text--muted">
          {item.access === "deleted"
            ? t("reminderMessageDeleted")
            : t("reminderNoAccess")}
        </p>
      )}
      {item.note && (
        <p className="reminder-row__note">
          <NotebookPen aria-hidden="true" />
          <span>{item.note}</span>
        </p>
      )}
      <div className="reminder-row__actions">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => setMoving(true)}
        >
          {t("reminderMove")}
        </Button>
        {message && (
          <Button size="sm" onClick={() => navigate(reminderHref(item))}>
            {t("reminderOpen")}
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          pending={busy && !moving}
          onClick={() => {
            setBusy(true);
            void remove(target, true).finally(() => setBusy(false));
          }}
        >
          {t("reminderDone")}
        </Button>
      </div>
      {moving && (
        <ReminderPicker
          initial={fired ? undefined : new Date(item.remind_at)}
          editing
          pending={busy}
          onConfirm={(at, note) => {
            setBusy(true);
            void set(target, at, note)
              .then((saved) => {
                if (saved) setMoving(false);
              })
              .finally(() => setBusy(false));
          }}
          onClose={() => setMoving(false)}
        />
      )}
    </article>
  );
}
