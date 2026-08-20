import { useCallback } from "react";
import type {
  MessengerAPI,
  OrganizationSettings,
  User,
} from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { Skeleton } from "../../../ui";
import { AutosaveStatus } from "../../components/AutosaveStatus";
import {
  SettingsAccessDenied,
  SettingsSection,
  SettingsToggle,
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

export function WorkspacePoliciesPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
}) {
  const { t } = useTranslation();
  const allowed = canAccessSettingsPage(user, "workspace-policies");
  const { query, draft, setDraft } = useOrganizationDraft(api, allowed);
  const fingerprint = useCallback(
    (value: OrganizationSettings) =>
      JSON.stringify({
        allow_public_chat_creation: value.allow_public_chat_creation,
        allow_channel_creation: value.allow_channel_creation,
      }),
    [],
  );
  const autosave = useAutosave({
    value: allowed ? draft : null,
    fingerprint,
    save: (snapshot) => api.updateOrganization(organizationUpdate(snapshot)),
    onSaved: useDraftReconciler(setDraft, fingerprint),
  });

  return (
    <SettingsShell
      user={user}
      active="workspace-policies"
      title={t("creationPolicy")}
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
            title={t("creationPolicy")}
            description={t("creationPolicyHint")}
          >
            <SettingsToggle
              label={t("allowPublicChats")}
              hint={t("allowPublicChatsHint")}
              checked={draft.allow_public_chat_creation}
              onChange={(checked) =>
                setDraft({ ...draft, allow_public_chat_creation: checked })
              }
            />
            <SettingsToggle
              label={t("allowChannels")}
              hint={t("allowChannelsHint")}
              checked={draft.allow_channel_creation}
              onChange={(checked) =>
                setDraft({ ...draft, allow_channel_creation: checked })
              }
            />
          </SettingsSection>
        </div>
      )}
    </SettingsShell>
  );
}
