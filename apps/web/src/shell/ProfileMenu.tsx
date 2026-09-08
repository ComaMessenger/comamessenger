import { useState } from "react";
import {
  Bell,
  BookOpen,
  Bug,
  ChevronDown,
  History,
  Moon,
  Smile,
  UserRound,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar, Menu, MenuDivider, MenuItem, cx } from "../ui";
import { formatDateTime } from "../lib/format";
import { useMessenger } from "./MessengerContext";
import { SnoozeControls } from "./SnoozeControls";

export const helpLinks = {
  knowledgeBase: "https://github.com/ComaMessenger/comamessenger#readme",
  reportProblem: "https://github.com/ComaMessenger/comamessenger/issues/new/choose",
  latestUpdates: "https://github.com/ComaMessenger/comamessenger/commits/main/",
};

export function ProfileMenu({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { user, navigate, openDialog, snoozedUntil } = useMessenger();
  const [dndOpen, setDndOpen] = useState(Boolean(snoozedUntil));
  return (
    <Menu label={t("profileMenu")} className="profile-menu">
      <div className="profile-menu__identity">
        <Avatar
          name={user.display_name}
          seed={user.id}
          actorID={user.id}
          avatarVersion={user.avatar_version}
          size="xl"
          presence="online"
        />
        <span className="profile-menu__identity__copy">
          <strong className="truncate">{user.display_name}</strong>
          <small className="truncate">
            @{user.handle} · {t("online").toLocaleLowerCase()}
          </small>
        </span>
      </div>
      <MenuItem
        icon={<Smile />}
        className={cx(!user.status_text && "profile-menu__status--empty")}
        onClick={() => {
          onClose();
          openDialog({ kind: "status" });
        }}
      >
        {user.status_text
          ? `${user.status_emoji} ${user.status_text}`.trim()
          : t("setStatusAction")}
      </MenuItem>
      <MenuItem
        icon={<UserRound />}
        onClick={() => {
          onClose();
          navigate("/settings/profile");
        }}
      >
        {t("personalSettings")}
      </MenuItem>
      <div className={cx("profile-menu__dnd", dndOpen && "profile-menu__dnd--open")}>
        <button
          type="button"
          className="ui-menu__item profile-menu__dnd-toggle"
          aria-expanded={dndOpen}
          onClick={() => setDndOpen((open) => !open)}
        >
          <Moon aria-hidden="true" />
          <span>
            <b>{t("doNotDisturb")}</b>
            <small>
              {snoozedUntil
                ? t("dndUntil", { time: formatDateTime(snoozedUntil) })
                : t("dndOff")}
            </small>
          </span>
          <ChevronDown aria-hidden="true" className="profile-menu__chevron" />
        </button>
        {dndOpen && <SnoozeControls />}
      </div>
      <MenuItem
        icon={<Bell />}
        onClick={() => {
          onClose();
          navigate("/settings/notifications");
        }}
      >
        {t("notifications")}
      </MenuItem>
      <MenuDivider />
      <a className="ui-menu__item profile-menu__link" role="menuitem" href={helpLinks.knowledgeBase} target="_blank" rel="noreferrer">
        <BookOpen aria-hidden="true" />
        <span>{t("knowledgeBase")}</span>
      </a>
      <a className="ui-menu__item profile-menu__link" role="menuitem" href={helpLinks.reportProblem} target="_blank" rel="noreferrer">
        <Bug aria-hidden="true" />
        <span>{t("reportProblem")}</span>
      </a>
      <a className="ui-menu__item profile-menu__link" role="menuitem" href={helpLinks.latestUpdates} target="_blank" rel="noreferrer">
        <History aria-hidden="true" />
        <span>{t("whatsNew")}</span>
        <i className="profile-menu__dot" aria-hidden="true" />
      </a>
    </Menu>
  );
}
