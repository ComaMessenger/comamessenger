import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, StyleSheet, View } from "react-native";
import { chatHeaderStatus, type ConversationStatus } from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";

/** Re-render on a slow tick so "5 minutes ago" keeps counting. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Three dots pulsing one after another, as in Telegram. */
function TypingDots({ color }: { color: string }) {
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0.25))).current;
  const [still, setStill] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setStill);
  }, []);
  useEffect(() => {
    if (still) {
      dots.forEach((dot) => dot.setValue(0.7));
      return;
    }
    const loop = Animated.loop(
      Animated.stagger(
        200,
        dots.map((dot) =>
          Animated.sequence([
            Animated.timing(dot, {
              toValue: 1,
              duration: 300,
              useNativeDriver: true,
            }),
            Animated.timing(dot, {
              toValue: 0.25,
              duration: 300,
              useNativeDriver: true,
            }),
          ]),
        ),
      ),
    );
    loop.start();
    return () => loop.stop();
  }, [dots, still]);
  return (
    <View style={styles.dots} importantForAccessibility="no-hide-descendants">
      {dots.map((opacity, index) => (
        <Animated.View
          key={index}
          style={[styles.dot, { backgroundColor: color, opacity }]}
        />
      ))}
    </View>
  );
}

/** The line under a chat title: online, last seen, or what people do. */
export function HeaderStatus({ status }: { status: ConversationStatus }) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text
        testID="conversation-status"
        tone={status.live ? "primary" : "muted"}
        size={12.5}
        numberOfLines={1}
        accessibilityLiveRegion={status.animated ? "polite" : "none"}
        style={styles.text}
      >
        {status.text}
      </Text>
      {status.animated && <TypingDots color={theme.primary} />}
    </View>
  );
}

/**
 * The status line with its own clock: only this line re-renders every half
 * minute, not the feed around it.
 */
export function ChatStatusLine({
  input,
}: {
  input: Omit<Parameters<typeof chatHeaderStatus>[0], "now">;
}) {
  const now = useNow();
  const status = chatHeaderStatus({ ...input, now });
  return status.text ? <HeaderStatus status={status} /> : null;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", minWidth: 0 },
  text: { flexShrink: 1 },
  dots: { flexDirection: "row", gap: 2, marginLeft: 3, marginTop: 3 },
  dot: { width: 3, height: 3, borderRadius: 1.5 },
});
