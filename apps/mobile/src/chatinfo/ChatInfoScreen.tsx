import { useMemo, useState, type ReactNode } from "react";
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
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Bell,
  BellOff,
  Check,
  ChevronRight,
  FileText,
  FolderPlus,
  LogOut,
  Pencil,
  Pin,
  PinOff,
  Search,
  UserPlus,
  UserRound,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  chatAvatarSource,
  chatRights,
  isChatMuted,
  memberRights,
  onlineCount,
  pinnedChatLimit,
  sortChatMembers,
  toggleChatInFolder,
  upsertFolder,
  folderColorToken,
  type ChatMember,
  type ChatRole,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { messageOf } from "@/lib/errors";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { ChatAvatar } from "@/chats/ChatAvatar";
import { chatTitle } from "@/chats/ChatRow";
import { FolderSheet } from "@/chats/FolderSheet";
import { useOpenDirect } from "@/people/openDirect";
import { AgentTag, PersonRow, presenceLabelKey } from "@/people/PersonRow";
import {
  MenuSheet,
  afterSheetCloses,
  type MenuSheetItem,
} from "@/ui/MenuSheet";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import {
  chatKeys,
  useChatMembers,
  usePinnedMessages,
  viewerOf,
} from "./queries";

const visibleMembers = 6;
type NotifyLevel = "default" | "all" | "mentions" | "none";

const roleKeys: Record<ChatRole, string> = {
  owner: "roleOwner",
  admin: "roleAdmin",
  member: "roleMember",
};
const makeRoleKeys: Record<ChatRole, string> = {
  owner: "makeOwner",
  admin: "makeAdmin",
  member: "makeMember",
};

function QuickAction({
  icon: Icon,
  label,
  onPress,
  disabled,
  testID,
}: {
  icon: LucideIcon;
  label: string;
  onPress(): void;
  disabled?: boolean;
  testID: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.quick,
        {
          backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
          borderColor: theme.border,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <Icon size={20} color={theme.primary} />
      <Text size={12} weight="medium" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function InfoRow({
  icon: Icon,
  label,
  meta,
  danger,
  onPress,
  testID,
}: {
  icon: LucideIcon;
  label: string;
  meta?: string;
  danger?: boolean;
  onPress(): void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={meta ? `${label}, ${meta}` : label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <Icon size={20} color={danger ? theme.danger : theme.muted} />
      <Text
        size={16}
        tone={danger ? "danger" : "default"}
        style={styles.grow}
        numberOfLines={1}
      >
        {label}
      </Text>
      {meta ? (
        <Text tone="muted" size={14}>
          {meta}
        </Text>
      ) : null}
      {danger ? null : <ChevronRight size={18} color={theme.subtle} />}
    </Pressable>
  );
}

function Group({
  title,
  children,
}: {
  title?: ReactNode;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={styles.groupWrap}>
      {title}
      <View
        style={[
          styles.group,
          { backgroundColor: theme.surface, borderColor: theme.border },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

function Divider() {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.border }]} />;
}

/**
 * «О чате»: who is in it and what it holds, with the actions the reader's
 * role allows. A direct chat shows the other person instead of members.
 */
export function ChatInfoScreen({ chatID }: { chatID: string }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const queryClient = useQueryClient();
  const {
    store,
    reload,
    pinnedChatIDs,
    togglePinnedChat,
    folders,
    saveFolders,
  } = useMessenger();
  const chat = useStore(store, (state) => state.chats[chatID]);
  const presence = useStore(store, (state) => state.presence);
  const { members, query: membersQuery } = useChatMembers(chatID);
  const pinned = usePinnedMessages(chatID);
  const [allMembers, setAllMembers] = useState(false);
  const [memberFor, setMemberFor] = useState<ChatMember | null>(null);
  const [menu, setMenu] = useState<"notify" | "folders" | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const viewer = useMemo(() => viewerOf(user), [user]);
  const sorted = useMemo(
    () => sortChatMembers(members, i18n.language),
    [i18n.language, members],
  );
  const direct = useOpenDirect((id) => router.push(`/chat/${id}`));

  if (!chat)
    return (
      <SafeAreaView
        edges={["bottom"]}
        style={[styles.screen, { backgroundColor: theme.canvas }]}
      >
        <ScreenHeader title={t("chatInfo")} />
        <View style={styles.content}>
          <Notice
            tone="neutral"
            title={t("chatUnavailable")}
            hint={t("chatUnavailableHint")}
          />
        </View>
      </SafeAreaView>
    );

  const rights = chatRights(chat, viewer, members);
  const title = chatTitle(chat, t("directChat"));
  const peer = chat.kind === "direct" ? chat.direct_peer : null;
  const agentPeer = peer?.type === "agent";
  const muted = isChatMuted(chat);
  const isPinned = pinnedChatIDs.includes(chat.id);
  const channel = chat.kind === "channel";
  const failed = (cause: unknown) =>
    Alert.alert(t("actionFailed"), messageOf(cause));

  const kindLine =
    chat.kind === "direct"
      ? peer
        ? [
            `@${peer.handle}`,
            peer.title,
            agentPeer ? null : t(presenceLabelKey(presence[peer.actor_id])),
          ]
            .filter(Boolean)
            .join(" · ")
        : ""
      : [
          channel ? t("channel") : t("group"),
          chat.visibility === "public" ? t("openLabel") : t("privateLabel"),
          membersQuery.data
            ? t("headerMembers", { count: members.length })
            : null,
          membersQuery.data && onlineCount(members, presence) > 0
            ? t("onlineCount", { count: onlineCount(members, presence) })
            : null,
        ]
          .filter(Boolean)
          .join(" · ");

  async function setNotify(level: NotifyLevel) {
    try {
      await api.updateChatNotifications(chat!.id, {
        notify_level: level,
        muted_until: null,
      });
      await reload();
    } catch (cause) {
      failed(cause);
    }
  }

  async function togglePin() {
    try {
      if (!(await togglePinnedChat(chat!.id)))
        Alert.alert(t("pinLimit", { limit: pinnedChatLimit }));
    } catch (cause) {
      failed(cause);
    }
  }

  async function run(action: () => Promise<unknown>, after?: () => void) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      after?.();
    } catch (cause) {
      failed(cause);
    } finally {
      setBusy(false);
    }
  }

  function leave() {
    if (rights.lastOwner) {
      Alert.alert(t("lastOwnerTitle"), t("lastOwnerHint"));
      return;
    }
    Alert.alert(
      t("leaveGroupTitle", { name: title }),
      channel ? t("leaveChannelHint") : t("leaveGroupHint"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: channel ? t("leaveChannelAction") : t("leaveGroupAction"),
          style: "destructive",
          onPress: () =>
            void run(
              async () => {
                await api.removeMember(chat!.id, user.id);
                await reload();
              },
              () => router.dismissAll(),
            ),
        },
      ],
    );
  }

  function archive() {
    Alert.alert(t("archiveTitle", { name: title }), t("archiveHint"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("archiveAction"),
        style: "destructive",
        onPress: () =>
          void run(
            async () => {
              await api.archiveChat(chat!.id);
              await reload();
            },
            () => router.dismissAll(),
          ),
      },
    ]);
  }

  function changeRole(member: ChatMember, role: ChatRole) {
    void run(async () => {
      await api.updateMember(chat!.id, member.actor_id, role);
      await queryClient.invalidateQueries({
        queryKey: chatKeys.members(chat!.id),
      });
    });
  }

  function removeMember(member: ChatMember) {
    Alert.alert(
      t("removeMemberTitle", { name: member.display_name }),
      t("removeMemberHint"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("removeMemberAction"),
          style: "destructive",
          onPress: () =>
            void run(async () => {
              await api.removeMember(chat!.id, member.actor_id);
              await queryClient.invalidateQueries({
                queryKey: chatKeys.members(chat!.id),
              });
            }),
        },
      ],
    );
  }

  const memberItems: MenuSheetItem[] = [];
  if (memberFor) {
    const self = memberFor.actor_id === user.id;
    memberItems.push({
      key: "profile",
      label: t("openProfile"),
      onPress: () => router.push(`/people/${memberFor.actor_id}`),
    });
    if (!self)
      memberItems.push({
        key: "write",
        label: t("writeMessage"),
        onPress: () => void direct.open(memberFor.actor_id),
      });
    const allowed = memberRights(chat, viewer, memberFor, members);
    if (allowed.roles.length || allowed.remove)
      memberItems.push({ key: "manage", divider: true });
    for (const role of allowed.roles)
      memberItems.push({
        key: `role-${role}`,
        testID: `member-role-${role}`,
        label: t(makeRoleKeys[role]),
        onPress: () => changeRole(memberFor, role),
      });
    if (allowed.remove)
      memberItems.push({
        key: "remove",
        testID: "member-remove",
        label: t("removeMemberAction"),
        danger: true,
        onPress: () => afterSheetCloses(() => removeMember(memberFor)),
      });
  }

  const level = (chat.notify_level ?? "default") as NotifyLevel;
  const notifyItems: MenuSheetItem[] = (
    [
      ["default", t("notifyDefault")],
      ["all", t("notifyAll")],
      ["mentions", t("notifyMentions")],
      ["none", t("notifyNone")],
    ] as const
  ).map(([value, label]) => ({
    key: value,
    label,
    icon:
      value === level ? (
        <Check size={20} color={theme.primary} />
      ) : (
        <View style={styles.iconSpace} />
      ),
    onPress: () => void setNotify(value),
  }));
  const levelLabel = notifyItems.find((item) => item.key === level)?.label;

  const folderItems: MenuSheetItem[] = [
    ...folders.map((folder) => ({
      key: folder.id,
      label: folder.name,
      icon: (
        <View
          style={[
            styles.dot,
            { backgroundColor: theme[folderColorToken(folder.color)] },
          ]}
        />
      ),
      checked: folder.chat_ids.includes(chat.id),
      onPress: () =>
        void saveFolders(toggleChatInFolder(folders, folder.id, chat.id)).catch(
          failed,
        ),
    })),
    {
      key: "new-folder",
      label: t("newFolder"),
      icon: <FolderPlus size={20} color={theme.muted} />,
      onPress: () => afterSheetCloses(() => setNewFolder(true)),
    },
  ];
  const inFolders = folders.filter((folder) =>
    folder.chat_ids.includes(chat.id),
  ).length;

  const shownMembers = allMembers ? sorted : sorted.slice(0, visibleMembers);

  return (
    <SafeAreaView
      testID="chat-info"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        backTestID="chat-info-back"
        title={
          chat.kind === "direct"
            ? agentPeer
              ? t("agentProfile")
              : t("personProfile")
            : channel
              ? t("channelInfo")
              : t("groupInfo")
        }
        trailing={
          busy ? (
            <ActivityIndicator color={theme.muted} style={styles.busy} />
          ) : undefined
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.identity}>
          <ChatAvatar
            name={title}
            seed={chat.avatar_seed || chat.id}
            size={88}
            shape={chat.kind === "direct" ? "circle" : "square"}
            agent={agentPeer}
            glyph={channel && !chat.avatar_version ? "#" : undefined}
            online={
              Boolean(peer) &&
              !agentPeer &&
              presence[peer!.actor_id] === "online"
            }
            ringColor={theme.canvas}
            {...chatAvatarSource(chat)}
          />
          <View style={styles.nameLine}>
            <Text
              testID="chat-info-title"
              accessibilityRole="header"
              weight="bold"
              size={21}
              style={styles.center}
            >
              {title}
            </Text>
            {agentPeer ? <AgentTag /> : null}
          </View>
          {kindLine ? (
            <Text tone="muted" size={14} style={styles.center}>
              {kindLine}
            </Text>
          ) : null}
          {peer && (peer.status_emoji || peer.status_text) ? (
            <Text size={14} style={styles.center}>
              {[peer.status_emoji, peer.status_text].filter(Boolean).join(" ")}
            </Text>
          ) : null}
          {chat.topic ? (
            <Text size={15} style={styles.center}>
              {chat.topic}
            </Text>
          ) : peer?.about ? (
            <Text size={15} style={styles.center}>
              {peer.about}
            </Text>
          ) : null}
        </View>

        <View style={styles.quicks}>
          <QuickAction
            testID="chat-info-mute"
            icon={muted ? Bell : BellOff}
            label={muted ? t("soundOn") : t("soundOff")}
            onPress={() => void setNotify(muted ? "default" : "none")}
          />
          <QuickAction
            testID="chat-info-pin"
            icon={isPinned ? PinOff : Pin}
            label={isPinned ? t("unpinChat") : t("pinChat")}
            disabled={!isPinned && pinnedChatIDs.length >= pinnedChatLimit}
            onPress={() => void togglePin()}
          />
          <QuickAction
            testID="chat-info-search"
            icon={Search}
            label={t("search")}
            onPress={() => router.push(`/search?chat=${chat.id}`)}
          />
          <QuickAction
            testID="chat-info-folder"
            icon={FolderPlus}
            label={t("toFolder")}
            onPress={() => setMenu("folders")}
          />
        </View>

        <Group>
          <InfoRow
            testID="chat-info-notify"
            icon={Bell}
            label={t("chatNotifications")}
            meta={levelLabel}
            onPress={() => setMenu("notify")}
          />
          <Divider />
          <InfoRow
            testID="chat-info-pinned"
            icon={Pin}
            label={t("pinnedMessages")}
            meta={pinned.loading ? undefined : String(pinned.count)}
            onPress={() => router.push(`/chat/${chat.id}/pinned`)}
          />
          <Divider />
          <InfoRow
            testID="chat-info-files"
            icon={FileText}
            label={t("chatFiles")}
            onPress={() => router.push(`/chat/${chat.id}/files`)}
          />
          {inFolders > 0 ? (
            <>
              <Divider />
              <InfoRow
                icon={FolderPlus}
                label={t("inFolders")}
                meta={String(inFolders)}
                onPress={() => setMenu("folders")}
              />
            </>
          ) : null}
          {rights.edit ? (
            <>
              <Divider />
              <InfoRow
                testID="chat-info-edit"
                icon={Pencil}
                label={t("editChat")}
                onPress={() => router.push(`/chat/${chat.id}/edit`)}
              />
            </>
          ) : null}
        </Group>

        {chat.kind !== "direct" ? (
          <Group
            title={
              <View style={styles.groupHead}>
                <Text
                  tone="muted"
                  size={13}
                  weight="semibold"
                  style={styles.grow}
                >
                  {membersQuery.data
                    ? t("headerMembers", { count: members.length })
                    : t("membersTitle")}
                </Text>
              </View>
            }
          >
            {rights.addMembers ? (
              <>
                <Pressable
                  testID="chat-info-add-members"
                  accessibilityRole="button"
                  onPress={() => router.push(`/chat/${chat.id}/add-members`)}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && { backgroundColor: theme.surfaceSelected },
                  ]}
                >
                  <UserPlus size={20} color={theme.primary} />
                  <Text size={16} tone="primary" weight="medium">
                    {t("addMembers")}
                  </Text>
                </Pressable>
                <Divider />
              </>
            ) : null}
            {membersQuery.isLoading ? (
              <ActivityIndicator style={styles.loader} color={theme.muted} />
            ) : membersQuery.isError && !members.length ? (
              <View style={styles.inner}>
                <Notice
                  title={t("membersLoadFailed")}
                  actionLabel={t("retry")}
                  onAction={() => void membersQuery.refetch()}
                />
              </View>
            ) : (
              shownMembers.map((member, index) => (
                <PersonRow
                  key={member.actor_id}
                  testID={`chat-member-${index}`}
                  person={member}
                  presence={presence[member.actor_id]}
                  meta={
                    member.type === "agent"
                      ? member.title || `@${member.handle}`
                      : member.role !== "member"
                        ? t(roleKeys[member.role as ChatRole])
                        : member.title || `@${member.handle}`
                  }
                  hint={t("memberActionsHint")}
                  onPress={() => setMemberFor(member)}
                />
              ))
            )}
            {sorted.length > visibleMembers ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setAllMembers((value) => !value)}
                style={styles.more}
              >
                <Text tone="primary" weight="medium" size={15}>
                  {allMembers
                    ? t("showFewer")
                    : t("showAllMembers", { count: sorted.length })}
                </Text>
              </Pressable>
            ) : null}
          </Group>
        ) : peer && !agentPeer ? (
          <Group>
            <InfoRow
              testID="chat-info-profile"
              icon={UserRound}
              label={t("openProfile")}
              onPress={() => router.push(`/people/${peer.actor_id}`)}
            />
          </Group>
        ) : null}

        {rights.leave || rights.archive ? (
          <Group>
            {rights.leave ? (
              <InfoRow
                testID="chat-info-leave"
                icon={LogOut}
                danger
                label={
                  channel ? t("leaveChannelAction") : t("leaveGroupAction")
                }
                onPress={leave}
              />
            ) : null}
            {rights.leave && rights.archive ? <Divider /> : null}
            {rights.archive ? (
              <InfoRow
                testID="chat-info-archive"
                icon={Archive}
                danger
                label={t("archiveAction")}
                onPress={archive}
              />
            ) : null}
          </Group>
        ) : null}
      </ScrollView>

      <MenuSheet
        visible={memberFor !== null}
        testID="member-actions"
        title={memberFor?.display_name}
        items={memberItems}
        onClose={() => setMemberFor(null)}
      />
      <MenuSheet
        visible={menu === "notify"}
        testID="notify-levels"
        title={t("chatNotifications")}
        items={notifyItems}
        onClose={() => setMenu(null)}
      />
      <MenuSheet
        visible={menu === "folders"}
        testID="chat-folders"
        title={t("inFolders")}
        items={folderItems}
        onClose={() => setMenu(null)}
      />
      <FolderSheet
        visible={newFolder}
        initialChatIDs={[chat.id]}
        onClose={() => setNewFolder(false)}
        onSave={(folder) => saveFolders(upsertFolder(folders, folder))}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing[4], gap: spacing[4], paddingBottom: spacing[8] },
  identity: { alignItems: "center", gap: spacing[1], paddingTop: spacing[2] },
  nameLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: spacing[2],
    flexWrap: "wrap",
    justifyContent: "center",
  },
  center: { textAlign: "center" },
  quicks: { flexDirection: "row", gap: spacing[2] },
  quick: {
    flex: 1,
    alignItems: "center",
    gap: 4,
    minHeight: 64,
    paddingVertical: spacing[2],
    paddingHorizontal: 4,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  groupWrap: { gap: spacing[2] },
  groupHead: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing[1],
  },
  group: { borderWidth: 1, borderRadius: radius.lg, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 52,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 52 },
  grow: { flex: 1 },
  loader: { marginVertical: spacing[4] },
  inner: { padding: spacing[3] },
  more: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  busy: { marginHorizontal: spacing[3] },
  dot: { width: 10, height: 10, borderRadius: 5, marginHorizontal: 5 },
  iconSpace: { width: 20 },
});
