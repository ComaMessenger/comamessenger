import { Bot, MessagesSquare, Plus, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { messagePlainText } from "@comamessenger/core";
import { hasPermission } from "../settings";
import { Avatar, Badge, Button, countLabel } from "../ui";
import { firstName, greetingKey } from "../lib/format";
import { chatGlyph, titleOf } from "../lib/chats";
import { useMessenger } from "./MessengerContext";
import { Logo } from "./Logo";
import { ConnectionPill } from "./ConnectionPill";

/** Empty workspace on /chats: greeting card and the items that need attention. */
export function Welcome() {
  const { t } = useTranslation();
  const { api, user, store, navigate, openDialog } = useMessenger();
  const chats = useStore(store, (state) => state.chats);
  const unread = useStore(store, (state) => state.unread);
  const canManageAgents = hasPermission(user, "agents.manage");
  const approvals = useQuery({
    queryKey: ["agent-approvals", "pending"],
    queryFn: () => api.agentToolConfirmations("pending"),
    enabled: canManageAgents,
    staleTime: 60_000,
    retry: false,
  });

  const unreadTotal = unread.chats.reduce((sum, item) => sum + item.unread_count, 0);
  const mentionTotal = unread.chats.reduce((sum, item) => sum + item.mention_count, 0);
  const attentionChats = unread.chats
    .filter((item) => item.unread_count > 0 && chats[item.chat_id])
    .sort(
      (left, right) =>
        right.mention_count - left.mention_count ||
        right.unread_count - left.unread_count,
    )
    .slice(0, 2)
    .map((item) => ({ item, chat: chats[item.chat_id]! }));
  const unreadThreads = unread.threads.filter((item) => item.unread_count > 0);
  const threadTitles = unreadThreads
    .slice(0, 2)
    .map((item) => chats[item.chat_id]?.display_name)
    .filter(Boolean)
    .join(" · ");
  const pendingApprovals = approvals.data?.length ?? 0;
  const hasAttention =
    attentionChats.length > 0 || unreadThreads.length > 0 || pendingApprovals > 0;

  return (
    <section className="welcome" aria-label={t("selectChat")}>
      <ConnectionPill className="welcome__connection" />
      <div className="welcome__column">
        <div className="welcome__card">
          <Logo size="xl" className="welcome__logo" />
          <div className="welcome__copy">
            <h2>{t(greetingKey(), { name: firstName(user.display_name) })}</h2>
            <p>
              {unreadTotal
                ? t("welcomeSummary", { unread: unreadTotal, mentions: mentionTotal })
                : t("welcomeSummaryQuiet")}
            </p>
            <div className="welcome__actions">
              <Button variant="ink" size="sm" onClick={() => openDialog({ kind: "new-chat" })}>
                <Plus strokeWidth={2.4} />
                {t("newChat")}
              </Button>
              <Button variant="ink-soft" size="sm" onClick={() => openDialog({ kind: "search" })}>
                <Search />
                {t("searchShortcut")}
              </Button>
              {user.can_create_invitations && (
                <Button
                  variant="ink-soft"
                  size="sm"
                  onClick={() => navigate("/settings/workspace/invitations")}
                >
                  {t("inviteColleagues")}
                </Button>
              )}
            </div>
          </div>
        </div>
        {hasAttention && (
          <>
            <h3 className="welcome__section">{t("needsAttention")}</h3>
            <div className="welcome__grid">
              {attentionChats.map(({ item, chat }) => (
                <button
                  key={chat.id}
                  type="button"
                  className="welcome__tile"
                  onClick={() => navigate(`/chat/${chat.id}`)}
                >
                  <Avatar
                    name={titleOf(chat, [], user.id)}
                    seed={chat.avatar_seed}
                    actorID={chat.direct_peer?.actor_id}
                    avatarVersion={chat.direct_peer?.avatar_version}
                    agent={chat.direct_peer?.type === "agent"}
                    glyph={chatGlyph(chat)}
                    size="md"
                  />
                  <span className="welcome__tile-body">
                    <span className="welcome__tile-head">
                      <strong className="truncate">{titleOf(chat, [], user.id)}</strong>
                      {item.mention_count ? (
                        <Badge tone="primary">@</Badge>
                      ) : (
                        <Badge>{countLabel(item.unread_count)}</Badge>
                      )}
                    </span>
                    <small className="clamp-2">
                      {chat.last_message && !chat.last_message.deleted
                        ? `${chat.kind === "direct" ? "" : `${chat.last_message.actor_display_name}: `}${messagePlainText(chat.last_message.body)}`
                        : chat.topic}
                    </small>
                  </span>
                </button>
              ))}
              {unreadThreads.length > 0 && (
                <button type="button" className="welcome__tile" onClick={() => navigate("/threads")}>
                  <span className="welcome__tile-icon">
                    <MessagesSquare aria-hidden="true" />
                  </span>
                  <span className="welcome__tile-body">
                    <strong>{t("threadsWithReplies", { count: unreadThreads.length })}</strong>
                    {threadTitles && <small className="truncate">{threadTitles}</small>}
                  </span>
                </button>
              )}
              {pendingApprovals > 0 && (
                <button
                  type="button"
                  className="welcome__tile"
                  onClick={() => navigate("/agents/approvals")}
                >
                  <span className="welcome__tile-icon">
                    <Bot aria-hidden="true" />
                  </span>
                  <span className="welcome__tile-body">
                    <strong>{t("agentApprovalsPending", { count: pendingApprovals })}</strong>
                    <small>{t("welcomeApprovalsHint")}</small>
                  </span>
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
