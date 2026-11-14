/**
 * How photos and videos of one message sit in the bubble, like Telegram:
 * one item keeps its proportions (a tall photo stays tall, within limits),
 * two to four make a mosaic around the first one, more go in justified
 * rows. Everything here is in points; aspect = width / height.
 */

export type MediaFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MediaMosaic = {
  width: number;
  height: number;
  frames: MediaFrame[];
};

export type MosaicOptions = {
  maxWidth: number;
  /** A single item is never taller than this. */
  maxHeight: number;
  /** A tall single item is never narrower than this. */
  minWidth: number;
  gap?: number;
};

/** A known aspect, kept within what reads well in a bubble. */
export function displayAspect(aspect: number | undefined, fallback = 1) {
  if (!aspect || !Number.isFinite(aspect) || aspect <= 0) return fallback;
  return Math.min(2.6, Math.max(0.45, aspect));
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function rowFrames(
  aspects: number[],
  y: number,
  width: number,
  height: number,
  gap: number,
): MediaFrame[] {
  const total = aspects.reduce((sum, value) => sum + value, 0);
  const room = width - gap * (aspects.length - 1);
  const frames: MediaFrame[] = [];
  let x = 0;
  aspects.forEach((aspect, index) => {
    const last = index === aspects.length - 1;
    const itemWidth = last ? width - x : Math.round((room * aspect) / total);
    frames.push({ x, y, width: itemWidth, height });
    x += itemWidth + gap;
  });
  return frames;
}

/** Height of a justified row: every item at its proportions, filling the width. */
function rowHeight(aspects: number[], width: number, gap: number) {
  const total = aspects.reduce((sum, value) => sum + value, 0);
  return (width - gap * (aspects.length - 1)) / total;
}

/** Row sizes for five and more items: rows of three, the shorter rows first. */
export function rowCounts(count: number): number[] {
  const rows = Math.ceil(count / 3);
  const counts = Array.from({ length: rows }, () => 3);
  let extra = rows * 3 - count;
  for (let index = 0; extra > 0; index = (index + 1) % rows) {
    counts[index]! -= 1;
    extra -= 1;
  }
  return counts;
}

export function mediaMosaic(
  rawAspects: (number | undefined)[],
  options: MosaicOptions,
): MediaMosaic {
  const gap = options.gap ?? 2;
  const width = Math.round(options.maxWidth);
  const aspects = rawAspects.map((aspect) => displayAspect(aspect));
  const count = aspects.length;
  if (count === 0) return { width: 0, height: 0, frames: [] };

  if (count === 1) {
    const aspect = aspects[0]!;
    let itemWidth = width;
    let height = itemWidth / aspect;
    if (height > options.maxHeight) {
      height = options.maxHeight;
      itemWidth = clamp(height * aspect, options.minWidth, width);
    }
    itemWidth = Math.round(itemWidth);
    height = Math.round(height);
    return {
      width: itemWidth,
      height,
      frames: [{ x: 0, y: 0, width: itemWidth, height }],
    };
  }

  const minRow = width / 5;
  const maxRow = width * 0.75;
  const [first, ...rest] = aspects as [number, ...number[]];

  // Two: side by side, unless both are wide (then one above the other).
  if (count === 2) {
    if (first > 1.2 && rest[0]! > 1.2) {
      const heights = aspects.map((aspect) =>
        Math.round(clamp(width / aspect, minRow, maxRow)),
      );
      return {
        width,
        height: heights[0]! + gap + heights[1]!,
        frames: [
          { x: 0, y: 0, width, height: heights[0]! },
          { x: 0, y: heights[0]! + gap, width, height: heights[1]! },
        ],
      };
    }
    const height = Math.round(
      clamp(rowHeight(aspects, width, gap), minRow, maxRow),
    );
    return { width, height, frames: rowFrames(aspects, 0, width, height, gap) };
  }

  if (count <= 4) {
    // A tall first item: big on the left, the others stacked on the right.
    if (first < 0.85) {
      const inverse = rest.reduce((sum, aspect) => sum + 1 / aspect, 0);
      let right =
        (width - gap - first * gap * (rest.length - 1)) / (1 + first * inverse);
      right = clamp(right, width * 0.33, width * 0.5);
      const left = width - gap - right;
      const height = Math.round(clamp(left / first, minRow * 2, width * 1.2));
      const room = height - gap * (rest.length - 1);
      const frames: MediaFrame[] = [
        { x: 0, y: 0, width: Math.round(left), height },
      ];
      let y = 0;
      rest.forEach((aspect, index) => {
        const last = index === rest.length - 1;
        const itemHeight = last
          ? height - y
          : Math.round((room * (1 / aspect)) / inverse);
        frames.push({
          x: Math.round(left) + gap,
          y,
          width: width - Math.round(left) - gap,
          height: itemHeight,
        });
        y += itemHeight + gap;
      });
      return { width, height, frames };
    }
    // Otherwise the first across the top, the others in a row below.
    const top = Math.round(clamp(width / first, minRow, maxRow));
    const bottom = Math.round(
      clamp(rowHeight(rest, width, gap), minRow, maxRow * 0.6),
    );
    return {
      width,
      height: top + gap + bottom,
      frames: [
        { x: 0, y: 0, width, height: top },
        ...rowFrames(rest, top + gap, width, bottom, gap),
      ],
    };
  }

  const frames: MediaFrame[] = [];
  let y = 0;
  let index = 0;
  for (const size of rowCounts(count)) {
    const row = aspects.slice(index, index + size);
    const height = Math.round(
      clamp(rowHeight(row, width, gap), minRow, maxRow * 0.6),
    );
    frames.push(...rowFrames(row, y, width, height, gap));
    y += height + gap;
    index += size;
  }
  return { width, height: y - gap, frames };
}
