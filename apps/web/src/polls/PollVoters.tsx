import { useMemo, useState, type RefObject } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  pollKeys,
  pollVoterTabs,
  type ActorSummary,
  type ChatMember,
  type MessagePoll,
  type PollViewer,
  type PollVoterTab,
} from "@comamessenger/core";
import {
  Avatar,
  Button,
  Dialog,
  FloatingPopover,
  InlineError,
  SkeletonRow,
  Tabs,
} from "../ui";
import { useIsMobile } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { useAllActors } from "../org/useOrg";
import { calendarLocale } from "../requests/format";
import type { PollCardActions } from "./PollCard";

const pageSize = 50;

/**
 * Who voted: one tab per option and No vote · k for the author
 * and chat admins, with Remind there. A popover at the card on a wide
 * screen, a sheet on a phone. Never offered in an anonymous poll.
 */
export function PollVoters({
  messageID,
  poll,
  viewer,
  members,
  actions,
  anchorRef,
  onClose,
}: {
  messageID: string;
  poll: MessagePoll;
  viewer: PollViewer | null;
  members: readonly ChatMember[];
  actions: Pick<PollCardActions, "remind" | "busy">;
  anchorRef: RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const tabs = pollVoterTabs(poll, viewer, calendarLocale());
  const [tab, setTab] = useState<PollVoterTab["filter"] | null>(null);
  const current = tabs.find((item) => item.filter === tab) ?? tabs[0];
  const body = (
    <div className="poll-voters">
      <p className="poll-voters__question">{poll.question}</p>
      {tabs.length > 1 && current && (
        <Tabs
          underline
          className="poll-voters__tabs"
          label={t("pollVotersTitle")}
          value={current.filter}
          onChange={(value) => setTab(value as PollVoterTab["filter"])}
          items={tabs.map((item) => ({
            id: item.filter,
            label:
              item.filter === "waiting"
                ? item.label
                : `${item.label} · ${item.count}`,
          }))}
        />
      )}
      {current && (
        <VoterList
          key={current.filter}
          messageID={messageID}
          filter={current.filter}
          members={members}
          version={poll.version}
        />
      )}
      {current?.filter === "waiting" && viewer?.can_remind && current.count > 0 && (
        <Button
          size="sm"
          className="poll-voters__remind"
          pending={actions.busy === "remind"}
          onClick={() => void actions.remind()}
        >
          <Bell aria-hidden="true" />
          {t("pollVotersRemind")}
        </Button>
      )}
    </div>
  );
  if (isMobile)
    return (
      <Dialog
        title={t("pollVotersTitle")}
        sheet
        onClose={onClose}
        className="poll-voters-dialog"
        footer={<Button onClick={onClose}>{t("pollVotersDone")}</Button>}
      >
        {body}
      </Dialog>
    );
  return (
    <FloatingPopover
      anchorRef={anchorRef}
      placement="bottom-end"
      width={340}
      className="poll-voters-popover"
      onDismiss={onClose}
    >
      <div role="dialog" aria-label={t("pollVotersTitle")}>
        <h2 className="poll-voters__title">{t("pollVotersTitle")}</h2>
        {body}
      </div>
    </FloatingPopover>
  );
}

function VoterList({
  messageID,
  filter,
  members,
  version,
}: {
  messageID: string;
  filter: PollVoterTab["filter"];
  members: readonly ChatMember[];
  version: number;
}) {
  const { t } = useTranslation();
  const { api, user } = useMessenger();
  const query = useInfiniteQuery({
    queryKey: [...pollKeys.voters(user.id, messageID, filter), version],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.pollVoters(messageID, { filter, cursor: pageParam, limit: pageSize }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const items = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  const known = useMemo(
    () => new Map(members.map((member) => [member.actor_id, member])),
    [members],
  );
  // Someone who left the chat is not among its members.
  const unknown = items.some((item) => !known.has(item.actor_id));
  const everyone = useAllActors(api, unknown);
  const people = useMemo(
    () =>
      new Map<string, Pick<ActorSummary, "display_name" | "avatar_version" | "title">>(
        (everyone.data ?? []).map((actor) => [actor.actor_id, actor]),
      ),
    [everyone.data],
  );
  if (query.isLoading)
    return (
      <div className="poll-voters__list">
        <SkeletonRow avatar={28} lines={["50%", "30%"]} />
        <SkeletonRow avatar={28} lines={["40%", "25%"]} />
      </div>
    );
  if (query.isError)
    return (
      <InlineError
        title={t("pollVotersLoadFailed")}
        retryLabel={t("retry")}
        onRetry={() => void query.refetch()}
      />
    );
  if (!items.length)
    return <p className="poll-voters__empty">{t("pollVotersNobody")}</p>;
  return (
    <ul className="poll-voters__list">
      {items.map((item) => {
        const person = known.get(item.actor_id) ?? people.get(item.actor_id);
        return (
          <li key={item.actor_id} className="poll-voters__row">
            <Avatar
              name={person?.display_name ?? ""}
              seed={item.actor_id}
              actorID={item.actor_id}
              avatarVersion={person?.avatar_version}
              size="sm"
            />
            <span className="poll-voters__name">
              <strong className="truncate">
                {person?.display_name ?? t("participant")}
              </strong>
              {(person?.title || !item.in_chat) && (
                <small className="truncate">
                  {[person?.title, !item.in_chat ? t("pollVotersNotInChat") : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              )}
            </span>
          </li>
        );
      })}
      {query.hasNextPage && (
        <li>
          <Button
            variant="ghost"
            size="sm"
            pending={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {t("pollVotersMore")}
          </Button>
        </li>
      )}
    </ul>
  );
}
