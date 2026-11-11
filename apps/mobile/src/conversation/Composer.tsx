import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
} from "react-native";
import {
  ArrowUp,
  Check,
  FileText,
  Plus,
  RotateCw,
  X,
} from "lucide-react-native";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import {
  commandQuery,
  decodeMentions,
  encodeMentions,
  insertMention,
  matchCommands,
  updateMentionText,
  type ChatCommand,
  type ChatMember,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/ui/Avatar";
import { IconButton } from "@/ui/IconButton";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import type { Attachment } from "@/files/useAttachments";
import { VoiceActionButton, VoiceRecordingBar } from "@/voice/VoiceComposer";
import { useVoiceRecorder, type VoiceTarget } from "@/voice/useVoiceRecorder";

const lineHeight = 21;
const inputPadding = 9;
const maxLines = 5;

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
  onMore,
  onRemoveAttachment,
  onRetryAttachment,
  commands = [],
  focusRequest = 0,
  onSendOptions,
  voice,
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
  /** Opens the "+" sheet: attachments and other actions. */
  onMore?(): void;
  onRemoveAttachment?(id: string): void;
  onRetryAttachment?(id: string): void;
  /** Agent commands offered after typing "/" at the start of a message. */
  commands?: ChatCommand[];
  /** Raised by the screen to put the cursor in the field, e.g. after a mention was inserted. */
  focusRequest?: number;
  /** Long press on send: «Send later» and «Send without sound» (package E). */
  onSendOptions?(event?: GestureResponderEvent): void;
  /** Enables voice recording on the microphone while the field is empty. */
  voice?: VoiceTarget;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (focusRequest) input.current?.focus();
  }, [focusRequest]);
  const draft = useMemo(() => decodeMentions(body), [body]);
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, maxTextScale);
  const emptyHeight = Math.ceil(lineHeight * scale) + inputPadding * 2;
  // The field grows with the text up to about five lines, then scrolls.
  const maxHeight = Math.ceil(lineHeight * maxLines * scale) + inputPadding * 2;
  const showMore = Boolean(onMore) && context?.kind !== "edit";
  const uploading = attachments.some((item) => item.status === "uploading");
  const canSend =
    (Boolean(draft.text.trim()) ||
      attachments.some((item) => item.status === "ready")) &&
    !uploading;
  const sendOptions =
    canSend && context?.kind !== "edit" && Boolean(onSendOptions);
  // Voice (package F): the microphone takes the send button's place while
  // there is nothing to send; recording replaces the field.
  const recorder = useVoiceRecorder(readonly ? undefined : voice);
  const recording = recorder.phase.kind !== "idle";
  const micMode =
    recorder.enabled &&
    (recording ||
      (!draft.text.trim() &&
        attachments.length === 0 &&
        context?.kind !== "edit"));
  useEffect(() => {
    if (recording) input.current?.blur();
  }, [recording]);

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

  const typedCommand = commands.length ? commandQuery(draft.text) : null;
  const commandMatches =
    typedCommand === null
      ? []
      : matchCommands(commands, typedCommand).slice(0, 6);

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

  function pickCommand(command: ChatCommand) {
    onChangeBody(`/${command.command} `);
    input.current?.focus();
  }

  return (
    <View style={styles.wrap}>
      {commandMatches.length > 0 && (
        <ScrollView
          testID="command-menu"
          keyboardShouldPersistTaps="always"
          accessibilityLabel={t("acCommandsLabel")}
          style={[
            styles.suggestions,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}
        >
          {commandMatches.map((command) => (
            <Pressable
              key={`${command.agentID}/${command.command}`}
              accessibilityRole="button"
              accessibilityLabel={`/${command.command}, ${command.agentName}`}
              onPress={() => pickCommand(command)}
              style={({ pressed }) => [
                styles.suggestion,
                pressed && { backgroundColor: theme.surfaceSelected },
              ]}
            >
              <Avatar
                name={command.agentName}
                seed={command.agentID}
                size={28}
                agent
                actorID={command.agentID}
                avatarVersion={command.avatarVersion}
              />
              <Text weight="semibold" size={15} numberOfLines={1}>
                /{command.command}
              </Text>
              <Text
                tone="subtle"
                size={14}
                numberOfLines={1}
                style={styles.grow}
              >
                {command.description
                  ? `${command.agentName} · ${command.description}`
                  : command.agentName}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
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
      {context && (
        <View
          style={[
            styles.context,
            showMore && styles.indented,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}
        >
          <View style={[styles.quote, { borderLeftColor: theme.primary }]}>
            <Text
              weight="semibold"
              size={12.5}
              tone="primary"
              numberOfLines={1}
            >
              {context.kind === "reply" ? context.author : t("editingMessage")}
            </Text>
            <Text tone="muted" size={13} numberOfLines={1}>
              {context.text}
            </Text>
          </View>
          <IconButton
            label={context.kind === "reply" ? t("cancelReply") : t("cancel")}
            size={32}
            onPress={onCancelContext}
            icon={(color) => <X size={16} color={color} />}
          />
        </View>
      )}
      {attachments.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={showMore && styles.indented}
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
                    backgroundColor: theme.surface,
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
                  hitSlop={10}
                  onPress={() => onRemoveAttachment?.(item.id)}
                  style={[styles.remove, { backgroundColor: theme.foreground }]}
                >
                  <X size={14} color={theme.canvas} />
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      )}
      <View style={styles.line}>
        {recording && <VoiceRecordingBar voice={recorder} />}
        {showMore && !recording && (
          <IconButton
            testID="composer-attach"
            variant="soft"
            label={t("composerMore")}
            onPress={onMore}
            icon={(color) => <Plus size={22} color={color} />}
          />
        )}
        <View
          style={[
            styles.pill,
            recording && styles.hidden,
            {
              backgroundColor: theme.surface,
              borderColor: focused ? theme.borderStrong : theme.border,
            },
          ]}
        >
          <TextInput
            ref={input}
            testID="composer-input"
            value={draft.text}
            onChangeText={(text) =>
              onChangeBody(encodeMentions(updateMentionText(draft, text)))
            }
            placeholder={placeholder ?? t("messagePlaceholder")}
            placeholderTextColor={theme.muted}
            accessibilityLabel={placeholder ?? t("messagePlaceholder")}
            selectionColor={theme.primary}
            multiline
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            maxFontSizeMultiplier={maxTextScale}
            style={[
              styles.input,
              { color: theme.foreground, maxHeight },
              // iOS keeps a multiline input at its tallest size after the
              // text is cleared; an empty field is pinned back to one line.
              !draft.text && { height: emptyHeight },
            ]}
          />
        </View>
        <IconButton
          testID="composer-send"
          variant={canSend ? "accent" : "soft"}
          label={context?.kind === "edit" ? t("save") : t("send")}
          disabled={!canSend}
          onPress={onSend}
          onLongPress={sendOptions ? onSendOptions : undefined}
          hint={sendOptions ? t("scheduledSendHint") : undefined}
          style={micMode ? styles.hidden : undefined}
          icon={(color) =>
            context?.kind === "edit" ? (
              <Check size={20} color={color} strokeWidth={2.4} />
            ) : (
              <ArrowUp size={20} color={color} strokeWidth={2.4} />
            )
          }
        />
        {micMode && <VoiceActionButton voice={recorder} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing[2],
    paddingTop: 6,
    paddingBottom: spacing[2],
    gap: 6,
  },
  indented: { marginLeft: 48 },
  context: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 4,
    marginRight: 4,
  },
  quote: { flex: 1, borderLeftWidth: 3, paddingLeft: spacing[2] },
  line: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
  pill: {
    flex: 1,
    minWidth: 0,
    minHeight: 40,
    borderRadius: radius.field,
    borderWidth: 1,
    paddingLeft: 14,
    paddingRight: spacing[3],
    justifyContent: "center",
  },
  input: {
    fontFamily: fonts.regular,
    fontSize: 16,
    paddingTop: inputPadding,
    paddingBottom: inputPadding,
    paddingHorizontal: 0,
    textAlignVertical: "top",
  },
  handle: { maxWidth: "45%", flexShrink: 1 },
  suggestions: {
    maxHeight: 220,
    borderWidth: 1,
    borderRadius: radius.xl,
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
  attachments: { gap: spacing[2] },
  attachment: {
    width: 72,
    height: 72,
    borderRadius: radius.lg,
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
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  center: { textAlign: "center" },
  hidden: { display: "none" },
});
