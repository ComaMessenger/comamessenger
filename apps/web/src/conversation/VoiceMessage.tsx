import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { LoaderCircle, Pause, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  formatVoiceDuration,
  nextVoicePlaybackRate,
  waveformBars,
  type FileMetadata,
  type MessengerAPI,
  type VoiceInfo,
} from "@comamessenger/core";
import { cx } from "../ui";

const BARS = 40;
const SEEK_STEP_SECONDS = 5;
const AUTOPLAY_EVENT = "coma-voice-autoplay";

/** Only one recording plays at a time across the whole app. */
let activeAudio: HTMLAudioElement | null = null;
function claimPlayback(audio: HTMLAudioElement) {
  if (activeAudio && activeAudio !== audio) activeAudio.pause();
  activeAudio = audio;
}

/**
 * After a recording ends, the next message in the feed starts if it is a
 * voice message too; anything else in between stops the chain.
 */
function playNextVoice(from: HTMLElement) {
  const row = from.closest("article.message");
  if (!row) return;
  const feed = row.closest(".message-feed, .thread-panel") ?? document;
  const rows = Array.from(feed.querySelectorAll("article.message"));
  const next = rows[rows.indexOf(row) + 1];
  next
    ?.querySelector("[data-voice-player]")
    ?.dispatchEvent(new CustomEvent(AUTOPLAY_EVENT));
}

export function VoiceMessage({
  api,
  file,
}: {
  api: MessengerAPI;
  file: FileMetadata & { voice: VoiceInfo };
}) {
  const { t, i18n } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const objectURL = useRef<string | null>(null);
  const loading = useRef<Promise<HTMLAudioElement> | null>(null);
  const disposed = useRef(false);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "paused">(
    "idle",
  );
  const [position, setPosition] = useState(0);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);
  const bars = useMemo(
    () => waveformBars(file.voice.waveform, BARS),
    [file.voice.waveform],
  );
  const declaredSeconds = file.voice.duration_ms / 1000;

  useEffect(() => {
    // StrictMode mounts twice with the same refs, so every mount starts clean.
    disposed.current = false;
    return () => {
      // A download still in flight finds this flag and keeps nothing.
      disposed.current = true;
      audio.current?.pause();
      if (activeAudio === audio.current) activeAudio = null;
      if (objectURL.current) URL.revokeObjectURL(objectURL.current);
      audio.current = null;
      objectURL.current = null;
      loading.current = null;
    };
  }, []);

  function durationSeconds() {
    const value = audio.current?.duration;
    return value && Number.isFinite(value) ? value : declaredSeconds;
  }

  /** Downloads the recording on first use; a blob URL seeks without Range. */
  function load(): Promise<HTMLAudioElement> {
    if (audio.current) return Promise.resolve(audio.current);
    if (loading.current) return loading.current;
    setState("loading");
    setFailed(false);
    loading.current = api
      .downloadFile(file.id)
      .then((blob) => {
        if (disposed.current) throw new Error("voice player unmounted");
        const url = URL.createObjectURL(blob);
        objectURL.current = url;
        const element = new Audio(url);
        element.preload = "auto";
        element.addEventListener("timeupdate", () =>
          setPosition(element.currentTime),
        );
        element.addEventListener("play", () => {
          claimPlayback(element);
          setState("playing");
        });
        element.addEventListener("pause", () =>
          setState(element.ended ? "idle" : "paused"),
        );
        element.addEventListener("ended", () => {
          setState("idle");
          setPosition(0);
          element.currentTime = 0;
          if (root.current) playNextVoice(root.current);
        });
        audio.current = element;
        return element;
      })
      .catch((error: unknown) => {
        loading.current = null;
        if (!disposed.current) {
          setState("idle");
          setFailed(true);
        }
        throw error;
      });
    return loading.current;
  }

  async function play() {
    try {
      const element = await load();
      element.playbackRate = rate;
      claimPlayback(element);
      await element.play();
    } catch {
      setState(audio.current ? "paused" : "idle");
    }
  }

  function toggle() {
    if (state === "playing") audio.current?.pause();
    else void play();
  }

  async function seek(seconds: number, resume: boolean) {
    try {
      const element = await load();
      const target = Math.min(Math.max(0, seconds), durationSeconds());
      element.currentTime = target;
      setPosition(target);
      if (resume && element.paused) await play();
      else if (state === "loading") setState("paused");
    } catch {
      setState("idle");
    }
  }

  function seekByPointer(event: MouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );
    void seek(ratio * durationSeconds(), state !== "paused");
  }

  function seekByKey(event: KeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, number> = {
      ArrowRight: SEEK_STEP_SECONDS,
      ArrowUp: SEEK_STEP_SECONDS,
      ArrowLeft: -SEEK_STEP_SECONDS,
      ArrowDown: -SEEK_STEP_SECONDS,
    };
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      void seek(event.key === "Home" ? 0 : durationSeconds(), false);
    } else if (steps[event.key] !== undefined) {
      event.preventDefault();
      void seek(position + steps[event.key]!, false);
    }
  }

  function cycleRate() {
    const next = nextVoicePlaybackRate(rate);
    setRate(next);
    if (audio.current) audio.current.playbackRate = next;
  }

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const autoplay = () => void play();
    element.addEventListener(AUTOPLAY_EVENT, autoplay);
    return () => element.removeEventListener(AUTOPLAY_EVENT, autoplay);
  });

  const total = audio.current ? durationSeconds() : declaredSeconds;
  const progress = total > 0 ? Math.min(1, position / total) : 0;
  const listening = state === "playing" || state === "paused" || position > 0;
  const totalLabel = formatVoiceDuration(file.voice.duration_ms);
  const elapsedLabel = formatVoiceDuration(position * 1000);
  const rateLabel = `${new Intl.NumberFormat(i18n.language).format(rate)}×`;

  return (
    <div
      ref={root}
      className={cx(
        "voice-message",
        state === "playing" && "voice-message--playing",
      )}
      data-voice-player=""
      role="group"
      aria-label={t("voiceMessageLabel", { duration: totalLabel })}
    >
      <button
        type="button"
        className="voice-message__play"
        onClick={toggle}
        aria-label={state === "playing" ? t("voicePause") : t("voicePlay")}
        aria-busy={state === "loading" || undefined}
      >
        {state === "loading" ? (
          <LoaderCircle className="voice-message__spinner" aria-hidden="true" />
        ) : state === "playing" ? (
          <Pause aria-hidden="true" />
        ) : (
          <Play aria-hidden="true" />
        )}
      </button>
      <div className="voice-message__body">
        <div
          className="voice-message__wave"
          role="slider"
          tabIndex={0}
          aria-label={t("voiceSeek")}
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(position)}
          aria-valuetext={`${elapsedLabel} / ${totalLabel}`}
          onClick={seekByPointer}
          onKeyDown={seekByKey}
        >
          {bars.map((height, index) => (
            <i
              key={index}
              className={cx(
                (index + 0.5) / bars.length <= progress && "is-played",
              )}
              style={{ height: `${Math.max(3, Math.round(24 * height))}px` }}
            />
          ))}
        </div>
        <div className="voice-message__meta">
          <span>
            {listening ? `${elapsedLabel} / ${totalLabel}` : totalLabel}
          </span>
          {listening && (
            <button
              type="button"
              className="voice-message__rate"
              onClick={cycleRate}
              aria-label={t("voiceSpeed", { rate: rateLabel })}
            >
              {rateLabel}
            </button>
          )}
          {failed && (
            <span className="voice-message__error">{t("voiceLoadFailed")}</span>
          )}
        </div>
      </div>
    </div>
  );
}
