type Point = [number, number];

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const len = (v: Point): number => Math.hypot(v[0], v[1]);
const norm = (v: Point): Point => {
  const length = len(v) || 1;
  return [v[0] / length, v[1] / length];
};
const add = (a: Point, v: Point, k: number): Point => [a[0] + v[0] * k, a[1] + v[1] * k];
const fmt = (p: Point): string => `${p[0].toFixed(3)} ${p[1].toFixed(3)}`;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Build an SVG path for a polygon whose corners are true tangent arcs of the
 * given radius.
 *
 * The tangent points are NOT at distance `radius` along each edge. For an
 * interior angle a, a fillet of radius r meets the edges at t = r / tan(a / 2),
 * so a sharp corner needs a much longer run-up than a blunt one. Using t = r
 * everywhere only works at 90 degrees; at the ~61 degree apex of a triangle the
 * arc can no longer reach both tangent points and the renderer degenerates it
 * into a chord, which reads as a chopped-off tip.
 */
export const roundedPolygon = (points: Point[], radius: number, sweep = 1): string => {
  const n = points.length;
  let d = '';

  for (let i = 0; i < n; i++) {
    const vertex = points[i];
    const toPrev = sub(points[(i - 1 + n) % n], vertex);
    const toNext = sub(points[(i + 1) % n], vertex);
    const u1 = norm(toPrev);
    const u2 = norm(toNext);

    const interior = Math.acos(clamp(u1[0] * u2[0] + u1[1] * u2[1], -1, 1));
    const half = Math.tan(interior / 2);

    let tangent = radius / half;
    let r = radius;

    // Never let two corners overrun each other along a shared edge.
    const limit = Math.min(len(toPrev), len(toNext)) / 2;
    if (tangent > limit) {
      tangent = limit;
      r = tangent * half;
    }

    d += `${i === 0 ? 'M' : 'L'} ${fmt(add(vertex, u1, tangent))} `;
    d += `A ${r.toFixed(3)} ${r.toFixed(3)} 0 0 ${sweep} ${fmt(add(vertex, u2, tangent))} `;
  }

  return `${d}Z`;
};

const TRIANGLE_RADIUS = 16;

/**
 * An equilateral triangle whose *painted* box is 112 units wide and centred on
 * (60, 60) - matching the success circle, which is r=56 about the same point.
 *
 * The vertices sit outside the viewBox on purpose. A fillet pulls each tip back
 * along the angle bisector by r / sin(a / 2) - r, which is 16 units at every
 * corner of an equilateral triangle, so the vertices have to be pushed out by
 * that much for the visible shape to land where we want it. The bottom edge is
 * the exception: its two fillets are tangent to it, so it needs no correction.
 */
export const TRIANGLE_PATH = roundedPolygon(
  [
    [60, -6.65],
    [127.67, 110.55],
    [-7.67, 110.55],
  ],
  TRIANGLE_RADIUS,
);

/** Centroid of that triangle: where the icon and the exclamation mark sit. */
export const TRIANGLE_CENTROID_Y = (-6.65 + 110.55 + 110.55) / 3;
