import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Image } from "expo-image";
import { Download, FileText, MessageSquare, Play } from "lucide-react-native";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  formatBytes,
  formatListTime,
  groupSharedByMonth,
  isSharedVideo,
  messagePlainText,
  sharedItemKey,
  sharedItems,
  sharedKeys,
  sharedNextCursor,
  sharedPageSize,
  sharedTabs,
  type ChatSharedAttachment,
  type ChatSharedLink,
  type SharedAttachmentKind,
  type SharedTab,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { chatTitle } from "@/chats/ChatRow";
import { openAttachment } from "@/files/open";
import { mediaKind, type MediaItem } from "@/media/items";
import { MediaViewerHost } from "@/media/MediaViewer";
import { useOpenMedia } from "@/media/MediaViewerContext";
import { measureAnchor } from "@/ui/AnchoredMenu";
import { useFileSource } from "@/files/sources";
import { Avatar } from "@/ui/Avatar";
import { IconButton } from "@/ui/IconButton";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { TabChip } from "@/ui/TabChip";
import { Text } from "@/ui/Text";
import { playableVoice } from "@/voice/model";
import { VoiceBoundary } from "@/voice/VoiceFeed";
import { VoiceMessage } from "@/voice/VoiceMessage";
import { openMessage } from "./PinnedScreen";

/** Numbers on the tabs and the chat info rows, counted by the server. */
export function useSharedCounts(chatID: string) {
  const { api } = useSignedIn();
  return useQuery({
    queryKey: sharedKeys.counts(chatID),
    queryFn: () => api.sharedCounts(chatID),
    staleTime: 30_000,
    retry: false,
  });
}

/** The message of an item, in its thread or in the feed. */
function openShared(
  chatID: string,
  item: ChatSharedAttachment | ChatSharedLink,
) {
  if (item.thread_root_id)
    router.push(`/chat/${chatID}/thread/${item.thread_root_id}`);
  else openMessage(chatID, item.message_id);
}

const tabLabel: Record<SharedTab, string> = {
  media: "sharedMedia",
  files: "chatFiles",
  voice: "sharedVoice",
  links: "sharedLinks",
};

export function isSharedTab(value: unknown): value is SharedTab {
  return sharedTabs.includes(value as SharedTab);
}

/**
 * The chat's archive as in Telegram: media by month, files, voice messages
 * and links, each loaded page by page, newest first.
 */
export function SharedScreen({
  chatID,
  initialTab = "media",
}: {
  chatID: string;
  initialTab?: SharedTab;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { store } = useMessenger();
  const chat = useStore(store, (state) => state.chats[chatID]);
  const counts = useSharedCounts(chatID);
  const [tab, setTab] = useState<SharedTab>(initialTab);
  return (
    <SafeAreaView
      testID="chat-shared"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.surface }]}
    >
      <ScreenHeader
        backTestID="shared-back"
        title={t("sharedTitle")}
        subtitle={chat ? chatTitle(chat, t("directChat")) : undefined}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        style={styles.tabsScroll}
        contentContainerStyle={styles.tabs}
      >
        {sharedTabs.map((id) => (
          <TabChip
            key={id}
            testID={`shared-tab-${id}`}
            label={t(tabLabel[id])}
            count={counts.data?.[id]}
            selected={tab === id}
            onPress={() => setTab(id)}
          />
        ))}
      </ScrollView>
      {tab === "media" ? (
        <MediaTab chatID={chatID} />
      ) : tab === "links" ? (
        <LinksTab chatID={chatID} />
      ) : (
        <AttachmentList key={tab} chatID={chatID} kind={tab} />
      )}
    </SafeAreaView>
  );
}

function useAttachments(chatID: string, kind: SharedAttachmentKind) {
  const { api } = useSignedIn();
  return useInfiniteQuery({
    queryKey: sharedKeys.tab(chatID, kind),
    queryFn: ({ pageParam }) =>
      api.sharedAttachments(chatID, kind, {
        cursor: pageParam,
        limit: sharedPageSize,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: sharedNextCursor,
    staleTime: 30_000,
    retry: false,
  });
}

type PagedState = {
  isLoading: boolean;
  isError: boolean;
  isFetchingNextPage: boolean;
  refetch(): unknown;
};

/** Loading, error and empty states shared by the tabs. */
function EmptyState({
  query,
  title,
  hint,
}: {
  query: PagedState;
  title: string;
  hint: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  if (query.isLoading)
    return <ActivityIndicator style={styles.loader} color={theme.muted} />;
  if (query.isError)
    return (
      <View style={styles.state}>
        <Notice
          title={t("sharedLoadFailed")}
          actionLabel={t("retry")}
          onAction={() => void query.refetch()}
        />
      </View>
    );
  return (
    <View testID="shared-empty" style={styles.state}>
      <Text weight="semibold" size={16} style={styles.center}>
        {title}
      </Text>
      <Text tone="muted" size={14} style={styles.center}>
        {hint}
      </Text>
    </View>
  );
}

function Footer({ loading }: { loading: boolean }) {
  const theme = useTheme();
  return loading ? (
    <ActivityIndicator style={styles.footer} color={theme.muted} />
  ) : null;
}

const columns = 3;
const gap = 2;

function MediaTab({ chatID }: { chatID: string }) {
  const { t, i18n } = useTranslation();
  const query = useAttachments(chatID, "media");
  const counts = useSharedCounts(chatID);
  const items = useMemo(() => sharedItems(query.data?.pages), [query.data]);
  const sections = useMemo(
    () =>
      groupSharedByMonth(items, i18n.language).map((month) => ({
        key: month.key,
        title: month.label,
        data: chunk(month.items, columns),
      })),
    [items, i18n.language],
  );
  // The full-screen viewer of the feed pages through the chat's media from
  // the server: oldest first, older pages loaded as the reader nears the
  // start, the counter over the whole chat.
  const viewerItems = useMemo(() => archiveMedia(items), [items]);
  const byMessage = useMemo(
    () => new Map(items.map((item) => [item.message_id, item])),
    [items],
  );
  const authors = useMemo(
    () =>
      new Map(
        items.map((item) => [item.author.actor_id, item.author.display_name]),
      ),
    [items],
  );
  const { width } = useWindowDimensions();
  const size = Math.floor((width - gap * (columns - 1)) / columns);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const loadOlder = useCallback(async () => {
    if (hasNextPage && !isFetchingNextPage) await fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return (
    <MediaViewerHost
      items={viewerItems}
      total={counts.data?.media}
      hasOlder={hasNextPage}
      onLoadOlder={loadOlder}
      authorName={(actorID) => authors.get(actorID) ?? ""}
      onGoToMessage={(messageID) => {
        const item = byMessage.get(messageID);
        if (item) openShared(chatID, item);
      }}
    >
      <SectionList
        testID="shared-media"
        sections={sections}
        keyExtractor={(row) => row.map(sharedItemKey).join("|")}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text
            weight="semibold"
            tone="muted"
            size={13}
            style={styles.month}
            accessibilityRole="header"
          >
            {section.title}
          </Text>
        )}
        renderItem={({ item: row }) => (
          <View style={[styles.gridRow, { gap }]}>
            {row.map((item) => (
              <MediaTile key={sharedItemKey(item)} item={item} size={size} />
            ))}
          </View>
        )}
        onEndReachedThreshold={0.6}
        onEndReached={() => void loadOlder()}
        ListFooterComponent={<Footer loading={isFetchingNextPage} />}
        ListEmptyComponent={
          <EmptyState
            query={query}
            title={t("mediaEmpty")}
            hint={t("mediaEmptyHint")}
          />
        }
      />
    </MediaViewerHost>
  );
}

/** The archive's media (newest first) as the viewer's items (oldest first). */
function archiveMedia(items: ChatSharedAttachment[]): MediaItem[] {
  const result: MediaItem[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const kind = mediaKind(item.file);
    if (!kind) continue;
    result.push({
      key: item.file.id,
      kind,
      file: item.file,
      messageID: item.message_id,
      actorID: item.author.actor_id,
      createdAt: item.created_at,
    });
  }
  return result;
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    rows.push(items.slice(index, index + size));
  return rows;
}

function MediaTile({
  item,
  size,
}: {
  item: ChatSharedAttachment;
  size: number;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const openMedia = useOpenMedia();
  const tile = useRef<View>(null);
  const video = isSharedVideo(item);
  // A video shows its generated preview; without one, a plain tile.
  const source = useFileSource(
    item.file.preview_file_id ?? (video ? undefined : item.file.id),
  );
  return (
    <Pressable
      ref={tile}
      testID={`shared-media-${item.file.id}`}
      accessibilityRole="imagebutton"
      accessibilityLabel={
        video ? `${t("sharedVideo")}, ${item.file.name}` : item.file.name
      }
      onPress={() =>
        void measureAnchor(tile).then((origin) =>
          openMedia?.(item.file.id, origin),
        )
      }
      style={({ pressed }) => [
        { width: size, height: size, backgroundColor: theme.sidebar },
        pressed && styles.pressed,
      ]}
    >
      {source && (
        <Image
          source={source}
          contentFit="cover"
          cachePolicy="disk"
          style={StyleSheet.absoluteFill}
        />
      )}
      {video && (
        <View style={styles.play}>
          <Play size={14} color="#ffffff" fill="#ffffff" />
        </View>
      )}
    </Pressable>
  );
}

function AttachmentList({
  chatID,
  kind,
}: {
  chatID: string;
  kind: "files" | "voice";
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const query = useAttachments(chatID, kind);
  const items = useMemo(() => sharedItems(query.data?.pages), [query.data]);
  const [opening, setOpening] = useState<string | null>(null);

  async function open(item: ChatSharedAttachment) {
    setOpening(item.file.id);
    try {
      await openAttachment(api, item.file);
    } catch {
      Alert.alert(t("actionFailed"));
    } finally {
      setOpening(null);
    }
  }

  const renderFile = (item: ChatSharedAttachment, index: number) => {
    const meta = [
      formatBytes(item.file.size, i18n.language, {
        bytes: t("unitBytes"),
        kilobytes: t("unitKilobytes"),
        megabytes: t("unitMegabytes"),
        gigabytes: t("unitGigabytes"),
      }),
      item.author.display_name,
      formatListTime(item.created_at, i18n.language, t("yesterday")),
    ].join(" · ");
    return (
      <View style={[styles.row, { borderBottomColor: theme.border }]}>
        <Pressable
          testID={`file-row-${index}`}
          accessibilityRole="button"
          accessibilityLabel={`${item.file.name}, ${meta}`}
          accessibilityHint={t("openInChatHint")}
          onPress={() => openShared(chatID, item)}
          style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        >
          <View style={[styles.icon, { backgroundColor: theme.primarySoft }]}>
            <FileText size={20} color={theme.primary} />
          </View>
          <View style={styles.body}>
            <Text weight="medium" size={15} numberOfLines={1}>
              {item.file.name}
            </Text>
            <Text tone="muted" size={12.5} numberOfLines={1}>
              {meta}
            </Text>
          </View>
        </Pressable>
        {opening === item.file.id ? (
          <ActivityIndicator color={theme.muted} style={styles.spin} />
        ) : (
          <IconButton
            label={t("openFile")}
            onPress={() => void open(item)}
            icon={(color) => <Download size={20} color={color} />}
          />
        )}
      </View>
    );
  };

  const renderVoice = (item: ChatSharedAttachment, index: number) => {
    const voice = playableVoice(item.file);
    return (
      <View
        testID={`voice-row-${index}`}
        style={[styles.voiceRow, { borderBottomColor: theme.border }]}
      >
        <View style={styles.voiceHead}>
          <Avatar
            name={item.author.display_name}
            seed={item.author.actor_id}
            actorID={item.author.actor_id}
            avatarVersion={item.author.avatar_version}
            size={24}
          />
          <Text weight="medium" size={14} numberOfLines={1} style={styles.body}>
            {item.author.display_name}
          </Text>
          <Text tone="muted" size={12.5}>
            {formatListTime(item.created_at, i18n.language, t("yesterday"))}
          </Text>
          <IconButton
            label={t("sharedShowInChat")}
            onPress={() => openShared(chatID, item)}
            icon={(color) => <MessageSquare size={18} color={color} />}
          />
        </View>
        {voice ? (
          <VoiceBoundary fallback={renderFile(item, index)}>
            <VoiceMessage api={api} file={voice} own={false} />
          </VoiceBoundary>
        ) : (
          renderFile(item, index)
        )}
      </View>
    );
  };

  return (
    <FlatList
      testID={`shared-${kind}`}
      data={items}
      keyExtractor={sharedItemKey}
      renderItem={({ item, index }) =>
        kind === "voice" ? renderVoice(item, index) : renderFile(item, index)
      }
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage)
          void query.fetchNextPage();
      }}
      ListFooterComponent={<Footer loading={query.isFetchingNextPage} />}
      ListEmptyComponent={
        <EmptyState
          query={query}
          title={t(kind === "voice" ? "voiceEmpty" : "filesEmpty")}
          hint={t(kind === "voice" ? "voiceEmptyHint" : "filesEmptyHint")}
        />
      }
    />
  );
}

/** Only http(s) ever opens, whatever the server sends. */
function openLink(url: string, failed: string) {
  if (!/^https?:\/\//i.test(url)) return;
  void Linking.openURL(url).catch(() => Alert.alert(failed));
}

function LinksTab({ chatID }: { chatID: string }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const query = useInfiniteQuery({
    queryKey: sharedKeys.tab(chatID, "links"),
    queryFn: ({ pageParam }) =>
      api.sharedLinks(chatID, { cursor: pageParam, limit: sharedPageSize }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: sharedNextCursor,
    staleTime: 30_000,
    retry: false,
  });
  const items = useMemo(() => sharedItems(query.data?.pages), [query.data]);
  const renderItem = ({
    item,
    index,
  }: {
    item: ChatSharedLink;
    index: number;
  }): ReactElement => (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <Pressable
        testID={`link-row-${index}`}
        accessibilityRole="link"
        accessibilityLabel={`${item.label ?? item.domain}, ${item.url}`}
        accessibilityHint={t("sharedOpenLinkHint")}
        onPress={() => openLink(item.url, t("actionFailed"))}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
      >
        <View style={[styles.icon, { backgroundColor: theme.primarySoft }]}>
          <Text weight="bold" size={16} tone="primary">
            {(item.domain[0] ?? "#").toUpperCase()}
          </Text>
        </View>
        <View style={styles.body}>
          <Text weight="medium" size={15} numberOfLines={1}>
            {item.label ?? item.domain}
          </Text>
          <Text tone="primary" size={12.5} numberOfLines={1}>
            {item.url}
          </Text>
          {item.snippet ? (
            <Text tone="muted" size={13} numberOfLines={2}>
              {messagePlainText(item.snippet)}
            </Text>
          ) : null}
          <Text tone="subtle" size={12} numberOfLines={1}>
            {item.author.display_name} ·{" "}
            {formatListTime(item.created_at, i18n.language, t("yesterday"))}
          </Text>
        </View>
      </Pressable>
      <IconButton
        label={t("sharedShowInChat")}
        onPress={() => openShared(chatID, item)}
        icon={(color) => <MessageSquare size={18} color={color} />}
      />
    </View>
  );
  return (
    <FlatList
      testID="shared-links"
      data={items}
      keyExtractor={sharedItemKey}
      renderItem={renderItem}
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage)
          void query.fetchNextPage();
      }}
      ListFooterComponent={<Footer loading={query.isFetchingNextPage} />}
      ListEmptyComponent={
        <EmptyState
          query={query}
          title={t("linksEmpty")}
          hint={t("linksEmptyHint")}
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  tabsScroll: { flexGrow: 0 },
  tabs: {
    gap: spacing[2],
    paddingHorizontal: 14,
    paddingVertical: spacing[2],
  },
  month: { paddingHorizontal: 14, paddingTop: spacing[3], paddingBottom: 6 },
  gridRow: { flexDirection: "row", marginBottom: gap },
  play: {
    position: "absolute",
    left: 6,
    bottom: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  main: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingLeft: 14,
  },
  voiceRow: {
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  voiceHead: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  pressed: { opacity: 0.6 },
  icon: {
    width: 40,
    height: 40,
    borderRadius: radius.tile,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, minWidth: 0 },
  spin: { width: 40 },
  loader: { marginTop: spacing[10] },
  footer: { marginVertical: spacing[4] },
  state: { padding: spacing[5], gap: spacing[2] },
  center: { textAlign: "center" },
});
