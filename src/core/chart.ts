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

/** Centred moving average, so step-like sensor history reads as a smooth trend. */
export const easeSeries = (vals: number[], radius = 2): number[] =>
  vals.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(vals.length - 1, i + radius); k++) {
      sum += vals[k];
      n++;
    }
    return sum / n;
  });

/**
 * Monotone cubic through the points (as d3's curveMonotoneX): smooth, but it
 * never overshoots, so a flat run of power stays flat instead of bulging.
 */
export const monotonePath = (pts: Point[]): string => {
  const n = pts.length;
  if (!n) return '';
  if (n < 3) return linePath(pts);
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1));
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t.push(0);
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      t.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]));
    }
  }
  t.push(m[n - 2]);
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(pts[i][0] + h).toFixed(1)} ${(pts[i][1] + h * t[i]).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)} ${(pts[i + 1][1] - h * t[i + 1]).toFixed(1)} ${pts[i + 1][0].toFixed(1)} ${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
};

/**
 * Line and filled area for a series with gaps (null), spread across x0..x1
 * and scaled 0..max onto bottom..top. A gap breaks the line rather than
 * diving to zero. `floor` closes the fill lower than the line's zero, so it
 * can run on beneath axis labels.
 */
export const gappedPaths = (
  vals: Array<number | null>,
  x0: number,
  x1: number,
  top: number,
  bottom: number,
  max: number,
  floor = bottom,
): { line: string; area: string } => {
  const n = Math.max(1, vals.length - 1);
  const lines: string[] = [];
  const areas: string[] = [];
  let run: Point[] = [];
  const flush = () => {
    if (run.length === 1) run.push([run[0][0] + 1, run[0][1]]);
    if (run.length > 1) {
      const line = monotonePath(run);
      lines.push(line);
      areas.push(`${line} L${run[run.length - 1][0].toFixed(1)} ${floor} L${run[0][0].toFixed(1)} ${floor} Z`);
    }
    run = [];
  };
  vals.forEach((v, i) => {
    if (v === null) return flush();
    const y = bottom - (Math.min(Math.max(v, 0), max) / (max || 1)) * (bottom - top);
    run.push([x0 + ((x1 - x0) * i) / n, y]);
  });
  flush();
  return { line: lines.join(' '), area: areas.join(' ') };
};
