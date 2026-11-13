import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { Clock } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  groupScheduled,
  needsAuthorCheck,
  scheduledErrorKind,
  type ScheduledMessage,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { chatTitle } from "@/chats/ChatRow";
import { ConnectionBanner } from "@/messenger/ConnectionBanner";
import { useMessenger } from "@/messenger/MessengerProvider";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import { useClock, useNow, useWhen } from "./clock";
import { formatSectionDay, formatTime } from "./format";
import { ScheduledBoundary } from "./ScheduledBoundary";
import { ScheduledEditSheet } from "./ScheduledEditSheet";
import { ScheduledItem, type ScheduledItemAction } from "./ScheduledItem";
import { ScheduleSheet } from "./ScheduleSheet";
import {
  ScheduledVerifySheet,
  type VerifyAction,
} from "./ScheduledVerifySheet";
import {
  useChatScheduled,
  useScheduledActions,
  scheduledErrorKey,
} from "./useScheduled";

const noticeMs = 2200;

/**
 * Scheduled messages of one chat (`chatID`) or of every chat (null).
 * `focusID` brings one record up and marks it, e.g. from the feed.
 */
export function ScheduledScreen({
  chatID,
  focusID = null,
}: {
  chatID: string | null;
  focusID?: string | null;
}) {
  return (
    <ScheduledBoundary>
      <ScheduledContent chatID={chatID} focusID={focusID} />
    </ScheduledBoundary>
  );
}

function ScheduledContent({
  chatID,
  focusID,
}: {
  chatID: string | null;
  focusID: string | null;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const clock = useClock();
  const when = useWhen();
  const now = useNow(60_000);
  const { store } = useMessenger();
  const chats = useStore(store, (state) => state.chats);
  const { query, items } = useChatScheduled(chatID);
  const [notice, setNotice] = useState<string | null>(null);
  const actions = useScheduledActions(setNotice);
  const [editing, setEditing] = useState<ScheduledMessage | null>(null);
  const [moving, setMoving] = useState<ScheduledMessage | null>(null);
  const [verifying, setVerifying] = useState<{
    item: ScheduledMessage;
    action: VerifyAction;
  } | null>(null);
  const list =
    useRef<
      SectionList<
        ScheduledMessage,
        { key: string; title: string; failed: boolean }
      >
    >(null);

  // Records changed on another device arrive by realtime; a return to the
  // screen reads the list again in case the socket was asleep.
  const { refetch } = query;
  const visited = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (visited.current) void refetch();
      visited.current = true;
    }, [refetch]),
  );

  useEffect(() => {
    if (!notice) return;
    AccessibilityInfo.announceForAccessibility(notice);
    const timer = setTimeout(() => setNotice(null), noticeMs);
    return () => clearTimeout(timer);
  }, [notice]);

  // Sent or deleted elsewhere while its sheet was open: close it and say so.
  const ids = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  useEffect(() => {
    const open = editing ?? moving;
    if (!open || query.isFetching || ids.has(open.id)) return;
    setEditing(null);
    setMoving(null);
    setNotice(t("scheduledErrorClosed"));
  }, [editing, ids, moving, query.isFetching, t]);

  const sections = useMemo(() => {
    const groups = groupScheduled(items, now);
    const words = {
      today: t("scheduledToday"),
      tomorrow: t("scheduledTomorrow"),
    };
    return [
      ...(groups.failed.length
        ? [
            {
              key: "failed",
              title: t("scheduledFailedSection"),
              failed: true,
              data: groups.failed,
            },
          ]
        : []),
      ...groups.days.map((day) => ({
        key: day.key,
        title: formatSectionDay(day.day, now, clock, words),
        failed: false,
        data: day.items,
      })),
    ];
  }, [clock, items, now, t]);

  // Opened from a scheduled bubble: bring that record up once it is listed.
  const focused = useRef(false);
  useEffect(() => {
    if (!focusID || focused.current) return;
    const sectionIndex = sections.findIndex((section) =>
      section.data.some((item) => item.id === focusID),
    );
    if (sectionIndex < 0) return;
    focused.current = true;
    const itemIndex = sections[sectionIndex]!.data.findIndex(
      (item) => item.id === focusID,
    );
    setTimeout(
      () =>
        list.current?.scrollToLocation({
          sectionIndex,
          itemIndex,
          viewPosition: 0.3,
        }),
      250,
    );
  }, [focusID, sections]);

  const chatName = useCallback(
    (item: ScheduledMessage) => {
      const chat = chats[item.chat_id];
      return chat
        ? chatTitle(chat, t("directChat"))
        : t("scheduledUnknownChat");
    },
    [chats, t],
  );

  const onAction = useCallback(
    (item: ScheduledMessage, action: ScheduledItemAction) => {
      switch (action) {
        case "edit":
          setEditing(item);
          return;
        case "time":
          if (needsAuthorCheck(item)) setVerifying({ item, action: "time" });
          else setMoving(item);
          return;
        case "sendNow":
          if (needsAuthorCheck(item)) setVerifying({ item, action: "sendNow" });
          else void actions.sendNow(item);
          return;
        case "delete":
          Alert.alert(
            t("scheduledDeleteTitle"),
            t(
              item.status === "failed"
                ? "scheduledDeleteFailedHint"
                : "scheduledDeleteHint",
            ),
            [
              { text: t("cancel"), style: "cancel" },
              {
                text: t("scheduledDelete"),
                style: "destructive",
                onPress: () => void actions.remove(item),
              },
            ],
          );
      }
    },
    [actions, t],
  );

  const openChat = useCallback((item: ScheduledMessage) => {
    router.push(
      item.thread_root_id
        ? `/chat/${item.chat_id}/thread/${item.thread_root_id}`
        : `/chat/${item.chat_id}`,
    );
  }, []);

  const subtitle =
    chatID !== null
      ? chats[chatID]
        ? chatTitle(chats[chatID]!, t("directChat"))
        : undefined
      : t("scheduledAllChats");

  const error = query.isError && !query.data;
  return (
    <SafeAreaView
      testID="scheduled-screen"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        backTestID="scheduled-back"
        title={t("scheduledTitle")}
        subtitle={
          subtitle ? (
            <Text tone="muted" size={12.5} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : undefined
        }
      />
      <ConnectionBanner />
      {query.isPending ? (
        <ActivityIndicator style={styles.loading} color={theme.muted} />
      ) : error ? (
        <View style={styles.state}>
          <Notice
            title={t("scheduledLoadError")}
            hint={t(scheduledErrorKey(scheduledErrorKind(query.error)))}
            actionLabel={t("retry")}
            onAction={() => void refetch()}
          />
        </View>
      ) : (
        <SectionList
          ref={list}
          testID="scheduled-list"
          onScrollToIndexFailed={() => undefined}
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => void refetch()}
              tintColor={theme.muted}
            />
          }
          renderSectionHeader={({ section }) => (
            <Text
              accessibilityRole="header"
              size={12}
              weight="semibold"
              tone={section.failed ? "danger" : "muted"}
              style={styles.section}
            >
              {section.title.toLocaleUpperCase()}
            </Text>
          )}
          renderItem={({ item, section }) => {
            const at = new Date(item.send_at);
            return (
              <ScheduledItem
                item={item}
                time={
                  Number.isNaN(at.getTime())
                    ? "—"
                    : section.failed
                      ? when(at, now)
                      : formatTime(at, clock)
                }
                chatName={chatID === null ? chatName(item) : null}
                busy={actions.busy.has(item.id)}
                focused={item.id === focusID}
                onAction={onAction}
                onOpenChat={openChat}
              />
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Clock size={28} color={theme.subtle} />
              <Text weight="semibold" size={16}>
                {t("scheduledEmpty")}
              </Text>
              <Text tone="muted" size={14} style={styles.center}>
                {t("scheduledEmptyHint")}
              </Text>
            </View>
          }
        />
      )}
      {notice && (
        <View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[styles.notice, { backgroundColor: theme.action }]}
        >
          <Text size={14} weight="medium" style={{ color: theme.onAction }}>
            {notice}
          </Text>
        </View>
      )}
      <ScheduledEditSheet
        item={editing}
        pending={editing ? actions.busy.has(editing.id) : false}
        onClose={() => setEditing(null)}
        onSave={(item, change) =>
          void actions
            .update(item, change, t("scheduledSaved"))
            .then((record) =>
              // After a conflict the sheet continues from the fresh version.
              setEditing(record ? null : actions.latest(item.id)),
            )
        }
      />
      <ScheduleSheet
        visible={moving !== null}
        title={t("scheduledRescheduleTitle")}
        confirmKey="scheduledMoveConfirm"
        initial={moving ? new Date(moving.send_at) : null}
        initialSilent={moving?.silent ?? false}
        pending={moving ? actions.busy.has(moving.id) : false}
        onClose={() => setMoving(null)}
        onConfirm={(at, silent) => {
          const item = moving;
          if (!item) return;
          void actions
            .update(
              item,
              { send_at: at.toISOString(), silent },
              t("scheduledMoved", { when: when(at, new Date()) }),
            )
            .then((record) =>
              setMoving(record ? null : actions.latest(item.id)),
            );
        }}
      />
      <ScheduledVerifySheet
        target={verifying}
        onClose={() => setVerifying(null)}
        onConfirm={(item, action) => {
          setVerifying(null);
          if (action === "sendNow") void actions.sendNow(item);
          // iOS cannot present the next sheet while this one fades out.
          else setTimeout(() => setMoving(item), 350);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  loading: { marginTop: spacing[10] },
  state: { padding: spacing[5] },
  content: { paddingBottom: spacing[6], flexGrow: 1 },
  // Prototype `.sect`: 12px, 600, uppercase, padding 14px 16px 8px.
  section: {
    paddingTop: 14,
    paddingHorizontal: 16,
    paddingBottom: 8,
    letterSpacing: 0.5,
  },
  empty: {
    alignItems: "center",
    gap: spacing[2],
    padding: spacing[8],
    marginTop: spacing[8],
  },
  center: { textAlign: "center" },
  notice: {
    position: "absolute",
    alignSelf: "center",
    bottom: spacing[6],
    borderRadius: 18,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    maxWidth: "90%",
  },
});
