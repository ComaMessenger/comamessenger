/**
 * Where a known aspect came from. "full" is the photo itself (the picked
 * file, or the original once loaded); "preview" is the server's small copy,
 * which before the EXIF fix could lie on its side. A preview only fills in
 * what nothing better has said, so the tile and the viewer keep the same
 * proportions before and after the original loads instead of flipping
 * between the two each time one of them reloads.
 */
export type AspectSource = "full" | "preview";

export type AspectFacts = { aspect?: number; aspectFrom?: AspectSource };

/** The aspect to keep after `source` reported `aspect`; null keeps the old one. */
export function nextAspect(
  current: AspectFacts,
  aspect: number,
  source: AspectSource,
): AspectFacts | null {
  if (!(aspect > 0) || !Number.isFinite(aspect)) return null;
  // Facts written before sources were tracked count as a preview's.
  if (source === "preview" && current.aspectFrom === "full") return null;
  if (current.aspect === aspect && current.aspectFrom === source) return null;
  return { aspect, aspectFrom: source };
}
