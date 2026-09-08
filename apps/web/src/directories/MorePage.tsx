import { useState, type ReactNode } from "react";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  LogOut,
  Moon,
  Settings2,
  Smile,
  UserRound,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Avatar, Spinner, cx } from "../ui";
import { formatTime } from "../lib/format";
import { useMessenger } from "../shell/MessengerContext";
import { Logo } from "../shell/Logo";
import { SnoozeControls } from "../shell/SnoozeControls";
import { workspaceRoleKey } from "../shell/WorkspaceMenu";

function MoreRow({
  icon,
  title,
  hint,
  hintTone = "muted",
  trailing,
  onClick,
  danger = false,
  disabled = false,
  expanded,
}: {
  icon: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  hintTone?: "muted" | "primary" | "foreground";
  trailing?: ReactNode;
  onClick?(): void;
  danger?: boolean;
  disabled?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx("more-page__row", danger && "more-page__row--danger")}
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
    >
      <span className="more-page__row-icon">{icon}</span>
      <span className="more-page__row-body">
        <strong>{title}</strong>
        {hint && (
          <small className={cx(`more-page__hint--${hintTone}`)}>{hint}</small>
        )}
      </span>
      {trailing !== undefined ? (
        trailing
      ) : onClick ? (
        <ChevronRight className="more-page__chevron" aria-hidden="true" />
      ) : null}
    </button>
  );
}

export function MorePage() {
  const { t } = useTranslation();
  const { api, user, navigate, logout, snoozedUntil, openDialog } =
    useMessenger();
  const [dndOpen, setDndOpen] = useState(Boolean(snoozedUntil));
  const [loggingOut, setLoggingOut] = useState(false);
  const preferences = useQuery({
    queryKey: ["preferences"],
    queryFn: () => api.preferences(),
    staleTime: 60_000,
  });
  const isAdmin = user.role !== "member";
  const statusText = user.status_text
    ? `${user.status_emoji} ${user.status_text}`.trim()
    : "";

  async function signOut() {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      setLoggingOut(false);
    }
  }

  return (
    <section className="more-page" aria-label={t("more")}>
      <div className="more-page__column">
        <header className="more-page__identity">
          <Avatar
            name={user.display_name}
            seed={user.id}
            actorID={user.id}
            avatarVersion={user.avatar_version}
            size="xxl"
            presence="online"
            className="more-page__avatar"
          />
          <span className="more-page__identity-copy">
            <strong className="truncate">{user.display_name}</strong>
            <small className="truncate">
              @{user.handle} · {t("moreOnline")}
            </small>
          </span>
        </header>

        <button
          type="button"
          className="more-page__workspace"
          onClick={isAdmin ? () => navigate("/settings/workspace") : undefined}
          disabled={!isAdmin}
        >
          <Logo size="md" className="more-page__workspace-logo" />
          <span className="more-page__workspace-copy">
            <strong className="truncate">{user.organization_name}</strong>
            <small className="truncate">
              {window.location.host} ·{" "}
              {t(workspaceRoleKey(user.role)).toLocaleLowerCase()}
            </small>
          </span>
          {isAdmin && (
            <ChevronRight className="more-page__chevron" aria-hidden="true" />
          )}
        </button>

        <div className="more-page__card">
          <MoreRow
            icon={<Smile aria-hidden="true" />}
            title={t("moreStatus")}
            hint={statusText || t("moreStatusEmpty")}
            hintTone={statusText ? "foreground" : "muted"}
            onClick={() => openDialog({ kind: "status" })}
          />
          <div className="more-page__divider" />
          <MoreRow
            icon={<Moon aria-hidden="true" />}
            title={t("moreDnd")}
            hint={
              snoozedUntil
                ? t("moreDndUntil", { time: formatTime(snoozedUntil) })
                : t("moreDndOff")
            }
            hintTone={snoozedUntil ? "primary" : "muted"}
            expanded={dndOpen}
            onClick={() => setDndOpen((open) => !open)}
            trailing={
              <ChevronDown
                className={cx(
                  "more-page__chevron",
                  "more-page__chevron--toggle",
                  dndOpen && "more-page__chevron--open",
                )}
                aria-hidden="true"
              />
            }
          />
          {dndOpen && (
            <div className="more-page__dnd">
              <SnoozeControls size="lg" />
            </div>
          )}
          <div className="more-page__divider" />
          <MoreRow
            icon={<UserRound aria-hidden="true" />}
            title={t("moreProfile")}
            hint={t("moreProfileHint")}
            onClick={() => navigate("/settings/profile")}
          />
          {isAdmin && (
            <>
              <div className="more-page__divider" />
              <MoreRow
                icon={<Settings2 aria-hidden="true" />}
                title={t("workspaceSettings")}
                hint={t("moreWorkspaceHint")}
                onClick={() => navigate("/settings/workspace")}
              />
            </>
          )}
          <div className="more-page__divider" />
          <MoreRow
            icon={<Bell aria-hidden="true" />}
            title={t("notifications")}
            hint={
              preferences.data
                ? preferences.data.push_enabled
                  ? t("morePushOn")
                  : t("morePushOff")
                : t("notificationsHint")
            }
            onClick={() => navigate("/settings/notifications")}
          />
        </div>

        <div className="more-page__card">
          <MoreRow
            danger
            icon={<LogOut aria-hidden="true" />}
            title={loggingOut ? t("moreLoggingOut") : t("logout")}
            hint={user.email}
            disabled={loggingOut}
            onClick={() => void signOut()}
            trailing={
              loggingOut ? <Spinner /> : <span className="more-page__spacer" />
            }
          />
        </div>
      </div>
    </section>
  );
}
