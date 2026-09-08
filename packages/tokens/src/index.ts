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
    surfaceSelected: "#e7edf4",
    foreground: "#182235",
    muted: "#566477",
    subtle: "#65728a",
    border: "#dce3ec",
    borderStrong: "#c9d3df",
    primary: "#174586",
    primaryHover: "#123a72",
    primarySoft: "#e3edf9",
    onPrimary: "#ffffff",
    avatarStart: "#174586",
    avatarEnd: "#3e76bc",
    avatar1: "#3f7778",
    avatar2: "#4c6ca6",
    avatar3: "#5d7196",
    avatar4: "#776b8e",
    avatar5: "#4f76a8",
    avatar6: "#5f7289",
    avatar7: "#8f677e",
    avatar8: "#587a96",
    online: "#13b96f",
    tooltip: "#182235",
    danger: "#bd3346",
    dangerSoft: "#fce8eb",
    success: "#247a54",
    folderBlue: "#2f6fca",
    folderViolet: "#7456c9",
    folderPink: "#c54f8b",
    folderRed: "#c54852",
    folderOrange: "#c86a2d",
    folderAmber: "#a97312",
    folderGreen: "#32845e",
    folderTeal: "#25857f",
    folderCyan: "#287f9d",
    folderSlate: "#607086",
    overlay: "rgba(14, 25, 43, 0.42)",
    shadow: "0 18px 48px rgba(20, 42, 72, 0.14)",
    threadShadow: "-12px 0 30px rgba(20, 42, 72, 0.08)",
  },
  dark: {
    canvas: "#181a1f",
    sidebar: "#1d2026",
    surface: "#202329",
    surfaceRaised: "#292d36",
    surfaceSelected: "#2a2e36",
    foreground: "#f0f1f5",
    muted: "#a9adbb",
    subtle: "#838896",
    border: "#343844",
    borderStrong: "#4b5263",
    primary: "#7f91ff",
    primaryHover: "#9aa8ff",
    primarySoft: "#2c3250",
    onPrimary: "#ffffff",
    avatarStart: "#22589d",
    avatarEnd: "#3d83d3",
    avatar1: "#4f8a8b",
    avatar2: "#5b7bb3",
    avatar3: "#6b7fa3",
    avatar4: "#8a7f9e",
    avatar5: "#7a9cc6",
    avatar6: "#8b9db5",
    avatar7: "#a0788f",
    avatar8: "#6f8fa8",
    online: "#2ee58d",
    tooltip: "#f0f1f5",
    danger: "#ff8a99",
    dangerSoft: "#49272f",
    success: "#48d59b",
    folderBlue: "#78a9ff",
    folderViolet: "#a995ff",
    folderPink: "#f08bc0",
    folderRed: "#ff8991",
    folderOrange: "#f3a06d",
    folderAmber: "#e6b85c",
    folderGreen: "#75cf9d",
    folderTeal: "#67cbc2",
    folderCyan: "#6ec5df",
    folderSlate: "#a4b0c1",
    overlay: "rgba(0, 0, 0, 0.62)",
    shadow: "none",
    threadShadow: "none",
  },
} as const;

export type ThemeName = keyof typeof themes;
export type ThemeTokens = (typeof themes)[ThemeName];

export const avatarPaletteSize = 8;

export function stableAvatarIndex(
  seed: string,
  paletteSize = avatarPaletteSize,
): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % paletteSize;
}
