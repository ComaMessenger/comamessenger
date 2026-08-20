import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  MessengerAPI,
  OrganizationMember,
  Permission,
  User,
} from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../../errors";
import { Avatar, Button, Field, SelectField, Skeleton } from "../../../ui";
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
  const [message, setMessage] = useState("");
  const [ownershipTarget, setOwnershipTarget] = useState("");
  const [ownershipPassword, setOwnershipPassword] = useState("");
  const [ownershipPending, setOwnershipPending] = useState(false);

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
                          member.status === "active" ? "deactivated" : "active",
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
                        <SettingsToggle
                          key={code}
                          label={t(permissionLabelKeys[code])}
                          checked={member.permissions.includes(code)}
                          onChange={(checked) =>
                            void updateMember(member, {
                              permissions: checked
                                ? [...member.permissions, code]
                                : member.permissions.filter(
                                    (permission) => permission !== code,
                                  ),
                            })
                          }
                        />
                      ))}
                    </fieldset>
                  )}
                </article>
              ))}
            </div>
          </SettingsSection>
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
