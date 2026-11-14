import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Image } from "expo-image";
import { useQueryClient } from "@tanstack/react-query";
import {
  Download,
  MessageSquareText,
  RotateCw,
  Share,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useFileSource } from "@/files/sources";
import { useSignedIn } from "@/session/SessionProvider";
import { Text } from "@/ui/Text";
import type { AnchorRect } from "@/ui/AnchoredMenu";
import {
  recordMediaFacts,
  useLocalMedia,
  useMediaFacts,
  usePoster,
} from "./facts";
import {
  containSize,
  formatMediaDate,
  indexOfMedia,
  mediaPosition,
  panBounds,
  type MediaItem,
} from "./items";
import { saveMediaToPhotos, shareMedia } from "./save";
import { MediaViewerContext } from "./MediaViewerContext";
import { VideoStage } from "./VideoStage";

const maxScale = 4;
const doubleTapScale = 2.5;
const dismissDistance = 110;
const dismissVelocity = 900;

/**
 * Hosts the full-screen viewer for the photos and videos of one chat (or
 * thread): the bubbles open it through context, it pages through `items`
 * in feed order and asks for older messages at the start of the list.
 */
export function MediaViewerHost({
  items,
  total,
  hasOlder = false,
  onLoadOlder,
  authorName,
  onGoToMessage,
  children,
}: {
  items: MediaItem[];
  /**
   * How many photos and videos the whole chat has, when known (the chat
   * archive reads it from the server): `items` are then the newest ones and
   * the counter counts across the chat, not the loaded part.
   */
  total?: number;
  hasOlder?: boolean;
  onLoadOlder?(): Promise<void> | void;
  authorName(actorID: string): string;
  /** Closes the viewer and brings the message up in the feed. */
  onGoToMessage?(messageID: string): void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<{
    key: string;
    origin: AnchorRect | null;
  } | null>(null);
  const openMedia = useCallback(
    (key: string, origin: AnchorRect | null) => setOpen({ key, origin }),
    [],
  );
  const close = useCallback(() => setOpen(null), []);
  return (
    <MediaViewerContext.Provider value={openMedia}>
      {children}
      {open && (
        <Modal
          visible
          transparent
          animationType="none"
          statusBarTranslucent
          navigationBarTranslucent
          supportedOrientations={["portrait", "landscape"]}
          onRequestClose={close}
        >
          <ViewerBoundary onClose={close}>
            <MediaViewer
              items={items}
              total={total}
              initialKey={open.key}
              origin={open.origin}
              hasOlder={hasOlder}
              onLoadOlder={onLoadOlder}
              authorName={authorName}
              onGoToMessage={
                onGoToMessage
                  ? (messageID) => {
                      close();
                      onGoToMessage(messageID);
                    }
                  : undefined
              }
              onClose={close}
            />
          </ViewerBoundary>
        </Modal>
      )}
    </MediaViewerContext.Provider>
  );
}

type ViewerProps = {
  items: MediaItem[];
  total?: number;
  initialKey: string;
  origin: AnchorRect | null;
  hasOlder: boolean;
  onLoadOlder?(): Promise<void> | void;
  authorName(actorID: string): string;
  onGoToMessage?(messageID: string): void;
  onClose(): void;
};

function MediaViewer({
  items,
  total,
  initialKey,
  origin,
  hasOlder,
  onLoadOlder,
  authorName,
  onGoToMessage,
  onClose,
}: ViewerProps) {
  const { t, i18n } = useTranslation();
  const { api } = useSignedIn();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [currentKey, setCurrentKey] = useState(initialKey);
  const [chrome, setChrome] = useState(true);
  const [zoomed, setZoomed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"share" | "save" | null>(null);
  const list = useRef<FlatList<MediaItem>>(null);
  // An item opened from a message that is gone (deleted meanwhile) still shows.
  const index = Math.max(0, indexOfMedia(items, currentKey));
  const current = items[index];
  const facts = useMediaFacts(current?.key ?? initialKey);

  // 0 → 1 opens, 1 → 0 closes; the drag moves the page and fades the black.
  const presence = useSharedValue(0);
  const dismissY = useSharedValue(0);
  // The page flies back into its tile only if it is the one opened.
  const morph = Boolean(origin) && currentKey === initialKey;
  const fitted = containSize(facts.aspect ?? 1, window);
  const originScale = origin ? Math.max(0.1, origin.width / fitted.width) : 1;
  const originX = origin ? origin.x + origin.width / 2 - window.width / 2 : 0;
  const originY = origin ? origin.y + origin.height / 2 - window.height / 2 : 0;

  useEffect(() => {
    presence.value = withTiming(1, {
      duration: 240,
      easing: Easing.out(Easing.cubic),
    });
  }, [presence]);

  const closing = useRef(false);
  const close = useCallback(
    (velocity = 0) => {
      if (closing.current) return;
      closing.current = true;
      const done = (finished?: boolean) => {
        "worklet";
        if (finished) runOnJS(onClose)();
      };
      if (morph) {
        dismissY.value = withTiming(0, { duration: 220 });
        presence.value = withTiming(0, { duration: 220 }, done);
      } else {
        const direction = velocity < 0 || dismissY.value < 0 ? -1 : 1;
        dismissY.value = withTiming(direction * window.height, {
          duration: 220,
        });
        presence.value = withTiming(0, { duration: 220 }, done);
      }
    },
    [dismissY, morph, onClose, presence, window.height],
  );

  const backdrop = useAnimatedStyle(() => ({
    opacity:
      presence.value *
      (1 - Math.min(1, Math.abs(dismissY.value) / (window.height * 0.6))),
  }));
  const stage = useAnimatedStyle(() => {
    const p = presence.value;
    if (!morph)
      return {
        opacity: Math.min(1, p * 1.5),
        transform: [{ translateY: dismissY.value }],
      };
    return {
      transform: [
        { translateX: originX * (1 - p) },
        { translateY: originY * (1 - p) + dismissY.value },
        { scale: originScale + (1 - originScale) * p },
      ],
    };
  });
  const bars = useAnimatedStyle(() => ({
    opacity: presence.value * (1 - Math.min(1, Math.abs(dismissY.value) / 80)),
  }));

  // Older messages are loaded while the reader is near the start, until
  // there is media before the current one or nothing older is left.
  useEffect(() => {
    if (index > 1 || !hasOlder || !onLoadOlder) return;
    void onLoadOlder();
  }, [hasOlder, index, items.length, onLoadOlder]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(timer);
  }, [notice]);

  const onMomentumEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / window.width);
    const item = items[next];
    if (item && item.key !== currentKey) {
      setCurrentKey(item.key);
      setZoomed(false);
    }
  };

  const step = (delta: number) => {
    const item = items[index + delta];
    if (!item) return;
    list.current?.scrollToIndex({ index: index + delta, animated: true });
    setCurrentKey(item.key);
  };

  async function run(kind: "share" | "save") {
    if (!current || busy) return;
    setBusy(kind);
    try {
      if (kind === "share") await shareMedia(api, current.file);
      else {
        const result = await saveMediaToPhotos(api, current.file);
        setNotice(result === "denied" ? t("mediaSaveDenied") : t("mediaSaved"));
      }
    } catch {
      setNotice(t("mediaActionFailed"));
    } finally {
      setBusy(null);
    }
  }

  const author = current ? authorName(current.actorID) : "";
  const date = current ? formatMediaDate(current.createdAt, i18n.language) : "";
  const showBars = chrome && !zoomed;

  return (
    <GestureHandlerRootView style={styles.root}>
      <Animated.View
        style={[StyleSheet.absoluteFill, styles.black, backdrop]}
      />
      <Animated.View testID="media-viewer" style={[styles.root, stage]}>
        <FlatList
          ref={list}
          data={items}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
          keyExtractor={(item) => item.key}
          initialScrollIndex={index}
          getItemLayout={(_, position) => ({
            length: window.width,
            offset: window.width * position,
            index: position,
          })}
          // Older media arrive at the start: the current page stays put.
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          windowSize={3}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          onMomentumScrollEnd={onMomentumEnd}
          renderItem={({ item, index: position }) => (
            <MediaPage
              item={item}
              active={item.key === currentKey}
              width={window.width}
              height={window.height}
              dismissY={dismissY}
              chrome={chrome}
              insets={insets}
              onZoomChange={setZoomed}
              onToggleChrome={() => setChrome((value) => !value)}
              onDismiss={close}
              onStep={step}
              hasPrevious={position > 0}
              hasNext={position < items.length - 1}
            />
          )}
        />
      </Animated.View>
      {showBars && (
        <Animated.View
          style={[styles.top, { paddingTop: insets.top + 4 }, bars]}
          pointerEvents="box-none"
        >
          <Pressable
            testID="media-viewer-close"
            accessibilityRole="button"
            accessibilityLabel={t("close")}
            hitSlop={8}
            onPress={() => close()}
            style={styles.button}
          >
            <X size={26} color="#ffffff" />
          </Pressable>
          <View style={styles.title} accessible>
            <Text
              weight="semibold"
              size={15}
              numberOfLines={1}
              style={styles.white}
            >
              {author}
            </Text>
            <Text size={12.5} numberOfLines={1} style={styles.dim}>
              {date}
            </Text>
          </View>
          <Text
            testID="media-viewer-counter"
            size={14}
            weight="medium"
            style={[styles.white, styles.counter]}
          >
            {t("mediaCounter", mediaPosition(index, items.length, total))}
          </Text>
        </Animated.View>
      )}
      {showBars && (
        <Animated.View
          style={[styles.bottom, { paddingBottom: insets.bottom + 6 }, bars]}
          pointerEvents="box-none"
        >
          <BarButton
            testID="media-viewer-share"
            label={t("share")}
            busy={busy === "share"}
            onPress={() => void run("share")}
            icon={<Share size={22} color="#ffffff" />}
          />
          <BarButton
            testID="media-viewer-save"
            label={t("mediaSave")}
            busy={busy === "save"}
            onPress={() => void run("save")}
            icon={<Download size={22} color="#ffffff" />}
          />
          {onGoToMessage && current ? (
            <BarButton
              testID="media-viewer-goto"
              label={t("mediaGoToMessage")}
              onPress={() => onGoToMessage(current.messageID)}
              icon={<MessageSquareText size={22} color="#ffffff" />}
            />
          ) : null}
        </Animated.View>
      )}
      {notice ? (
        <View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[styles.notice, { bottom: insets.bottom + 80 }]}
        >
          <Text size={14} style={styles.white}>
            {notice}
          </Text>
        </View>
      ) : null}
    </GestureHandlerRootView>
  );
}

function BarButton({
  label,
  icon,
  onPress,
  busy = false,
  testID,
}: {
  label: string;
  icon: ReactNode;
  onPress(): void;
  busy?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}
    >
      {busy ? <ActivityIndicator color="#ffffff" /> : icon}
      <Text size={11.5} numberOfLines={1} style={styles.dim}>
        {label}
      </Text>
    </Pressable>
  );
}

type PageProps = {
  item: MediaItem;
  active: boolean;
  width: number;
  height: number;
  dismissY: SharedValue<number>;
  chrome: boolean;
  insets: { top: number; bottom: number };
  onZoomChange(zoomed: boolean): void;
  onToggleChrome(): void;
  onDismiss(velocity?: number): void;
  onStep(delta: number): void;
  hasPrevious: boolean;
  hasNext: boolean;
};

/**
 * One photo or video: pinch and double tap zoom, a zoomed item pans within
 * its edges, a vertical swipe of an unzoomed one closes the viewer. A
 * screen reader gets the same through actions: next and previous (swipe up
 * and down), zoom (double tap), close (escape).
 */
function MediaPage({
  item,
  active,
  width,
  height,
  dismissY,
  chrome,
  insets,
  onZoomChange,
  onToggleChrome,
  onDismiss,
  onStep,
  hasPrevious,
  hasNext,
}: PageProps) {
  const { t } = useTranslation();
  const facts = useMediaFacts(item.key);
  const content = containSize(facts.aspect ?? 1, { width, height });
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const [zoomed, setZoomedState] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const setZoomed = useCallback(
    (value: boolean) => {
      setZoomedState(value);
      onZoomChange(value);
    },
    [onZoomChange],
  );

  // A page swiped away comes back unzoomed.
  useEffect(() => {
    if (active) return;
    scale.value = 1;
    x.value = 0;
    y.value = 0;
    setZoomedState(false);
  }, [active, scale, x, y]);

  const settle = () => {
    "worklet";
    if (scale.value <= 1.02) {
      scale.value = withTiming(1);
      x.value = withTiming(0);
      y.value = withTiming(0);
      runOnJS(setZoomed)(false);
      return;
    }
    const target = Math.min(maxScale, scale.value);
    const bounds = panBounds(content, { width, height }, target);
    scale.value = withTiming(target);
    x.value = withTiming(Math.max(-bounds.x, Math.min(bounds.x, x.value)));
    y.value = withTiming(Math.max(-bounds.y, Math.min(bounds.y, y.value)));
    runOnJS(setZoomed)(true);
  };

  const zoomAt = (pointX: number, pointY: number) => {
    "worklet";
    if (scale.value > 1.02) {
      scale.value = withTiming(1);
      x.value = withTiming(0);
      y.value = withTiming(0);
      runOnJS(setZoomed)(false);
      return;
    }
    const target = doubleTapScale;
    const bounds = panBounds(content, { width, height }, target);
    const nextX = -(pointX - width / 2) * (target - 1);
    const nextY = -(pointY - height / 2) * (target - 1);
    scale.value = withTiming(target);
    x.value = withTiming(Math.max(-bounds.x, Math.min(bounds.x, nextX)));
    y.value = withTiming(Math.max(-bounds.y, Math.min(bounds.y, nextY)));
    runOnJS(setZoomed)(true);
  };

  const pinch = Gesture.Pinch()
    .onStart(() => {
      savedScale.value = scale.value;
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((event) => {
      const next = Math.max(
        0.8,
        Math.min(maxScale + 1, savedScale.value * event.scale),
      );
      const focusX = event.focalX - width / 2;
      const focusY = event.focalY - height / 2;
      const ratio = next / savedScale.value;
      x.value = focusX - (focusX - startX.value) * ratio;
      y.value = focusY - (focusY - startY.value) * ratio;
      scale.value = next;
    })
    .onEnd(() => settle());

  const pan = Gesture.Pan()
    .maxPointers(1)
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((event) => {
      if (zoomed) {
        x.value = startX.value + event.translationX;
        y.value = startY.value + event.translationY;
      } else dismissY.value = event.translationY;
    })
    .onEnd((event) => {
      if (zoomed) {
        settle();
        return;
      }
      if (
        Math.abs(event.translationY) > dismissDistance ||
        Math.abs(event.velocityY) > dismissVelocity
      )
        runOnJS(onDismiss)(event.velocityY);
      else dismissY.value = withSpring(0, { damping: 20, stiffness: 220 });
    });
  // Unzoomed, a horizontal move belongs to the pager.
  if (!zoomed) pan.activeOffsetY([-10, 10]).failOffsetX([-12, 12]);

  // Taps are judged on the JS side: no worklet state, and a single tap
  // waits for a possible second one (up to maxDelay) before toggling bars.
  const doubleTap = Gesture.Tap()
    .runOnJS(true)
    .numberOfTaps(2)
    .maxDelay(400)
    .maxDuration(800)
    .onEnd((event, success) => {
      if (success) zoomAt(event.x, event.y);
    });
  const singleTap = Gesture.Tap()
    .runOnJS(true)
    .maxDuration(800)
    .onEnd((_event, success) => {
      if (success) onToggleChrome();
    });
  const gesture = Gesture.Simultaneous(
    pinch,
    pan,
    Gesture.Exclusive(doubleTap, singleTap),
  );

  const transform = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { scale: scale.value },
    ],
  }));

  const label = item.kind === "video" ? t("mediaVideo") : t("mediaPhoto");
  return (
    <View style={{ width, height }}>
      <GestureDetector gesture={gesture}>
        <View
          testID={active ? "media-viewer-page" : undefined}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={label}
          accessibilityHint={t("mediaViewerHint")}
          accessibilityActions={[
            { name: "increment", label: t("mediaNext") },
            { name: "decrement", label: t("mediaPrevious") },
            {
              name: "activate",
              label: zoomed ? t("mediaZoomOut") : t("mediaZoomIn"),
            },
            { name: "escape", label: t("close") },
          ]}
          onAccessibilityAction={(event) => {
            const action = event.nativeEvent.actionName;
            if (action === "increment" && hasNext) onStep(1);
            else if (action === "decrement" && hasPrevious) onStep(-1);
            else if (action === "activate") zoomAt(width / 2, height / 2);
            else if (action === "escape") onDismiss();
          }}
          onAccessibilityEscape={() => onDismiss()}
          style={styles.page}
        >
          <Animated.View
            style={[
              { width: content.width, height: content.height },
              transform,
            ]}
          >
            {item.kind === "photo" ? (
              <PhotoContent item={item} onLoaded={setLoaded} />
            ) : (
              <VideoPosterContent item={item} />
            )}
          </Animated.View>
        </View>
      </GestureDetector>
      {/* A marker for UI tests: the page itself is one accessible element. */}
      {active && loaded ? (
        <View
          testID="media-viewer-loaded"
          pointerEvents="none"
          style={styles.marker}
        />
      ) : null}
      {item.kind === "video" && active ? (
        <VideoStage
          file={item.file}
          content={content}
          scale={scale}
          x={x}
          y={y}
          controls={chrome && !zoomed}
          bottomInset={insets.bottom}
        />
      ) : null}
    </View>
  );
}

function PhotoContent({
  item,
  onLoaded,
}: {
  item: MediaItem;
  onLoaded(loaded: boolean): void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const local = useLocalMedia(item.key);
  const full = useFileSource(local ? undefined : item.key);
  const preview = useFileSource(item.file.preview_file_id ?? undefined);
  const [state, setState] = useState<"loading" | "loaded" | "failed">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const source = local ? { uri: local } : full;
  return (
    <View style={StyleSheet.absoluteFill}>
      {source && (
        <Image
          key={attempt}
          source={source}
          placeholder={preview ?? undefined}
          placeholderContentFit="contain"
          contentFit="contain"
          cachePolicy="disk"
          style={StyleSheet.absoluteFill}
          accessibilityIgnoresInvertColors
          onLoad={(event) => {
            setState("loaded");
            onLoaded(true);
            const { width, height } = event.source;
            if (width > 0 && height > 0)
              recordMediaFacts(item.key, { aspect: width / height });
          }}
          onError={() => {
            setState("failed");
            onLoaded(false);
          }}
        />
      )}
      {state === "loading" && (
        <ActivityIndicator
          testID="media-viewer-loading"
          color="#ffffff"
          size="large"
          style={styles.center}
        />
      )}
      {state === "failed" && (
        <View style={styles.center}>
          <Text size={15} style={styles.white}>
            {t("photoLoadFailed")}
          </Text>
          <Pressable
            testID="media-viewer-retry"
            accessibilityRole="button"
            accessibilityLabel={t("retry")}
            onPress={() => {
              setState("loading");
              void queryClient
                .invalidateQueries({ queryKey: ["file-link", item.key] })
                .finally(() => setAttempt((value) => value + 1));
            }}
            style={styles.retry}
          >
            <RotateCw size={16} color="#ffffff" />
            <Text size={14} weight="semibold" style={styles.white}>
              {t("retry")}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** The video's first frame while its player is not on screen. */
function VideoPosterContent({ item }: { item: MediaItem }) {
  const poster = usePoster(item.key);
  return poster ? (
    <Image
      source={poster}
      contentFit="contain"
      style={StyleSheet.absoluteFill}
    />
  ) : null;
}

/** A crash in the viewer closes it instead of taking the chat down. */
class ViewerBoundary extends Component<
  { children: ReactNode; onClose(): void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[MediaViewer]", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <ViewerFallback onClose={this.props.onClose} />;
  }
}

function ViewerFallback({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  return (
    <View style={[styles.root, styles.black, styles.center]}>
      <Text size={15} style={styles.white}>
        {t("photoLoadFailed")}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("close")}
        onPress={onClose}
        style={styles.retry}
      >
        <Text size={14} weight="semibold" style={styles.white}>
          {t("close")}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  marker: { position: "absolute", left: 0, top: 0, width: 1, height: 1 },
  black: { backgroundColor: "#000000" },
  page: { flex: 1, alignItems: "center", justifyContent: "center" },
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  white: { color: "#ffffff" },
  dim: { color: "rgba(255, 255, 255, 0.75)" },
  top: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    paddingBottom: 8,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  title: { flex: 1, alignItems: "center" },
  counter: { minWidth: 44, textAlign: "right", paddingRight: 8 },
  button: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  bottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    justifyContent: "space-around",
    paddingTop: 8,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  barButton: {
    minWidth: 72,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    paddingHorizontal: 6,
    borderRadius: 12,
  },
  pressed: { backgroundColor: "rgba(255, 255, 255, 0.12)" },
  retry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    minHeight: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.16)",
  },
  notice: {
    position: "absolute",
    alignSelf: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: "rgba(40, 40, 44, 0.92)",
  },
});
