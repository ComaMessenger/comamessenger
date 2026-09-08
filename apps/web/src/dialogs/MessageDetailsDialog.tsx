import { useState } from "react";
import { Eye, Smile } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ChatMember, ClientMessage, MessageReceipt, Reaction } from "@comamessenger/core";
import { Avatar, Dialog, EmptyState, SkeletonRow, Tabs } from "../ui";
import { formatTime } from "../lib/format";
import { useMessenger } from "../shell/MessengerContext";

export function MessageDetailsDialog({
  message,
  members,
  onClose,
}: {
  message: ClientMessage;
  members: ChatMember[];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { api, user } = useMessenger();
  const [tab, setTab] = useState<"receipts" | "reactions">("receipts");
  const receipts = useQuery<MessageReceipt[]>({
    queryKey: ["message-receipts", message.id],
    queryFn: () => api.receipts(message.id),
  });
  const reactions = useQuery<Reaction[]>({
    queryKey: ["message-reactions", message.id],
    queryFn: () => api.reactions(message.id),
  });
  const memberOf = (actorID: string) => members.find((member) => member.actor_id === actorID);
  const nameOf = (actorID: string) =>
    actorID === user.id ? user.display_name : memberOf(actorID)?.display_name ?? t("participant");
  const reactionActors = Object.values(
    (reactions.data ?? []).reduce<Record<string, { actorID: string; emojis: string[] }>>(
      (result, reaction) => {
        const current = result[reaction.actor_id] ?? { actorID: reaction.actor_id, emojis: [] };
        current.emojis.push(reaction.emoji);
        result[reaction.actor_id] = current;
        return result;
      },
      {},
    ),
  );
  const readers = (receipts.data ?? []).filter((receipt) => receipt.actor_id !== message.actor_id);
  const others = members.filter(
    (member) => member.actor_id !== message.actor_id && member.actor_id !== user.id,
  ).length;
  const unread = Math.max(0, others - readers.length);
  return (
    <Dialog
      title={t("viewsAndReactions")}
      onClose={onClose}
      size="sm"
      className="details-dialog"
      bodyClassName="details-dialog__body"
    >
      <Tabs<"receipts" | "reactions">
        underline
        label={t("viewsAndReactions")}
        value={tab}
        onChange={setTab}
        className="details-dialog__tabs"
        items={[
          {
            id: "receipts",
            icon: <Eye aria-hidden="true" />,
            label: t("viewsTab", { count: readers.length }),
          },
          {
            id: "reactions",
            icon: <Smile aria-hidden="true" />,
            label: t("reactionsTab", { count: reactions.data?.length ?? 0 }),
          },
        ]}
      />
      <div className="details-dialog__list" role="tabpanel">
        {tab === "receipts" ? (
          receipts.isLoading ? (
            <>
              <SkeletonRow avatar={32} />
              <SkeletonRow avatar={32} />
            </>
          ) : readers.length === 0 ? (
            <EmptyState compact title={t("nobodyRead")} />
          ) : (
            <>
              {readers.map((receipt) => (
                <div className="details-dialog__person" key={receipt.actor_id}>
                  <Avatar
                    name={nameOf(receipt.actor_id)}
                    seed={receipt.actor_id}
                    actorID={receipt.actor_id}
                    avatarVersion={memberOf(receipt.actor_id)?.avatar_version}
                    agent={memberOf(receipt.actor_id)?.type === "agent"}
                    size="sm"
                  />
                  <strong className="truncate">{nameOf(receipt.actor_id)}</strong>
                  <time className="tabular">{formatTime(receipt.read_at)}</time>
                </div>
              ))}
              {unread > 0 && (
                <p className="details-dialog__more">{t("detailsUnread", { count: unread })}</p>
              )}
            </>
          )
        ) : reactions.isLoading ? (
          <>
            <SkeletonRow avatar={28} lines={["60%", "0%"]} />
            <SkeletonRow avatar={28} lines={["45%", "0%"]} />
          </>
        ) : reactionActors.length === 0 ? (
          <EmptyState compact title={t("noReactions")} hint={t("beFirst")} />
        ) : (
          reactionActors.map((entry) => (
            <div className="details-dialog__person" key={entry.actorID}>
              <Avatar
                name={nameOf(entry.actorID)}
                seed={entry.actorID}
                actorID={entry.actorID}
                avatarVersion={memberOf(entry.actorID)?.avatar_version}
                size="sm"
              />
              <strong className="truncate">{nameOf(entry.actorID)}</strong>
              <span className="details-dialog__emojis">{entry.emojis.join(" ")}</span>
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}
