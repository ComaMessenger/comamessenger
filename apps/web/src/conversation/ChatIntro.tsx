import { UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Chat } from "@comamessenger/core";
import { Avatar, Button } from "../ui";
import { formatLongDate } from "../lib/format";
import { chatGlyph } from "../lib/chats";

/** Shown at the very top of history: who the chat is and when it started. */
export function ChatIntro({
  chat,
  title,
  onAddMembers,
}: {
  chat: Chat;
  title: string;
  onAddMembers(): void;
}) {
  const { t } = useTranslation();
  return (
    <section className="chat-intro">
      <Avatar
        name={title}
        seed={chat.avatar_seed}
        actorID={chat.direct_peer?.actor_id}
        avatarVersion={chat.direct_peer?.avatar_version}
        agent={chat.direct_peer?.type === "agent"}
        glyph={chatGlyph(chat)}
        size="xxl"
      />
      <h2>{title}</h2>
      <p>
        {chat.topic ? `${t("topicLabel", { topic: chat.topic })} · ` : ""}
        {t("createdOn", { date: formatLongDate(chat.created_at) })}
      </p>
      {chat.kind !== "direct" && (
        <Button size="sm" onClick={onAddMembers}>
          <UserPlus />
          {t("addMembers")}
        </Button>
      )}
    </section>
  );
}
