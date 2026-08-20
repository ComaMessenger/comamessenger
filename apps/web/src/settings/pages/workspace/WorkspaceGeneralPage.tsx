import { useCallback } from "react";
import type {
  MessengerAPI,
  OrganizationSettings,
  User,
} from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { Field, Skeleton } from "../../../ui";
import { AutosaveStatus } from "../../components/AutosaveStatus";
import {
  SettingsAccessDenied,
  SettingsSection,
} from "../../components/SettingsPrimitives";
import {
  SettingsShell,
  type SettingsNavigate,
} from "../../components/SettingsShell";
import { useAutosave } from "../../hooks/useAutosave";
import { canAccessSettingsPage } from "../../registry";
import {
  organizationUpdate,
  useDraftReconciler,
  useOrganizationDraft,
} from "./shared";

export function WorkspaceGeneralPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
}) {
  const { t } = useTranslation();
  const allowed = canAccessSettingsPage(user, "workspace-general");
  const { query, draft, setDraft } = useOrganizationDraft(api, allowed);
  const fingerprint = useCallback(
    (value: OrganizationSettings) =>
      JSON.stringify({ name: value.name, slug: value.slug }),
    [],
  );
  const reconcile = useDraftReconciler(setDraft, fingerprint);
  const autosave = useAutosave({
    value: allowed ? draft : null,
    fingerprint,
    save: (snapshot) => api.updateOrganization(organizationUpdate(snapshot)),
    onSaved: (updated, snapshot) => {
      reconcile(updated, snapshot);
      window.dispatchEvent(new Event("coma-branding-changed"));
    },
  });

  return (
    <SettingsShell
      user={user}
      active="workspace-general"
      title={t("workspaceGeneral")}
      navigate={navigate}
    >
      {!allowed ? (
        <SettingsAccessDenied />
      ) : query.isLoading || !draft ? (
        <Skeleton />
      ) : (
        <div className="settings-page__body">
          <AutosaveStatus
            phase={autosave.phase}
            error={autosave.error}
            onRetry={autosave.retry}
          />
          <SettingsSection
            title={t("workspaceGeneral")}
            description={t("workspaceGeneralHint")}
          >
            <div className="settings-form-grid">
              <Field
                label={t("organization")}
                name="workspace-name"
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
              <Field
                label={t("slug")}
                name="workspace-slug"
                value={draft.slug}
                onChange={(event) =>
                  setDraft({ ...draft, slug: event.target.value.toLowerCase() })
                }
              />
            </div>
          </SettingsSection>
        </div>
      )}
    </SettingsShell>
  );
}
