import { useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  canAccessSettingsPage,
  filterMembers,
  memberFilterCounts,
  memberFilters,
  memberRules,
  ownershipCandidates,
  permissionLabelKeys,
  roleLabelKey,
  withPermission,
  workspacePermissions,
  type MemberFilter,
  type OrganizationMember,
  type Permission,
  type UpdateOrganizationMemberRequest,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { pickAndUploadAvatar } from "@/files/avatar";
import { ImageTooLarge } from "@/files/images";
import { messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { SearchField } from "@/people/PersonRow";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import { Avatar } from "@/ui/Avatar";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import {
  ActionRow,
  ChoiceRow,
  Divider,
  GroupBody,
  InfoRow,
  NavRow,
  SettingsGroup,
  SwitchRow,
} from "@/ui/Settings";
import { TabChip } from "@/ui/TabChip";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { SettingsScreen, settingsContent } from "./SettingsScreen";

export const membersKey = ["organization-members"] as const;

function useMembers(enabled: boolean) {
  const { api } = useSignedIn();
  return useQuery({
    queryKey: membersKey,
    queryFn: () => api.organizationMembers(),
    enabled,
  });
}

const filterLabel: Record<MemberFilter, string> = {
  all: "membersFilterAll",
  admins: "membersFilterAdmins",
  members: "membersFilterMembers",
  deactivated: "membersFilterDeactivated",
};

function statusLine(
  member: OrganizationMember,
  t: (key: string) => string,
): string {
  return [
    t(roleLabelKey(member.role)),
    member.status === "active" ? null : t("statusDeactivated"),
    member.title || `@${member.handle}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Workspace members with search and filters; a row opens the member card. */
export function MembersScreen() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const allowed = canAccessSettingsPage(user, "workspace-members");
  const members = useMembers(allowed);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MemberFilter>("all");
  const list = useMemo(
    () => filterMembers(members.data ?? [], { query, filter }, i18n.language),
    [filter, i18n.language, members.data, query],
  );
  const counts = memberFilterCounts(members.data ?? []);
  return (
    <SettingsScreen
      title={t("membersAndRoles")}
      subtitle={
        members.data ? t("membersCount", { count: counts.all }) : undefined
      }
      allowed={allowed}
      query={members}
      scroll={false}
      testID="settings-members-screen"
    >
      <View style={{ backgroundColor: theme.surface }}>
        <SearchField
          testID="members-search"
          value={query}
          onChange={setQuery}
          placeholder={t("membersSearch")}
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          accessibilityRole="tablist"
          style={styles.chipsScroll}
          contentContainerStyle={styles.chips}
        >
          {memberFilters.map((value) => (
            <TabChip
              key={value}
              testID={`members-filter-${value}`}
              label={t(filterLabel[value])}
              count={value === "all" ? undefined : counts[value]}
              selected={filter === value}
              onPress={() => setFilter(value)}
            />
          ))}
        </ScrollView>
      </View>
      <FlatList
        testID="members-list"
        data={list}
        keyExtractor={(member) => member.actor_id}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: theme.surface }}
        ItemSeparatorComponent={Divider}
        renderItem={({ item, index }) => (
          <Pressable
            testID={`member-row-${index}`}
            accessibilityRole="button"
            accessibilityLabel={`${item.display_name}, ${statusLine(item, t)}`}
            accessibilityHint={t("manageMember")}
            onPress={() =>
              router.push(`/settings/workspace/members/${item.actor_id}`)
            }
            style={({ pressed }) => [
              styles.row,
              pressed && { backgroundColor: theme.surfaceSelected },
              item.status !== "active" && styles.inactive,
            ]}
          >
            <Avatar
              name={item.display_name}
              seed={item.actor_id}
              size={44}
              actorID={item.actor_id}
              avatarVersion={item.avatar_version}
            />
            <View style={styles.grow}>
              <Text weight="semibold" size={15.5} numberOfLines={1}>
                {item.display_name}
                {item.actor_id === user.id ? ` · ${t("you")}` : ""}
              </Text>
              <Text tone="muted" size={13.5} numberOfLines={1}>
                {statusLine(item, t)}
              </Text>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text tone="muted" size={15} style={styles.center}>
              {t("membersEmpty")}
            </Text>
          </View>
        }
        ListFooterComponent={
          user.role === "owner" ? (
            <View style={[settingsContent, styles.footer]}>
              <SettingsGroup hint={t("transferOwnershipHint")}>
                <NavRow
                  testID="members-transfer"
                  icon={Crown}
                  label={t("transferOwnership")}
                  onPress={() => router.push("/settings/workspace/transfer")}
                />
              </SettingsGroup>
            </View>
          ) : null
        }
      />
    </SettingsScreen>
  );
}

/**
 * One member: role, status, password actions, photo and permissions, with
 * the web's rules (packages/core `memberRules`) and a confirmation before
 * anything that locks the person out.
 */
export function MemberScreen({ actorID }: { actorID: string }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { branding, updateUser } = useSession();
  const queryClient = useQueryClient();
  const allowed = canAccessSettingsPage(user, "workspace-members");
  const members = useMembers(allowed);
  const member = members.data?.find((item) => item.actor_id === actorID);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(
    key: string,
    action: () => Promise<unknown>,
    done?: string,
  ) {
    setBusy(key);
    try {
      await action();
      if (done) Alert.alert(done);
    } catch (cause) {
      Alert.alert(
        cause instanceof ImageTooLarge
          ? t("avatarValidation")
          : messageOf(cause),
      );
    } finally {
      setBusy(null);
    }
  }

  function store(updated: OrganizationMember) {
    queryClient.setQueryData<OrganizationMember[]>(membersKey, (list) =>
      list?.map((item) =>
        item.actor_id === updated.actor_id ? updated : item,
      ),
    );
  }

  const update = (key: string, patch: UpdateOrganizationMemberRequest) =>
    run(key, async () =>
      store(await api.updateOrganizationMember(actorID, patch)),
    );

  const confirm = (
    title: string,
    message: string | undefined,
    label: string,
    action: () => void,
  ) =>
    Alert.alert(title, message, [
      { text: t("cancel"), style: "cancel" },
      { text: label, style: "destructive", onPress: action },
    ]);

  const refreshAvatar = async () => {
    const list = await members.refetch();
    const next = list.data?.find((item) => item.actor_id === actorID);
    if (actorID === user.id && next)
      updateUser({ ...user, avatar_version: next.avatar_version });
  };

  return (
    <SettingsScreen
      title={member?.display_name ?? t("manageMember")}
      allowed={allowed}
      query={members}
      testID="settings-member-screen"
    >
      {members.data && !member ? (
        <Notice title={t("memberNotFound")} />
      ) : member ? (
        (() => {
          const rules = memberRules(user, member, {
            passwordRecoveryAvailable: branding?.password_recovery_available,
          });
          const active = member.status === "active";
          return (
            <>
              <View style={styles.identity}>
                <Avatar
                  name={member.display_name}
                  seed={member.actor_id}
                  size={80}
                  actorID={member.actor_id}
                  avatarVersion={member.avatar_version}
                />
                <Text weight="semibold" size={19} style={styles.center}>
                  {member.display_name}
                </Text>
                <Text tone="muted" size={14} style={styles.center}>
                  @{member.handle} · {member.email}
                </Text>
                {member.title ? (
                  <Text tone="muted" size={14} style={styles.center}>
                    {member.title}
                  </Text>
                ) : null}
              </View>
              <SettingsGroup>
                <InfoRow
                  label={t("memberStatus")}
                  value={active ? t("statusActive") : t("statusDeactivated")}
                />
                {member.last_seen_at && (
                  <>
                    <Divider />
                    <InfoRow
                      label={t("lastSeen")}
                      value={new Intl.DateTimeFormat(i18n.language, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(member.last_seen_at))}
                    />
                  </>
                )}
              </SettingsGroup>

              <SettingsGroup
                title={t("memberRole")}
                hint={
                  rules.canChangeRole && rules.assignableRoles.length > 1
                    ? t("memberRoleHint")
                    : undefined
                }
              >
                {rules.canChangeRole && rules.assignableRoles.length > 1 ? (
                  rules.assignableRoles.map((role, index) => (
                    <View key={role}>
                      {index > 0 && <Divider />}
                      <ChoiceRow
                        testID={`member-role-${role}`}
                        label={t(roleLabelKey(role))}
                        selected={member.role === role}
                        onPress={() =>
                          member.role !== role &&
                          confirm(
                            t("changeRoleConfirm", {
                              name: member.display_name,
                              role: t(roleLabelKey(role)),
                            }),
                            undefined,
                            t("changeRole"),
                            () => void update("role", { role }),
                          )
                        }
                      />
                    </View>
                  ))
                ) : (
                  <InfoRow
                    testID="member-role"
                    label={t("memberRole")}
                    value={t(roleLabelKey(member.role))}
                  />
                )}
              </SettingsGroup>

              {rules.showsKnowledgePermission && (
                <SettingsGroup
                  title={t("kbPermissionTitle")}
                  hint={
                    rules.canGrantKnowledge
                      ? t("kbPermissionHint")
                      : t("kbPermissionNeedsOwn")
                  }
                >
                  <SwitchRow
                    testID="member-knowledge"
                    label={t("kbPermissionToggle")}
                    value={member.permissions.includes("knowledge.manage")}
                    disabled={!rules.canGrantKnowledge || busy !== null}
                    onChange={(checked) =>
                      void update("permissions", {
                        permissions: withPermission(
                          member.permissions,
                          "knowledge.manage",
                          checked,
                        ),
                      })
                    }
                  />
                </SettingsGroup>
              )}

              {rules.showsAdminPermissions && (
                <SettingsGroup title={t("administratorPermissions")}>
                  {workspacePermissions.map((code: Permission, index) => (
                    <View key={code}>
                      {index > 0 && <Divider />}
                      <SwitchRow
                        testID={`member-permission-${code}`}
                        label={t(permissionLabelKeys[code])}
                        value={member.permissions.includes(code)}
                        disabled={busy !== null}
                        onChange={(checked) =>
                          void update("permissions", {
                            permissions: withPermission(
                              member.permissions,
                              code,
                              checked,
                            ),
                          })
                        }
                      />
                    </View>
                  ))}
                </SettingsGroup>
              )}

              <SettingsGroup
                title={t("memberPhoto")}
                hint={t("avatarValidation")}
              >
                <ActionRow
                  testID="member-avatar-change"
                  label={t("changeAvatar")}
                  pending={busy === "avatar"}
                  disabled={busy !== null && busy !== "avatar"}
                  onPress={() =>
                    void run("avatar", async () => {
                      if (await pickAndUploadAvatar(api, actorID))
                        await refreshAvatar();
                    })
                  }
                />
                {member.avatar_version > 0 && (
                  <>
                    <Divider />
                    <ActionRow
                      tone="danger"
                      label={t("removeAvatar")}
                      pending={busy === "avatar-remove"}
                      disabled={busy !== null && busy !== "avatar-remove"}
                      onPress={() =>
                        void run("avatar-remove", async () => {
                          await api.deleteOrganizationMemberAvatar(actorID);
                          await refreshAvatar();
                        })
                      }
                    />
                  </>
                )}
              </SettingsGroup>

              {(rules.canRequirePasswordChange ||
                rules.canSendPasswordReset ||
                rules.canChangeStatus) && (
                <SettingsGroup
                  title={t("memberAccess")}
                  hint={active ? t("deactivateHint") : t("activateHint")}
                >
                  {rules.canRequirePasswordChange && (
                    <ActionRow
                      testID="member-require-password"
                      label={t("requirePasswordChange")}
                      pending={busy === "require"}
                      disabled={busy !== null && busy !== "require"}
                      onPress={() =>
                        confirm(
                          t("requirePasswordChangeConfirm", {
                            name: member.display_name,
                          }),
                          t("requirePasswordChangeConfirmHint"),
                          t("requirePasswordChange"),
                          () =>
                            void run(
                              "require",
                              () => api.requireMemberPasswordChange(actorID),
                              t("passwordChangeRequired"),
                            ),
                        )
                      }
                    />
                  )}
                  {rules.canSendPasswordReset && (
                    <>
                      <Divider />
                      <ActionRow
                        testID="member-password-reset"
                        label={t("sendPasswordReset")}
                        pending={busy === "reset"}
                        disabled={busy !== null && busy !== "reset"}
                        onPress={() =>
                          confirm(
                            t("sendPasswordResetConfirm", {
                              email: member.email,
                            }),
                            undefined,
                            t("sendPasswordReset"),
                            () =>
                              void run(
                                "reset",
                                () => api.issueMemberPasswordReset(actorID),
                                t("passwordResetSent"),
                              ),
                          )
                        }
                      />
                    </>
                  )}
                  {rules.canChangeStatus && (
                    <>
                      {(rules.canRequirePasswordChange ||
                        rules.canSendPasswordReset) && <Divider />}
                      <ActionRow
                        testID="member-status"
                        tone={active ? "danger" : "primary"}
                        label={active ? t("deactivate") : t("activate")}
                        pending={busy === "status"}
                        disabled={busy !== null && busy !== "status"}
                        onPress={() =>
                          active
                            ? confirm(
                                t("deactivateConfirm", {
                                  name: member.display_name,
                                }),
                                t("deactivateConfirmHint"),
                                t("deactivate"),
                                () =>
                                  void update("status", {
                                    status: "deactivated",
                                  }),
                              )
                            : void update("status", { status: "active" })
                        }
                      />
                    </>
                  )}
                </SettingsGroup>
              )}
              {rules.self && (
                <Text tone="subtle" size={13} style={styles.center}>
                  {t("memberSelfHint")}
                </Text>
              )}
              {member.role === "owner" && !rules.self && (
                <View
                  style={[
                    styles.note,
                    { backgroundColor: theme.surfaceSelected },
                  ]}
                >
                  <Text tone="muted" size={14}>
                    {t("memberOwnerHint")}
                  </Text>
                </View>
              )}
            </>
          );
        })()
      ) : null}
    </SettingsScreen>
  );
}

/** The owner hands the workspace to another active member, with their password. */
export function TransferOwnershipScreen() {
  const { t } = useTranslation();
  const { api, user } = useSignedIn();
  const { updateUser } = useSession();
  const allowed = user.role === "owner";
  const members = useMembers(allowed);
  const [target, setTarget] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const candidates = ownershipCandidates(user, members.data ?? []);
  const chosen = candidates.find((member) => member.actor_id === target);

  async function transfer() {
    setPending(true);
    setError("");
    try {
      const updated = await api.transferOrganizationOwnership({
        target_actor_id: target,
        current_password: password,
      });
      updateUser(updated);
      await members.refetch();
      Alert.alert(t("ownershipTransferred"));
      router.back();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsScreen
      title={t("transferOwnership")}
      allowed={allowed}
      query={members}
      testID="settings-transfer-screen"
    >
      <Notice tone="neutral" title={t("transferOwnershipHint")} />
      <SettingsGroup title={t("newOwner")}>
        {candidates.length ? (
          candidates.map((member, index) => (
            <View key={member.actor_id}>
              {index > 0 && <Divider />}
              <ChoiceRow
                testID={`transfer-target-${index}`}
                label={`${member.display_name} (@${member.handle})`}
                selected={target === member.actor_id}
                onPress={() => setTarget(member.actor_id)}
              />
            </View>
          ))
        ) : (
          <GroupBody>
            <Text tone="muted" size={14}>
              {t("noOwnershipCandidates")}
            </Text>
          </GroupBody>
        )}
      </SettingsGroup>
      <SettingsGroup>
        <GroupBody>
          <TextField
            testID="transfer-password"
            label={t("currentPassword")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            autoCapitalize="none"
          />
          {error ? <Notice title={error} /> : null}
          <Button
            testID="transfer-submit"
            label={t("confirmOwnershipTransfer")}
            pending={pending}
            disabled={!chosen || !password}
            onPress={() =>
              chosen &&
              Alert.alert(
                t("transferOwnershipConfirm", { name: chosen.display_name }),
                t("transferOwnershipConfirmHint"),
                [
                  { text: t("cancel"), style: "cancel" },
                  {
                    text: t("confirmOwnershipTransfer"),
                    style: "destructive",
                    onPress: () => void transfer(),
                  },
                ],
              )
            }
          />
        </GroupBody>
      </SettingsGroup>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  chipsScroll: { flexGrow: 0 },
  chips: { gap: 6, paddingHorizontal: 14, paddingBottom: 10 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
    minHeight: 60,
  },
  inactive: { opacity: 0.6 },
  grow: { flex: 1, minWidth: 0 },
  empty: { padding: spacing[6] },
  center: { textAlign: "center" },
  footer: { paddingTop: spacing[5] },
  identity: { alignItems: "center", gap: spacing[1] },
  note: { padding: spacing[3], borderRadius: radius.md },
});
