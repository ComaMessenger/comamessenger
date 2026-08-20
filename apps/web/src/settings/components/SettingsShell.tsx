import type { ReactNode } from "react";
import type { User } from "@comamessenger/core";
import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../../ui";
import {
  parentSettingsPage,
  visibleChildSettings,
  visibleSettings,
  type SettingsPageID,
} from "../registry";

export type SettingsNavigate = (to: string) => void;

export function SettingsShell({
  user,
  active,
  title,
  navigate,
  children,
}: {
  user: User;
  active: SettingsPageID;
  title: string;
  navigate: SettingsNavigate;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const primaryActive = parentSettingsPage(active);
  const childPages = visibleChildSettings(user, primaryActive);

  return (
    <section
      className={`settings-page utility-page${childPages.length ? " settings-page--nested" : ""}`}
    >
      <header className="utility-page__header">
        <IconButton
          className="mobile-back"
          label={t("back")}
          onClick={() => navigate("/more")}
        >
          <ChevronLeft />
        </IconButton>
        <h1>{title}</h1>
      </header>
      <nav className="settings-navigation" aria-label={t("settingsNavigation")}>
        {visibleSettings(user).map((item) => (
          <button
            key={item.id}
            className={primaryActive === item.id ? "active" : ""}
            aria-current={primaryActive === item.id ? "page" : undefined}
            onClick={() => navigate(item.path)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </nav>
      {childPages.length > 0 && (
        <nav
          className="settings-subnavigation"
          aria-label={t("workspaceSettingsNavigation")}
        >
          {childPages.map((item) => (
            <button
              key={item.id}
              className={active === item.id ? "active" : ""}
              aria-current={active === item.id ? "page" : undefined}
              onClick={() => navigate(item.path)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </nav>
      )}
      {children}
    </section>
  );
}
