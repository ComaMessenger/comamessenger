import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import {
  AlertCircle,
  FileText,
  Image as ImageIcon,
  Paperclip,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  decodeMentions,
  encodeMentions,
  updateMentionText,
  type FileMetadata,
  type ScheduledMessage,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { pickFiles, type PickSource } from "@/files/pick";
import { attachmentLimit, useAttachments } from "@/files/useAttachments";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { BottomSheet } from "@/ui/BottomSheet";
import { Button } from "@/ui/Button";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import type { ScheduledChange } from "./useScheduled";

function sameFiles(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    [...left].sort().join() === [...right].sort().join()
  );
}

/**
 * Text and attachments of a scheduled message, waiting or not sent. Mentions
 * survive edits around them, as in the composer. Files can be removed and
 * added; new ones upload at once and the record takes them on «Save». An
 * unsent message stays unsent until a new time or «Send now».
 */
export function ScheduledEditSheet({
  item,
  pending,
  onSave,
  onClose,
}: {
  item: ScheduledMessage | null;
  pending: boolean;
  /** Receives only what changed. */
  onSave(item: ScheduledMessage, change: ScheduledChange): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const [text, setText] = useState("");
  const [kept, setKept] = useState<FileMetadata[]>([]);
  const added = useAttachments(api);
  const original = item ? decodeMentions(item.body ?? "") : null;
  const originalText = original?.text ?? "";
  const originalFiles = item?.files ?? [];
  const { reset } = added;
  useEffect(() => {
    setText(originalText);
    setKept(item?.files ?? []);
    reset();
    // Each opening (or a fresher version after a conflict) starts anew.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.version]);

  const fileIDs = [
    ...kept.map((file) => file.id),
    ...added.ready.map((file) => file.id),
  ];
  const fileCount = kept.length + added.items.length;
  const filesChanged = !sameFiles(
    fileIDs,
    originalFiles.map((file) => file.id),
  );
  const unchanged = text === originalText && !filesChanged;
  const empty = !text.trim() && fileIDs.length === 0;
  const uploading = added.uploading;

  function pick(source: PickSource) {
    void pickFiles(source, attachmentLimit - fileCount)
      .then((files) => {
        if (added.add(files) > 0)
          Alert.alert(t("attachmentLimit", { limit: attachmentLimit }));
      })
      .catch(() => Alert.alert(t("actionFailed")));
  }

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
      {fileCount ? (
        <View style={styles.files}>
          {kept.map((file) => (
            <FileChip
              key={file.id}
              name={file.name}
              onRemove={() =>
                setKept((current) =>
                  current.filter((other) => other.id !== file.id),
                )
              }
            />
          ))}
          {added.items.map((attachment) => (
            <FileChip
              key={attachment.id}
              name={attachment.local.name}
              status={attachment.status}
              onRetry={() => added.retry(attachment.id)}
              onRemove={() => added.remove(attachment.id)}
            />
          ))}
        </View>
      ) : null}
      {/* The server takes no files in a thread message yet. */}
      {fileCount < attachmentLimit && !item?.thread_root_id ? (
        <View style={styles.addRow}>
          <AddButton
            testID="scheduled-edit-add-photo"
            label={t("attachPhotos")}
            icon={<ImageIcon size={16} color={theme.primary} />}
            onPress={() => pick("photos")}
          />
          <AddButton
            testID="scheduled-edit-add-file"
            label={t("attachFile")}
            icon={<FileText size={16} color={theme.primary} />}
            onPress={() => pick("file")}
          />
        </View>
      ) : null}
      <View style={styles.save}>
        <Button
          testID="scheduled-edit-save"
          label={t("save")}
          pending={pending}
          disabled={unchanged || empty || uploading}
          onPress={() => {
            if (!item || !original || unchanged || empty || uploading) return;
            onSave(item, {
              ...(text !== originalText
                ? {
                    body: encodeMentions(updateMentionText(original, text)),
                  }
                : {}),
              ...(filesChanged ? { file_ids: fileIDs } : {}),
            });
          }}
        />
      </View>
    </BottomSheet>
  );
}

function AddButton({
  label,
  icon,
  onPress,
  testID,
}: {
  label: string;
  icon: React.ReactNode;
  onPress(): void;
  testID: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.add,
        {
          backgroundColor: pressed ? theme.surfaceSelected : theme.primarySoft,
        },
      ]}
    >
      {icon}
      <Text size={14} weight="semibold" style={{ color: theme.primary }}>
        {label}
      </Text>
    </Pressable>
  );
}

function FileChip({
  name,
  status = "ready",
  onRemove,
  onRetry,
}: {
  name: string;
  status?: "uploading" | "ready" | "failed";
  onRemove(): void;
  onRetry?(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const failed = status === "failed";
  return (
    <View
      style={[
        styles.file,
        {
          backgroundColor: theme.surfaceSelected,
          borderColor: failed ? theme.dangerBorder : theme.border,
        },
      ]}
    >
      {status === "uploading" ? (
        <ActivityIndicator size="small" color={theme.muted} />
      ) : failed ? (
        <AlertCircle size={15} color={theme.danger} />
      ) : (
        <Paperclip size={15} color={theme.muted} />
      )}
      <Pressable
        style={styles.grow}
        disabled={!failed}
        accessibilityRole={failed ? "button" : undefined}
        onPress={onRetry}
      >
        <Text size={13.5} numberOfLines={1}>
          {name}
        </Text>
        {failed ? (
          <Text size={12} tone="danger" numberOfLines={1}>
            {t("scheduledFileFailed")}
          </Text>
        ) : null}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("scheduledFileRemove", { name })}
        hitSlop={8}
        onPress={onRemove}
      >
        <X size={17} color={theme.muted} />
      </Pressable>
    </View>
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
  files: { marginTop: spacing[2], gap: 6 },
  file: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: 8,
    paddingHorizontal: spacing[3],
  },
  addRow: { flexDirection: "row", gap: spacing[2], marginTop: spacing[2] },
  add: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  grow: { flex: 1, minWidth: 0 },
  save: { marginTop: 14 },
});
