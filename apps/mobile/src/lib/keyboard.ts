import { Platform } from "react-native";

/**
 * Scroll views that put the keyboard away when dragged. `interactive` exists on
 * iOS only; Android ignores it and keeps the keyboard open, so it gets
 * `on-drag` instead.
 */
export const dismissKeyboardOnDrag =
  Platform.OS === "ios" ? ("interactive" as const) : ("on-drag" as const);
