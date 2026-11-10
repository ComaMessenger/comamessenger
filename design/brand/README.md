# Coma brand assets

The Coma mascot is a pixel-art comma with eyes and feet.

- `coma-mascot-source.svg` is the drawn source.
- `generate.mjs` holds the geometry and the palette and is the only place they live. Everything else is generated from it:
  - `packages/tokens/src/mascot.ts`: the geometry, per-theme colours and the feet threshold. The web `Mascot` component and the mobile `WorkspaceMark` and `AnimatedSplash` draw from it;
  - `apps/web/public/favicon.svg`: the browser tab icon. It follows the browser colour scheme through its own media query;
  - `apps/web/public/*.png`: the iOS touch icon and the web push icon and badge;
  - `apps/mobile/assets/*.png`: app icons, splash images and the Android notification icon.

## Rules

- The body uses the product colour, `#174586` on light and `#86AFF0` on dark. It never takes the workspace accent.
- Light theme: white background, white eyes, `#242831` feet. Dark theme: `#151517` background, white eyes and feet.
- Below 48 px of mascot height the feet are drawn bold (`FEET.bold`); otherwise they use the drawn size (`FEET.regular`).
- On the web the colours come from the `--coma-mascot-*` tokens in `packages/tokens/src/theme.css`, so the mark follows the theme picked in the app.

## Rebuilding

```sh
node design/brand/generate.mjs           # everything, PNGs included
node design/brand/generate.mjs sources   # text outputs only, same as `pnpm generate`
```

Do not edit the generated files by hand. CI runs `pnpm generate && git diff --exit-code`.
