import { useEffect, useState } from "react";
import { cx } from "../ui";
import { brandingLogoURL, comaLogo } from "../lib/branding";

/** Workspace brand mark: the uploaded logo when present, the Coma glyph otherwise. */
export function Logo({
  size = "md",
  className,
}: {
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const [source, setSource] = useState(brandingLogoURL);
  useEffect(() => {
    const refresh = () => setSource(brandingLogoURL());
    window.addEventListener("coma-branding-changed", refresh);
    return () => window.removeEventListener("coma-branding-changed", refresh);
  }, []);
  return (
    <span className={cx("brand-mark", `brand-mark--${size}`, className)}>
      <img
        src={source}
        alt=""
        onError={(event) => {
          if (!event.currentTarget.src.endsWith(comaLogo))
            event.currentTarget.src = comaLogo;
        }}
      />
    </span>
  );
}
