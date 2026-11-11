import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

/** A pull further than this, or a quick flick down, closes the sheet. */
const closeDistance = 90;
const closeVelocity = 0.8;

/**
 * Sheet that rises from the bottom over a dimmed screen: grab handle, title
 * with an optional action on the right, scrolling content. Pulling it down
 * closes it, like the dimmed area above it and the system back gesture.
 * Built on the plain responder system: a modal is a new native root, where
 * gesture-handler would need a root of its own.
 */
export function BottomSheet({
  visible,
  title,
  action,
  onClose,
  children,
  testID,
  accessibilityLabel,
}: {
  visible: boolean;
  title?: string;
  /** Header action such as «Done». */
  action?: { label: string; disabled?: boolean; onPress(): void };
  onClose(): void;
  children: ReactNode;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const drag = useRef(new Animated.Value(0)).current;
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (visible) drag.setValue(0);
  }, [drag, visible]);
  const pull = useMemo(
    () =>
      PanResponder.create({
        // Only a mostly vertical pull down; content that scrolls keeps its
        // own drags, and the grab handle and title always pull the sheet.
        onMoveShouldSetPanResponder: (_, move) =>
          move.dy > 6 && Math.abs(move.dy) > Math.abs(move.dx) * 1.5,
        onPanResponderMove: (_, move) => drag.setValue(Math.max(0, move.dy)),
        onPanResponderRelease: (_, move) => {
          if (move.dy > closeDistance || move.vy > closeVelocity)
            Animated.timing(drag, {
              toValue: 800,
              duration: 160,
              useNativeDriver: true,
            }).start(() => close.current());
          else
            Animated.spring(drag, {
              toValue: 0,
              useNativeDriver: true,
            }).start();
        },
        onPanResponderTerminate: () =>
          Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start(),
      }),
    [drag],
  );
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("close")}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]}
          onPress={onClose}
        />
        <Animated.View
          {...pull.panHandlers}
          testID={testID}
          accessibilityViewIsModal
          accessibilityLabel={accessibilityLabel ?? title}
          style={[
            styles.sheet,
            {
              backgroundColor: theme.surface,
              maxHeight: "88%",
              paddingBottom: Math.max(insets.bottom, 22),
              transform: [{ translateY: drag }],
            },
          ]}
        >
          <View
            style={[styles.grab, { backgroundColor: theme.borderStrong }]}
          />
          {title || action ? (
            <View style={styles.head}>
              <Text
                accessibilityRole="header"
                weight="bold"
                size={17}
                numberOfLines={1}
                style={styles.title}
              >
                {title}
              </Text>
              {action ? (
                <Pressable
                  testID={testID ? `${testID}-action` : undefined}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: Boolean(action.disabled) }}
                  disabled={action.disabled}
                  hitSlop={10}
                  onPress={action.onPress}
                  style={styles.action}
                >
                  <Text
                    weight="semibold"
                    size={15}
                    style={{
                      color: action.disabled ? theme.subtle : theme.primary,
                    }}
                  >
                    {action.label}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {children}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  // Prototype: `.sheet { border-radius: 24px 24px 0 0; padding: 8px 16px 22px }`.
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  grab: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 12,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
    minHeight: 24,
  },
  title: { flex: 1 },
  action: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: "center",
    alignItems: "flex-end",
  },
});
