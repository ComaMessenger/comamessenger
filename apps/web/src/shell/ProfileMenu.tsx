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
  UsersRound,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { myStatusSummary, substitutingLine } from "@comamessenger/core";
import { Menu, MenuDivider, MenuItem, cx } from "../ui";
import { calendarLocale } from "../requests/format";
import { AwayAvatar } from "../status/AwayAvatar";
import {
  useAwayLookup,
  useSelfAway,
  useSubstituting,
} from "../status/useAway";
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
  const away = useSelfAway();
  const now = new Date();
  // The away status in effect or planned, else the custom one (decision 12).
  const summary = myStatusSummary({ ...user, away }, now, calendarLocale());
  const substituting = useSubstituting();
  const people = useAwayLookup();
  const statusLine =
    summary.kind === "none" ? "" : `${summary.emoji} ${summary.text}`.trim();
  return (
    <Menu label={t("profileMenu")} className="profile-menu">
      <div className="profile-menu__identity">
        <AwayAvatar
          name={user.display_name}
          seed={user.id}
          actorID={user.id}
          avatarVersion={user.avatar_version}
          size="xl"
          presence="online"
          away={away}
          now={now}
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
        className={cx(
          !statusLine && "profile-menu__status--empty",
          (summary.kind === "away" || summary.kind === "planned") &&
            "profile-menu__status--away",
        )}
        onClick={() => {
          onClose();
          openDialog({ kind: "status" });
        }}
      >
        {statusLine || t("setStatusAction")}
      </MenuItem>
      {(substituting.data ?? []).map((entry) => {
        const name = people.lookup(entry.actor_id)?.display_name;
        if (!name) return null;
        return (
          <MenuItem
            key={entry.actor_id}
            icon={<UsersRound />}
            className="profile-menu__substituting"
            onClick={() => {
              onClose();
              navigate(`/members/${entry.actor_id}`);
            }}
          >
            {substitutingLine(entry, name, new Date(), calendarLocale())}
          </MenuItem>
        );
      })}
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
