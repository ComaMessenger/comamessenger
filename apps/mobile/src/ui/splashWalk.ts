import { mascot } from "@comamessenger/tokens";

/**
 * Frame logic of the animated splash: the mascot walks in place like a kinesin
 * motor protein — feet hand over hand on a moving track, a message bubble in
 * tow. Everything here is a pure worklet so AnimatedSplash can run it on the UI
 * thread and tests can run it in Node. Units are those of the mascot source.
 *
 * The prototype the owner picked: design/prototypes/splash/index.html
 * (variant 1 «Идёт», «На месте»).
 */

export type SplashFinale = "quick" | "delivered";

/**
 * How the splash hands over to the app once it is ready:
 * - "quick": on the next footfall the screen fades out (never holds the app
 *   more than STEP_MS + FADE_MS);
 * - "delivered": the mascot sits down, unhooks the bubble, shows ✓✓, then
 *   fades (DELIVER_FADE_AT ms longer).
 */
export const SPLASH_FINALE: SplashFinale = "quick";

export const FADE_MS = 220;
/** Rising onto its legs before the first step. */
export const RISE_MS = 180;
/** "delivered": from the footfall to the start of the fade. */
export const DELIVER_FADE_AT = 360;

const [FOOT_LEFT, FOOT_RIGHT] = mascot.feet.regular;
const [EYE_LEFT, EYE_RIGHT] = mascot.eyes;
const GROUND = FOOT_LEFT[1];
const FOOT_W = FOOT_LEFT[2];
const FOOT_H = FOOT_LEFT[3];
const EYE = EYE_LEFT[2];
/** The body advances by the gap between the feet on every step. */
export const STRIDE = FOOT_RIGHT[0] - FOOT_LEFT[0];
/** How high the body stands on its legs while walking. */
const STANCE = 36;

/**
 * One step: the rear foot lifts, swings over the planted one and lands a
 * double stride ahead while the body advances one stride. `swing` is the rear
 * foot's offset from where it started; `y` is the body offset.
 */
export const STEP_FRAMES = [
  { ms: 130, advance: 0, y: -STANCE, swingX: 0, swingY: GROUND }, // both feet down
  { ms: 85, advance: 22, y: -STANCE, swingX: 56, swingY: 480 }, // rear foot lifts
  { ms: 100, advance: 44, y: -42, swingX: STRIDE, swingY: 462 }, // right over the planted one
  { ms: 85, advance: 66, y: -STANCE, swingX: 140, swingY: 482 }, // reaching down ahead
] as const;
export const STEP_MS = STEP_FRAMES.reduce((sum, f) => sum + f.ms, 0);

/** The cargo trails the body by this long, so it reads as being towed. */
const CARGO_LAG = 90;
const BLINK_FIRST = 1300;
const BLINK_EVERY = 2200;
const BLINK_MS = 100;

export interface SplashPose {
  bodyX: number;
  bodyY: number;
  /** Rear and front foot, top-left corners. */
  feet: [number, number, number, number];
  eyeDx: number;
  eyeDy: number;
  eyeH: number;
  /** 0 hidden, 1 tether only, 2 tether and bubble. */
  cargo: 0 | 1 | 2;
  cargoX: number;
  cargoY: number;
  /** Share of the tether still attached, from the body up. */
  tether: number;
  delivered: boolean;
  /** Share of the track drawn, from the centre out. */
  track: number;
  /** World offset of the camera: the track scrolls by it. */
  trackShift: number;
  opacity: number;
}

const REST_FEET: SplashPose["feet"] = [
  FOOT_LEFT[0],
  GROUND,
  FOOT_RIGHT[0],
  GROUND,
];

/** The native splash frame: the mascot as on the icon, nothing else. */
export const REST_POSE: SplashPose = {
  bodyX: 0,
  bodyY: 0,
  feet: REST_FEET,
  eyeDx: 0,
  eyeDy: 0,
  eyeH: EYE,
  cargo: 0,
  cargoX: 0,
  cargoY: 0,
  tether: 0,
  delivered: false,
  track: 0,
  trackShift: 0,
  opacity: 1,
};

/**
 * When the walk stops for the finale: the first footfall at or after the app
 * became ready. `readyAt` is Infinity while it is still loading.
 */
export function stopAt(readyAt: number, finale: SplashFinale): number {
  "worklet";
  if (!(readyAt < Infinity)) return Infinity;
  // The icon frame itself is a fine place to stop, unless there is a bubble to deliver.
  if (readyAt <= 0 && finale === "quick") return 0;
  if (readyAt <= RISE_MS) return RISE_MS;
  return RISE_MS + Math.ceil((readyAt - RISE_MS) / STEP_MS) * STEP_MS;
}

/** When the overlay starts fading out. */
export function fadeStartAt(
  readyAt: number,
  finale: SplashFinale,
  reduced: boolean,
): number {
  "worklet";
  if (reduced) return readyAt;
  const stop = stopAt(readyAt, finale);
  return finale === "quick" ? stop : stop + DELIVER_FADE_AT;
}

/** When the overlay is gone and can be unmounted. */
export function doneAt(
  readyAt: number,
  finale: SplashFinale,
  reduced: boolean,
): number {
  "worklet";
  return fadeStartAt(readyAt, finale, reduced) + FADE_MS;
}

function walkAt(t: number) {
  "worklet";
  const step = Math.floor(t / STEP_MS);
  let within = t - step * STEP_MS;
  let i = 0;
  while (i < STEP_FRAMES.length - 1 && within >= STEP_FRAMES[i]!.ms) {
    within -= STEP_FRAMES[i]!.ms;
    i++;
  }
  const frame = STEP_FRAMES[i]!;
  const base = step * STRIDE;
  return {
    base,
    x: base + frame.advance,
    y: frame.y,
    rear: [base + FOOT_LEFT[0] + frame.swingX, frame.swingY] as const,
    front: [base + FOOT_RIGHT[0], GROUND] as const,
  };
}

/** The walking pose `t` ms after the overlay appeared, before any finale. */
function walking(t: number): SplashPose {
  "worklet";
  if (t < RISE_MS) {
    // The first frame is the native splash itself, so the handover has no jump.
    if (t < RISE_MS / 3) return REST_POSE;
    const first = t < (RISE_MS * 2) / 3;
    return {
      ...REST_POSE,
      bodyY: first ? -STANCE / 2 : -STANCE,
      cargo: first ? 0 : 1,
      tether: 0.5,
      track: first ? 0.3 : 0.7,
    };
  }
  const walk = walkAt(t - RISE_MS);
  const lag = walkAt(Math.max(0, t - RISE_MS - CARGO_LAG));
  // In place: the camera follows the body and the track runs under it.
  const cam = walk.x;
  const blink = t >= BLINK_FIRST && (t - BLINK_FIRST) % BLINK_EVERY < BLINK_MS;
  return {
    bodyX: 0,
    bodyY: walk.y,
    feet: [
      walk.rear[0] - cam,
      walk.rear[1],
      walk.front[0] - cam,
      walk.front[1],
    ],
    eyeDx: 6,
    eyeDy: 0,
    eyeH: blink ? 6 : EYE,
    cargo: 2,
    cargoX: lag.x - cam,
    cargoY: lag.y,
    tether: 1,
    delivered: false,
    track: 1,
    trackShift: cam,
    opacity: 1,
  };
}

function fade(t: number, from: number): number {
  "worklet";
  return t <= from ? 1 : Math.max(0, 1 - (t - from) / FADE_MS);
}

/** Everything drawn at `t` ms after the overlay appeared. */
export function splashPose(
  t: number,
  readyAt: number,
  finale: SplashFinale,
  reduced: boolean,
): SplashPose {
  "worklet";
  if (reduced) return { ...REST_POSE, opacity: fade(t, readyAt) };
  const stop = stopAt(readyAt, finale);
  if (t < stop) return walking(t);
  if (finale === "quick") {
    return { ...walking(stop), opacity: fade(t, stop) };
  }
  // "delivered": settle into the icon pose, unhook the bubble, ✓✓, fade.
  const d = t - stop;
  const standing = walking(stop);
  const looking = d >= 160;
  const blink = d >= 300 && d < 390;
  return {
    ...standing,
    bodyY: d < 80 ? -STANCE / 2 : 0,
    feet: REST_FEET,
    eyeDx: looking ? -6 : 6,
    eyeDy: looking ? -6 : 0,
    eyeH: blink ? 6 : EYE,
    cargo: 2,
    cargoX: 0,
    cargoY: looking ? -12 : 0,
    tether: d < 80 ? 1 : d < 160 ? 0.5 : 0,
    delivered: d >= 240,
    opacity: fade(d, DELIVER_FADE_AT),
  };
}

// ---------------------------------------------------------------- Paths

/** An empty path that every renderer accepts. */
export const EMPTY = "M0 0";

function rect(x: number, y: number, w: number, h: number): string {
  "worklet";
  return `M${x} ${y}h${w}v${h}h${-w}z`;
}

/** The body outline with relative segments, so moving it rewrites only `M`. */
export function relativeOutline(d: string): {
  x: number;
  y: number;
  tail: string;
} {
  const tokens = d.match(/[MHVZ]|-?\d+(?:\.\d+)?/g) ?? [];
  let x = 0;
  let y = 0;
  let start = { x: 0, y: 0 };
  let tail = "";
  for (let i = 0; i < tokens.length; i++) {
    const cmd = tokens[i];
    if (cmd === "M") {
      x = Number(tokens[++i]);
      y = Number(tokens[++i]);
      start = { x, y };
    } else if (cmd === "H") {
      const next = Number(tokens[++i]);
      tail += `h${next - x}`;
      x = next;
    } else if (cmd === "V") {
      const next = Number(tokens[++i]);
      tail += `v${next - y}`;
      y = next;
    } else if (cmd === "Z") {
      tail += "z";
    } else {
      throw new Error(`Unexpected token in the mascot outline: ${cmd}`);
    }
  }
  return { ...start, tail };
}

const OUTLINE = relativeOutline(mascot.body);
const BUBBLE = { x: 150, y: 20, w: 180, h: 102 };
const TETHER_BODY = { x: 352, y: 199 };
const TETHER_BUBBLE_X = 300;

function tetherPath(p: SplashPose): string {
  "worklet";
  const ax = p.cargoX + TETHER_BUBBLE_X;
  const ay = p.cargoY + BUBBLE.y + BUBBLE.h;
  const bx = p.bodyX + TETHER_BODY.x;
  const by = p.bodyY + TETHER_BODY.y;
  const n = Math.max(3, Math.round(Math.hypot(bx - ax, by - ay) / 12));
  let d = "";
  for (let i = 0; i <= n; i++) {
    if (i / n < 1 - p.tether) continue;
    const x = Math.round((ax + ((bx - ax) * i) / n) / 2) * 2;
    const y = Math.round((ay + ((by - ay) * i) / n) / 2) * 2;
    d += rect(x - 5, y - 6, 10, 12);
  }
  return d;
}

/** Body, bubble and tether: everything in the body colour. */
export function bodyPath(p: SplashPose): string {
  "worklet";
  let d = `M${OUTLINE.x + p.bodyX} ${OUTLINE.y + p.bodyY}${OUTLINE.tail}`;
  if (p.cargo >= 1 && p.tether > 0) d += tetherPath(p);
  if (p.cargo === 2) {
    const x = p.cargoX + BUBBLE.x;
    const y = p.cargoY + BUBBLE.y;
    d += rect(x + 12, y, BUBBLE.w - 24, BUBBLE.h);
    d += rect(x, y + 12, 12, BUBBLE.h - 24);
    d += rect(x + BUBBLE.w - 12, y + 12, 12, BUBBLE.h - 24);
  }
  return d;
}

const CHECK = [
  [0, 2],
  [1, 3],
  [2, 2],
  [3, 1],
  [4, 0],
] as const;

/** Eyes and the bubble's content (typing dots or ✓✓): the eye colour. */
export function eyesPath(p: SplashPose): string {
  "worklet";
  let d = "";
  for (const [x, y] of [EYE_LEFT, EYE_RIGHT]) {
    const top = y + (EYE - p.eyeH) / 2;
    d += rect(x + p.bodyX + p.eyeDx, top + p.bodyY + p.eyeDy, EYE, p.eyeH);
  }
  if (p.cargo === 2) {
    const cx = p.cargoX + BUBBLE.x + BUBBLE.w / 2;
    const cy = p.cargoY + BUBBLE.y + BUBBLE.h / 2;
    if (p.delivered) {
      for (const shift of [0, 4]) {
        for (const [c, r] of CHECK) {
          d += rect(cx - 54 + (c + shift) * 12, cy - 24 + r * 12, 12, 12);
        }
      }
    } else {
      for (const o of [-36, 0, 36]) d += rect(cx + o - 10, cy - 10, 20, 20);
    }
  }
  return d;
}

/** Feet, and the legs that show when the body stands up on them. */
export function feetPath(p: SplashPose): string {
  "worklet";
  const bottom = GROUND + p.bodyY;
  const left = OUTLINE.x - 14 + p.bodyX; // the body's narrowest bottom row: 284..374
  let d = "";
  for (let i = 0; i < 4; i += 2) {
    const x = p.feet[i]!;
    const y = p.feet[i + 1]!;
    if (y > bottom) {
      const legX = Math.min(Math.max(x + 18, left), left + 78);
      d += rect(legX, bottom, 12, y - bottom);
    }
    d += rect(x, y, FOOT_W, FOOT_H);
  }
  return d;
}

/** The track's two alternating tones, `half` units each side of the mascot. */
export function trackPath(p: SplashPose, tone: 0 | 1, half: number): string {
  "worklet";
  if (p.track <= 0) return EMPTY;
  const centre = OUTLINE.x + 52; // the middle of the mascot's box
  const reach = Math.round(half * p.track);
  const from = centre - reach;
  const to = centre + reach;
  const start = tone === 0 ? 0 : 44;
  const width = tone === 0 ? 42 : 43;
  let d = "";
  // World positions: the pattern moves left as the camera moves right.
  let k = Math.floor((from + p.trackShift) / STRIDE) - 1;
  for (; k * STRIDE - p.trackShift < to; k++) {
    const a = Math.max(k * STRIDE + start - p.trackShift, from);
    const b = Math.min(k * STRIDE + start + width - p.trackShift, to);
    if (b > a) d += rect(a, GROUND + FOOT_H, b - a, 12);
  }
  return d || EMPTY;
}
