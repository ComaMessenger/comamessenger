import { createContext, useContext } from "react";
import type { AnchorRect } from "@/ui/AnchoredMenu";

/** Opens the full-screen viewer on a file; `origin` is its tile on screen. */
export type OpenMedia = (key: string, origin: AnchorRect | null) => void;

export const MediaViewerContext = createContext<OpenMedia | null>(null);

export function useOpenMedia() {
  return useContext(MediaViewerContext);
}
