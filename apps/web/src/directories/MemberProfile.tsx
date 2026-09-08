import { useMemo, useState } from "react";
import { MessageSquare } from "lucide-react";
import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { ActorSummary, Chat } from "@comamessenger/core";
import { Avatar, Button, Tag } from "../ui";
import { titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";
import { DirectoryDetailHead } from "./DirectoryPage";
import { openDirectChat } from "./openDirectChat";

/** Non-direct chats where both the viewer and the actor are members (one members call per chat, cached). */
function useSharedChats(actorID: string) {
  const { api, store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const chats = useMemo(() => Object.values(chatMap), [chatMap]);
  const groupChats = useMemo(
    () => chats.filter((chat) => chat.kind !== "direct").slice(0, 60),
    [chats],
  );
  const results = useQueries({
    queries: groupChats.map((chat) => ({
      queryKey: ["chat-members", chat.id],
      queryFn: () => api.members(chat.id),
      staleTime: 5 * 60_000,
    })),
  });
  const loading = results.some((result) => result.isLoading);
  const shared: Chat[] = groupChats.filter((_, index) =>
    results[index]?.data?.some((member) => member.actor_id === actorID),
  );
  return { shared, loading };
}

/** Member detail: identity, status, actions, about and shared chats. */
export function MemberProfile({
  actor,
  onBack,
  standalone = false,
}: {
  actor: ActorSummary;
  onBack(): void;
  /** Mobile full-screen page with its own back button. */
  standalone?: boolean;
}) {
  const { t } = useTranslation();
  const { api, user, store, navigate } = useMessenger();
  const presence = useStore(store, (state) => state.presence[actor.actor_id] ?? "offline");
  const { shared, loading } = useSharedChats(actor.actor_id);
  const [opening, setOpening] = useState(false);
  const isAgent = actor.type === "agent";

  async function write() {
    if (opening) return;
    setOpening(true);
    try {
      navigate(`/chat/${await openDirectChat(api, store, actor.actor_id)}`);
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="member-profile">
      {standalone && <DirectoryDetailHead onBack={onBack} title={t("memberProfileTitle")} />}
      <div className="member-profile__scroll">
        <header className="member-profile__identity">
          <Avatar
            name={actor.display_name}
            seed={actor.actor_id}
            actorID={actor.actor_id}
            avatarVersion={actor.avatar_version}
            size="xxl"
            agent={isAgent}
            square={isAgent}
            presence={isAgent ? undefined : presence}
          />
          <div className="member-profile__copy">
            <div className="member-profile__name">
              <h2>{actor.display_name}</h2>
              {isAgent && (
                <Tag tone="agent" size="lg">
                  {t("memberTagAgent")}
                </Tag>
              )}
            </div>
            <p className="member-profile__handle">
              {[`@${actor.handle}`, actor.title, !isAgent && t(presence === "online" ? "presenceOnline" : presence === "away" ? "presenceAway" : "presenceOffline")].filter(Boolean).join(" · ")}
            </p>
            {actor.status_text && (
              <span className="member-profile__status">
                {actor.status_emoji && <span aria-hidden="true">{actor.status_emoji}</span>}
                {actor.status_text}
              </span>
            )}
            <div className="member-profile__actions">
              <Button variant="primary" size="lg" pending={opening} onClick={() => void write()}>
                <MessageSquare aria-hidden="true" />
                {t("memberWrite")}
              </Button>
            </div>
          </div>
        </header>
        <div className="member-profile__cards">
          {actor.about && (
            <section className="member-profile__card">
              <h3>{t("memberAbout")}</h3>
              <p>{actor.about}</p>
            </section>
          )}
          <section className="member-profile__card member-profile__card--wide">
            <h3>{loading ? t("memberSharedChats") : t("memberSharedChatsCount", { count: shared.length })}</h3>
            {shared.length > 0 ? (
              <div className="member-profile__chats">
                {shared.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    className="member-profile__chat"
                    onClick={() => navigate(`/chat/${chat.id}`)}
                  >
                    <Avatar name={titleOf(chat, [], user.id)} seed={chat.avatar_seed} size="xs" />
                    {titleOf(chat, [], user.id)}
                  </button>
                ))}
              </div>
            ) : (
              <p className="member-profile__muted">
                {loading ? t("memberSharedChatsLoading") : t("memberSharedChatsEmpty")}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
