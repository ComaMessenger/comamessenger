import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, StyleSheet, useColorScheme } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path, Rect } from "react-native-svg";

// Geometry of design/brand/coma-mascot-source.svg; keep in sync with
// design/brand/generate.mjs, which draws the static splash image.
const BODY =
  "M298 193H410V218H462V244H487V376H462V418H438V442H417V462H397V482H374V504H284V482H308V462H330V442H348V418H264V401H239V376H213V269H239V244H264V218H298Z";
const BOX = { x: 213, y: 193, width: 274, height: 337 };

// The native splash shows splash-icon.png 200 pt wide with the mascot taking
// SPLASH_MASCOT_HEIGHT of it; the overlay starts from exactly that frame.
const SPLASH_IMAGE_WIDTH = 200;
const SPLASH_MASCOT_HEIGHT = 0.6;
const HEIGHT = SPLASH_IMAGE_WIDTH * SPLASH_MASCOT_HEIGHT;
const WIDTH = (HEIGHT * BOX.width) / BOX.height;
const VIEW_BOX = `${BOX.x} ${BOX.y} ${BOX.width} ${BOX.height}`;

const palettes = {
  light: {
    background: "#FFFFFF",
    body: "#174586",
    eyes: "#FFFFFF",
    feet: "#242831",
  },
  dark: {
    background: "#151517",
    body: "#86AFF0",
    eyes: "#FFFFFF",
    feet: "#FFFFFF",
  },
};

const HOP = 520;
const MIN_VISIBLE = 900;
const FADE = 220;

/**
 * Continues the native splash screen: the mascot hops and blinks while the app
 * loads, then the overlay fades into the first screen.
 *
 * `onShown` fires once the overlay is on screen, so the native splash can be
 * hidden without a blank frame; `onDone` fires after the fade-out.
 */
export function AnimatedSplash({
  ready,
  onShown,
  onDone,
}: {
  ready: boolean;
  onShown: () => void;
  onDone: () => void;
}) {
  const colors = palettes[useColorScheme() === "dark" ? "dark" : "light"];
  const [reduceMotion, setReduceMotion] = useState(false);
  const [minimumElapsed, setMinimumElapsed] = useState(false);
  const leaving = useRef(false);

  const lift = useSharedValue(0);
  const squash = useSharedValue(1);
  const blink = useSharedValue(1);
  const opacity = useSharedValue(1);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduceMotion(enabled);
    });
    const timer = setTimeout(() => setMinimumElapsed(true), MIN_VISIBLE);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      lift.value = 0;
      squash.value = 1;
      blink.value = 1;
      return;
    }
    const up = { duration: HOP * 0.45, easing: Easing.out(Easing.quad) };
    const down = { duration: HOP * 0.35, easing: Easing.in(Easing.quad) };
    lift.value = withRepeat(
      withSequence(
        withDelay(140, withTiming(-16, up)),
        withTiming(0, down),
        withDelay(HOP * 0.9, withTiming(0, { duration: 1 })),
      ),
      -1,
    );
    squash.value = withRepeat(
      withSequence(
        withDelay(140 + HOP * 0.8, withTiming(0.93, { duration: 70 })),
        withTiming(1, { duration: 110 }),
        withDelay(HOP * 0.75, withTiming(1, { duration: 1 })),
      ),
      -1,
    );
    blink.value = withRepeat(
      withSequence(
        withDelay(760, withTiming(0.12, { duration: 70 })),
        withTiming(1, { duration: 90 }),
        withDelay(900, withTiming(1, { duration: 1 })),
      ),
      -1,
    );
  }, [reduceMotion, lift, squash, blink]);

  useEffect(() => {
    if (!ready || !minimumElapsed || leaving.current) return;
    leaving.current = true;
    opacity.value = withTiming(0, { duration: FADE }, (finished) => {
      if (finished) runOnJS(onDone)();
    });
  }, [ready, minimumElapsed, opacity, onDone]);

  const overlayStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const bodyStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: lift.value }, { scaleY: squash.value }],
  }));
  const eyesStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: blink.value }],
  }));

  return (
    <Animated.View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      onLayout={onShown}
      style={[
        StyleSheet.absoluteFill,
        styles.overlay,
        { backgroundColor: colors.background },
        overlayStyle,
      ]}
    >
      <Animated.View style={styles.mascot}>
        <Svg style={StyleSheet.absoluteFill} viewBox={VIEW_BOX}>
          <Rect x={260} y={504} width={48} height={26} fill={colors.feet} />
          <Rect x={349} y={504} width={48} height={26} fill={colors.feet} />
        </Svg>
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.body, bodyStyle]}
        >
          <Svg style={StyleSheet.absoluteFill} viewBox={VIEW_BOX}>
            <Path d={BODY} fill={colors.body} />
          </Svg>
          <Animated.View
            style={[StyleSheet.absoluteFill, styles.eyes, eyesStyle]}
          >
            <Svg style={StyleSheet.absoluteFill} viewBox={VIEW_BOX}>
              <Rect x={286} y={273} width={36} height={36} fill={colors.eyes} />
              <Rect x={381} y={294} width={36} height={36} fill={colors.eyes} />
            </Svg>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

// Eyes span y 273–330 of the 193–530 box: blink around their middle.
const EYES_CENTER = `50% ${(((273 + 330) / 2 - BOX.y) / BOX.height) * 100}%`;
// The body ends where the feet begin (y 504): squash towards that line.
const BODY_BASE = `50% ${((504 - BOX.y) / BOX.height) * 100}%`;

const styles = StyleSheet.create({
  overlay: { alignItems: "center", justifyContent: "center", zIndex: 1000 },
  mascot: { width: WIDTH, height: HEIGHT },
  body: { transformOrigin: BODY_BASE },
  eyes: { transformOrigin: EYES_CENTER },
});
