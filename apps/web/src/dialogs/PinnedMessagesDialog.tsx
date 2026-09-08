import { Pin } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { messagePlainText, type Message, type MessagePin } from "@comamessenger/core";
import { Avatar, Dialog, EmptyState, InlineError, SkeletonRow } from "../ui";
import { formatListTime } from "../lib/format";
import { useMessenger } from "../shell/MessengerContext";

export type PinnedEntry = { pin: MessagePin; message: Message | undefined };

export function usePinnedMessages(chatID: string) {
  const { api } = useMessenger();
  return useQuery({
    queryKey: ["pins", chatID],
    queryFn: async (): Promise<PinnedEntry[]> => {
      const pins = await api.pins(chatID);
      return Promise.all(
        pins.map(async (pin) => {
          try {
            const context = await api.messageContext(pin.message_id, 1);
            return {
              pin,
              message: context.messages.find((item) => item.id === pin.message_id),
            };
          } catch {
            return { pin, message: undefined };
          }
        }),
      );
    },
  });
}

export function PinnedMessagesDialog({
  chatID,
  onClose,
  onOpen,
}: {
  chatID: string;
  onClose(): void;
  onOpen(messageID: string): void;
}) {
  const { t } = useTranslation();
  const { api } = useMessenger();
  const query = usePinnedMessages(chatID);
  const members = useQuery({
    queryKey: ["chat-members", chatID],
    queryFn: () => api.members(chatID),
  });
  const authorOf = (actorID: string) =>
    members.data?.find((member) => member.actor_id === actorID)?.display_name ??
    t("participant");
  const entries = query.data ?? [];
  return (
    <Dialog
      title={t("pinnedTitle", { count: entries.length })}
      onClose={onClose}
      size="sm"
      sheet
      plain
      className="pinned-dialog"
      bodyClassName="ui-dialog__body--flush"
    >
      {query.isLoading ? (
        <>
          <SkeletonRow avatar={28} />
          <SkeletonRow avatar={28} />
        </>
      ) : query.isError ? (
        <InlineError
          title={t("pinnedLoadError")}
          onRetry={() => void query.refetch()}
          retryLabel={t("retry")}
          center
        />
      ) : entries.length === 0 ? (
        <EmptyState icon={<Pin />} title={t("pinnedEmpty")} hint={t("pinnedEmptyHint")} />
      ) : (
        <div className="pinned-dialog__list">
          {entries.map(({ pin, message }) => (
            <button
              key={pin.message_id}
              type="button"
              className="pinned-dialog__row"
              onClick={() => onOpen(pin.message_id)}
            >
              <Avatar
                name={message ? authorOf(message.actor_id) : t("participant")}
                seed={message?.actor_id ?? pin.message_id}
                size="sm"
              />
              <span className="pinned-dialog__body">
                <span className="pinned-dialog__head">
                  <strong className="truncate">
                    {message ? authorOf(message.actor_id) : t("participant")}
                  </strong>
                  <small>{formatListTime(message?.created_at ?? pin.pinned_at)}</small>
                </span>
                <span className="pinned-dialog__text clamp-2">
                  {message?.deleted_at
                    ? t("remove")
                    : message
                      ? messagePlainText(message.body)
                      : ""}
                </span>
              </span>
              <Pin className="pinned-dialog__pin" aria-hidden="true" />
            </button>
          ))}
          <p className="pinned-dialog__hint">{t("pinnedUnpinHint")}</p>
        </div>
      )}
    </Dialog>
  );
}
