export type Point = [number, number];

/** Catmull-Rom spline through the points, as an SVG path. */
export const smoothPath = (pts: Point[]): string => {
  if (!pts.length) return '';
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c = [
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
      p2[0],
      p2[1],
    ];
    d += ` C${c.map((n) => n.toFixed(1)).join(' ')}`;
  }
  return d;
};

export const linePath = (pts: Point[]): string =>
  pts.length ? 'M' + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L') : '';

/** Map values evenly across x0..x1, scaled between min and max onto y1 (bottom) .. y0 (top). */
export const mapPoints = (vals: number[], x0: number, x1: number, y0: number, y1: number, min: number, max: number): Point[] => {
  const span = max - min || 1;
  const n = Math.max(1, vals.length - 1);
  return vals.map((v, i) => [x0 + ((x1 - x0) * i) / n, y1 - ((v - min) / span) * (y1 - y0)]);
};

/** Close a line path down to the baseline to make a filled area. */
export const areaPath = (line: string, width: number, baseline: number): string =>
  line ? `${line} L${width} ${baseline} L0 ${baseline} Z` : '';

export const extent = (vals: number[], pad = 0): [number, number] => {
  if (!vals.length) return [0, 1];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
};
