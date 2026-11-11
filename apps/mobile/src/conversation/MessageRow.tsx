import { memo, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import * as Haptics from "expo-haptics";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Clock3,
  CornerUpLeft,
  Forward,
  MessagesSquare,
  Pin,
  RefreshCw,
  Star,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  messagePlainText,
  renderableBlocks,
  type ActionViewer,
  type ChatMember,
  type ClientMessage,
  type Message,
  type MessengerAPI,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Avatar, avatarColors } from "@/ui/Avatar";
import { AvatarStack } from "@/ui/AvatarStack";
import { Text } from "@/ui/Text";
import { Markdown } from "./Markdown";
import { playableVoice } from "@/voice/model";
import { MessageFiles } from "./MessageFiles";
import { MessageBlocks } from "./MessageBlocks";
import { AgentWhy } from "./AgentWhy";
import { useReactions } from "./reactions";
import { bubbleCorners, messageMarks, type BubblePlacement } from "./bubbles";
import { useThreadPreview } from "./useThreadPreview";

const avatarSize = 30;

export type MessageBubbleProps = {
  api: MessengerAPI;
  ownID: string;
  message: ClientMessage;
  author?: ChatMember;
  placement: BubblePlacement;
  quoted?: ClientMessage;
  quotedAuthor?: string;
  showThread: boolean;
  /** Pinned in the chat: a pin by the time, seen by every member. */
  pinned?: boolean;
  /** The reader saved it to their own «Important»: a star by the time. */
  saved?: boolean;
  highlighted?: boolean;
  onThread(message: ClientMessage): void;
  onActions(message: ClientMessage): void;
  onRetry(): void;
  /** Chat members, to name who answered a card and who replied in a thread. */
  members?: ChatMember[];
  /** The reader, to show which card buttons they may press. */
  viewer?: ActionViewer;
  onUpdated?(message: Message): void;
  /** A still copy for the long-press menu: nothing inside reacts to touch. */
  preview?: boolean;
};

export type MessageRowProps = MessageBubbleProps & {
  onReply(message: ClientMessage): void;
};

export function formatTime(iso: string, language: string) {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** A message in the feed: a bubble with swipe-to-reply. */
export const MessageRow = memo(function MessageRow({
  onReply,
  ...props
}: MessageRowProps) {
  const theme = useTheme();
  const swipeable = useRef<SwipeableMethods>(null);
  const { message } = props;
  const actionable = !message.deleted_at && message.delivery !== "sending";
  return (
    <ReanimatedSwipeable
      ref={swipeable}
      enabled={actionable}
      friction={2}
      rightThreshold={56}
      overshootRight={false}
      renderRightActions={() => (
        <View style={styles.swipeAction}>
          <CornerUpLeft size={22} color={theme.primary} />
        </View>
      )}
      onSwipeableWillOpen={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onReply(message);
        swipeable.current?.close();
      }}
    >
      <MessageBubble {...props} onReply={onReply} />
    </ReanimatedSwipeable>
  );
});

/**
 * One message as a bubble: the reader's own on the right in `own`, other
 * people's on the left on `surface`. Name, quote, text, cards, files, time
 * and delivery, reactions and the thread caption all live inside it.
 */
export function MessageBubble({
  api,
  ownID,
  message,
  author,
  placement,
  quoted,
  quotedAuthor,
  showThread,
  pinned = false,
  saved = false,
  highlighted = false,
  onThread,
  onActions,
  onRetry,
  onReply,
  members = [],
  viewer,
  onUpdated,
  preview = false,
}: MessageBubbleProps & { onReply?(message: ClientMessage): void }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const reactions = useReactions(api, message, ownID);
  const own = placement.own;
  const name =
    author?.display_name ?? (own ? t("previewYou") : t("participant"));
  const agent = author?.type === "agent";
  const deleted = Boolean(message.deleted_at);
  const time = formatTime(message.created_at, i18n.language);
  const actionable = !deleted && message.delivery !== "sending";
  // Unknown block versions fall back to the body; a card replaces its fallback text.
  const blocks = viewer && !deleted ? renderableBlocks(message) : null;
  const files = deleted ? [] : message.files;
  // A lone voice message is as wide as its player (prototype `.voice`),
  // its time in the player's row; other attachments widen the bubble.
  const voiceOnly =
    files.length === 1 &&
    playableVoice(files[0]!) !== null &&
    !blocks &&
    !message.body.trim();
  const wide = Boolean(blocks) || (files.length > 0 && !voiceOnly);
  // Photos run edge to edge of the bubble, without a coloured frame; a
  // message of photos only carries its time on the last one.
  const images = files.filter(
    (file) => file.mime.startsWith("image/") && file.status === "ready",
  );
  const photosOnly =
    images.length > 0 &&
    images.length === files.length &&
    !blocks &&
    !message.body.trim();
  const thread = useThreadPreview(message, showThread);
  const hasThread = showThread && message.thread_reply_count > 0 && !deleted;
  const muted = own ? theme.ownMuted : theme.muted;
  const accent = own ? theme.onOwn : theme.primary;
  const background = own ? theme.own : theme.surface;
  const nameColor = agent
    ? theme.primary
    : avatarColors(theme, message.actor_id).foreground;

  // Nested buttons (thread caption, reactions) pass a long press on to the
  // menu; without it the release would count as a tap on them.
  const openActions = () => {
    if (!actionable || preview) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onActions(message);
  };

  const status =
    message.delivery === "sending"
      ? {
          label: t("deliverySending"),
          icon: <Clock3 size={13} color={muted} />,
        }
      : message.delivery === "retrying"
        ? { label: t("retrying"), icon: <RefreshCw size={13} color={muted} /> }
        : message.delivery === "failed"
          ? {
              label: t("notSent"),
              icon: (
                <AlertCircle
                  size={13}
                  color={own ? theme.onOwn : theme.danger}
                />
              ),
            }
          : own
            ? {
                label: t("deliverySent"),
                icon: <Check size={14} color={muted} />,
              }
            : null;
  const marks = messageMarks({ pinned, saved, deleted: Boolean(deleted) });
  const meta = (
    <View
      accessible
      accessibilityLabel={[
        marks.includes("pin") ? t("pinnedMark") : null,
        marks.includes("star") ? t("savedMark") : null,
        message.edited_at && !deleted ? t("edited") : null,
        time,
        status?.label,
      ]
        .filter(Boolean)
        .join(", ")}
      style={styles.meta}
    >
      {marks.includes("pin") && <Pin size={12} color={muted} />}
      {marks.includes("star") && (
        <Star size={12} color={theme.warning} fill={theme.warning} />
      )}
      {message.edited_at && !deleted ? (
        <Text size={11} style={{ color: muted }}>
          {t("edited")}
        </Text>
      ) : null}
      <Text size={11} style={[styles.tabular, { color: muted }]}>
        {time}
      </Text>
      {status?.icon}
    </View>
  );
  const inlineMeta = !wide && !message.agent_provenance && !voiceOnly;
  const photoTop =
    photosOnly &&
    !placement.showName &&
    !message.forwarded_from &&
    !message.reply_to_id;
  const photoBottom =
    photosOnly &&
    !message.agent_provenance &&
    reactions.groups.length === 0 &&
    !hasThread;
  const photoMeta = photosOnly ? (
    <View
      accessible
      accessibilityLabel={[time, status?.label].filter(Boolean).join(", ")}
      style={styles.photoMeta}
    >
      {marks.includes("pin") && <Pin size={12} color="#ffffff" />}
      {marks.includes("star") && (
        <Star size={12} color={theme.warning} fill={theme.warning} />
      )}
      <Text size={11} style={[styles.tabular, styles.photoMetaText]}>
        {time}
      </Text>
      {own && message.delivery !== "failed" ? (
        <Check size={13} color="#ffffff" />
      ) : (
        status?.icon
      )}
    </View>
  ) : null;

  let body: ReactNode = null;
  if (deleted)
    body = (
      <Text size={15} style={[styles.italic, { color: muted }]}>
        {t("messageDeleted")}
      </Text>
    );
  else if (!blocks?.card && message.body.trim())
    body = <Markdown source={message.body} own={own} />;

  const bubble = (
    <View
      style={[
        styles.bubble,
        wide && styles.wideBubble,
        bubbleCorners(placement, radius.bubble, radius.sm),
        images.length > 0 && styles.clip,
        {
          backgroundColor: background,
          borderColor: highlighted
            ? theme.primary
            : own
              ? "transparent"
              : theme.border,
        },
      ]}
    >
      {placement.showName && (
        <View style={styles.name}>
          <Text
            weight="semibold"
            size={12.5}
            numberOfLines={1}
            style={[styles.shrink, { color: nameColor }]}
          >
            {name}
          </Text>
          {agent && (
            <View style={[styles.tag, { backgroundColor: theme.primarySoft }]}>
              <Text
                weight="semibold"
                size={10.5}
                tone="primary"
                style={styles.tagText}
              >
                {t("agentTag")}
              </Text>
            </View>
          )}
        </View>
      )}
      {message.forwarded_from && !deleted && (
        <View style={styles.inline}>
          <Forward size={14} color={muted} />
          <Text
            size={13}
            numberOfLines={1}
            style={[styles.shrink, { color: muted }]}
          >
            {t("forwardedFrom", { name: message.forwarded_from.author_name })}
          </Text>
        </View>
      )}
      {message.reply_to_id && !deleted && (
        <View style={[styles.quote, { borderLeftColor: accent }]}>
          <Text
            weight="semibold"
            size={12.5}
            numberOfLines={1}
            style={{ color: accent }}
          >
            {quotedAuthor ?? t("reply")}
          </Text>
          <Text size={13} numberOfLines={2} style={{ color: muted }}>
            {quoted ? messagePlainText(quoted.body) : "…"}
          </Text>
        </View>
      )}
      {inlineMeta ? (
        <View style={styles.textWithMeta}>
          {body ? <View style={styles.shrink}>{body}</View> : null}
          {meta}
        </View>
      ) : (
        body
      )}
      {blocks && viewer && (
        <MessageBlocks
          api={api}
          message={message}
          blocks={blocks}
          members={members}
          authorName={name}
          viewer={viewer}
          onUpdated={(updated) => onUpdated?.(updated)}
        />
      )}
      {files.length > 0 && (
        <MessageFiles
          api={api}
          files={files}
          own={own}
          bleed={
            images.length > 0
              ? { top: photoTop, bottom: photoBottom }
              : undefined
          }
          overlay={photoMeta}
          voiceMeta={voiceOnly ? meta : undefined}
        />
      )}
      {!deleted && <AgentWhy provenance={message.agent_provenance} />}
      {!inlineMeta && !photosOnly && !voiceOnly && (
        <View style={styles.metaEnd}>{meta}</View>
      )}
      {reactions.groups.length > 0 && !deleted && (
        <View style={styles.reactions}>
          {reactions.groups.map((group) => (
            <Pressable
              key={group.emoji}
              accessibilityRole="button"
              accessibilityState={{ selected: group.own }}
              accessibilityLabel={t("reactionCount", group)}
              hitSlop={{ top: 10, bottom: 10, left: 3, right: 3 }}
              onPress={() =>
                void reactions.toggle(group.emoji).catch(() => undefined)
              }
              onLongPress={openActions}
              style={[
                styles.chip,
                {
                  backgroundColor: own
                    ? group.own
                      ? theme.onOwn
                      : theme.ownTrack
                    : group.own
                      ? theme.primarySoft
                      : theme.surfaceSelected,
                },
              ]}
            >
              <Text size={13} allowFontScaling={false}>
                {group.emoji}
              </Text>
              <Text
                weight="semibold"
                size={12.5}
                style={{
                  color: own
                    ? group.own
                      ? theme.own
                      : theme.onOwn
                    : group.own
                      ? theme.primary
                      : theme.foreground,
                }}
              >
                {group.count}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {hasThread && (
        <Pressable
          testID="thread-caption"
          accessibilityRole="button"
          accessibilityHint={t("threadOpen")}
          accessibilityLabel={[
            t("threadReplies", { count: message.thread_reply_count }),
            thread.lastReplyAt
              ? t("threadLastReply", {
                  time: formatTime(thread.lastReplyAt, i18n.language),
                })
              : null,
          ]
            .filter(Boolean)
            .join(", ")}
          hitSlop={{ top: 4, bottom: 8 }}
          onPress={() => onThread(message)}
          onLongPress={openActions}
          style={[
            styles.thread,
            { borderTopColor: own ? theme.ownTrack : theme.border },
          ]}
        >
          {thread.participantIDs.length > 0 ? (
            <AvatarStack
              actorIDs={thread.participantIDs}
              members={members}
              ring={background}
            />
          ) : (
            <MessagesSquare size={16} color={accent} />
          )}
          <Text
            weight="semibold"
            size={13}
            numberOfLines={1}
            style={{ color: accent }}
          >
            {t("threadReplies", { count: message.thread_reply_count })}
          </Text>
          {thread.lastReplyAt && (
            <Text
              size={12}
              numberOfLines={1}
              style={[styles.shrink, { color: muted }]}
            >
              {t("threadLastReply", {
                time: formatTime(thread.lastReplyAt, i18n.language),
              })}
            </Text>
          )}
          <ChevronRight size={15} color={muted} style={styles.chevron} />
        </Pressable>
      )}
    </View>
  );

  return (
    <View
      style={[
        styles.row,
        own ? styles.rowOwn : null,
        { marginTop: placement.first ? 6 : 2 },
        highlighted && { backgroundColor: theme.primarySoft },
      ]}
    >
      <View
        style={[styles.lane, wide && styles.wideLane, own && styles.laneOwn]}
      >
        {placement.avatarColumn && (
          <View style={styles.gutter}>
            {placement.showAvatar && (
              <Avatar
                name={name}
                seed={message.actor_id}
                size={avatarSize}
                agent={agent}
                actorID={message.actor_id}
                avatarVersion={author?.avatar_version}
              />
            )}
          </View>
        )}
        {preview ? (
          <View
            pointerEvents="none"
            style={[styles.pressable, wide && styles.grow]}
          >
            {bubble}
          </View>
        ) : (
          <Pressable
            accessibilityHint={t("messageActions")}
            accessibilityActions={[
              { name: "longpress", label: t("messageActions") },
              ...(actionable && onReply
                ? [{ name: "reply", label: t("reply") }]
                : []),
              ...(hasThread
                ? [{ name: "thread", label: t("threadOpen") }]
                : []),
            ]}
            onAccessibilityAction={(event) => {
              const action = event.nativeEvent.actionName;
              if (action === "longpress") openActions();
              else if (action === "reply") onReply?.(message);
              else if (action === "thread") onThread(message);
            }}
            delayLongPress={350}
            onLongPress={openActions}
            style={({ pressed }) => [
              styles.pressable,
              wide && styles.grow,
              { opacity: pressed && actionable ? 0.85 : 1 },
            ]}
          >
            {bubble}
          </Pressable>
        )}
      </View>
      {message.delivery === "failed" && !preview && (
        <View
          style={[
            styles.failed,
            own && styles.laneOwn,
            placement.avatarColumn && styles.failedOther,
          ]}
        >
          <AlertCircle size={14} color={theme.danger} />
          <Text tone="danger" size={13}>
            {t("notSent")}
          </Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            style={styles.retry}
            onPress={onRetry}
          >
            <Text tone="primary" weight="semibold" size={13}>
              {t("retry")}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 10 },
  rowOwn: { alignItems: "flex-end" },
  lane: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 7,
    maxWidth: "86%",
  },
  wideLane: { width: "86%" },
  laneOwn: { alignSelf: "flex-end" },
  gutter: { width: avatarSize },
  pressable: { flexShrink: 1 },
  grow: { flex: 1 },
  bubble: {
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingTop: 7,
    paddingBottom: 6,
    gap: spacing[1],
  },
  wideBubble: { alignSelf: "stretch" },
  clip: { overflow: "hidden" },
  photoMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
    // A scrim over any photo, in both themes.
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  photoMetaText: { color: "#ffffff" },
  name: { flexDirection: "row", alignItems: "center", gap: 5 },
  shrink: { flexShrink: 1 },
  tag: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
  tagText: { letterSpacing: 0.2, textTransform: "uppercase" },
  inline: { flexDirection: "row", alignItems: "center", gap: spacing[1] },
  quote: { borderLeftWidth: 3, paddingLeft: spacing[2], paddingVertical: 1 },
  italic: { fontStyle: "italic" },
  textWithMeta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-end",
    columnGap: 10,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginLeft: "auto",
    paddingBottom: 1,
  },
  metaEnd: { flexDirection: "row" },
  tabular: { fontVariant: ["tabular-nums"] },
  reactions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 2,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 11,
  },
  thread: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 3,
    paddingTop: 7,
    borderTopWidth: 1,
  },
  chevron: { marginLeft: "auto" },
  failed: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[1],
    marginTop: 2,
  },
  failedOther: { marginLeft: avatarSize + 7 },
  retry: {
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: spacing[1],
  },
  swipeAction: { width: 64, alignItems: "center", justifyContent: "center" },
});
