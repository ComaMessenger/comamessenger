// Generates every Coma mascot asset: mobile icons and splash images, web
// icons, the favicon and the geometry module shared by the clients.
// Run: node design/brand/generate.mjs           (everything)
//      node design/brand/generate.mjs sources   (text outputs only; `pnpm generate`)
//
// The mascot is pixel art made of axis-aligned shapes, so it is rasterised here
// directly (no SVG renderer, no dependencies) and stays crisp at every size.
// Geometry comes from coma-mascot-source.svg; colours follow the product tokens.
// SPDX-License-Identifier: Apache-2.0
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const BODY =
  "M298 193H410V218H462V244H487V376H462V418H438V442H417V462H397V482H374V504H284V482H308V462H330V442H348V418H264V401H239V376H213V269H239V244H264V218H298Z";
const EYES = [
  [286, 273, 36, 36],
  [381, 294, 36, 36],
];
// "regular" keeps the drawn feet; "bold" enlarges them so they survive at
// 20–40 px, where the regular feet collapse into a line.
const FEET = {
  regular: [
    [260, 504, 48, 26],
    [349, 504, 48, 26],
  ],
  bold: [
    [252, 504, 62, 46],
    [343, 504, 62, 46],
  ],
};

export const palette = {
  brand: "#174586", // --coma-primary, light theme
  brandOnDark: "#86AFF0", // --coma-primary, dark theme
  ink: "#242831",
  white: "#FFFFFF",
  lightBackground: "#FFFFFF",
  darkBackground: "#151517", // --coma-canvas, dark theme
};

function polygon(path) {
  const points = [];
  let x = 0;
  let y = 0;
  for (const [, command, a, b] of path.matchAll(
    /([MHVZ])\s*(-?\d+)?\s*(-?\d+)?/g,
  )) {
    if (command === "M") [x, y] = [Number(a), Number(b)];
    else if (command === "H") x = Number(a);
    else if (command === "V") y = Number(a);
    else continue;
    points.push([x, y]);
  }
  return points;
}

const rectangle = ([x, y, w, h]) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

function shapes(feet) {
  return {
    feet: FEET[feet].map(rectangle),
    body: [polygon(BODY)],
    eyes: EYES.map(rectangle),
  };
}

function bounds(groups) {
  const all = Object.values(groups).flat(2);
  const xs = all.map((point) => point[0]);
  const ys = all.map((point) => point[1]);
  return {
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    y0: Math.min(...ys),
    y1: Math.max(...ys),
  };
}

/** Coverage (0..1 per pixel) of a set of rectilinear polygons. */
function coverage(polygons, size, map) {
  const SUB = 4;
  const result = new Float32Array(size * size);
  for (const points of polygons) {
    const edges = [];
    for (let index = 0; index < points.length; index += 1) {
      const [ax, ay] = map(points[index]);
      const [bx, by] = map(points[(index + 1) % points.length]);
      if (ax === bx && ay !== by)
        edges.push([ax, Math.min(ay, by), Math.max(ay, by)]);
    }
    for (let row = 0; row < size * SUB; row += 1) {
      const y = (row + 0.5) / SUB;
      const crossings = edges
        .filter((edge) => y >= edge[1] && y < edge[2])
        .map((edge) => edge[0]);
      crossings.sort((left, right) => left - right);
      const base = Math.floor(row / SUB) * size;
      for (let index = 0; index + 1 < crossings.length; index += 2) {
        const from = Math.max(0, crossings[index]);
        const to = Math.min(size, crossings[index + 1]);
        for (
          let column = Math.floor(from);
          column < Math.ceil(to);
          column += 1
        ) {
          const part = Math.min(to, column + 1) - Math.max(from, column);
          if (part > 0) result[base + column] += part / SUB;
        }
      }
    }
  }
  return result;
}

const rgb = (hex) =>
  [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));

/**
 * @param {object} options
 * @param {number} options.size canvas edge in pixels
 * @param {number} options.height mascot height as a fraction of the canvas
 * @param {"regular"|"bold"} options.feet
 * @param {string|null} options.background hex colour or null for transparency
 * @param {{body: string, eyes: string|null, feet: string}} options.colors eyes: null cuts them out
 */
export function render({ size, height, feet, background, colors }) {
  const groups = shapes(feet);
  const box = bounds(groups);
  const scale = (size * height) / (box.y1 - box.y0);
  const dx = (size - (box.x1 - box.x0) * scale) / 2 - box.x0 * scale;
  const dy = (size - (box.y1 - box.y0) * scale) / 2 - box.y0 * scale;
  const map = ([x, y]) => [x * scale + dx, y * scale + dy];

  const pixels = new Float32Array(size * size * 4); // premultiplied RGBA, 0..1
  if (background) {
    const [r, g, b] = rgb(background);
    for (let index = 0; index < size * size; index += 1) {
      pixels.set([r / 255, g / 255, b / 255, 1], index * 4);
    }
  }
  const paint = (polygons, color) => {
    const alpha = coverage(polygons, size, map);
    const [r, g, b] = color ? rgb(color) : [0, 0, 0];
    for (let index = 0; index < size * size; index += 1) {
      const a = Math.min(1, alpha[index]);
      if (a === 0) continue;
      const at = index * 4;
      if (color) {
        pixels[at] = (r / 255) * a + pixels[at] * (1 - a);
        pixels[at + 1] = (g / 255) * a + pixels[at + 1] * (1 - a);
        pixels[at + 2] = (b / 255) * a + pixels[at + 2] * (1 - a);
        pixels[at + 3] = a + pixels[at + 3] * (1 - a);
      } else {
        for (let channel = 0; channel < 4; channel += 1)
          pixels[at + channel] *= 1 - a;
      }
    }
  };
  paint(groups.feet, colors.feet);
  paint(groups.body, colors.body);
  paint(groups.eyes, colors.eyes);
  return encode(pixels, size);
}

function encode(pixels, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4;
      const alpha = pixels[from + 3];
      for (let channel = 0; channel < 3; channel += 1) {
        const value = alpha > 0 ? pixels[from + channel] / alpha : 0;
        raw[row + 1 + x * 4 + channel] = Math.round(Math.min(1, value) * 255);
      }
      raw[row + 1 + x * 4 + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, tail]);
}

const light = { body: palette.brand, eyes: palette.white, feet: palette.ink };
const dark = {
  body: palette.brandOnDark,
  eyes: palette.white,
  feet: palette.white,
};
const silhouette = { body: palette.white, eyes: null, feet: palette.white };

// height: share of the canvas the mascot occupies. The splash height must match
// SPLASH_MASCOT_HEIGHT in apps/mobile/src/ui/AnimatedSplash.tsx.
export const assets = {
  "icon.png": {
    size: 1024,
    height: 0.56,
    feet: "bold",
    background: palette.lightBackground,
    colors: light,
  },
  "icon-dark.png": {
    size: 1024,
    height: 0.56,
    feet: "bold",
    background: palette.darkBackground,
    colors: dark,
  },
  "icon-tinted.png": {
    size: 1024,
    height: 0.56,
    feet: "bold",
    background: null,
    colors: silhouette,
  },
  "android-icon-foreground.png": {
    size: 1024,
    height: 0.38,
    feet: "bold",
    background: null,
    colors: light,
  },
  "android-icon-monochrome.png": {
    size: 432,
    height: 0.38,
    feet: "bold",
    background: null,
    colors: silhouette,
  },
  "splash-icon.png": {
    size: 1024,
    height: 0.6,
    feet: "regular",
    background: null,
    colors: light,
  },
  "splash-icon-dark.png": {
    size: 1024,
    height: 0.6,
    feet: "regular",
    background: null,
    colors: dark,
  },
  "notification-icon.png": {
    size: 96,
    height: 0.82,
    feet: "bold",
    background: null,
    colors: silhouette,
  },
  "favicon.png": {
    size: 48,
    height: 0.86,
    feet: "bold",
    background: null,
    colors: light,
  },
};

// Raster assets for the web client: touch icon and notification icon/badge.
export const webAssets = {
  "apple-touch-icon.png": {
    size: 180,
    height: 0.56,
    feet: "bold",
    background: palette.lightBackground,
    colors: light,
  },
  "notification-icon.png": {
    size: 192,
    height: 0.56,
    feet: "bold",
    background: palette.lightBackground,
    colors: light,
  },
  "notification-badge.png": {
    size: 96,
    height: 0.82,
    feet: "bold",
    background: null,
    colors: silhouette,
  },
};

/** Tight bounding box of the mascot with the given feet, in source units. */
function viewBox(feet) {
  const box = bounds(shapes(feet));
  return {
    x: box.x0,
    y: box.y0,
    width: box.x1 - box.x0,
    height: box.y1 - box.y0,
  };
}

const rectsSVG = (rects, attributes) =>
  rects
    .map(
      ([x, y, w, h]) =>
        `<rect x="${x}" y="${y}" width="${w}" height="${h}"${attributes}/>`,
    )
    .join("");

/**
 * Browser tab icon. A favicon cannot read the page's CSS variables, so it
 * follows the browser's colour scheme through its own media query.
 */
export function faviconSVG() {
  const box = viewBox("bold");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.width} ${box.height}" shape-rendering="crispEdges">
<style>.b{fill:${palette.brand}}.e{fill:${palette.white}}.f{fill:${palette.ink}}@media (prefers-color-scheme:dark){.b{fill:${palette.brandOnDark}}.f{fill:${palette.white}}}</style>
<g class="f">${rectsSVG(FEET.bold, "")}</g>
<path class="b" d="${BODY}"/>
<g class="e">${rectsSVG(EYES, "")}</g>
</svg>
`;
}

/** JSON with number tuples kept on one line. */
const literal = (value) =>
  JSON.stringify(value, null, 2).replace(
    /\[\s+([-\d.,\s]+?)\s+\]/g,
    (_, inner) => `[${inner.split(/,\s*/).join(", ")}]`,
  );

/** Geometry and palette for clients that draw the mascot themselves. */
export function mascotModule() {
  const geometry = {
    body: BODY,
    eyes: EYES,
    feet: FEET,
    viewBox: { regular: viewBox("regular"), bold: viewBox("bold") },
  };
  const colors = {
    light: { plate: palette.lightBackground, ...light },
    dark: { plate: palette.darkBackground, ...dark },
  };
  return `// Generated by design/brand/generate.mjs from coma-mascot-source.svg. Do not edit.
// SPDX-License-Identifier: Apache-2.0

/** Pixel geometry of the Coma mascot: rects are [x, y, width, height]. */
export const mascot = ${literal(geometry)} as const;

/** Mascot colours per theme; plate is the background the mark sits on. */
export const mascotColors = ${literal(colors)} as const;

/**
 * Below this rendered mascot height (px/pt) the regular feet collapse into a
 * line, so the "bold" feet are used instead.
 */
export const MASCOT_BOLD_FEET_BELOW = 48;

export type MascotFeet = keyof typeof mascot.feet;
`;
}

/** Text outputs checked into the repository and verified by `pnpm generate`. */
export const sources = {
  "packages/tokens/src/mascot.ts": mascotModule,
  "apps/web/public/favicon.svg": faviconSVG,
};

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(path.slice(root.length + 1));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [path, build] of Object.entries(sources))
    write(resolve(root, path), build());
  if (process.argv[2] !== "sources") {
    for (const [name, options] of Object.entries(assets))
      write(resolve(root, "apps/mobile/assets", name), render(options));
    for (const [name, options] of Object.entries(webAssets))
      write(resolve(root, "apps/web/public", name), render(options));
  }
}
