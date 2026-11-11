import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  Camera,
  FileText,
  Image as ImageIcon,
  Sparkles,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  applySavedChange,
  chatAvatarSource,
  chatCommands,
  compactUUID,
  decodeMentions,
  encodeMentions,
  formatDaySeparator,
  grantsPermission,
  insertMention,
  messagePlainText,
  savedKeys,
  type ActionViewer,
  type ChatMember,
  type ClientMessage,
  type FeedRow,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { chatTitle } from "@/chats/ChatRow";
import { Avatar } from "@/ui/Avatar";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import { ConnectionBanner } from "@/messenger/ConnectionBanner";
import { attachmentLimit, useAttachments } from "@/files/useAttachments";
import { pickFiles, type PickSource } from "@/files/pick";
import { saveFailureKey } from "@/important/saved";
import { RowBoundary } from "@/ui/RowBoundary";
import { ScheduledBubbles } from "@/scheduled/ScheduledBubbles";
import { ScheduledStrip } from "@/scheduled/ScheduledStrip";
import { useScheduleComposer } from "@/scheduled/useScheduleComposer";
import { useChatScheduled } from "@/scheduled/useScheduled";
import { AgentPicker } from "./AgentPicker";
import { AgentStreamRow } from "./AgentStreamRow";
import { bubblePlacement, type BubblePlacement } from "./bubbles";
import { Composer, type ComposerContext } from "./Composer";
import { ComposerSheet, type ComposerAction } from "./ComposerSheet";
import { ForwardSheet } from "./ForwardSheet";
import { MessageDetailsSheet } from "./MessageDetailsSheet";
import { MessageMenu } from "./MessageMenu";
import { MessageBubble, MessageRow } from "./MessageRow";
import { canPinIn, messageMenu, type MessageMenuAction } from "./menuItems";
import { reactionsKey, toggleReaction } from "./reactions";
import { ThreadRoot } from "./ThreadRoot";
import { useConversation } from "./useConversation";
import { useVoiceFeed } from "@/voice/VoiceFeed";
import { VoiceOutboxStrip } from "@/voice/VoiceOutbox";

type Context =
  | { kind: "reply"; message: ClientMessage }
  | { kind: "edit"; message: ClientMessage };

const bottomTolerance = 64;
const noticeMs = 2200;

/** iOS cannot present a sheet or an alert while the menu is still fading out. */
function afterMenu(next: () => void) {
  setTimeout(next, Platform.OS === "ios" ? 350 : 0);
}

function persisted(message: ClientMessage) {
  return !message.delivery || message.delivery === "sent";
}

/** Feed, header and composer of a chat, or of one thread when `threadRootID` is set. */
export function ConversationView({
  chatID,
  threadRootID,
  focusMessageID = null,
}: {
  chatID: string;
  threadRootID: string | null;
  focusMessageID?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const queryClient = useQueryClient();
  const conversation = useConversation(chatID, threadRootID, focusMessageID);
  const [highlighted, setHighlighted] = useState(focusMessageID);
  const { chat, members, rows, markRead } = conversation;
  useVoiceFeed(conversation.messages);
  const [context, setContext] = useState<Context | null>(null);
  const [editBody, setEditBody] = useState("");
  const [menuFor, setMenuFor] = useState<ClientMessage | null>(null);
  const [forwarding, setForwarding] = useState<ClientMessage | null>(null);
  const [detailsFor, setDetailsFor] = useState<ClientMessage | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const attachments = useAttachments(api);
  const list = useRef<FlashListRef<FeedRow>>(null);
  const atBottom = useRef(true);
  const title = chat ? chatTitle(chat, t("directChat")) : "";
  const inThread = threadRootID !== null;
  const groupChat = chat ? chat.kind !== "direct" : members.length > 2;

  // In a thread the root is pinned above the list; the list holds replies.
  const root = inThread
    ? conversation.messages.find((message) => message.id === threadRootID)
    : undefined;
  const feed = useMemo(
    () =>
      inThread ? rows.filter((row) => row.message.id !== threadRootID) : rows,
    [inThread, rows, threadRootID],
  );

  const memberOf = useCallback(
    (actorID: string) => members.find((member) => member.actor_id === actorID),
    [members],
  );
  const authorName = useCallback(
    (actorID: string) =>
      memberOf(actorID)?.display_name ??
      (actorID === user.id ? t("previewYou") : t("participant")),
    [memberOf, t, user.id],
  );

  const agentMembers = useMemo(
    () => members.filter((member) => member.type === "agent"),
    [members],
  );
  const chatAgents = useQuery({
    queryKey: ["chat-agents", chatID],
    queryFn: () => api.chatAgents(chatID),
    enabled: agentMembers.length > 0 && !inThread,
    staleTime: 60_000,
  });
  const commands = useMemo(
    () => (agentMembers.length ? chatCommands(chatAgents.data ?? []) : []),
    [chatAgents.data, agentMembers.length],
  );
  const pins = useQuery({
    queryKey: ["pins", chatID],
    queryFn: () => api.pins(chatID),
    staleTime: 30_000,
  });
  const pinnedIDs = useMemo(
    () => new Set((pins.data ?? []).map((pin) => pin.message_id)),
    [pins.data],
  );
  // The reader's own saves («Важные»): the star in the bubble. Kept apart from
  // messages so the feed is the same for everyone.
  const savedQuery = useQuery({
    queryKey: savedKeys.ids(user.id, chatID),
    queryFn: () => api.savedMessageIDs(chatID),
    staleTime: 5 * 60_000,
  });
  const savedIDs = useMemo(
    () => new Set(savedQuery.data ?? []),
    [savedQuery.data],
  );
  const myRole =
    chat?.role ?? members.find((member) => member.actor_id === user.id)?.role;
  const viewer = useMemo<ActionViewer>(
    () => ({
      actorID: user.id,
      chatRole: myRole,
      orgRole: user.role,
      hasPermission: (permission) =>
        grantsPermission(user.role, user.permissions ?? [], permission),
    }),
    [myRole, user.id, user.permissions, user.role],
  );
  const reply = useCallback(
    (message: ClientMessage) => setContext({ kind: "reply", message }),
    [],
  );
  const openThread = useCallback(
    (message: ClientMessage) =>
      router.push(`/chat/${chatID}/thread/${message.id}`),
    [chatID],
  );

  useEffect(() => {
    if (!notice) return;
    AccessibilityInfo.announceForAccessibility(notice);
    const timer = setTimeout(() => setNotice(null), noticeMs);
    return () => clearTimeout(timer);
  }, [notice]);

  // A chat with unread messages opens on the first of them; reading them
  // (scrolling to the bottom) is what marks the chat read.
  // A message opened from search takes precedence over the unread boundary.
  const focusIndex = conversation.focusedMessageID
    ? feed.findIndex((row) => row.message.id === conversation.focusedMessageID)
    : -1;
  const firstUnreadIndex =
    focusIndex >= 0 ? focusIndex : feed.findIndex((row) => row.firstUnread);
  const openedAt = useRef<number | null>(null);
  if (openedAt.current === null && feed.length && !conversation.loading) {
    openedAt.current = firstUnreadIndex;
    if (firstUnreadIndex >= 0) atBottom.current = false;
  }
  useEffect(() => {
    if (openedAt.current !== null && openedAt.current >= 0) setShowJump(true);
  }, [feed.length]);
  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => setHighlighted(null), 2500);
    return () => clearTimeout(timer);
  }, [highlighted]);

  function jumpToBottom() {
    if (conversation.hasLater) {
      // The search window ends before the latest messages: load them first.
      conversation.jumpToLatest();
      setTimeout(() => list.current?.scrollToEnd({ animated: true }), 300);
    } else list.current?.scrollToEnd({ animated: true });
  }

  // New messages while the reader follows the bottom count as read.
  useEffect(() => {
    if (atBottom.current && rows.length) markRead();
  }, [markRead, rows.length]);

  function onScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const bottom =
      contentOffset.y + layoutMeasurement.height >=
      contentSize.height - bottomTolerance;
    if (bottom !== atBottom.current) {
      atBottom.current = bottom;
      setShowJump(!bottom);
    }
    if (bottom) markRead();
  }

  async function sendOrSave(options: { silent?: boolean } = {}) {
    if (context?.kind === "edit") {
      const message = context.message;
      setContext(null);
      await conversation
        .edit(message, decodeMentions(editBody).text)
        .catch(() => Alert.alert(t("actionFailed")));
      return;
    }
    const replyTo = context?.kind === "reply" ? context.message : null;
    const fileIDs = attachments.ready.map((file) => file.id);
    setContext(null);
    attachments.reset();
    await conversation.send(replyTo, fileIDs, options);
    if (options.silent) setNotice(t("scheduledSilentSent"));
    list.current?.scrollToEnd({ animated: true });
  }

  // Sending later and without sound (package E). Only the author sees their
  // scheduled messages; the strip lives under the chat header, not in threads,
  // and each feed ends with its own scheduled messages as dashed bubbles.
  const chatScheduled = useChatScheduled(chatID);
  const scheduling = useScheduleComposer({
    chatID,
    threadRootID,
    members,
    draft: () => ({
      body: conversation.body,
      replyToID: context?.kind === "reply" ? context.message.id : undefined,
      fileIDs: attachments.ready.map((file) => file.id),
      uploading: attachments.items.some((item) => item.status === "uploading"),
    }),
    onScheduled: (text) => {
      conversation.changeBody("");
      setContext(null);
      attachments.reset();
      setNotice(text);
    },
    onSilent: () => void sendOrSave({ silent: true }),
    onNotice: setNotice,
  });

  function pick(source: PickSource) {
    void pickFiles(source, attachmentLimit - attachments.items.length)
      .then((files) => {
        if (attachments.add(files) > 0)
          Alert.alert(t("attachmentLimit", { limit: attachmentLimit }));
      })
      .catch(() => Alert.alert(t("actionFailed")));
  }

  /** «Позвать агента»: puts a mention of the agent at the end of the draft. */
  function callAgent(agent: ChatMember) {
    setAgentsOpen(false);
    const draft = decodeMentions(conversation.body);
    const spaced =
      draft.text && !/\s$/.test(draft.text)
        ? { ...draft, text: `${draft.text} ` }
        : draft;
    const end = spaced.text.length;
    conversation.changeBody(
      encodeMentions(
        insertMention(spaced, end, end, agent.actor_id, agent.display_name),
      ),
    );
    setFocusRequest((value) => value + 1);
  }

  // The "+" sheet. Media and files first, conversation actions after; a
  // feature adds its tile with one entry here.
  const composerActions: ComposerAction[] = [
    {
      key: "photos",
      label: t("attachPhotos"),
      icon: ImageIcon,
      onPress: () => pick("photos"),
    },
    {
      key: "camera",
      label: t("attachCamera"),
      icon: Camera,
      onPress: () => pick("camera"),
    },
    {
      key: "file",
      label: t("attachFile"),
      icon: FileText,
      onPress: () => pick("file"),
    },
    ...(agentMembers.length
      ? [
          {
            key: "agent",
            label: t("callAgent"),
            icon: Sparkles,
            accent: true,
            onPress: () => setAgentsOpen(true),
          },
        ]
      : []),
    ...(conversation.readonly ? [] : [scheduling.action]),
  ];

  async function setPinned(message: ClientMessage, pin: boolean) {
    try {
      if (pin) await api.pin(message.id);
      else await api.unpin(message.id);
      setNotice(pin ? t("messagePinned") : t("messageUnpinned"));
      void queryClient.invalidateQueries({ queryKey: ["pins", chatID] });
    } catch {
      Alert.alert(t("actionFailed"));
    }
  }

  async function setSaved(message: ClientMessage, saved: boolean) {
    try {
      if (saved) await api.saveMessage(message.id);
      else await api.unsaveMessage(message.id);
      applySavedChange(queryClient, user.id, {
        messageID: message.id,
        chatID: message.chat_id,
        saved,
      });
      setNotice(
        saved ? t("addedToImportantPrivate") : t("removedFromImportant"),
      );
    } catch (error) {
      Alert.alert(t(saveFailureKey(error)));
    }
  }

  function act(action: MessageMenuAction) {
    const message = menuFor;
    setMenuFor(null);
    if (!message) return;
    switch (action) {
      case "reply":
        setContext({ kind: "reply", message });
        setFocusRequest((value) => value + 1);
        return;
      case "thread":
        openThread(message);
        return;
      case "save":
      case "unsave":
        void setSaved(message, action === "save");
        return;
      case "pin":
      case "unpin":
        void setPinned(message, action === "pin");
        return;
      case "forward":
        afterMenu(() => setForwarding(message));
        return;
      case "details":
        afterMenu(() => setDetailsFor(message));
        return;
      case "copyLink":
        void Clipboard.setStringAsync(
          `${api.apiURL}/m/${compactUUID(message.id)}`,
        ).then(() => setNotice(t("linkCopied")));
        return;
      case "copyText":
        void Clipboard.setStringAsync(messagePlainText(message.body)).then(() =>
          setNotice(t("textCopied")),
        );
        return;
      case "edit":
        setEditBody(message.body);
        setContext({ kind: "edit", message });
        setFocusRequest((value) => value + 1);
        return;
      case "delete":
        afterMenu(() => confirmDelete(message));
    }
  }

  function confirmDelete(message: ClientMessage) {
    Alert.alert(t("deleteMessageTitle"), t("deleteMessageHint"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("deleteMessage"),
        style: "destructive",
        onPress: () =>
          void conversation
            .remove(message)
            .catch(() => Alert.alert(t("actionFailed"))),
      },
    ]);
  }

  const menuPersisted = menuFor ? persisted(menuFor) : false;
  const menuReactions = useQuery({
    queryKey: reactionsKey(menuFor?.id ?? ""),
    queryFn: () => api.reactions(menuFor!.id),
    enabled: menuFor !== null && menuPersisted,
  });
  const menuSections = menuFor
    ? messageMenu({
        own: menuFor.actor_id === user.id,
        canModerate: conversation.canModerate,
        canPin: canPinIn(myRole),
        pinned: pinnedIDs.has(menuFor.id),
        saved: savedIDs.has(menuFor.id),
        inThread,
        hasText: Boolean(messagePlainText(menuFor.body).trim()),
        persisted: menuPersisted,
      })
    : [];
  const placementOf = (message: ClientMessage): BubblePlacement => {
    const own = message.actor_id === user.id;
    const column = groupChat && !own;
    return {
      own,
      first: true,
      last: true,
      showName: column,
      avatarColumn: column,
      showAvatar: column,
    };
  };

  const composerContext: ComposerContext | null =
    context?.kind === "reply"
      ? {
          kind: "reply",
          author: authorName(context.message.actor_id),
          text: messagePlainText(context.message.body),
        }
      : context?.kind === "edit"
        ? { kind: "edit", text: messagePlainText(context.message.body) }
        : null;

  const agents = conversation.workingAgents;
  const live = Boolean(agents.length || conversation.typingNames.length);
  const subtitle = agents.length
    ? agents.length === 1
      ? t("agentWorking", { name: authorName(agents[0]!.actorID) })
      : t("agentsWorking", { count: agents.length })
    : conversation.typingNames.length
      ? conversation.typingNames.length === 1
        ? t("typingOne", { name: conversation.typingNames[0] })
        : t("typingMany", { count: conversation.typingNames.length })
      : inThread
        ? title
        : members.length
          ? t("headerMembers", { count: members.length })
          : "";
  const replyCount = Math.max(root?.thread_reply_count ?? 0, feed.length);

  const daySeparator = (iso: string) => (
    <View style={styles.dayRow}>
      <View style={[styles.day, { backgroundColor: theme.surfaceSelected }]}>
        <Text tone="muted" size={12} weight="semibold">
          {formatDaySeparator(iso, i18n.language, {
            today: t("today"),
            yesterday: t("yesterday"),
          })}
        </Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView
      testID="conversation"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        backTestID="conversation-back"
        title={inThread ? t("threadTitle") : title}
        onTitlePress={
          chat && !inThread
            ? () => router.push(`/chat/${chatID}/info`)
            : undefined
        }
        titleHint={t("chatInfoHint")}
        titleTestID="conversation-title"
        leading={
          chat && !inThread ? (
            <Avatar
              name={title}
              seed={chat.avatar_seed || chat.id}
              size={36}
              shape={chat.kind === "direct" ? "circle" : "square"}
              agent={chat.direct_peer?.type === "agent"}
              {...chatAvatarSource(chat)}
            />
          ) : undefined
        }
        subtitle={
          subtitle ? (
            <Text
              tone={live ? "primary" : "muted"}
              size={12.5}
              numberOfLines={1}
              accessibilityLiveRegion={live ? "polite" : "none"}
            >
              {subtitle}
            </Text>
          ) : undefined
        }
      />
      <ConnectionBanner />
      {!inThread && (
        <ScheduledStrip
          chatID={chatID}
          items={chatScheduled.items}
          onPress={() => router.push(`/chat/${chatID}/scheduled`)}
        />
      )}
      {inThread && root && (
        <RowBoundary kind="message" resetKey={root}>
          <ThreadRoot
            api={api}
            ownID={user.id}
            message={root}
            author={memberOf(root.actor_id)}
            members={members}
            viewer={viewer}
            onActions={setMenuFor}
            onUpdated={conversation.applyMessage}
          />
        </RowBoundary>
      )}
      <KeyboardAvoidingView behavior="padding" style={styles.grow}>
        <View style={styles.grow}>
          {conversation.loading ? (
            <ActivityIndicator style={styles.center} color={theme.muted} />
          ) : conversation.loadError ? (
            <View style={styles.state}>
              <Notice
                title={t("loadFailed")}
                actionLabel={t("retry")}
                onAction={() => void conversation.retry()}
              />
            </View>
          ) : (
            <FlashList
              ref={list}
              testID="message-list"
              data={feed}
              keyExtractor={(row) =>
                row.message.client_msg_id || row.message.id
              }
              initialScrollIndex={
                openedAt.current !== null && openedAt.current >= 0
                  ? openedAt.current
                  : undefined
              }
              maintainVisibleContentPosition={{
                startRenderingFromBottom: !(
                  openedAt.current !== null && openedAt.current >= 0
                ),
                autoscrollToBottomThreshold: 0.2,
              }}
              // Thread captions and reactions load after the first layout and
              // make the last bubbles taller; a reader at the bottom stays
              // there instead of seeing the last message under the composer.
              onContentSizeChange={() => {
                const focused =
                  openedAt.current !== null && openedAt.current >= 0;
                if (atBottom.current && !focused)
                  list.current?.scrollToEnd({ animated: false });
              }}
              onStartReached={() => void conversation.loadOlder()}
              onScroll={onScroll}
              scrollEventThrottle={100}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.feed}
              ListHeaderComponent={
                inThread && replyCount > 0 ? (
                  <View style={styles.threadDivider}>
                    <Text tone="muted" size={12} weight="semibold">
                      {t("threadReplies", { count: replyCount })}
                    </Text>
                    <View
                      style={[styles.line, { backgroundColor: theme.border }]}
                    />
                  </View>
                ) : null
              }
              ListFooterComponent={
                <>
                  {/* A recorded voice message is a bubble at once: it
                      uploads here, then sends as an ordinary message. */}
                  <VoiceOutboxStrip
                    chatID={chatID}
                    threadRootID={threadRootID}
                  />
                  <ScheduledBubbles
                    items={chatScheduled.items}
                    chatID={chatID}
                    threadRootID={threadRootID}
                    onOpen={(item) =>
                      router.push(
                        `/chat/${chatID}/scheduled?focus=${encodeURIComponent(item.id)}`,
                      )
                    }
                  />
                  {conversation.streams.map((stream) => (
                    <AgentStreamRow
                      key={stream.streamID}
                      body={stream.body}
                      author={memberOf(stream.actorID)}
                      state={
                        agents.find((status) => status.runID === stream.runID)
                          ?.state ?? "streaming"
                      }
                    />
                  ))}
                </>
              }
              ListEmptyComponent={
                inThread ? null : (
                  <Text tone="muted" size={15} style={styles.empty}>
                    {t("noMessages")}
                  </Text>
                )
              }
              renderItem={({ item, index }) => {
                const { message } = item;
                const quoted = message.reply_to_id
                  ? conversation.messages.find(
                      (other) => other.id === message.reply_to_id,
                    )
                  : undefined;
                return (
                  <View>
                    {item.newDay && daySeparator(message.created_at)}
                    {item.firstUnread && (
                      <View style={styles.unread}>
                        <View
                          style={[
                            styles.line,
                            { backgroundColor: theme.primary },
                          ]}
                        />
                        <Text tone="primary" size={12} weight="semibold">
                          {t("newMessages")}
                        </Text>
                        <View
                          style={[
                            styles.line,
                            { backgroundColor: theme.primary },
                          ]}
                        />
                      </View>
                    )}
                    <RowBoundary
                      kind="message"
                      resetKey={message}
                      testID={`message-render-failed-${index}`}
                    >
                      <MessageRow
                        api={api}
                        ownID={user.id}
                        message={message}
                        author={memberOf(message.actor_id)}
                        placement={bubblePlacement(
                          feed,
                          index,
                          user.id,
                          groupChat,
                          inThread && index === 0,
                        )}
                        quoted={quoted}
                        quotedAuthor={
                          quoted ? authorName(quoted.actor_id) : undefined
                        }
                        showThread={!inThread}
                        pinned={pinnedIDs.has(message.id)}
                        saved={savedIDs.has(message.id)}
                        highlighted={message.id === highlighted}
                        onReply={reply}
                        onThread={openThread}
                        onActions={setMenuFor}
                        onRetry={conversation.retryOutbox}
                        members={members}
                        viewer={viewer}
                        onUpdated={conversation.applyMessage}
                      />
                    </RowBoundary>
                  </View>
                );
              }}
            />
          )}
          {showJump && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("scrollToBottom")}
              onPress={jumpToBottom}
              style={[
                styles.jump,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              <ArrowDown size={20} color={theme.foreground} />
            </Pressable>
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
        </View>
        <Composer
          body={context?.kind === "edit" ? editBody : conversation.body}
          onChangeBody={
            context?.kind === "edit" ? setEditBody : conversation.changeBody
          }
          onSend={() => void sendOrSave()}
          members={members.filter((member) => member.actor_id !== user.id)}
          context={composerContext}
          onCancelContext={() => setContext(null)}
          readonly={conversation.readonly}
          placeholder={inThread ? t("threadPlaceholder") : undefined}
          attachments={attachments.items}
          onMore={() => setMoreOpen(true)}
          onRemoveAttachment={attachments.remove}
          onRetryAttachment={attachments.retry}
          commands={inThread || context?.kind === "edit" ? [] : commands}
          focusRequest={focusRequest}
          onSendOptions={scheduling.openOptions}
          voice={{
            chatID,
            threadRootID,
            replyToID: context?.kind === "reply" ? context.message.id : null,
            onQueued: () => {
              setContext(null);
              list.current?.scrollToEnd({ animated: true });
            },
          }}
        />
      </KeyboardAvoidingView>
      <ComposerSheet
        visible={moreOpen}
        actions={composerActions}
        onClose={() => setMoreOpen(false)}
      />
      {scheduling.layer}
      <AgentPicker
        visible={agentsOpen}
        agents={agentMembers}
        onPick={callAgent}
        onClose={() => setAgentsOpen(false)}
      />
      <MessageMenu
        visible={menuFor !== null}
        own={menuFor?.actor_id === user.id}
        preview={
          menuFor ? (
            <MessageBubble
              preview
              api={api}
              ownID={user.id}
              message={menuFor}
              author={memberOf(menuFor.actor_id)}
              placement={placementOf(menuFor)}
              quoted={
                menuFor.reply_to_id
                  ? conversation.messages.find(
                      (other) => other.id === menuFor.reply_to_id,
                    )
                  : undefined
              }
              quotedAuthor={(() => {
                const quoted = conversation.messages.find(
                  (other) => other.id === menuFor.reply_to_id,
                );
                return quoted ? authorName(quoted.actor_id) : undefined;
              })()}
              showThread={!inThread}
              pinned={pinnedIDs.has(menuFor.id)}
              saved={savedIDs.has(menuFor.id)}
              members={members}
              viewer={viewer}
              onThread={openThread}
              onActions={() => undefined}
              onRetry={conversation.retryOutbox}
            />
          ) : null
        }
        sections={menuSections}
        canReact={menuPersisted && !menuFor?.deleted_at}
        ownReactions={(menuReactions.data ?? [])
          .filter((reaction) => reaction.actor_id === user.id)
          .map((reaction) => reaction.emoji)}
        onReact={(emoji) => {
          const message = menuFor;
          setMenuFor(null);
          if (!message) return;
          void Haptics.selectionAsync();
          void toggleReaction(
            api,
            queryClient,
            message.id,
            emoji,
            user.id,
          ).catch(() => Alert.alert(t("actionFailed")));
        }}
        onAction={act}
        onClose={() => setMenuFor(null)}
      />
      <ForwardSheet
        message={forwarding}
        authorName={forwarding ? authorName(forwarding.actor_id) : ""}
        chatName={title}
        onClose={() => setForwarding(null)}
        onDone={setNotice}
      />
      <MessageDetailsSheet
        message={detailsFor}
        members={members}
        onClose={() => setDetailsFor(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grow: { flex: 1 },
  center: { marginTop: spacing[10] },
  state: { padding: spacing[5] },
  feed: { paddingTop: spacing[2], paddingBottom: 6 },
  empty: { textAlign: "center", padding: spacing[6] },
  dayRow: {
    alignItems: "center",
    marginTop: spacing[2],
    marginBottom: spacing[1],
  },
  day: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 3 },
  unread: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  threadDivider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 14,
    marginTop: spacing[1],
    marginBottom: 2,
  },
  line: { flex: 1, height: 1 },
  jump: {
    position: "absolute",
    right: spacing[3],
    bottom: spacing[3],
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  notice: {
    position: "absolute",
    alignSelf: "center",
    bottom: spacing[3],
    borderRadius: 18,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    maxWidth: "90%",
  },
});
