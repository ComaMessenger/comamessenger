import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { messagePlainText, type ClientMessage } from "@comamessenger/core";
import { Avatar, Button, CheckMark, Dialog, EmptyState, Field, SearchField, cx } from "../ui";
import { isReadOnly, titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";

export function ForwardMessageDialog({
  message,
  authorName,
  chatName,
  onClose,
}: {
  message: ClientMessage;
  authorName: string;
  chatName?: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { api, user, store } = useMessenger();
  const { toast } = useToast();
  const chatMap = useStore(store, (state) => state.chats);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const chats = Object.values(chatMap).filter((chat) =>
    titleOf(chat, [], user.id).toLowerCase().includes(query.trim().toLowerCase()),
  );
  const metaOf = (chat: (typeof chats)[number]) =>
    chat.kind === "direct"
      ? t("chatMetaDirect")
      : isReadOnly(chat)
        ? t("chatMetaReadOnly")
        : chat.kind === "group"
          ? t("chatMetaGroup")
          : t("chatMetaChannel");
  async function submit() {
    if (!selected.size || sending) return;
    setSending(true);
    const targets = [...selected];
    const results = await Promise.all(
      targets.map(async (chatID) => {
        try {
          await api.forward(message.id, chatID, crypto.randomUUID());
          if (comment.trim())
            await api.createMessage(chatID, {
              client_msg_id: crypto.randomUUID(),
              body: comment.trim(),
              body_format: "markdown",
              mentioned_actor_ids: [],
            });
          return { chatID, ok: true };
        } catch {
          return { chatID, ok: false };
        }
      }),
    );
    setSending(false);
    const failed = results.filter((item) => !item.ok);
    const nameOf = (chatID: string) => titleOf(chatMap[chatID], [], user.id);
    if (failed.length === 0) {
      toast({ message: t("forwardSent", { chat: targets.map(nameOf).join(", ") }) });
      onClose();
      return;
    }
    setSelected(new Set(failed.map((item) => item.chatID)));
    toast({
      message: t("forwardFailed", { chat: failed.map((item) => nameOf(item.chatID)).join(", ") }),
      tone: "danger",
      action: { label: t("retry"), onClick: () => void submit() },
    });
  }
  return (
    <Dialog
      title={t("forwardTitle")}
      onClose={onClose}
      className="forward-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={sending}>
            {t("cancel")}
          </Button>
          <Button variant="primary" pending={sending} disabled={!selected.size} onClick={() => void submit()}>
            {t("forwardSelected", { count: selected.size })}
          </Button>
        </>
      }
    >
      <blockquote className="forward-dialog__quote">
        <strong className="truncate">
          {authorName}
          {chatName ? ` · ${chatName}` : ""}
        </strong>
        <span className="clamp-2">{messagePlainText(message.body)}</span>
      </blockquote>
      <SearchField value={query} onChange={setQuery} placeholder={t("forwardWhere")} clearLabel={t("clearSearch")} />
      <div className="forward-dialog__list" role="listbox" aria-multiselectable aria-label={t("forwardWhere")}>
        {chats.map((chat) => {
          const checked = selected.has(chat.id);
          const disabled = isReadOnly(chat);
          const title = titleOf(chat, [], user.id);
          return (
            <button
              key={chat.id}
              type="button"
              role="option"
              aria-selected={checked}
              disabled={disabled}
              className={cx("forward-dialog__row", checked && "forward-dialog__row--checked")}
              onClick={() =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(chat.id)) next.delete(chat.id);
                  else next.add(chat.id);
                  return next;
                })
              }
            >
              <CheckMark checked={checked} />
              <Avatar
                name={title}
                seed={chat.avatar_seed}
                actorID={chat.direct_peer?.actor_id}
                avatarVersion={chat.direct_peer?.avatar_version}
                agent={chat.direct_peer?.type === "agent"}
                size="sm"
              />
              <span className="forward-dialog__copy">
                <strong className="truncate">{title}</strong>
                <small>{metaOf(chat)}</small>
              </span>
            </button>
          );
        })}
        {chats.length === 0 && <EmptyState compact title={t("nothingFound")} />}
      </div>
      <Field
        label={t("forwardComment")}
        name="forward_comment"
        compact
        required={false}
        optional={t("optional")}
        value={comment}
        placeholder={t("forwardCommentPlaceholder")}
        onChange={(event) => setComment(event.target.value)}
      />
    </Dialog>
  );
}
