import { useEffect, useState } from "react";

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia(query).matches,
  );
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export const mobileQuery = "(max-width: 640px)";

export function useIsMobile() {
  return useMediaQuery(mobileQuery);
}

/** Narrow desktop (641–900px): utility screens show either the list or the detail, not both. */
export const narrowDesktopQuery = "(max-width: 900px)";

export function useIsNarrowDesktop() {
  return useMediaQuery(narrowDesktopQuery);
}
