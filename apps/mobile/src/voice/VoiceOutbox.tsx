import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { AlertCircle, Mic, RotateCw, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { formatVoiceDuration } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { Text } from "@/ui/Text";
import {
  deleteVoice,
  hydrateVoiceOutbox,
  retryVoice,
  useVoiceOutbox,
  type VoiceOutboxItem,
} from "./outbox";
import { Waveform } from "./Waveform";

/**
 * Voice messages of this chat (or thread) still uploading or stuck, as own
 * bubbles at the end of the feed: progress while sending; why it failed,
 * «Retry» and «Delete» otherwise. Once uploaded, the message joins the
 * ordinary outbox and the feed shows it as any other sending message.
 */
export function VoiceOutboxStrip({
  chatID,
  threadRootID,
}: {
  chatID: string;
  threadRootID: string | null;
}) {
  const { api, user } = useSignedIn();
  const { outbox, store } = useMessenger();
  useEffect(() => {
    hydrateVoiceOutbox({ api, outbox, store, userID: user.id });
  }, [api, outbox, store, user.id]);
  const items = useVoiceOutbox(chatID, threadRootID);
  if (!items.length) return null;
  return (
    <View style={styles.strip}>
      {items.map((item) => (
        <OutgoingVoice key={item.id} item={item} />
      ))}
    </View>
  );
}

function OutgoingVoice({ item }: { item: VoiceOutboxItem }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const duration = formatVoiceDuration(item.durationMs);
  const sending = item.status === "sending";
  const reason = {
    sending: t("voiceOutboxSending"),
    offline: t("voiceOutboxOffline"),
    rejected: t("voiceOutboxRejected"),
    full: t("voiceOutboxFull"),
    failed: t("voiceOutboxFailed"),
  }[item.status];
  return (
    <View testID="voice-outbox-item" style={styles.row}>
      <View
        accessible
        accessibilityLabel={`${t("voiceOutboxLabel", { duration })}, ${reason}${
          sending ? `, ${Math.round(item.progress * 100)}%` : ""
        }`}
        style={[styles.bubble, { backgroundColor: theme.own }]}
      >
        <Mic size={16} color={theme.onOwn} />
        <Waveform
          waveform={item.waveform}
          progress={sending ? item.progress : 0}
          color={theme.onOwn}
          playedColor={theme.onOwn}
          height={18}
        />
        <Text size={12} style={[styles.tabular, { color: theme.ownMuted }]}>
          {duration}
        </Text>
      </View>
      <View style={styles.status}>
        {!sending && <AlertCircle size={14} color={theme.danger} />}
        <Text
          size={12.5}
          tone={sending ? "muted" : "danger"}
          numberOfLines={2}
          style={styles.reason}
        >
          {sending ? `${reason} · ${Math.round(item.progress * 100)}%` : reason}
        </Text>
        {!sending && item.status !== "rejected" && (
          <Pressable
            testID="voice-outbox-retry"
            accessibilityRole="button"
            accessibilityLabel={t("retry")}
            hitSlop={8}
            onPress={() => retryVoice(item.id)}
            style={styles.action}
          >
            <RotateCw size={14} color={theme.primary} />
            <Text tone="primary" weight="semibold" size={13}>
              {t("retry")}
            </Text>
          </Pressable>
        )}
        {!sending && (
          <Pressable
            testID="voice-outbox-delete"
            accessibilityRole="button"
            accessibilityLabel={t("voiceDelete")}
            hitSlop={8}
            onPress={() => deleteVoice(item.id)}
            style={styles.action}
          >
            <Trash2 size={14} color={theme.danger} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { paddingHorizontal: 10, paddingTop: spacing[1], gap: spacing[2] },
  row: { alignItems: "flex-end", gap: 2 },
  bubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    width: 214,
    maxWidth: "86%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.bubble,
    borderBottomRightRadius: radius.sm,
  },
  tabular: { fontVariant: ["tabular-nums"] },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[1],
    maxWidth: "86%",
  },
  reason: { flexShrink: 1 },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minHeight: 32,
    paddingHorizontal: spacing[1],
  },
});
