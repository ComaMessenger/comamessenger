import { useEffect, useState } from "react";
import { cx } from "../ui";
import { brandingLogoURL } from "../lib/branding";
import { Mascot, mascotFeet } from "./Mascot";

type LogoSize = "xs" | "sm" | "md" | "lg" | "xl";

// Plate edge per size (shell.css); the mascot takes MASCOT_SHARE of it.
const plate: Record<LogoSize, number> = {
  xs: 22,
  sm: 28,
  md: 40,
  lg: 56,
  xl: 56,
};
const MASCOT_SHARE = 0.7;
// The animated loading mark is drawn without a plate (auth.css).
const SPLASH_HEIGHT = 72;

/**
 * Workspace brand mark: the uploaded logo when present, the Coma mascot
 * otherwise. `animated` lets the mascot hop on the loading screen.
 */
export function Logo({
  size = "md",
  animated,
  className,
}: {
  size?: LogoSize;
  animated?: boolean;
  className?: string;
}) {
  const [source, setSource] = useState(brandingLogoURL);
  const [state, setState] = useState<"pending" | "ready" | "missing">(
    "pending",
  );
  useEffect(() => {
    const refresh = () => {
      setSource(brandingLogoURL());
      setState("pending");
    };
    window.addEventListener("coma-branding-changed", refresh);
    return () => window.removeEventListener("coma-branding-changed", refresh);
  }, []);
  const custom = state === "ready";
  const height = animated ? SPLASH_HEIGHT : plate[size] * MASCOT_SHARE;
  return (
    <span
      className={cx(
        "brand-mark",
        `brand-mark--${size}`,
        !custom && "brand-mark--mascot",
        !custom && animated && "brand-mark--splash",
        className,
      )}
    >
      {!custom && <Mascot feet={mascotFeet(height)} animated={animated} />}
      {state !== "missing" && (
        <img
          key={source}
          src={source}
          alt=""
          hidden={!custom}
          onLoad={() => setState("ready")}
          onError={() => setState("missing")}
        />
      )}
    </span>
  );
}
