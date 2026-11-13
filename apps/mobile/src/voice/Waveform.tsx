import { useMemo, useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { waveformBars } from "@comamessenger/core";
import { liveBars } from "./model";

const barWidth = 2.5;
const barGap = 2;

/**
 * Bars of a voice message (prototype `.wave`): `waveform` holds 0..255 peaks
 * resampled to the width, `levels` the recorder's dBFS readings, newest on the right. Bars left of
 * `progress` take the played colour. With `onSeek`, a tap or a horizontal
 * drag reports the position as 0..1; the drag wins over swipe-to-reply.
 */
export function Waveform({
  waveform,
  levels,
  progress = 0,
  color,
  playedColor,
  height = 24,
  onSeek,
  style,
}: {
  waveform?: readonly number[];
  levels?: readonly number[];
  progress?: number;
  color: string;
  playedColor: string;
  height?: number;
  onSeek?(ratio: number, done: boolean): void;
  style?: StyleProp<ViewStyle>;
}) {
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const count = Math.max(0, Math.floor((width + barGap) / (barWidth + barGap)));
  const bars = useMemo(
    () =>
      levels ? liveBars(levels, count) : waveformBars(waveform ?? [], count),
    [count, levels, waveform],
  );
  const shown = dragging ?? progress;

  const gesture = useMemo(() => {
    const ratio = (x: number) =>
      width > 0 ? Math.min(1, Math.max(0, x / width)) : 0;
    const pan = Gesture.Pan()
      .runOnJS(true)
      .activeOffsetX([-4, 4])
      .failOffsetY([-12, 12])
      .onStart((event) => setDragging(ratio(event.x)))
      .onUpdate((event) => setDragging(ratio(event.x)))
      .onEnd((event) => onSeek?.(ratio(event.x), true))
      .onFinalize(() => setDragging(null));
    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd((event, success) => {
        if (success) onSeek?.(ratio(event.x), true);
      });
    return Gesture.Race(pan, tap);
  }, [onSeek, width]);

  const content = (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.wave, { height }, style]}
    >
      {bars.map((value, index) => {
        const played = (index + 0.5) / Math.max(1, bars.length) <= shown;
        return (
          <View
            key={index}
            style={[
              styles.bar,
              {
                height: Math.max(3, Math.round(height * value)),
                backgroundColor: played ? playedColor : color,
                opacity: played ? 1 : 0.4,
              },
            ]}
          />
        );
      })}
    </View>
  );
  if (!onSeek) return content;
  return <GestureDetector gesture={gesture}>{content}</GestureDetector>;
}

const styles = StyleSheet.create({
  wave: {
    flexDirection: "row",
    alignItems: "center",
    gap: barGap,
    overflow: "hidden",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  bar: { width: barWidth, borderRadius: 2 },
});
