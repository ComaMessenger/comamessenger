import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useTranslation } from "react-i18next";
import {
  formatDaySeparator,
  renderableBlocks,
  type ActionViewer,
  type ChatMember,
  type ClientMessage,
  type Message,
  type MessengerAPI,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/ui/Avatar";
import { Text } from "@/ui/Text";
import { AgentWhy } from "./AgentWhy";
import { Markdown } from "./Markdown";
import { MessageBlocks } from "./MessageBlocks";
import { MessageFiles } from "./MessageFiles";
import { formatTime } from "./MessageRow";
import { useReactions } from "./reactions";

/** The message a thread grew from, pinned on white above the replies. */
export function ThreadRoot({
  api,
  ownID,
  message,
  author,
  members,
  viewer,
  onActions,
  onUpdated,
}: {
  api: MessengerAPI;
  ownID: string;
  message: ClientMessage;
  author?: ChatMember;
  members: ChatMember[];
  viewer: ActionViewer;
  onActions(message: ClientMessage): void;
  onUpdated(message: Message): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { height } = useWindowDimensions();
  const reactions = useReactions(api, message, ownID);
  const own = message.actor_id === ownID;
  const name =
    author?.display_name ?? (own ? t("previewYou") : t("participant"));
  const deleted = Boolean(message.deleted_at);
  const blocks = deleted ? null : renderableBlocks(message);
  const day = formatDaySeparator(message.created_at, i18n.language, {
    today: t("today"),
    yesterday: t("yesterday"),
  });
  const when = t("dayAtTime", {
    day: i18n.language === "ru" ? day.toLowerCase() : day,
    time: formatTime(message.created_at, i18n.language),
  });
  return (
    <View
      testID="thread-root"
      style={[
        styles.root,
        { backgroundColor: theme.surface, borderBottomColor: theme.border },
      ]}
    >
      <ScrollView style={{ maxHeight: height * 0.35 }} bounces={false}>
        <Pressable
          accessibilityHint={t("messageActions")}
          accessibilityActions={[
            { name: "longpress", label: t("messageActions") },
          ]}
          onAccessibilityAction={() => onActions(message)}
          delayLongPress={350}
          onLongPress={() => {
            if (deleted) return;
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onActions(message);
          }}
          style={styles.content}
        >
          <View style={styles.head}>
            <Avatar
              name={name}
              seed={message.actor_id}
              size={36}
              agent={author?.type === "agent"}
              actorID={message.actor_id}
              avatarVersion={author?.avatar_version}
            />
            <View style={styles.shrink}>
              <Text weight="semibold" size={14.5} numberOfLines={1}>
                {name}
              </Text>
              <Text tone="muted" size={12}>
                {when}
              </Text>
            </View>
          </View>
          {deleted ? (
            <Text tone="muted" size={15} style={styles.italic}>
              {t("messageDeleted")}
            </Text>
          ) : (
            !blocks?.card &&
            Boolean(message.body.trim()) && <Markdown source={message.body} />
          )}
          {blocks && (
            <MessageBlocks
              api={api}
              message={message}
              blocks={blocks}
              members={members}
              authorName={name}
              viewer={viewer}
              onUpdated={onUpdated}
            />
          )}
          {!deleted && message.files.length > 0 && (
            <MessageFiles api={api} files={message.files} />
          )}
          {!deleted && <AgentWhy provenance={message.agent_provenance} />}
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
                  style={[
                    styles.chip,
                    {
                      backgroundColor: group.own
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
                    tone={group.own ? "primary" : "default"}
                  >
                    {group.count}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { borderBottomWidth: 1 },
  content: {
    paddingHorizontal: 14,
    paddingVertical: spacing[3],
    gap: 6,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 9 },
  shrink: { flexShrink: 1 },
  italic: { fontStyle: "italic" },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 2 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 11,
  },
});
