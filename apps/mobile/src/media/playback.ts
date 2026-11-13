/**
 * One thing plays at a time: a voice message or a video. Whoever starts
 * claims playback, and the one playing before is paused. The voice side is
 * paused without releasing the audio session, so the video that took over
 * keeps its sound (and the other way round).
 */
type Pause = () => void;

let active: Pause | null = null;

export function claimPlayback(pause: Pause) {
  const previous = active;
  active = pause;
  if (previous && previous !== pause) previous();
}

export function releasePlayback(pause: Pause) {
  if (active === pause) active = null;
}
