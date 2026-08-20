import { useCallback, useState } from "react";
import type {
  MessengerAPI,
  OrganizationSettings,
  User,
} from "@comamessenger/core";
import { Copy, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Field, SelectField, Skeleton } from "../../../ui";
import { messageOf } from "../../../errors";
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

export function WorkspaceInvitationsPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
}) {
  const { t } = useTranslation();
  const allowed = canAccessSettingsPage(user, "workspace-invitations");
  const { query, draft, setDraft } = useOrganizationDraft(api, allowed);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteURL, setInviteURL] = useState("");
  const [message, setMessage] = useState("");
  const fingerprint = useCallback(
    (value: OrganizationSettings) =>
      JSON.stringify({
        invitation_default_role: value.invitation_default_role,
        invitation_ttl_hours: value.invitation_ttl_hours,
      }),
    [],
  );
  const autosave = useAutosave({
    value: allowed ? draft : null,
    fingerprint,
    save: (snapshot) => api.updateOrganization(organizationUpdate(snapshot)),
    onSaved: useDraftReconciler(setDraft, fingerprint),
  });

  async function invite() {
    setMessage("");
    try {
      const invitation = await api.createInvitation({
        email: inviteEmail,
        role: inviteRole,
      });
      setInviteURL(invitation.accept_url ?? "");
      setInviteEmail("");
      setMessage(t("invitationCreated"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }

  return (
    <SettingsShell
      user={user}
      active="workspace-invitations"
      title={t("invitationPolicy")}
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
            title={t("invitationPolicy")}
            description={t("invitationPolicyHint")}
          >
            <div className="settings-form-grid">
              <SelectField
                label={t("defaultRole")}
                name="default-role"
                value={draft.invitation_default_role}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    invitation_default_role: event.target.value as
                      | "admin"
                      | "member",
                  })
                }
              >
                <option value="member">{t("roleMember")}</option>
                <option value="admin">{t("roleAdmin")}</option>
              </SelectField>
              <Field
                label={t("invitationTTL")}
                name="invitation-ttl"
                type="number"
                min={1}
                max={720}
                value={String(draft.invitation_ttl_hours)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    invitation_ttl_hours: Number(event.target.value),
                  })
                }
              />
            </div>
          </SettingsSection>
          <SettingsSection
            title={t("createInvitation")}
            description={t("membersAccessHint")}
          >
            <div className="invitation-form">
              <Field
                label={t("inviteEmail")}
                name="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
              <SelectField
                label={t("defaultRole")}
                name="invite-role"
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(event.target.value as "member" | "admin")
                }
              >
                <option value="member">{t("roleMember")}</option>
                <option value="admin">{t("roleAdmin")}</option>
              </SelectField>
              <Button
                variant="primary"
                disabled={!inviteEmail}
                onClick={() => void invite()}
              >
                <UserPlus />
                {t("createInvitation")}
              </Button>
            </div>
            {inviteURL && (
              <div className="invitation-result">
                <span>
                  <strong>{t("invitationLink")}</strong>
                  <small>{t("invitationLinkHint")}</small>
                </span>
                <input
                  readOnly
                  value={inviteURL}
                  aria-label={t("invitationLink")}
                />
                <Button
                  onClick={() => void navigator.clipboard.writeText(inviteURL)}
                >
                  <Copy />
                  {t("copyLink")}
                </Button>
              </div>
            )}
          </SettingsSection>
          {message && <span className="settings-success">{message}</span>}
        </div>
      )}
    </SettingsShell>
  );
}
