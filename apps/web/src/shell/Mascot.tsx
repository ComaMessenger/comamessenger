import {
  MASCOT_BOLD_FEET_BELOW,
  mascot,
  type MascotFeet,
} from "@comamessenger/tokens";
import { cx } from "../ui";

const rects = (list: readonly (readonly number[])[]) =>
  list.map(([x, y, width, height]) => (
    <rect key={`${x}:${y}`} x={x} y={y} width={width} height={height} />
  ));

/** Feet variant for a mascot drawn `height` CSS pixels tall. */
export function mascotFeet(height: number): MascotFeet {
  return height < MASCOT_BOLD_FEET_BELOW ? "bold" : "regular";
}

/**
 * The Coma mascot. Colours come from the --coma-mascot-* theme tokens, so it
 * follows the theme the user picked rather than the system one. `animated`
 * makes it hop and blink (disabled under prefers-reduced-motion).
 */
export function Mascot({
  feet,
  animated,
  className,
}: {
  feet: MascotFeet;
  animated?: boolean;
  className?: string;
}) {
  const box = mascot.viewBox[feet];
  return (
    <svg
      className={cx(
        "coma-mascot",
        animated && "coma-mascot--animated",
        className,
      )}
      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <g className="coma-mascot__feet">{rects(mascot.feet[feet])}</g>
      <g className="coma-mascot__figure">
        <path className="coma-mascot__body" d={mascot.body} />
        <g className="coma-mascot__eyes">{rects(mascot.eyes)}</g>
      </g>
    </svg>
  );
}
