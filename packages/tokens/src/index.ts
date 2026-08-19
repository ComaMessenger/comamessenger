export const fontFamily =
  '"Onest Variable", Onest, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif';

export const spacing = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

export const radius = { sm: 6, md: 9, lg: 12, xl: 16, full: 999 } as const;
export const motion = {
  fast: 120,
  normal: 160,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
} as const;

export const themes = {
  light: {
    canvas: "#f3f6fa",
    sidebar: "#eef3f8",
    surface: "#ffffff",
    surfaceRaised: "#ffffff",
    foreground: "#182235",
    muted: "#566477",
    subtle: "#566477",
    border: "#dce3ec",
    borderStrong: "#c9d3df",
    primary: "#174586",
    primaryHover: "#123a72",
    primarySoft: "#e3edf9",
    onPrimary: "#ffffff",
    avatarStart: "#174586",
    avatarEnd: "#3e76bc",
    online: "#247a54",
    tooltip: "#182235",
    danger: "#bd3346",
    dangerSoft: "#fce8eb",
    success: "#247a54",
    overlay: "rgba(14, 25, 43, 0.42)",
    shadow: "0 18px 48px rgba(20, 42, 72, 0.14)",
    threadShadow: "-12px 0 30px rgba(20, 42, 72, 0.08)",
  },
  dark: {
    canvas: "#111722",
    sidebar: "#161e2b",
    surface: "#1b2533",
    surfaceRaised: "#222e3e",
    foreground: "#edf3fb",
    muted: "#9aa8ba",
    subtle: "#7f8da0",
    border: "#2c394a",
    borderStrong: "#405068",
    primary: "#7ea9e6",
    primaryHover: "#9bbded",
    primarySoft: "#213957",
    onPrimary: "#111722",
    avatarStart: "#315f9d",
    avatarEnd: "#6392ce",
    online: "#78d5a5",
    tooltip: "#edf3fb",
    danger: "#ff8a99",
    dangerSoft: "#4a2530",
    success: "#78d5a5",
    overlay: "rgba(0, 0, 0, 0.62)",
    shadow: "0 18px 48px rgba(0, 0, 0, 0.32)",
    threadShadow: "-12px 0 30px rgba(0, 0, 0, 0.24)",
  },
} as const;

export type ThemeName = keyof typeof themes;
export type ThemeTokens = (typeof themes)[ThemeName];

export function stableAvatarIndex(seed: string, paletteSize = 8): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % paletteSize;
}
