import { useEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Paperclip } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  decodeMentions,
  encodeMentions,
  updateMentionText,
  type ScheduledMessage,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { BottomSheet } from "@/ui/BottomSheet";
import { Button } from "@/ui/Button";
import { Text, fonts, maxTextScale } from "@/ui/Text";

/**
 * Text of a waiting scheduled message. Mentions survive edits around them,
 * as in the composer. Attachments are shown but cannot be changed yet: the
 * server does not accept new files for a scheduled message.
 */
export function ScheduledEditSheet({
  item,
  pending,
  onSave,
  onClose,
}: {
  item: ScheduledMessage | null;
  pending: boolean;
  /** Receives the encoded body, or nothing when the text is unchanged. */
  onSave(item: ScheduledMessage, body: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [text, setText] = useState("");
  const original = item ? decodeMentions(item.body ?? "") : null;
  const originalText = original?.text ?? "";
  useEffect(() => {
    setText(originalText);
  }, [item?.id, item?.version, originalText]);

  const files = item?.files ?? [];
  const unchanged = text === originalText;
  const empty = !text.trim() && files.length === 0;
  return (
    <BottomSheet
      visible={item !== null}
      title={t("scheduledEditTitle")}
      onClose={onClose}
      testID="scheduled-edit-sheet"
    >
      <TextInput
        testID="scheduled-edit-input"
        value={text}
        onChangeText={setText}
        multiline
        autoFocus
        accessibilityLabel={t("scheduledEditLabel")}
        placeholder={t("messagePlaceholder")}
        placeholderTextColor={theme.muted}
        selectionColor={theme.primary}
        maxFontSizeMultiplier={maxTextScale}
        style={[
          styles.input,
          {
            color: theme.foreground,
            borderColor: theme.borderStrong,
            backgroundColor: theme.surface,
          },
        ]}
      />
      {files.length ? (
        <View
          style={[
            styles.files,
            {
              backgroundColor: theme.surfaceSelected,
              borderColor: theme.border,
            },
          ]}
        >
          <View style={styles.fileLine}>
            <Paperclip size={14} color={theme.muted} />
            <Text
              size={13}
              weight="semibold"
              numberOfLines={2}
              style={styles.grow}
            >
              {files.map((file) => file?.name ?? "").join(", ")}
            </Text>
          </View>
          <Text size={12.5} tone="muted">
            {t("scheduledFilesReadonly")}
          </Text>
        </View>
      ) : null}
      <View style={styles.save}>
        <Button
          testID="scheduled-edit-save"
          label={t("save")}
          pending={pending}
          disabled={unchanged || empty}
          onPress={() => {
            if (!item || !original || unchanged || empty) return;
            onSave(item, encodeMentions(updateMentionText(original, text)));
          }}
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 96,
    maxHeight: 240,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: 13,
    paddingTop: 10,
    paddingBottom: 10,
    fontFamily: fonts.regular,
    fontSize: 16,
    textAlignVertical: "top",
  },
  files: {
    marginTop: spacing[2],
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing[3],
    gap: 4,
  },
  fileLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  grow: { flex: 1 },
  save: { marginTop: 14 },
});
