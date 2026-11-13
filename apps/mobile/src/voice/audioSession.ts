import { Platform } from "react-native";
import {
  createAudioPlayer,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type AudioPlayer,
} from "expo-audio";

/**
 * Audio session for voice messages.
 *
 * - Playback and recording use `doNotMix`: other apps' music pauses while
 *   a voice message plays or records, and `playsInSilentMode` keeps voice
 *   audible with the iOS ring/silent switch on.
 * - iOS: after recording the session is deactivated with
 *   notifyOthersOnDeactivation (expo-audio does that in
 *   setIsAudioActiveAsync(false)), so the paused music resumes.
 * - Android: expo-audio asks for audio focus only when a player starts, not
 *   for the recorder. A silent looping player at zero volume holds the focus
 *   during recording; pausing it releases the focus and music resumes.
 * - Nothing plays or records in the background: the app has no background
 *   audio mode, and the recorder stops when the app leaves the foreground.
 */

let focusHolder: AudioPlayer | null = null;

function holdAndroidFocus(hold: boolean) {
  if (Platform.OS !== "android") return;
  try {
    if (hold) {
      focusHolder ??= createAudioPlayer(
        require("../../assets/voice/silence.wav"),
      );
      focusHolder.loop = true;
      focusHolder.volume = 0;
      focusHolder.play();
    } else focusHolder?.pause();
  } catch {
    // Without the focus music keeps playing under the recording; not fatal.
  }
}

export async function enterRecordingMode() {
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    interruptionMode: "doNotMix",
    shouldPlayInBackground: false,
    allowsBackgroundRecording: false,
    shouldRouteThroughEarpiece: false,
  });
  await setIsAudioActiveAsync(true);
  holdAndroidFocus(true);
}

/** Leaves recording; on iOS hands the audio back to other apps. */
export async function leaveRecordingMode() {
  holdAndroidFocus(false);
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
    interruptionMode: "doNotMix",
    shouldPlayInBackground: false,
  }).catch(() => undefined);
  if (Platform.OS === "ios")
    await setIsAudioActiveAsync(false).catch(() => undefined);
}

export async function enterPlaybackMode() {
  // iOS activates the session on play(). The player keeps it active
  // (keepAudioSessionActive): expo-audio would otherwise deactivate it 100 ms
  // after the end, which stops the next voice message starting meanwhile.
  // leavePlaybackMode hands the audio back when nothing more plays.
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
    interruptionMode: "doNotMix",
    shouldPlayInBackground: false,
  });
}

/** Nothing plays any more: on iOS other apps' music resumes. */
export function leavePlaybackMode() {
  if (Platform.OS === "ios")
    void setIsAudioActiveAsync(false).catch(() => undefined);
}
