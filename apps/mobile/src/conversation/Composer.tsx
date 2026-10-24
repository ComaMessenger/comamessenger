import { useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import {
  ArrowUp,
  Check,
  FileText,
  Paperclip,
  RotateCw,
  X,
} from "lucide-react-native";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import {
  decodeMentions,
  encodeMentions,
  insertMention,
  updateMentionText,
  type ChatMember,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/ui/Avatar";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import type { Attachment } from "@/files/useAttachments";

const inputMinHeight = 52;
const inputMaxHeight = 140;

export type ComposerContext =
  | { kind: "reply"; author: string; text: string }
  | { kind: "edit"; text: string };

/**
 * Message input. `body` is the encoded form with structured mentions; the
 * user edits plain text and mentions survive edits around them.
 */
export function Composer({
  body,
  onChangeBody,
  onSend,
  members,
  context,
  onCancelContext,
  readonly,
  placeholder,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  onRetryAttachment,
}: {
  body: string;
  onChangeBody(body: string): void;
  onSend(): void;
  members: ChatMember[];
  context: ComposerContext | null;
  onCancelContext(): void;
  readonly: boolean;
  placeholder?: string;
  attachments?: Attachment[];
  onAttach?(): void;
  onRemoveAttachment?(id: string): void;
  onRetryAttachment?(id: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const draft = useMemo(() => decodeMentions(body), [body]);
  const { fontScale } = useWindowDimensions();
  const emptyHeight = Math.max(
    inputMinHeight,
    Math.ceil(22 * Math.min(fontScale, maxTextScale)) + spacing[6],
  );
  const uploading = attachments.some((item) => item.status === "uploading");
  const canSend =
    (Boolean(draft.text.trim()) ||
      attachments.some((item) => item.status === "ready")) &&
    !uploading;

  const mention = /@([\p{L}\p{N}_.-]*)$/u.exec(draft.text);
  const query = mention?.[1]?.toLowerCase() ?? "";
  const suggestions = mention
    ? members
        .filter(
          (member) =>
            member.display_name.toLowerCase().includes(query) ||
            member.handle.toLowerCase().includes(query),
        )
        .slice(0, 5)
    : [];

  if (readonly)
    return (
      <View style={[styles.readonly, { borderTopColor: theme.border }]}>
        <Text tone="muted" size={14} style={styles.center}>
          {t("channelReadOnly")}
        </Text>
      </View>
    );

  function pick(member: ChatMember) {
    if (!mention) return;
    const next = insertMention(
      draft,
      mention.index,
      draft.text.length,
      member.actor_id,
      member.display_name,
    );
    onChangeBody(encodeMentions(next));
    input.current?.focus();
  }

  return (
    <View style={styles.wrap}>
      {suggestions.length > 0 && (
        <ScrollView
          keyboardShouldPersistTaps="always"
          style={[
            styles.suggestions,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}
        >
          {suggestions.map((member) => (
            <Pressable
              key={member.actor_id}
              accessibilityRole="button"
              onPress={() => pick(member)}
              style={({ pressed }) => [
                styles.suggestion,
                pressed && { backgroundColor: theme.surfaceSelected },
              ]}
            >
              <Avatar
                name={member.display_name}
                seed={member.actor_id}
                size={28}
                agent={member.type === "agent"}
                actorID={member.actor_id}
                avatarVersion={member.avatar_version}
              />
              <Text
                weight="medium"
                size={15}
                numberOfLines={1}
                style={styles.grow}
              >
                {member.display_name}
              </Text>
              <Text
                tone="subtle"
                size={14}
                numberOfLines={1}
                style={styles.handle}
              >
                @{member.handle}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.surface,
            borderColor: focused ? theme.primary : theme.borderStrong,
          },
        ]}
      >
        {context && (
          <View style={[styles.context, { borderLeftColor: theme.primary }]}>
            <View style={styles.grow}>
              <Text
                weight="semibold"
                size={13}
                tone="primary"
                numberOfLines={1}
              >
                {context.kind === "reply"
                  ? t("replyingTo", { name: context.author })
                  : t("editingMessage")}
              </Text>
              <Text tone="muted" size={13} numberOfLines={1}>
                {context.text}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("cancelReply")}
              style={styles.cancel}
              onPress={onCancelContext}
            >
              <X size={18} color={theme.subtle} />
            </Pressable>
          </View>
        )}
        {attachments.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.attachments}
          >
            {attachments.map((item) => {
              const image = item.local.mime.startsWith("image/");
              return (
                <View
                  key={item.id}
                  style={[
                    styles.attachment,
                    {
                      backgroundColor: theme.sidebar,
                      borderColor:
                        item.status === "failed" ? theme.danger : theme.border,
                    },
                  ]}
                >
                  {image ? (
                    <Image
                      source={{ uri: item.local.uri }}
                      contentFit="cover"
                      style={StyleSheet.absoluteFill}
                    />
                  ) : (
                    <View style={styles.attachmentFile}>
                      <FileText size={18} color={theme.muted} />
                      <Text size={11} numberOfLines={2} style={styles.center}>
                        {item.local.name}
                      </Text>
                    </View>
                  )}
                  {item.status === "uploading" && (
                    <View
                      style={[
                        styles.progress,
                        { backgroundColor: theme.overlay },
                      ]}
                    >
                      <Text
                        size={12}
                        weight="semibold"
                        style={{ color: "#ffffff" }}
                      >
                        {Math.round(item.progress * 100)}%
                      </Text>
                    </View>
                  )}
                  {item.status === "failed" && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("retry")}
                      onPress={() => onRetryAttachment?.(item.id)}
                      style={[
                        styles.progress,
                        { backgroundColor: theme.overlay },
                      ]}
                    >
                      <RotateCw size={18} color="#ffffff" />
                    </Pressable>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("removeAttachment")}
                    onPress={() => onRemoveAttachment?.(item.id)}
                    style={[
                      styles.remove,
                      { backgroundColor: theme.foreground },
                    ]}
                  >
                    <X size={16} color={theme.canvas} />
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>
        )}
        <TextInput
          ref={input}
          testID="composer-input"
          value={draft.text}
          onChangeText={(text) =>
            onChangeBody(encodeMentions(updateMentionText(draft, text)))
          }
          placeholder={placeholder ?? t("messagePlaceholder")}
          placeholderTextColor={theme.subtle}
          accessibilityLabel={placeholder ?? t("messagePlaceholder")}
          selectionColor={theme.primary}
          multiline
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          maxFontSizeMultiplier={maxTextScale}
          style={[
            styles.input,
            { color: theme.foreground },
            // iOS keeps a multiline input at its tallest size after the
            // text is cleared; an empty field is pinned back to one line.
            !draft.text && { height: emptyHeight },
          ]}
        />
        <View
          style={[
            styles.toolbar,
            { backgroundColor: theme.sidebar, borderTopColor: theme.border },
          ]}
        >
          <View style={styles.tools}>
            {onAttach && context?.kind !== "edit" && (
              <Pressable
                testID="composer-attach"
                accessibilityRole="button"
                accessibilityLabel={t("attach")}
                hitSlop={6}
                onPress={onAttach}
                style={styles.attach}
              >
                <Paperclip size={22} color={theme.muted} />
              </Pressable>
            )}
          </View>
          <Pressable
            testID="composer-send"
            accessibilityRole="button"
            accessibilityLabel={
              context?.kind === "edit" ? t("save") : t("send")
            }
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={onSend}
            style={({ pressed }) => [
              styles.send,
              {
                backgroundColor: canSend
                  ? pressed
                    ? theme.actionHover
                    : theme.action
                  : theme.surfaceSelected,
              },
            ]}
          >
            <Text
              size={14}
              weight="medium"
              style={{ color: canSend ? theme.onAction : theme.subtle }}
            >
              {context?.kind === "edit" ? t("save") : t("send")}
            </Text>
            {context?.kind === "edit" ? (
              <Check
                size={20}
                color={canSend ? theme.onAction : theme.subtle}
              />
            ) : (
              <ArrowUp
                size={20}
                color={canSend ? theme.onAction : theme.subtle}
              />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing[3],
    paddingBottom: spacing[2],
    paddingTop: spacing[1],
  },
  card: {
    borderWidth: 1,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  context: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    borderLeftWidth: 2,
    paddingLeft: spacing[2],
    marginTop: spacing[3],
    marginHorizontal: spacing[3],
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    padding: spacing[1],
    gap: spacing[2],
  },
  tools: { flexDirection: "row", alignItems: "center" },
  handle: { maxWidth: "45%", flexShrink: 1 },
  cancel: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    fontFamily: fonts.regular,
    fontSize: 16,
    minHeight: inputMinHeight,
    maxHeight: inputMaxHeight,
    paddingHorizontal: spacing[3],
    paddingTop: spacing[3],
    paddingBottom: spacing[3],
    textAlignVertical: "top",
  },
  send: {
    flexDirection: "row",
    minHeight: 44,
    paddingHorizontal: spacing[3],
    gap: spacing[2],
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  suggestions: {
    maxHeight: 220,
    borderWidth: 1,
    borderRadius: radius.lg,
    marginBottom: spacing[2],
  },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    minHeight: 44,
  },
  grow: { flex: 1 },
  readonly: { padding: spacing[4], borderTopWidth: StyleSheet.hairlineWidth },
  attach: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  attachments: {
    gap: spacing[2],
    paddingTop: spacing[3],
    paddingHorizontal: spacing[3],
  },
  attachment: {
    width: 88,
    height: 88,
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: "hidden",
  },
  attachmentFile: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    padding: 4,
  },
  progress: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  remove: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 44,
    height: 44,
    borderBottomLeftRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  center: { textAlign: "center" },
});
