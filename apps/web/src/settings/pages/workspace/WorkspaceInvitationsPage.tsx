import { useCallback, useState } from "react";
import type {
  InvitationSummary,
  MessengerAPI,
  OrganizationSettings,
  User,
} from "@comamessenger/core";
import { Copy, RotateCcw, Trash2, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Button, Field, SelectField, Skeleton } from "../../../ui";
import { messageOf } from "../../../errors";
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
import { canAccessSettingsPage, hasPermission } from "../../registry";
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
  const canManage = hasPermission(user, "invitations.manage");
  const { query, draft, setDraft } = useOrganizationDraft(api, allowed);
  const invitations = useQuery({
    queryKey: ["invitations"],
    queryFn: () => api.invitations(),
    enabled: canManage,
  });
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteURL, setInviteURL] = useState("");
  const [message, setMessage] = useState("");
  const fingerprint = useCallback(
    (value: OrganizationSettings) =>
      JSON.stringify({
        invitation_default_role: value.invitation_default_role,
        invitation_ttl_hours: value.invitation_ttl_hours,
        allow_member_invitations: value.allow_member_invitations,
      }),
    [],
  );
  const autosave = useAutosave({
    value: canManage ? draft : null,
    fingerprint,
    save: (snapshot) => api.updateOrganization(organizationUpdate(snapshot)),
    onSaved: useDraftReconciler(setDraft, fingerprint),
  });

  async function invite() {
    setMessage("");
    try {
      const invitation = await api.createInvitation({
        email: inviteEmail,
        ...(canManage ? { role: inviteRole } : {}),
      });
      setInviteURL(invitation.accept_url ?? "");
      setInviteEmail("");
      setMessage(t("invitationCreated"));
      if (canManage) await invitations.refetch();
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }

  async function revoke(invitation: InvitationSummary) {
    setMessage("");
    try {
      await api.revokeInvitation(invitation.id);
      setMessage(t("invitationRevoked"));
      await invitations.refetch();
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }

  async function rotate(invitation: InvitationSummary) {
    setMessage("");
    try {
      const replacement = await api.rotateInvitation(invitation.id);
      setInviteURL(replacement.accept_url ?? "");
      setMessage(
        replacement.email_sent
          ? t("invitationRotatedAndSent")
          : t("invitationRotated"),
      );
      await invitations.refetch();
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
          {canManage && (
            <AutosaveStatus
              phase={autosave.phase}
              error={autosave.error}
              onRetry={autosave.retry}
            />
          )}
          {canManage && (
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
              <SettingsToggle
                label={t("allowMemberInvitations")}
                hint={t("allowMemberInvitationsHint")}
                checked={draft.allow_member_invitations}
                onChange={(checked) =>
                  setDraft({ ...draft, allow_member_invitations: checked })
                }
              />
            </SettingsSection>
          )}
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
              {canManage && (
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
              )}
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
          {canManage && (
            <SettingsSection
              title={t("activeInvitations")}
              description={t("activeInvitationsHint")}
            >
              {invitations.isLoading ? (
                <Skeleton />
              ) : (invitations.data?.length ?? 0) === 0 ? (
                <p className="settings-empty">{t("noActiveInvitations")}</p>
              ) : (
                <div className="settings-diagnostic-list">
                  {invitations.data?.map((invitation) => (
                    <div key={invitation.id}>
                      <span>
                        <strong>{invitation.email}</strong>
                        <small>
                          {t(
                            invitation.role === "admin"
                              ? "roleAdmin"
                              : "roleMember",
                          )}
                          {" · "}
                          {t("invitationCreatedBy", {
                            name: invitation.created_by_name,
                          })}
                          {" · "}
                          {t("invitationExpires", {
                            time: new Intl.DateTimeFormat(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(invitation.expires_at)),
                          })}
                          {" · "}
                          {t(
                            invitation.status === "expired"
                              ? "invitationStatusExpired"
                              : "invitationStatusActive",
                          )}
                        </small>
                      </span>
                      <Button size="sm" onClick={() => void rotate(invitation)}>
                        <RotateCcw />
                        {t("rotateInvitation")}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => void revoke(invitation)}
                      >
                        <Trash2 />
                        {t("revokeInvitation")}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </SettingsSection>
          )}
          {message && <span className="settings-success">{message}</span>}
        </div>
      )}
    </SettingsShell>
  );
}
