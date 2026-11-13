import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import Svg, { Circle } from "react-native-svg";
import { AlertCircle, RotateCw, Trash2, X } from "lucide-react-native";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Text } from "@/ui/Text";
import { retryUpload, useUploadJobs, type UploadJob } from "@/files/uploadJobs";
import { usePoster } from "./facts";
import { mediaKind } from "./items";
import { mediaMosaic } from "./layout";
import { useMediaMaxWidth } from "./MediaMosaic";
import { cancelMediaSend, useMediaSendsIn, type MediaSend } from "./outbox";
import { sendProgress } from "./progress";

/**
 * Own messages whose photos or videos are still uploading, at the end of
 * the feed: each file with a progress ring and a cancel button in it, the
 * caption under them. A failed upload offers «Retry» and «Delete».
 */
export function MediaOutboxStrip({
  chatID,
  threadRootID,
}: {
  chatID: string;
  threadRootID: string | null;
}) {
  const items = useMediaSendsIn(chatID, threadRootID);
  if (!items.length) return null;
  return (
    <View style={styles.strip}>
      {items.map((item) => (
        <OutgoingMedia key={item.id} item={item} />
      ))}
    </View>
  );
}

function OutgoingMedia({ item }: { item: MediaSend }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const jobs = useUploadJobs(
    useShallow((state) => item.jobIDs.map((id) => state.jobs[id])),
  );
  const present = jobs.filter((job): job is UploadJob => Boolean(job));
  const visual = present.filter((job) => mediaKind(job.local) !== null);
  const width = useMediaMaxWidth();
  const mosaic = mediaMosaic(
    visual.map((job) =>
      job.local.width && job.local.height
        ? job.local.width / job.local.height
        : undefined,
    ),
    {
      maxWidth: width,
      maxHeight: Math.round(width * 1.3),
      minWidth: Math.round(width * 0.55),
    },
  );
  const state = sendProgress(present);
  const percent = Math.round(state.progress * 100);
  const others = present.length - visual.length;
  return (
    <View testID="media-outbox-item" style={styles.row}>
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: theme.own,
            width: visual.length ? mosaic.width : undefined,
          },
        ]}
      >
        {visual.length > 0 && (
          <View style={{ width: mosaic.width, height: mosaic.height }}>
            {visual.map((job, index) => {
              const frame = mosaic.frames[index]!;
              return (
                <View
                  key={job.id}
                  style={[
                    styles.tile,
                    {
                      left: frame.x,
                      top: frame.y,
                      width: frame.width,
                      height: frame.height,
                      backgroundColor: theme.sidebar,
                    },
                  ]}
                >
                  <LocalPreview job={job} />
                  <View style={styles.center}>
                    {job.status === "failed" ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("retry")}
                        onPress={() => retryUpload(api, job.id)}
                        style={styles.ring}
                      >
                        <RotateCw size={20} color="#ffffff" />
                      </Pressable>
                    ) : job.status === "uploading" ? (
                      <Ring progress={job.progress} />
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        )}
        {others > 0 && (
          <Text size={13} style={[styles.caption, { color: theme.ownMuted }]}>
            {t("mediaOutboxFiles", { count: others })}
          </Text>
        )}
        {item.body ? (
          <Text
            size={15}
            numberOfLines={4}
            style={[styles.caption, { color: theme.onOwn }]}
          >
            {item.body}
          </Text>
        ) : null}
      </View>
      <View style={styles.status}>
        {state.failed && <AlertCircle size={14} color={theme.danger} />}
        <Text
          testID="media-outbox-status"
          size={12.5}
          tone={state.failed ? "danger" : "muted"}
          accessibilityLiveRegion="polite"
        >
          {state.failed
            ? t("mediaOutboxFailed")
            : t("mediaOutboxSending", { percent })}
        </Text>
        {state.failed && (
          <Pressable
            testID="media-outbox-retry"
            accessibilityRole="button"
            accessibilityLabel={t("retry")}
            hitSlop={8}
            onPress={() => {
              for (const job of present)
                if (job.status === "failed") retryUpload(api, job.id);
            }}
            style={styles.action}
          >
            <RotateCw size={14} color={theme.primary} />
            <Text tone="primary" weight="semibold" size={13}>
              {t("retry")}
            </Text>
          </Pressable>
        )}
        <Pressable
          testID="media-outbox-cancel"
          accessibilityRole="button"
          accessibilityLabel={
            state.failed ? t("mediaOutboxDelete") : t("mediaOutboxCancel")
          }
          hitSlop={8}
          onPress={() => cancelMediaSend(item.id)}
          style={styles.action}
        >
          {state.failed ? (
            <Trash2 size={14} color={theme.danger} />
          ) : (
            <X size={15} color={theme.muted} />
          )}
          <Text
            tone={state.failed ? "danger" : "muted"}
            weight="semibold"
            size={13}
          >
            {state.failed ? t("mediaOutboxDelete") : t("mediaOutboxCancel")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function LocalPreview({ job }: { job: UploadJob }) {
  const poster = usePoster(job.id);
  const video = mediaKind(job.local) === "video";
  const source = video ? poster : { uri: job.local.uri };
  return source ? (
    <Image source={source} contentFit="cover" style={StyleSheet.absoluteFill} />
  ) : null;
}

/** Telegram-like ring: the uploaded share of one file. */
function Ring({ progress }: { progress: number }) {
  const size = 44;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  return (
    <View
      style={styles.ring}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="#ffffff"
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${length} ${length}`}
          strokeDashoffset={length * (1 - Math.max(0.03, progress))}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { paddingHorizontal: 10, paddingTop: spacing[1], gap: spacing[2] },
  row: { alignItems: "flex-end", gap: 2 },
  bubble: {
    maxWidth: "86%",
    minWidth: 120,
    borderRadius: radius.bubble,
    borderBottomRightRadius: radius.sm,
    overflow: "hidden",
  },
  tile: { position: "absolute", overflow: "hidden" },
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  caption: { paddingHorizontal: 12, paddingVertical: 7 },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[1],
    maxWidth: "86%",
  },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minHeight: 32,
    paddingHorizontal: spacing[1],
  },
});
