import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  MessageCircle,
  MessageCirclePlus,
  MoreHorizontal,
  Pencil,
  UserPlus,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  canManageDepartmentChat,
  departmentChatState,
  departmentCount,
  departmentPath,
  orgIndex,
  personOrgLine,
  type Chat,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { ChatAvatar } from "@/chats/ChatAvatar";
import { chatTitle } from "@/chats/ChatRow";
import { PersonRow } from "@/people/PersonRow";
import { Avatar } from "@/ui/Avatar";
import { BottomSheet } from "@/ui/BottomSheet";
import { IconButton } from "@/ui/IconButton";
import { MenuSheet, afterSheetCloses } from "@/ui/MenuSheet";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import { DepartmentEditor } from "./DepartmentEditor";
import {
  ActionTiles,
  DepartmentIcon,
  InfoGroup,
  KVRow,
  OrgTag,
  orgErrorText,
  type ActionTile,
} from "./parts";
import { personName, useAllPeople, useOrg, useOrgRefresh } from "./useOrg";

export const missingKey = (departmentID: string) =>
  ["org", "missing", departmentID] as const;

/**
 * The department card (tab B of the prototype): head with the square, the
 * path and the count; the department chat; the lead and «Входит в»;
 * subdepartments and members. The lead and whoever runs the structure also
 * see «В чате нет N сотрудников · Добавить» and link a chat in the menu.
 */
export function DepartmentScreen({ departmentID }: { departmentID: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store, scheduleReload } = useMessenger();
  const queryClient = useQueryClient();
  const org = useOrg();
  const refresh = useOrgRefresh();
  const everyone = useAllPeople();
  const structure = org.structure;
  const index = useMemo(
    () => (structure ? orgIndex(structure) : null),
    [structure],
  );
  const department = index?.departments.get(departmentID) ?? null;
  const parent =
    (department?.parent_id && index?.departments.get(department.parent_id)) ||
    null;
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [linking, setLinking] = useState(false);
  const [editing, setEditing] = useState(false);
  const chats = useStore(store, (state) => state.chats);

  const chat = department ? departmentChatState(user, department) : null;
  const managesChat = department
    ? canManageDepartmentChat(user, department)
    : false;
  const missing = useQuery({
    queryKey: missingKey(departmentID),
    queryFn: () => api.departmentChatMissing(departmentID),
    enabled: Boolean(managesChat && chat?.kind === "open" && !chat.archived),
    staleTime: 10_000,
  });

  const linkable = useMemo(
    () =>
      Object.values(chats).filter(
        (item: Chat) =>
          item.kind === "group" &&
          !item.archived_at &&
          (item.role === "owner" || item.role === "admin"),
      ),
    [chats],
  );

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    try {
      await action();
    } catch (cause) {
      Alert.alert(orgErrorText(cause));
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  function openChat() {
    if (!chat || !department) return;
    if (chat.kind === "open") {
      router.push(`/chat/${chat.chatID}`);
      return;
    }
    if (chat.kind === "notMember") {
      const lead = personName(everyone.byID, department.lead_actor_id);
      Alert.alert(
        chat.archived
          ? t("orgChatArchived")
          : lead
            ? t("orgChatNotMemberLead", { name: lead })
            : t("orgChatNotMember"),
      );
      return;
    }
    if (chat.kind === "create")
      Alert.alert(
        t("orgCreateChat"),
        t("orgCreateChatConfirm", { name: department.name }),
        [
          { text: t("cancel"), style: "cancel" },
          {
            text: t("orgCreateChatAction"),
            onPress: () =>
              void run("chat", async () => {
                const result = await api.createDepartmentChat(department.id);
                scheduleReload();
                router.push(`/chat/${result.chat.id}`);
              }),
          },
        ],
      );
  }

  const actions: ActionTile[] = [];
  if (chat && (chat.kind === "open" || chat.kind === "notMember"))
    actions.push({
      key: "chat",
      label: t("orgDepartmentChat"),
      icon: chat.archived ? Archive : MessageCircle,
      testID: "department-chat",
      onPress: openChat,
    });
  else if (chat?.kind === "create")
    actions.push({
      key: "chat",
      label: t("orgCreateChat"),
      icon: MessageCirclePlus,
      testID: "department-create-chat",
      busy: busy === "chat",
      onPress: openChat,
    });

  const members = department ? (index?.members.get(department.id) ?? []) : [];
  const staff = members.filter(
    (membership) => membership.actorID !== department?.lead_actor_id,
  );
  const children = department ? (index?.children.get(department.id) ?? []) : [];
  const total =
    structure && department ? departmentCount(structure, department.id) : 0;
  const path =
    structure && department
      ? departmentPath(structure, department.id, { includeSelf: false })
      : "";
  const lead = department?.lead_actor_id
    ? everyone.byID.get(department.lead_actor_id)
    : undefined;
  const missingCount = missing.data?.length ?? 0;

  return (
    <SafeAreaView
      testID="department"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        backTestID="department-back"
        title={t("orgDepartment")}
        trailing={
          department && (org.canManage || managesChat) ? (
            <View style={styles.headerActions}>
              {org.canManage ? (
                <IconButton
                  testID="department-edit"
                  label={t("orgEdit")}
                  onPress={() => setEditing(true)}
                  icon={(color) => <Pencil size={20} color={color} />}
                />
              ) : null}
              {managesChat && chat?.kind !== "notMember" ? (
                <IconButton
                  testID="department-menu"
                  label={t("orgMore")}
                  onPress={() => setMenu(true)}
                  icon={(color) => <MoreHorizontal size={20} color={color} />}
                />
              ) : null}
            </View>
          ) : undefined
        }
      />
      {org.loading ? (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      ) : org.failed ? (
        <View style={styles.state}>
          <Notice
            title={t("orgLoadFailed")}
            actionLabel={t("retry")}
            onAction={org.refetch}
          />
        </View>
      ) : !department || !structure ? (
        <View style={styles.state}>
          <Notice tone="neutral" title={t("orgDepartmentNotFound")} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View
            style={[
              styles.head,
              {
                backgroundColor: theme.surface,
                borderBottomColor: theme.border,
              },
            ]}
          >
            <View style={styles.headTop}>
              <DepartmentIcon size={72} />
              <View style={styles.iconGap} />
              <Text
                accessibilityRole="header"
                weight="bold"
                size={19}
                style={styles.center}
                testID="department-name"
              >
                {department.name}
              </Text>
              <Text tone="muted" size={13} style={styles.center}>
                {[path, t("orgEmployees", { count: total })]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
            <ActionTiles actions={actions} />
          </View>

          {managesChat && missingCount > 0 ? (
            <View
              testID="department-missing"
              style={[
                styles.missing,
                {
                  backgroundColor: theme.warningSoft,
                  borderColor: theme.border,
                },
              ]}
            >
              <UserPlus size={18} color={theme.warning} />
              <Text size={14} style={styles.grow}>
                {t("orgMissing", { count: missingCount })}
              </Text>
              <Pressable
                testID="department-missing-add"
                accessibilityRole="button"
                disabled={busy !== null}
                hitSlop={8}
                onPress={() =>
                  void run("missing", async () => {
                    const added = await api.addDepartmentChatMissing(
                      department.id,
                    );
                    await queryClient.invalidateQueries({
                      queryKey: missingKey(department.id),
                    });
                    Alert.alert(t("orgMissingAdded", { count: added }));
                  })
                }
              >
                {busy === "missing" ? (
                  <ActivityIndicator color={theme.muted} />
                ) : (
                  <Text tone="primary" weight="semibold" size={14}>
                    {t("orgMissingAdd")}
                  </Text>
                )}
              </Pressable>
            </View>
          ) : null}

          <InfoGroup>
            <KVRow
              first
              testID="department-lead"
              leading={
                department.lead_actor_id ? (
                  <Avatar
                    name={lead?.display_name ?? ""}
                    seed={department.lead_actor_id}
                    actorID={department.lead_actor_id}
                    avatarVersion={lead?.avatar_version}
                    size={36}
                  />
                ) : undefined
              }
              title={lead?.display_name ?? t("orgNoLead")}
              caption={
                lead
                  ? (() => {
                      const line = personOrgLine(lead, structure);
                      return line.startsWith("@")
                        ? t("orgLeadCaption")
                        : t("orgLeadWithPosition", { position: line });
                    })()
                  : undefined
              }
              onPress={
                department.lead_actor_id
                  ? () => router.push(`/people/${department.lead_actor_id}`)
                  : undefined
              }
            />
            {parent ? (
              <KVRow
                testID="department-parent"
                leading={<DepartmentIcon />}
                title={parent.name}
                caption={t("orgPartOf")}
                onPress={() => router.push(`/org/${parent.id}` as never)}
              />
            ) : null}
          </InfoGroup>

          {children.length ? (
            <InfoGroup
              title={t("orgSubdepartments", { count: children.length })}
              testID="department-children"
            >
              {children.map((child, position) => {
                const count = departmentCount(structure, child.id);
                const name = personName(everyone.byID, child.lead_actor_id);
                return (
                  <KVRow
                    key={child.id}
                    first={position === 0}
                    testID={`department-child-${position}`}
                    leading={<DepartmentIcon />}
                    title={child.name}
                    caption={t("orgLeadCount", {
                      name: name || t("orgNoLead"),
                      count,
                    })}
                    onPress={() => router.push(`/org/${child.id}` as never)}
                  />
                );
              })}
            </InfoGroup>
          ) : null}

          {staff.length ? (
            <InfoGroup
              title={t("orgMembersCount", { count: staff.length })}
              testID="department-members"
            >
              {staff.map((membership, position) => {
                const person = everyone.byID.get(membership.actorID);
                if (!person) return null;
                return (
                  <PersonRow
                    key={membership.actorID}
                    testID={`department-member-${position}`}
                    person={person}
                    meta={personOrgLine(person, structure)}
                    tags={
                      membership.primary ? null : <OrgTag kind="additional" />
                    }
                    tagsLabel={
                      membership.primary
                        ? undefined
                        : t("orgAdditionalTagLabel")
                    }
                    hint={t("openProfileHint")}
                    onPress={() => router.push(`/people/${person.actor_id}`)}
                  />
                );
              })}
            </InfoGroup>
          ) : null}
        </ScrollView>
      )}

      {department ? (
        <>
          <MenuSheet
            visible={menu}
            title={department.name}
            testID="department-menu-sheet"
            onClose={() => setMenu(false)}
            items={
              chat?.kind === "open"
                ? [
                    {
                      key: "unlink",
                      label: t("orgUnlinkChat"),
                      danger: true,
                      testID: "department-unlink",
                      onPress: () => {
                        setMenu(false);
                        afterSheetCloses(() =>
                          Alert.alert(
                            t("orgUnlinkConfirm"),
                            t("orgUnlinkConfirmHint"),
                            [
                              { text: t("cancel"), style: "cancel" },
                              {
                                text: t("orgUnlinkChat"),
                                style: "destructive",
                                onPress: () =>
                                  void run("unlink", () =>
                                    api.unlinkDepartmentChat(department.id),
                                  ),
                              },
                            ],
                          ),
                        );
                      },
                    },
                  ]
                : [
                    {
                      key: "link",
                      label: t("orgLinkChat"),
                      testID: "department-link",
                      onPress: () => {
                        setMenu(false);
                        afterSheetCloses(() => setLinking(true));
                      },
                    },
                  ]
            }
          />
          <BottomSheet
            visible={linking}
            title={t("orgLinkChat")}
            testID="department-link-sheet"
            onClose={() => setLinking(false)}
          >
            <Text tone="muted" size={13.5} style={styles.sheetHint}>
              {linkable.length ? t("orgLinkChatHint") : t("orgLinkChatEmpty")}
            </Text>
            {linkable.map((item) => {
              const title = chatTitle(item, t("directChat"));
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  onPress={() => {
                    setLinking(false);
                    void run("link", () =>
                      api.linkDepartmentChat(department.id, item.id),
                    );
                  }}
                  style={({ pressed }) => [
                    styles.chatRow,
                    pressed && { backgroundColor: theme.surfaceSelected },
                  ]}
                >
                  <ChatAvatar
                    name={title}
                    seed={item.avatar_seed || item.id}
                    size={36}
                    shape="square"
                  />
                  <Text size={15.5} numberOfLines={1} style={styles.grow}>
                    {title}
                  </Text>
                </Pressable>
              );
            })}
          </BottomSheet>
          {org.canManage ? (
            <DepartmentEditor
              visible={editing}
              departmentID={department.id}
              onClose={() => setEditing(false)}
              onDeleted={() => router.back()}
            />
          ) : null}
        </>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  loader: { marginTop: spacing[8] },
  state: { padding: spacing[4] },
  content: { paddingBottom: spacing[6] },
  headerActions: { flexDirection: "row", gap: 4 },
  // Prototype: `.ihead { padding: 14px 14px 12px }` with `.iacts` under it.
  head: { borderBottomWidth: StyleSheet.hairlineWidth },
  headTop: {
    alignItems: "center",
    paddingTop: 14,
    paddingHorizontal: 14,
    paddingBottom: 12,
    gap: 2,
  },
  center: { textAlign: "center" },
  // Prototype: `.dsq.big { margin-bottom: 8px }`.
  iconGap: { height: 6 },
  missing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    marginHorizontal: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 48,
  },
  grow: { flex: 1, minWidth: 0 },
  sheetHint: { paddingHorizontal: spacing[4], paddingBottom: spacing[2] },
  chatRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: spacing[4],
    minHeight: 52,
  },
});
