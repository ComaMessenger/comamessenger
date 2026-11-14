import { describe, expect, it } from "vitest";
import { mascot } from "@comamessenger/tokens";
import {
  DELIVER_FADE_AT,
  FADE_MS,
  REST_POSE,
  RISE_MS,
  STEP_FRAMES,
  STEP_MS,
  STRIDE,
  bodyPath,
  doneAt,
  fadeStartAt,
  feetPath,
  relativeOutline,
  splashPose,
  stopAt,
  trackPath,
  type SplashFinale,
} from "./splashWalk";

const LOADING = Infinity;
const GROUND = mascot.feet.regular[0][1];
const finales: SplashFinale[] = ["quick", "delivered"];

/** Start of every frame of the walk, over a few steps. */
function frameStarts(steps: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < steps; s++) {
    let t = RISE_MS + s * STEP_MS;
    for (const f of STEP_FRAMES) {
      out.push(t);
      t += f.ms;
    }
  }
  return out;
}

describe("splash walk frames", () => {
  it("starts from exactly the native splash frame", () => {
    for (const finale of finales) {
      expect(splashPose(0, LOADING, finale, false)).toEqual(REST_POSE);
    }
    expect(REST_POSE.feet).toEqual(
      mascot.feet.regular.flatMap(([x, y]) => [x, y]),
    );
  });

  it("keeps the body outline identical after making it relative", () => {
    const outline = relativeOutline(mascot.body);
    const abs = outline.tail.replace(/z$/, "").match(/[hv]-?\d+/g) ?? [];
    let x = outline.x;
    let y = outline.y;
    let rebuilt = `M${x} ${y}`;
    for (const seg of abs) {
      const n = Number(seg.slice(1));
      if (seg[0] === "h") rebuilt += `H${(x += n)}`;
      else rebuilt += `V${(y += n)}`;
    }
    expect(`${rebuilt}Z`).toBe(mascot.body);
    expect(bodyPath(REST_POSE)).toBe(
      `M${outline.x} ${outline.y}${outline.tail}`,
    );
  });

  it("is a cycle: every footfall repeats the same pose", () => {
    const first = splashPose(RISE_MS, LOADING, "quick", false);
    for (let s = 1; s < 6; s++) {
      const pose = splashPose(RISE_MS + s * STEP_MS, LOADING, "quick", false);
      expect(pose.feet).toEqual(first.feet);
      expect(pose.bodyY).toBe(first.bodyY);
      expect(pose.trackShift).toBe(s * STRIDE);
    }
    // Both feet are down on a footfall: the icon's stance, lifted on legs.
    expect(first.feet).toEqual(REST_POSE.feet);
    expect(first.bodyY).toBeLessThan(0);
  });

  it("swings the rear foot over the planted one, hand over hand", () => {
    const [, lift, over, reach] = STEP_FRAMES.map((_, i) =>
      splashPose(frameStarts(1)[i]!, LOADING, "quick", false),
    );
    for (const pose of [lift!, over!, reach!]) {
      expect(pose.feet[1]).toBeLessThan(GROUND); // rear foot in the air
      expect(pose.feet[3]).toBe(GROUND); // front foot planted
    }
    // Mid-swing the lifted foot is right above the planted one.
    expect(over!.feet[0]).toBe(over!.feet[2]);
    // It moves forward frame by frame, the planted one slides back with the track.
    expect(lift!.feet[0]).toBeLessThan(over!.feet[0]);
    expect(over!.feet[0]).toBeLessThan(reach!.feet[0]);
    expect(lift!.feet[2]).toBeGreaterThan(reach!.feet[2]);
  });

  it("barely bobs the body and moves only in whole frames", () => {
    const ys = new Set(
      Array.from(
        { length: 2000 },
        (_, t) => splashPose(RISE_MS + t, LOADING, "quick", false).bodyY,
      ),
    );
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(6);
    // Within a frame nothing changes: the motion is stepped, not tweened.
    for (const t of frameStarts(3)) {
      const a = splashPose(t, LOADING, "quick", false);
      const b = splashPose(t + 40, LOADING, "quick", false);
      expect(feetPath(b)).toBe(feetPath(a));
    }
  });

  it("draws legs only while the body stands up on them", () => {
    const legs = (path: string) => (path.match(/M/g) ?? []).length - 2;
    expect(legs(feetPath(REST_POSE))).toBe(0);
    expect(legs(feetPath(splashPose(RISE_MS, LOADING, "quick", false)))).toBe(
      2,
    );
  });

  it("scrolls the track under the feet", () => {
    const a = splashPose(RISE_MS, LOADING, "quick", false);
    const b = splashPose(RISE_MS + STEP_FRAMES[0].ms, LOADING, "quick", false);
    expect(trackPath(a, 0, 600)).not.toBe(trackPath(b, 0, 600));
    // A whole stride later the pattern is back in place.
    const c = splashPose(RISE_MS + STEP_MS, LOADING, "quick", false);
    expect(trackPath(c, 0, 600)).toBe(trackPath(a, 0, 600));
    expect(trackPath(REST_POSE, 1, 600)).toBe("M0 0");
  });
});

describe("splash timing", () => {
  it("keeps walking while the app loads", () => {
    for (const finale of finales) {
      expect(stopAt(LOADING, finale)).toBe(Infinity);
      expect(doneAt(LOADING, finale, false)).toBe(Infinity);
      expect(splashPose(60_000, LOADING, finale, false).opacity).toBe(1);
    }
  });

  it("stops on a footfall no later than one step after the app is ready", () => {
    for (let ready = 0; ready < 5000; ready += 7) {
      for (const finale of finales) {
        const stop = stopAt(ready, finale);
        expect(stop).toBeGreaterThanOrEqual(ready);
        expect(stop - ready).toBeLessThanOrEqual(STEP_MS);
        const pose = splashPose(stop, ready, finale, false);
        if (stop >= RISE_MS) expect(pose.feet[1]).toBe(GROUND);
      }
    }
  });

  it("quick: starts fading within 0.4 s and holds the stopped pose", () => {
    for (let ready = 0; ready < 5000; ready += 13) {
      const fade = fadeStartAt(ready, "quick", false);
      expect(fade - ready).toBeLessThanOrEqual(400);
      expect(doneAt(ready, "quick", false)).toBe(fade + FADE_MS);
      const held = splashPose(fade + 100, ready, "quick", false);
      expect(held.feet).toEqual(splashPose(fade, ready, "quick", false).feet);
      expect(held.opacity).toBeGreaterThan(0);
      expect(held.opacity).toBeLessThan(1);
      expect(splashPose(fade + FADE_MS, ready, "quick", false).opacity).toBe(0);
    }
    // Ready before the first frame: the icon frame just fades.
    expect(fadeStartAt(0, "quick", false)).toBe(0);
  });

  it("delivered: sits down, unhooks the bubble, shows ✓✓, then fades", () => {
    const ready = 1000;
    const stop = stopAt(ready, "delivered");
    const at = (d: number) => splashPose(stop + d, ready, "delivered", false);
    expect(at(0).tether).toBe(1);
    expect(at(0).delivered).toBe(false);
    expect(at(100).tether).toBe(0.5);
    const after = at(250);
    expect(after.tether).toBe(0);
    expect(after.delivered).toBe(true);
    expect(after.bodyY).toBe(0);
    expect(after.feet).toEqual(REST_POSE.feet);
    expect(after.opacity).toBe(1);
    expect(fadeStartAt(ready, "delivered", false)).toBe(stop + DELIVER_FADE_AT);
    expect(at(DELIVER_FADE_AT + FADE_MS).opacity).toBe(0);
    // There is always a bubble to deliver, even when ready at once.
    expect(stopAt(0, "delivered")).toBe(RISE_MS);
  });

  it("reduce motion: the icon stands still and fades as soon as the app is ready", () => {
    for (const finale of finales) {
      for (const t of [0, 300, 1700]) {
        const pose = splashPose(t, LOADING, finale, true);
        expect({ ...pose, opacity: 1 }).toEqual(REST_POSE);
        expect(pose.opacity).toBe(1);
      }
      expect(fadeStartAt(500, finale, true)).toBe(500);
      expect(splashPose(610, 500, finale, true).opacity).toBeCloseTo(0.5);
      expect(doneAt(500, finale, true)).toBe(500 + FADE_MS);
    }
  });
});
