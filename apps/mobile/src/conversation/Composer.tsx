import { useMemo, useRef } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { ArrowUp, Check, X } from "lucide-react-native";
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
import { Text, fonts } from "@/ui/Text";

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
}: {
  body: string;
  onChangeBody(body: string): void;
  onSend(): void;
  members: ChatMember[];
  context: ComposerContext | null;
  onCancelContext(): void;
  readonly: boolean;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const input = useRef<TextInput>(null);
  const draft = useMemo(() => decodeMentions(body), [body]);
  const canSend = Boolean(draft.text.trim());

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
              />
              <Text
                weight="medium"
                size={15}
                numberOfLines={1}
                style={styles.grow}
              >
                {member.display_name}
              </Text>
              <Text tone="subtle" size={14}>
                @{member.handle}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View
        style={[
          styles.card,
          { backgroundColor: theme.surface, borderColor: theme.border },
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
              hitSlop={10}
              onPress={onCancelContext}
            >
              <X size={18} color={theme.subtle} />
            </Pressable>
          </View>
        )}
        <View style={styles.inputRow}>
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
            style={[styles.input, { color: theme.foreground }]}
          />
          <Pressable
            testID="composer-send"
            accessibilityRole="button"
            accessibilityLabel={
              context?.kind === "edit" ? t("save") : t("send")
            }
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={onSend}
            style={[
              styles.send,
              { backgroundColor: canSend ? theme.primary : theme.border },
            ]}
          >
            {context?.kind === "edit" ? (
              <Check size={20} color={theme.onPrimary} />
            ) : (
              <ArrowUp size={20} color={theme.onPrimary} />
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
    borderRadius: radius.xl,
    paddingLeft: spacing[4],
    paddingRight: spacing[2],
    paddingVertical: spacing[2],
    gap: spacing[2],
  },
  context: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    borderLeftWidth: 2,
    paddingLeft: spacing[2],
    marginTop: spacing[1],
  },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing[2] },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 17,
    maxHeight: 140,
    paddingTop: spacing[2],
    paddingBottom: spacing[2],
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
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
  center: { textAlign: "center" },
});
