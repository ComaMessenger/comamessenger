import { useState } from "react";
import { ChevronDown, ChevronUp, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { ChatFolder } from "@comamessenger/core";
import { Avatar, Button, CheckMark, Dialog, Field, SearchField, cx } from "../ui";
import {
  FolderGlyph,
  featuredFolderIconCount,
  folderColors,
  folderIconOptions,
} from "../lib/folders";
import { titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";

export function ChatFolderDialog({
  onClose,
  onSave,
}: {
  onClose(): void;
  onSave(folder: ChatFolder): void | Promise<void>;
}) {
  const { t } = useTranslation();
  const { user, store } = useMessenger();
  const chats = Object.values(useStore(store, (state) => state.chats));
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<ChatFolder["icon"]>("folder");
  const [color, setColor] = useState<ChatFolder["color"]>("blue");
  const [iconQuery, setIconQuery] = useState("");
  const [allIcons, setAllIcons] = useState(false);
  const [chatQuery, setChatQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const localizedTerms = new Map(
    t("folderIconSearchTerms")
      .split("|")
      .map((entry) => {
        const separator = entry.indexOf(":");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
  const normalizedIconQuery = iconQuery.trim().toLocaleLowerCase();
  const matchingIcons = folderIconOptions.filter((option) =>
    `${t(option.labelKey)} ${option.terms} ${localizedTerms.get(option.id) ?? ""}`
      .toLocaleLowerCase()
      .includes(normalizedIconQuery),
  );
  const visibleIcons =
    normalizedIconQuery || allIcons
      ? matchingIcons
      : matchingIcons.slice(0, featuredFolderIconCount);
  const hiddenIcons = matchingIcons.length - visibleIcons.length;
  const visibleChats = chats.filter((chat) =>
    titleOf(chat, [], user.id).toLocaleLowerCase().includes(chatQuery.trim().toLocaleLowerCase()),
  );
  async function save() {
    setPending(true);
    try {
      await onSave({ id: crypto.randomUUID(), name: name.trim(), icon, color, chat_ids: selected });
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      title={t("newFolderTitle")}
      onClose={onClose}
      className="folder-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button variant="primary" pending={pending} disabled={!name.trim()} onClick={() => void save()}>
            {t("createFolder")}
          </Button>
        </>
      }
    >
      <div className="folder-dialog__head">
        <span className="folder-dialog__preview" data-folder-color={color} aria-hidden="true">
          <FolderGlyph icon={icon} size={24} />
        </span>
        <Field
          label={t("folderName")}
          name="folder_name"
          compact
          maxLength={40}
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <fieldset className="folder-dialog__group">
        <legend className="folder-dialog__label">{t("folderColorLabel")}</legend>
        <div className="folder-dialog__colors">
          {folderColors.map((value) => (
            <button
              type="button"
              key={value}
              data-folder-color={value}
              className={cx("folder-dialog__color", color === value && "folder-dialog__color--active")}
              aria-pressed={color === value}
              aria-label={t("chooseFolderColor", { color: value })}
              onClick={() => setColor(value)}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="folder-dialog__group" data-folder-color={color}>
        <div className="folder-dialog__label-row">
          <legend className="folder-dialog__label">{t("folderIcon")}</legend>
          <SearchField
            className="folder-dialog__icon-search"
            value={iconQuery}
            onChange={setIconQuery}
            placeholder={t("searchIcons")}
            clearLabel={t("clearSearch")}
          />
        </div>
        <div className="folder-dialog__icons">
          {visibleIcons.map((option) => {
            const Glyph = option.icon;
            const label = t(option.labelKey);
            return (
              <button
                type="button"
                key={option.id}
                className={cx("folder-dialog__icon", icon === option.id && "folder-dialog__icon--active")}
                aria-pressed={icon === option.id}
                aria-label={label}
                title={label}
                onClick={() => setIcon(option.id)}
              >
                <Glyph aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <div className="folder-dialog__icon-actions">
          {!normalizedIconQuery && (
            <button type="button" className="folder-dialog__more" onClick={() => setAllIcons((value) => !value)}>
              {allIcons ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              {allIcons ? t("folderFewerIcons") : t("folderMoreIcons", { count: hiddenIcons })}
            </button>
          )}
          <button type="button" className="folder-dialog__cover" disabled title={t("folderCustomCover")}>
            <Upload aria-hidden="true" />
            {t("folderCustomCover")}
          </button>
        </div>
      </fieldset>
      <div className="folder-dialog__group">
        <div className="folder-dialog__label-row">
          <span className="folder-dialog__label">{t("folderChats")}</span>
          <span className="folder-dialog__count">{t("folderSelectedCount", { count: selected.length })}</span>
        </div>
        <SearchField value={chatQuery} onChange={setChatQuery} placeholder={t("findChat")} clearLabel={t("clearSearch")} />
        <div className="folder-dialog__chats" role="group" aria-label={t("folderChats")}>
          {visibleChats.map((chat) => {
            const checked = selected.includes(chat.id);
            const title = titleOf(chat, [], user.id);
            return (
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                key={chat.id}
                className="folder-dialog__chat"
                onClick={() =>
                  setSelected((items) =>
                    items.includes(chat.id) ? items.filter((id) => id !== chat.id) : [...items, chat.id],
                  )
                }
              >
                <CheckMark checked={checked} />
                <Avatar name={title} seed={chat.avatar_seed} size="xs" />
                <span className="truncate">{title}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
