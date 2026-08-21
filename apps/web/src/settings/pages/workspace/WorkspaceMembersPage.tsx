import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  MessengerAPI,
  OrganizationMember,
  Permission,
  User,
} from "@comamessenger/core";
import { MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../../errors";
import {
  Avatar,
  Button,
  Dialog,
  Field,
  IconButton,
  SelectField,
  Skeleton,
} from "../../../ui";
import {
  SettingsAccessDenied,
  SettingsSection,
  SettingsToggle,
} from "../../components/SettingsPrimitives";
import {
  SettingsShell,
  type SettingsNavigate,
} from "../../components/SettingsShell";
import {
  canAccessSettingsPage,
  permissionLabelKeys,
  permissions,
} from "../../registry";

export function WorkspaceMembersPage({
  api,
  user,
  navigate,
  onUserUpdated,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
  onUserUpdated(user: User): void;
}) {
  const { t } = useTranslation();
  const allowed = canAccessSettingsPage(user, "workspace-members");
  const members = useQuery({
    queryKey: ["organization-members"],
    queryFn: () => api.organizationMembers(),
    enabled: allowed,
  });
  const branding = useQuery({
    queryKey: ["public-branding"],
    queryFn: () => api.branding(),
    enabled: allowed,
  });
  const [message, setMessage] = useState("");
  const [ownershipTarget, setOwnershipTarget] = useState("");
  const [ownershipPassword, setOwnershipPassword] = useState("");
  const [ownershipPending, setOwnershipPending] = useState(false);
  const [selectedMember, setSelectedMember] =
    useState<OrganizationMember | null>(null);

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
      const updated = await api.updateOrganizationMember(
        member.actor_id,
        patch,
      );
      setSelectedMember((current) =>
        current?.actor_id === updated.actor_id ? updated : current,
      );
      await members.refetch();
      setMessage(t("changesSaved"));
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

  async function requirePasswordChange(member: OrganizationMember) {
    setMessage("");
    try {
      await api.requireMemberPasswordChange(member.actor_id);
      setMessage(t("passwordChangeRequired"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }

  async function issuePasswordReset(member: OrganizationMember) {
    setMessage("");
    try {
      await api.issueMemberPasswordReset(member.actor_id);
      setMessage(t("passwordResetSent"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }

  async function changeMemberAvatar(member: OrganizationMember, file: File) {
    setMessage("");
    if (
      file.size > 10_000_000 ||
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    ) {
      setMessage(t("avatarValidation"));
      return;
    }
    try {
      const updated = await api.putOrganizationMemberAvatar(
        member.actor_id,
        file,
      );
      const refreshed = await members.refetch();
      const next = refreshed.data?.find(
        (item) => item.actor_id === member.actor_id,
      );
      if (next) setSelectedMember(next);
      if (member.actor_id === user.id)
        onUserUpdated({ ...user, avatar_version: updated.avatar_version });
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }

  return (
    <SettingsShell
      user={user}
      active="workspace-members"
      title={t("membersAndAccess")}
      navigate={navigate}
    >
      {!allowed ? (
        <SettingsAccessDenied />
      ) : members.isLoading ? (
        <Skeleton />
      ) : (
        <div className="settings-page__body">
          <SettingsSection
            title={t("membersAndAccess")}
            description={t("membersAccessHint")}
          >
            <div className="organization-members">
              {(members.data ?? []).map((member) => (
                <article key={member.actor_id} className="organization-member">
                  <Avatar
                    name={member.display_name}
                    seed={member.actor_id}
                    actorID={member.actor_id}
                    avatarVersion={member.avatar_version}
                    size="md"
                    online={member.status === "active"}
                  />
                  <span>
                    <strong>{member.display_name}</strong>
                    <small>
                      @{member.handle} · {member.email}
                    </small>
                    {member.title && <small>{member.title}</small>}
                    {member.last_seen_at && (
                      <small>
                        {t("lastSeen")}:{" "}
                        {new Date(member.last_seen_at).toLocaleString()}
                      </small>
                    )}
                  </span>
                  <span className="organization-member__summary">
                    <small>
                      {member.role === "owner"
                        ? t("roleOwner")
                        : member.role === "admin"
                          ? t("roleAdmin")
                          : t("roleMember")}
                    </small>
                    <small>
                      {member.status === "active"
                        ? t("statusActive")
                        : t("statusDeactivated")}
                    </small>
                  </span>
                  <IconButton
                    label={t("manageMember")}
                    onClick={() => setSelectedMember(member)}
                  >
                    <MoreHorizontal />
                  </IconButton>
                </article>
              ))}
            </div>
          </SettingsSection>
          {selectedMember && (
            <Dialog
              title={t("manageMember")}
              className="member-management-dialog"
              onClose={() => setSelectedMember(null)}
            >
              <div className="member-management">
                <div className="member-management__identity">
                  <Avatar
                    name={selectedMember.display_name}
                    seed={selectedMember.actor_id}
                    actorID={selectedMember.actor_id}
                    avatarVersion={selectedMember.avatar_version}
                    size="lg"
                    online={selectedMember.status === "active"}
                  />
                  <span>
                    <strong>{selectedMember.display_name}</strong>
                    <small>
                      @{selectedMember.handle} · {selectedMember.email}
                    </small>
                  </span>
                </div>
                <SelectField
                  label={t("memberRole")}
                  name="member-role"
                  value={selectedMember.role}
                  disabled={
                    selectedMember.actor_id === user.id ||
                    (user.role !== "owner" && selectedMember.role !== "member")
                  }
                  onChange={(event) =>
                    void updateMember(selectedMember, {
                      role: event.target.value as "admin" | "member",
                    })
                  }
                >
                  {selectedMember.role === "owner" && (
                    <option value="owner">{t("roleOwner")}</option>
                  )}
                  <option value="admin">{t("roleAdmin")}</option>
                  <option value="member">{t("roleMember")}</option>
                </SelectField>
                <div className="member-management__actions">
                  <Button
                    disabled={selectedMember.actor_id === user.id}
                    onClick={() =>
                      void updateMember(selectedMember, {
                        status:
                          selectedMember.status === "active"
                            ? "deactivated"
                            : "active",
                      })
                    }
                  >
                    {selectedMember.status === "active"
                      ? t("deactivate")
                      : t("activate")}
                  </Button>
                  <label className="ui-button ui-button--secondary ui-button--md">
                    {t("changeAvatar")}
                    <input
                      hidden
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void changeMemberAvatar(selectedMember, file);
                        event.target.value = "";
                      }}
                    />
                  </label>
                  {selectedMember.avatar_version > 0 && (
                    <Button
                      onClick={() =>
                        void api
                          .deleteOrganizationMemberAvatar(
                            selectedMember.actor_id,
                          )
                          .then(async (updated) => {
                            const refreshed = await members.refetch();
                            const next = refreshed.data?.find(
                              (item) =>
                                item.actor_id === selectedMember.actor_id,
                            );
                            if (next) setSelectedMember(next);
                            if (selectedMember.actor_id === user.id)
                              onUserUpdated({
                                ...user,
                                avatar_version: updated.avatar_version,
                              });
                          })
                          .catch((cause) => setMessage(messageOf(cause)))
                      }
                    >
                      {t("removeAvatar")}
                    </Button>
                  )}
                  <Button
                    disabled={
                      selectedMember.actor_id === user.id ||
                      selectedMember.role === "owner" ||
                      (user.role !== "owner" &&
                        selectedMember.role !== "member")
                    }
                    onClick={() => void requirePasswordChange(selectedMember)}
                  >
                    {t("requirePasswordChange")}
                  </Button>
                  {branding.data?.password_recovery_available && (
                    <Button
                      disabled={
                        selectedMember.actor_id === user.id ||
                        selectedMember.role === "owner" ||
                        (user.role !== "owner" &&
                          selectedMember.role !== "member")
                      }
                      onClick={() => void issuePasswordReset(selectedMember)}
                    >
                      {t("sendPasswordReset")}
                    </Button>
                  )}
                </div>
                {selectedMember.role === "admin" && user.role === "owner" && (
                  <fieldset className="member-management__permissions">
                    <legend>{t("administratorPermissions")}</legend>
                    {permissions.map((code) => (
                      <SettingsToggle
                        key={code}
                        label={t(permissionLabelKeys[code])}
                        checked={selectedMember.permissions.includes(code)}
                        onChange={(checked) =>
                          void updateMember(selectedMember, {
                            permissions: checked
                              ? [...selectedMember.permissions, code]
                              : selectedMember.permissions.filter(
                                  (permission) => permission !== code,
                                ),
                          })
                        }
                      />
                    ))}
                  </fieldset>
                )}
                <small className="member-management__avatar-hint">
                  {t("avatarValidation")}
                </small>
              </div>
            </Dialog>
          )}
          {user.role === "owner" && (
            <SettingsSection
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
          {message && <span className="settings-success">{message}</span>}
        </div>
      )}
    </SettingsShell>
  );
}
