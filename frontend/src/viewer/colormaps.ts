import type { PathResult } from '../api/types';

/** RGB triple in sRGB, components 0..1. */
export type Rgb = [number, number, number];

function hex(h: string): Rgb {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Piecewise-linear colour ramp over (position, colour) stops, positions ascending. */
function ramp(stops: [number, string][]): (t: number) => Rgb {
  const pts = stops.map(([p, c]) => [p, hex(c)] as [number, Rgb]);
  return (t: number) => {
    if (Number.isNaN(t) || t <= pts[0][0]) return pts[0][1];
    const last = pts[pts.length - 1];
    if (t >= last[0]) return last[1];
    let i = 1;
    while (pts[i][0] < t) i++;
    const [p0, c0] = pts[i - 1];
    const [p1, c1] = pts[i];
    const k = (t - p0) / (p1 - p0 || 1);
    return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
  };
}

/** Viridis (perceptually uniform, colour-blind safe), t in 0..1. */
export const viridis = ramp([
  [0.0, '#440154'],
  [0.1, '#482475'],
  [0.2, '#414487'],
  [0.3, '#355f8d'],
  [0.4, '#2a788e'],
  [0.5, '#21918c'],
  [0.6, '#22a884'],
  [0.7, '#44bf70'],
  [0.8, '#7ad151'],
  [0.9, '#bddf26'],
  [1.0, '#fde725'],
]);

/** Utilisation thresholds shared by the bars and the 3D colouring. */
export const UTIL_WARN = 0.8;
export const UTIL_FAIL = 1;
/** Upper end of the utilisation colour scale; larger values saturate. */
export const UTIL_MAX = 1.25;

/** Green -> amber -> red for a utilisation |lambda|/mu (1 = at the friction limit). */
export const utilColor = ramp([
  [0, '#1a9e3a'],
  [0.55, '#6fb52c'],
  [UTIL_WARN, '#e0a100'],
  [UTIL_FAIL, '#d03b3b'],
  [UTIL_MAX, '#7d1515'],
]);

export function utilStatus(u: number): 'ok' | 'warn' | 'fail' {
  return u >= UTIL_FAIL ? 'fail' : u >= UTIL_WARN ? 'warn' : 'ok';
}

/** |lambda| / mu; a non-zero demand with zero friction is treated as infinite. */
export function utilisation(lambda: number, mu: number): number {
  const a = Math.abs(lambda);
  if (mu > 1e-9) return a / mu;
  return a > 1e-6 ? Infinity : 0;
}

/** CSS linear-gradient sampling `fn` over 0..1. */
export function cssGradient(fn: (t: number) => Rgb, n = 12): string {
  const stops = Array.from({ length: n + 1 }, (_, i) => {
    const [r, g, b] = fn(i / n);
    return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)}) ${((i / n) * 100).toFixed(1)}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

export type PathColorMode = 'layer' | 'alpha' | 'slip';

export interface PathColoring {
  mode: Exclude<PathColorMode, 'layer'>;
  /** sRGB colour per path point, xyz-interleaved (length = 3 * points). */
  colors: Float32Array;
  min: number;
  max: number;
  /** Colour-scale domain (the legend bar spans it). */
  domain: [number, number];
  /** Points drawn neutral as turnaround dwell (slippage mode only). */
  dwellPoints: number;
}

/** Neutral colour for dwell points on the turnaround circle (informational slippage). */
export const DWELL_COLOR = '#9aa0a8';

/**
 * Per-point colours for a fibre path. Returns null for "layer" mode or when
 * the path carries no per-point data for the requested quantity.
 *
 * `dwellCut`: the path samples a dwell on the turnaround circle (alpha = 90°)
 * with the slippage such a dwell would need. That value is informational (the
 * dwell really happens on the boss neck), so in slippage mode points at 90°
 * whose |slippage| exceeds `dwellCut` (the dome slippage) are drawn neutral
 * and left out of min/max.
 */
export function colorPath(
  path: PathResult | null,
  mode: PathColorMode,
  friction: number,
  dwellCut: number | null = null,
): PathColoring | null {
  if (!path || mode === 'layer') return null;
  const n = path.points.length;
  const src = mode === 'alpha' ? path.alpha : path.slippage;
  if (!src || src.length !== n || n < 2) return null;
  const alpha = path.alpha?.length === n ? path.alpha : null;
  const dwell = new Uint8Array(n);
  let dwellPoints = 0;
  if (mode === 'slip' && dwellCut != null && alpha) {
    for (let i = 0; i < n; i++) {
      if (alpha[i] >= 89.999 && Math.abs(src[i]) > dwellCut) {
        dwell[i] = 1;
        dwellPoints++;
      }
    }
  }
  const vals = mode === 'alpha' ? src : src.map((l) => utilisation(l, friction));
  let min = Infinity;
  let max = -Infinity;
  let inf = false;
  vals.forEach((v, i) => {
    if (dwell[i]) return;
    if (v === Infinity) inf = true;
    if (!Number.isFinite(v)) return;
    if (v < min) min = v;
    if (v > max) max = v;
  });
  if (inf) max = Infinity;
  if (!Number.isFinite(min)) min = max = 0;
  let domain: [number, number];
  let fn: (v: number) => Rgb;
  if (mode === 'alpha') {
    // a constant angle (hoop) sits mid-scale
    const flat = max - min < 0.05;
    const lo = flat ? min - 0.5 : min;
    const hi = flat ? max + 0.5 : max;
    domain = [lo, hi];
    fn = (v) => viridis((v - lo) / (hi - lo));
  } else {
    domain = [0, UTIL_MAX];
    fn = utilColor;
  }
  const colors = new Float32Array(n * 3);
  const neutral = hex(DWELL_COLOR);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = dwell[i] ? neutral : fn(vals[i]);
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  return { mode, colors, min, max, domain, dwellPoints };
}
