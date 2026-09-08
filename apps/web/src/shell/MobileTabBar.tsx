import { MessageCircle, MessagesSquare, MoreHorizontal, Star, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cx } from "../ui";
import type { PrimarySection } from "./GlobalSidebar";

export function MobileTabBar({
  active,
  compact,
  navigate,
}: {
  active: PrimarySection;
  /** Inside an open conversation the bar shrinks to icons only. */
  compact: boolean;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const items = [
    { id: "chats" as const, path: "/chats", label: t("chats"), icon: MessageCircle },
    { id: "threads" as const, path: "/threads", label: t("threads"), icon: MessagesSquare },
    { id: "important" as const, path: "/important", label: t("important"), icon: Star },
    { id: "members" as const, path: "/members", label: t("members"), icon: Users },
    { id: "more" as const, path: "/more", label: t("mobileMore"), icon: MoreHorizontal },
  ];
  return (
    <nav
      className={cx("mobile-tabbar", compact && "mobile-tabbar--compact")}
      aria-label={t("primaryNavigation")}
    >
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={cx("mobile-tabbar__item", isActive && "active")}
            aria-current={isActive ? "page" : undefined}
            aria-label={item.label}
            title={item.label}
            onClick={() => navigate(item.path)}
          >
            <span className="mobile-tabbar__icon">
              <Icon aria-hidden="true" />
            </span>
            <span className="mobile-tabbar__label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
