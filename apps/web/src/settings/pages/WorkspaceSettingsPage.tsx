import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  MessengerAPI,
  OrganizationMember,
  OrganizationSettings,
  Permission,
  User,
} from "@comamessenger/core";
import { Copy, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Avatar, Button, Field, SelectField, Skeleton } from "../../ui";
import { AutosaveStatus } from "../components/AutosaveStatus";
import {
  SettingsAccessDenied,
  SettingsSection,
  SettingsToggle,
} from "../components/SettingsPrimitives";
import {
  SettingsShell,
  type SettingsNavigate,
} from "../components/SettingsShell";
import { useAutosave } from "../hooks/useAutosave";
import {
  canAccessSettingsPage,
  hasPermission,
  permissionLabelKeys,
  permissions,
} from "../registry";

export function WorkspaceSettingsPage({
  api,
  user,
  navigate,
  onUserUpdated,
  renderLogo,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
  onUserUpdated(user: User): void;
  renderLogo(size: "small" | "medium" | "large"): ReactNode;
}) {
  const { t } = useTranslation();
  const allowed = canAccessSettingsPage(user, "workspace");
  const canManageGeneral = hasPermission(user, "workspace.settings");
  const canManagePolicies = hasPermission(user, "workspace.policies");
  const canManageInvitations = hasPermission(user, "invitations.manage");
  const canManageMembers = hasPermission(user, "members.manage");
  const canEditSettings =
    canManageGeneral || canManagePolicies || canManageInvitations;
  const query = useQuery({
    queryKey: ["organization-settings"],
    queryFn: () => api.organization(),
    enabled: allowed,
  });
  const members = useQuery({
    queryKey: ["organization-members"],
    queryFn: () => api.organizationMembers(),
    enabled: canManageMembers,
  });
  const [draft, setDraft] = useState<OrganizationSettings | null>(null);
  const [message, setMessage] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteURL, setInviteURL] = useState("");
  const [ownershipTarget, setOwnershipTarget] = useState("");
  const [ownershipPassword, setOwnershipPassword] = useState("");
  const [ownershipPending, setOwnershipPending] = useState(false);
  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);
  const organizationFingerprint = useCallback(
    (value: OrganizationSettings) =>
      JSON.stringify({
        name: value.name,
        slug: value.slug,
        invitation_default_role: value.invitation_default_role,
        invitation_ttl_hours: value.invitation_ttl_hours,
        allow_public_chat_creation: value.allow_public_chat_creation,
        allow_channel_creation: value.allow_channel_creation,
        accent_color: value.accent_color,
      }),
    [],
  );
  const autosave = useAutosave({
    value: canEditSettings ? draft : null,
    fingerprint: organizationFingerprint,
    save: (snapshot) =>
      api.updateOrganization({
        name: snapshot.name,
        slug: snapshot.slug,
        expected_version: snapshot.version,
        invitation_default_role: snapshot.invitation_default_role,
        invitation_ttl_hours: snapshot.invitation_ttl_hours,
        allow_public_chat_creation: snapshot.allow_public_chat_creation,
        allow_channel_creation: snapshot.allow_channel_creation,
        accent_color: snapshot.accent_color,
      }),
    onSaved: (updated, snapshot) => {
      setDraft((current) =>
        current &&
        organizationFingerprint(current) !== organizationFingerprint(snapshot)
          ? { ...current, version: updated.version }
          : updated,
      );
      window.dispatchEvent(new Event("coma-branding-changed"));
    },
  });
  async function updateMember(
    member: OrganizationMember,
    patch: {
      role?: "admin" | "member";
      status?: "active" | "deactivated";
      permissions?: Permission[];
    },
  ) {
    setMessage("");
    try {
      await api.updateOrganizationMember(member.actor_id, patch);
      await members.refetch();
      setMessage(t("changesSaved"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  async function invite() {
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
  async function transferOwnership() {
    if (!ownershipTarget || !ownershipPassword) return;
    setMessage("");
    setOwnershipPending(true);
    try {
      const updatedUser = await api.transferOrganizationOwnership({
        target_actor_id: ownershipTarget,
        current_password: ownershipPassword,
      });
      setOwnershipPassword("");
      setOwnershipTarget("");
      onUserUpdated(updatedUser);
      await members.refetch();
      setMessage(t("ownershipTransferred"));
    } catch (cause) {
      setMessage(messageOf(cause));
    } finally {
      setOwnershipPending(false);
    }
  }
  return (
    <SettingsShell
      user={user}
      active="workspace"
      title={t("workspaceSettings")}
      navigate={navigate}
    >
      {!allowed ? (
        <SettingsAccessDenied />
      ) : query.isLoading || !draft ? (
        <Skeleton />
      ) : (
        <div className="settings-page__body settings-page__body--columns">
          <AutosaveStatus
            phase={autosave.phase}
            error={autosave.error}
            onRetry={autosave.retry}
          />
          <article className="workspace-settings-card">
            {renderLogo("small")}
            <span>
              <strong>{user.organization_name}</strong>
              <small>{t("workspaceRole", { role: user.role })}</small>
            </span>
          </article>
          {canManageGeneral && (
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
                    setDraft({
                      ...draft,
                      slug: event.target.value.toLowerCase(),
                    })
                  }
                />
              </div>
            </SettingsSection>
          )}
          {canManageInvitations && (
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
          )}
          {canManagePolicies && (
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
          )}
          {(canManageInvitations || canManageMembers) && (
            <SettingsSection
              wide
              title={t("membersAndAccess")}
              description={t("membersAccessHint")}
            >
              {canManageInvitations && (
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
              )}
              {canManageInvitations && inviteURL && (
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
                    onClick={() =>
                      void navigator.clipboard.writeText(inviteURL)
                    }
                  >
                    <Copy />
                    {t("copyLink")}
                  </Button>
                </div>
              )}
              {canManageMembers && (
                <div className="organization-members">
                  {(members.data ?? []).map((member) => (
                    <article
                      key={member.actor_id}
                      className="organization-member"
                    >
                      <Avatar
                        name={member.display_name}
                        seed={member.actor_id}
                        size="md"
                        online={member.status === "active"}
                      />
                      <span>
                        <strong>{member.display_name}</strong>
                        <small>
                          @{member.handle} · {member.email}
                        </small>
                      </span>
                      <select
                        aria-label={t("defaultRole")}
                        value={member.role}
                        disabled={
                          member.actor_id === user.id ||
                          (user.role !== "owner" && member.role !== "member")
                        }
                        onChange={(event) =>
                          void updateMember(member, {
                            role: event.target.value as "admin" | "member",
                          })
                        }
                      >
                        {member.role === "owner" && (
                          <option value="owner">{t("roleOwner")}</option>
                        )}
                        <option value="admin">{t("roleAdmin")}</option>
                        <option value="member">{t("roleMember")}</option>
                      </select>
                      <Button
                        size="sm"
                        disabled={member.actor_id === user.id}
                        onClick={() =>
                          void updateMember(member, {
                            status:
                              member.status === "active"
                                ? "deactivated"
                                : "active",
                          })
                        }
                      >
                        {member.status === "active"
                          ? t("deactivate")
                          : t("activate")}
                      </Button>
                      {member.role === "admin" && user.role === "owner" && (
                        <fieldset className="organization-member__permissions">
                          <legend>{t("administratorPermissions")}</legend>
                          {permissions.map((code) => (
                            <label key={code}>
                              <input
                                type="checkbox"
                                checked={member.permissions.includes(code)}
                                onChange={(event) => {
                                  const next = event.target.checked
                                    ? [...member.permissions, code]
                                    : member.permissions.filter(
                                        (permission) => permission !== code,
                                      );
                                  void updateMember(member, {
                                    permissions: next,
                                  });
                                }}
                              />
                              {t(permissionLabelKeys[code])}
                            </label>
                          ))}
                        </fieldset>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </SettingsSection>
          )}
          {user.role === "owner" && (
            <SettingsSection
              wide
              title={t("transferOwnership")}
              description={t("transferOwnershipHint")}
            >
              <div className="ownership-transfer-form">
                <SelectField
                  label={t("newOwner")}
                  name="ownership-target"
                  value={ownershipTarget}
                  onChange={(event) => setOwnershipTarget(event.target.value)}
                >
                  <option value="">{t("chooseNewOwner")}</option>
                  {(members.data ?? [])
                    .filter(
                      (member) =>
                        member.actor_id !== user.id &&
                        member.status === "active" &&
                        member.role !== "owner",
                    )
                    .map((member) => (
                      <option key={member.actor_id} value={member.actor_id}>
                        {member.display_name} (@{member.handle})
                      </option>
                    ))}
                </SelectField>
                <Field
                  label={t("currentPassword")}
                  name="ownership-password"
                  type="password"
                  autoComplete="current-password"
                  value={ownershipPassword}
                  onChange={(event) => setOwnershipPassword(event.target.value)}
                />
                <Button
                  variant="danger"
                  disabled={
                    ownershipPending || !ownershipTarget || !ownershipPassword
                  }
                  onClick={() => void transferOwnership()}
                >
                  {ownershipPending
                    ? t("transferringOwnership")
                    : t("confirmOwnershipTransfer")}
                </Button>
              </div>
            </SettingsSection>
          )}
          {message && (
            <span className="settings-success settings-section--wide">
              {message}
            </span>
          )}
        </div>
      )}
    </SettingsShell>
  );
}
