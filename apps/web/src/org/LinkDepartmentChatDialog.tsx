import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  chatAvatarSource,
  type OrgDepartment,
  type OrgStructure,
} from "@comamessenger/core";
import { Avatar, Button, Dialog, EmptyState, FormError, SearchField } from "../ui";
import { titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";
import { orgErrorText } from "./useOrg";

/**
 * "Link a chat": a group (not a direct chat or a channel), not archived,
 * that the reader owns or administers, and not already another
 * department's chat. The server checks the same (422 department_chat_invalid,
 * 409 department_chat_exists).
 */
export function LinkDepartmentChatDialog({
  department,
  structure,
  onClose,
  onLinked,
}: {
  department: OrgDepartment;
  structure: OrgStructure;
  onClose(): void;
  onLinked(): void;
}) {
  const { t } = useTranslation();
  const { api, user, store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const linked = useMemo(
    () =>
      new Set(
        structure.departments
          .map((item) => item.chat_id)
          .filter((id): id is string => Boolean(id)),
      ),
    [structure],
  );
  const candidates = Object.values(chatMap)
    .filter(
      (chat) =>
        chat.kind === "group" &&
        !chat.archived_at &&
        (chat.role === "owner" || chat.role === "admin") &&
        !linked.has(chat.id),
    )
    .filter((chat) =>
      titleOf(chat, [], user.id)
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    )
    .sort((left, right) =>
      titleOf(left, [], user.id).localeCompare(titleOf(right, [], user.id)),
    );

  async function link(chatID: string) {
    setPending(chatID);
    setError("");
    try {
      await api.linkDepartmentChat(department.id, chatID);
      onLinked();
    } catch (cause) {
      setError(orgErrorText(cause));
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog
      title={t("orgChatLinkTitle", { name: department.name })}
      description={t("orgChatLinkHint")}
      onClose={onClose}
      sheet
    >
      <div className="org-picker">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t("orgChatLinkSearch")}
          clearLabel={t("clearSearch")}
        />
        {candidates.length ? (
          <div className="org-picker__list">
            {candidates.map((chat) => (
              <div key={chat.id} className="org-picker__row">
                <Avatar
                  name={titleOf(chat, [], user.id)}
                  seed={chat.avatar_seed}
                  {...chatAvatarSource(chat)}
                  size="md"
                />
                <span className="org-picker__body">
                  <strong className="truncate">
                    {titleOf(chat, [], user.id)}
                  </strong>
                </span>
                <Button
                  size="sm"
                  pending={pending === chat.id}
                  disabled={pending !== null}
                  onClick={() => void link(chat.id)}
                >
                  {t("orgChatLinkAction")}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title={t("orgChatLinkEmpty")} />
        )}
        {error && <FormError message={error} />}
      </div>
    </Dialog>
  );
}
