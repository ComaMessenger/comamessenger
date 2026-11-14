import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useColorScheme,
  useWindowDimensions,
} from "react-native";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { FullWindowOverlay } from "react-native-screens";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

export type AnchorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AnchoredMenuItem = {
  key: string;
  label: string;
  icon?: ReactNode;
  testID?: string;
  onPress(): void;
};

/** Where the menu card goes: above the anchor, its right edge on the anchor's. */
export function anchoredMenuFrame(
  anchor: AnchorRect,
  window: { width: number; height: number },
  gap = 8,
  margin = 10,
) {
  const right = Math.max(margin, window.width - (anchor.x + anchor.width));
  const bottom = Math.max(margin, window.height - anchor.y + gap);
  return { right, bottom };
}

/** Measures a view in window coordinates; null when it is not laid out. */
export function measureAnchor(
  ref: RefObject<View | null>,
): Promise<AnchorRect | null> {
  return new Promise((resolve) => {
    const node = ref.current;
    if (!node) {
      resolve(null);
      return;
    }
    node.measureInWindow((x, y, width, height) =>
      resolve(width > 0 || height > 0 ? { x, y, width, height } : null),
    );
  });
}

/**
 * A small menu tied to the view it was opened from (the send button), as
 * iOS context menus: above it, aligned to its right edge, over a blurred
 * and dimmed screen. A tap outside or a swipe closes it.
 *
 * The position is measured from the anchor itself, never from the finger,
 * and again whenever the keyboard moves. iOS draws it in a full-window
 * overlay instead of a modal: a modal takes the focus from the text field,
 * the keyboard went down and left the menu hanging mid-screen.
 */
export function AnchoredMenu({
  visible,
  anchorRef,
  items,
  onClose,
  testID,
  accessibilityLabel,
  renderAnchor,
}: {
  visible: boolean;
  anchorRef: RefObject<View | null>;
  items: AnchoredMenuItem[];
  onClose(): void;
  testID?: string;
  accessibilityLabel: string;
  /** A copy of the anchor drawn above the blur, so it stays in sight. */
  renderAnchor?(): ReactNode;
}) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [mounted, setMounted] = useState(false);
  const measure = useCallback(() => {
    void measureAnchor(anchorRef).then((rect) => {
      if (rect) setAnchor(rect);
    });
  }, [anchorRef]);

  useEffect(() => {
    if (!visible) return;
    setMounted(true);
    measure();
    // The keyboard can go up or down while the menu is open (Android shows
    // the menu in a modal, which takes the focus): follow the anchor.
    const events = [
      "keyboardDidShow",
      "keyboardDidHide",
      "keyboardDidChangeFrame",
    ] as const;
    const subscriptions = events.map((name) =>
      Keyboard.addListener(name, () => setTimeout(measure, 30)),
    );
    return () => subscriptions.forEach((item) => item.remove());
  }, [measure, visible]);

  const hidden = useCallback(() => {
    setMounted(false);
    setAnchor(null);
  }, []);

  if (!mounted || !anchor) return null;
  const content = (
    <MenuLayer
      visible={visible}
      anchor={anchor}
      items={items}
      onClose={onClose}
      onHidden={hidden}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      renderAnchor={renderAnchor}
    />
  );
  if (Platform.OS === "ios")
    return <FullWindowOverlay>{content}</FullWindowOverlay>;
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      {content}
    </Modal>
  );
}

function MenuLayer({
  visible,
  anchor,
  items,
  onClose,
  onHidden,
  testID,
  accessibilityLabel,
  renderAnchor,
}: {
  visible: boolean;
  anchor: AnchorRect;
  items: AnchoredMenuItem[];
  onClose(): void;
  onHidden(): void;
  testID?: string;
  accessibilityLabel: string;
  renderAnchor?(): ReactNode;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const scheme = useColorScheme();
  const window = useWindowDimensions();
  const shown = useSharedValue(0);
  const drag = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      drag.value = 0;
      shown.value = withTiming(1, {
        duration: 180,
        easing: Easing.out(Easing.cubic),
      });
    } else
      shown.value = withTiming(0, { duration: 140 }, (done) => {
        if (done) runOnJS(onHidden)();
      });
  }, [drag, onHidden, shown, visible]);

  const backdrop = useAnimatedStyle(() => ({ opacity: shown.value }));
  const card = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [
      { translateY: drag.value },
      { scale: 0.55 + 0.45 * shown.value },
    ],
  }));

  // A tap anywhere outside or a swipe in any direction closes the menu.
  const tap = Gesture.Tap().onEnd(() => runOnJS(onClose)());
  const swipe = Gesture.Pan()
    .minDistance(12)
    .onUpdate((event) => {
      drag.value = Math.max(-12, Math.min(40, event.translationY * 0.35));
    })
    .onEnd(() => {
      runOnJS(onClose)();
    });
  const outside = Gesture.Exclusive(swipe, tap);

  const frame = anchoredMenuFrame(anchor, window);
  return (
    <GestureHandlerRootView style={StyleSheet.absoluteFill}>
      <GestureDetector gesture={outside}>
        <Animated.View style={[StyleSheet.absoluteFill, backdrop]}>
          <BlurView
            intensity={22}
            tint={scheme === "dark" ? "dark" : "light"}
            style={StyleSheet.absoluteFill}
          />
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: theme.overlay, opacity: 0.55 },
            ]}
          />
          {/* Screen readers have no "outside": an explicit close target. */}
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={t("close")}
            onAccessibilityTap={onClose}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </GestureDetector>
      {renderAnchor ? (
        <View
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          style={{
            position: "absolute",
            left: anchor.x,
            top: anchor.y,
            width: anchor.width,
            height: anchor.height,
          }}
        >
          {renderAnchor()}
        </View>
      ) : null}
      <Animated.View
        testID={testID}
        accessibilityViewIsModal
        accessibilityRole="menu"
        accessibilityLabel={accessibilityLabel}
        onAccessibilityEscape={onClose}
        style={[
          styles.card,
          {
            right: frame.right,
            bottom: frame.bottom,
            backgroundColor: theme.surfaceRaised,
            borderColor: theme.border,
            boxShadow: "0 10px 30px rgba(0, 0, 0, 0.18)",
            transformOrigin: "right bottom",
          },
          card,
        ]}
      >
        {items.map((item) => (
          <Pressable
            key={item.key}
            testID={item.testID}
            accessibilityRole="menuitem"
            accessibilityLabel={item.label}
            onPress={() => {
              void Haptics.selectionAsync();
              item.onPress();
            }}
            style={({ pressed }) => [
              styles.item,
              pressed && { backgroundColor: theme.surfaceSelected },
            ]}
          >
            {item.icon}
            <Text size={15}>{item.label}</Text>
          </Pressable>
        ))}
      </Animated.View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  // Prototype `.pop`: 16px radius, 5px padding, min-width 216px.
  card: {
    position: "absolute",
    minWidth: 216,
    borderRadius: 16,
    borderWidth: 1,
    padding: 5,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 11,
    borderRadius: 11,
    minHeight: 44,
  },
});
