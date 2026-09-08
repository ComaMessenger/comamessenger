import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar, IconButton, cx } from "../ui";
import type { InAppNotification } from "./useMessengerSession";

export function InAppNotifications({
  items,
  onOpen,
  onDismiss,
}: {
  items: InAppNotification[];
  onOpen(notification: InAppNotification): void;
  onDismiss(id: string): void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="in-app-notification-stack"
      role="region"
      aria-live="polite"
      aria-label={t("inAppNotifications")}
    >
      {items.map((notification) => (
        <article
          className={cx(
            "in-app-notification",
            notification.mention && "in-app-notification--mention",
          )}
          key={notification.id}
        >
          <button
            type="button"
            className="in-app-notification__content"
            onClick={() => onOpen(notification)}
          >
            <Avatar name={notification.avatarName} seed={notification.avatarSeed} size="md" />
            <span>
              <strong className="truncate">
                {notification.title}
                {notification.mention && (
                  <i className="in-app-notification__mention" aria-label={t("newMention")}>
                    @
                  </i>
                )}
              </strong>
              <small className="clamp-2">{notification.body}</small>
            </span>
          </button>
          <IconButton
            size="icon-sm"
            label={t("close")}
            onClick={() => onDismiss(notification.id)}
          >
            <X />
          </IconButton>
          <span className="in-app-notification__progress" aria-hidden="true" />
        </article>
      ))}
    </div>
  );
}
