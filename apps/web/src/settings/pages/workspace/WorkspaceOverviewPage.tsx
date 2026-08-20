import type { ReactNode } from "react";
import type { User } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import {
  SettingsAccessDenied,
  SettingsSection,
} from "../../components/SettingsPrimitives";
import {
  SettingsShell,
  type SettingsNavigate,
} from "../../components/SettingsShell";
import { canAccessSettingsPage, visibleChildSettings } from "../../registry";

const descriptions: Record<string, string> = {
  "workspace-general": "workspaceGeneralHint",
  "workspace-members": "membersAccessHint",
  "workspace-invitations": "invitationPolicyHint",
  "workspace-policies": "creationPolicyHint",
};

export function WorkspaceOverviewPage({
  user,
  navigate,
  renderLogo,
}: {
  user: User;
  navigate: SettingsNavigate;
  renderLogo(size: "small" | "medium" | "large"): ReactNode;
}) {
  const { t } = useTranslation();
  const allowed = canAccessSettingsPage(user, "workspace");
  const pages = visibleChildSettings(user, "workspace");

  return (
    <SettingsShell
      user={user}
      active="workspace"
      title={t("workspaceSettings")}
      navigate={navigate}
    >
      {!allowed ? (
        <SettingsAccessDenied />
      ) : (
        <div className="settings-page__body">
          <article className="workspace-settings-card">
            {renderLogo("small")}
            <span>
              <strong>{user.organization_name}</strong>
              <small>{t("workspaceRole", { role: user.role })}</small>
            </span>
          </article>
          <SettingsSection
            title={t("currentWorkspace")}
            description={t("workspaceSettingsHint")}
          >
            <div className="workspace-settings-links">
              {pages.map((page) => (
                <button key={page.id} onClick={() => navigate(page.path)}>
                  <strong>{t(page.labelKey)}</strong>
                  <small>{t(descriptions[page.id])}</small>
                </button>
              ))}
            </div>
          </SettingsSection>
        </div>
      )}
    </SettingsShell>
  );
}
