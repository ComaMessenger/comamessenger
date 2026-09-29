import { useCallback, useEffect, useRef, useState } from "react";
import {
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
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ChevronLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  decodeMentions,
  formatDaySeparator,
  messagePlainText,
  type ClientMessage,
  type FeedRow,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { chatTitle } from "@/chats/ChatRow";
import { Avatar } from "@/ui/Avatar";
import { Notice } from "@/ui/Notice";
import { Text } from "@/ui/Text";
import { ConnectionBanner } from "@/messenger/ConnectionBanner";
import { AgentStreamRow } from "./AgentStreamRow";
import { Composer, type ComposerContext } from "./Composer";
import { MessageActions, type MessageAction } from "./MessageActions";
import { MessageRow } from "./MessageRow";
import { toggleReaction } from "./reactions";
import { useConversation } from "./useConversation";
import { attachmentLimit, useAttachments } from "@/files/useAttachments";
import { pickFiles, type PickSource } from "@/files/pick";
import { ActionSheet } from "@/ui/ActionSheet";

type Context =
  | { kind: "reply"; message: ClientMessage }
  | { kind: "edit"; message: ClientMessage };

const bottomTolerance = 64;

/** Feed, header and composer of a chat, or of one thread when `threadRootID` is set. */
export function ConversationView({
  chatID,
  threadRootID,
}: {
  chatID: string;
  threadRootID: string | null;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const queryClient = useQueryClient();
  const conversation = useConversation(chatID, threadRootID);
  const { chat, members, rows, markRead } = conversation;
  const [context, setContext] = useState<Context | null>(null);
  const [editBody, setEditBody] = useState("");
  const [actionsFor, setActionsFor] = useState<ClientMessage | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [picking, setPicking] = useState(false);
  const attachments = useAttachments(api);
  const list = useRef<FlashListRef<FeedRow>>(null);
  const atBottom = useRef(true);
  const title = chat ? chatTitle(chat, t("directChat")) : "";
  const inThread = threadRootID !== null;

  const authorName = useCallback(
    (actorID: string) =>
      members.find((member) => member.actor_id === actorID)?.display_name ??
      (actorID === user.id ? t("previewYou") : t("participant")),
    [members, t, user.id],
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

  // A chat with unread messages opens on the first of them; reading them
  // (scrolling to the bottom) is what marks the chat read.
  const firstUnreadIndex = rows.findIndex((row) => row.firstUnread);
  const openedAt = useRef<number | null>(null);
  if (openedAt.current === null && rows.length && !conversation.loading) {
    openedAt.current = firstUnreadIndex;
    if (firstUnreadIndex >= 0) atBottom.current = false;
  }
  useEffect(() => {
    if (openedAt.current !== null && openedAt.current >= 0) setShowJump(true);
  }, [rows.length]);

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

  async function sendOrSave() {
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
    await conversation.send(replyTo, fileIDs);
    list.current?.scrollToEnd({ animated: true });
  }

  function act(action: MessageAction) {
    const message = actionsFor;
    setActionsFor(null);
    if (!message) return;
    if (action === "reply") setContext({ kind: "reply", message });
    else if (action === "thread") openThread(message);
    else if (action === "copy")
      void Clipboard.setStringAsync(messagePlainText(message.body));
    else if (action === "edit") {
      setEditBody(message.body);
      setContext({ kind: "edit", message });
    } else
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
  const subtitle = agents.length
    ? agents.length === 1
      ? t("agentWorking", { name: authorName(agents[0]!.actorID) })
      : t("agentsWorking", { count: agents.length })
    : conversation.typingNames.length
      ? conversation.typingNames.length === 1
        ? t("typingOne", { name: conversation.typingNames[0] })
        : t("typingMany", { count: conversation.typingNames.length })
      : inThread
        ? t("threadIn", { chat: title })
        : members.length
          ? t("headerMembers", { count: members.length })
          : "";
  const canModerate = conversation.canModerate;
  const actionsOwn = actionsFor?.actor_id === user.id;

  return (
    <SafeAreaView
      testID="conversation"
      edges={["top", "bottom"]}
      style={styles.screen}
    >
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable
          testID="conversation-back"
          accessibilityRole="button"
          accessibilityLabel={t("back")}
          hitSlop={12}
          onPress={() => router.back()}
        >
          <ChevronLeft size={28} color={theme.primary} />
        </Pressable>
        {chat && !inThread && (
          <Avatar
            name={title}
            seed={chat.avatar_seed || chat.id}
            size={36}
            glyph={chat.kind === "channel" ? "#" : undefined}
            agent={chat.direct_peer?.type === "agent"}
          />
        )}
        <View style={styles.grow}>
          <Text
            accessibilityRole="header"
            weight="semibold"
            size={17}
            numberOfLines={1}
          >
            {inThread ? t("threadTitle") : title}
          </Text>
          {subtitle ? (
            <Text
              tone={
                agents.length || conversation.typingNames.length
                  ? "primary"
                  : "muted"
              }
              size={13}
              numberOfLines={1}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      <ConnectionBanner />
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
              data={rows}
              keyExtractor={(row) =>
                row.message.client_msg_id || row.message.id
              }
              initialScrollIndex={
                openedAt.current !== null && openedAt.current > 0
                  ? openedAt.current
                  : undefined
              }
              maintainVisibleContentPosition={{
                startRenderingFromBottom: !(
                  openedAt.current !== null && openedAt.current > 0
                ),
                autoscrollToBottomThreshold: 0.2,
              }}
              onStartReached={() => void conversation.loadOlder()}
              onScroll={onScroll}
              scrollEventThrottle={100}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.feed}
              ListFooterComponent={
                <>
                  {conversation.streams.map((stream) => (
                    <AgentStreamRow
                      key={stream.streamID}
                      body={stream.body}
                      author={members.find(
                        (member) => member.actor_id === stream.actorID,
                      )}
                      state={
                        agents.find((status) => status.runID === stream.runID)
                          ?.state ?? "streaming"
                      }
                    />
                  ))}
                </>
              }
              ListEmptyComponent={
                <Text tone="muted" size={15} style={styles.empty}>
                  {t("noMessages")}
                </Text>
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
                    {item.newDay && (
                      <View style={styles.separator}>
                        <View
                          style={[
                            styles.line,
                            { backgroundColor: theme.border },
                          ]}
                        />
                        <Text tone="muted" size={13} weight="medium">
                          {formatDaySeparator(
                            message.created_at,
                            i18n.language,
                            {
                              today: t("today"),
                              yesterday: t("yesterday"),
                            },
                          )}
                        </Text>
                        <View
                          style={[
                            styles.line,
                            { backgroundColor: theme.border },
                          ]}
                        />
                      </View>
                    )}
                    {item.firstUnread && (
                      <View style={styles.separator}>
                        <View
                          style={[
                            styles.line,
                            { backgroundColor: theme.danger },
                          ]}
                        />
                        <Text tone="danger" size={13} weight="semibold">
                          {t("newMessages")}
                        </Text>
                        <View
                          style={[
                            styles.line,
                            { backgroundColor: theme.danger },
                          ]}
                        />
                      </View>
                    )}
                    <MessageRow
                      api={api}
                      ownID={user.id}
                      message={message}
                      author={members.find(
                        (member) => member.actor_id === message.actor_id,
                      )}
                      grouped={item.grouped && !(inThread && index === 1)}
                      quoted={quoted}
                      quotedAuthor={
                        quoted ? authorName(quoted.actor_id) : undefined
                      }
                      showThread={!inThread}
                      onReply={reply}
                      onThread={openThread}
                      onActions={setActionsFor}
                      onRetry={conversation.retryOutbox}
                    />
                    {inThread && index === 0 && (
                      <View style={styles.separator}>
                        <View
                          style={[
                            styles.line,
                            { backgroundColor: theme.border },
                          ]}
                        />
                        <Text tone="muted" size={13} weight="medium">
                          {t("threadReplies", { count: rows.length - 1 })}
                        </Text>
                        <View
                          style={[
                            styles.line,
                            { backgroundColor: theme.border },
                          ]}
                        />
                      </View>
                    )}
                  </View>
                );
              }}
            />
          )}
          {showJump && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("scrollToBottom")}
              onPress={() => list.current?.scrollToEnd({ animated: true })}
              style={[
                styles.jump,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              <ArrowDown size={20} color={theme.foreground} />
            </Pressable>
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
          attachments={attachments.items}
          onAttach={() => setPicking(true)}
          onRemoveAttachment={attachments.remove}
          onRetryAttachment={attachments.retry}
        />
      </KeyboardAvoidingView>
      <ActionSheet<PickSource>
        visible={picking}
        title={t("attach")}
        options={[
          { value: "photos", label: t("attachPhotos") },
          { value: "camera", label: t("attachCamera") },
          { value: "file", label: t("attachFile") },
        ]}
        onClose={() => setPicking(false)}
        onSelect={(source) => {
          setPicking(false);
          // iOS cannot present the system picker while our sheet is still dismissing.
          setTimeout(
            () =>
              void pickFiles(source, attachmentLimit - attachments.items.length)
                .then((files) => {
                  if (attachments.add(files) > 0)
                    Alert.alert(
                      t("attachmentLimit", { limit: attachmentLimit }),
                    );
                })
                .catch(() => Alert.alert(t("actionFailed"))),
            Platform.OS === "ios" ? 400 : 0,
          );
        }}
      />
      <MessageActions
        visible={actionsFor !== null}
        canThread={!inThread}
        canEdit={actionsOwn}
        canDelete={actionsOwn || canModerate}
        onReact={(emoji) => {
          const message = actionsFor;
          setActionsFor(null);
          if (message)
            void toggleReaction(
              api,
              queryClient,
              message.id,
              emoji,
              user.id,
            ).catch(() => Alert.alert(t("actionFailed")));
        }}
        onAction={act}
        onClose={() => setActionsFor(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  grow: { flex: 1 },
  center: { marginTop: spacing[10] },
  state: { padding: spacing[5] },
  feed: { paddingVertical: spacing[2] },
  empty: { textAlign: "center", padding: spacing[6] },
  separator: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  line: { flex: 1, height: 1 },
  jump: {
    position: "absolute",
    right: spacing[4],
    bottom: spacing[3],
    width: 44,
    height: 44,
    borderRadius: radius.full,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
