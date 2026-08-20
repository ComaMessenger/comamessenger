import type { ReactNode } from "react";
import type { User } from "@comamessenger/core";
import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../../ui";
import { visibleSettings, type SettingsPageID } from "../registry";

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

  return (
    <section className="settings-page utility-page">
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
            className={active === item.id ? "active" : ""}
            aria-current={active === item.id ? "page" : undefined}
            onClick={() => navigate(item.path)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </nav>
      {children}
    </section>
  );
}
