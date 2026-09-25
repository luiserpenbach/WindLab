/**
 * Client-side G-code backplot: interprets a WindLab program like a controller
 * (G0/G1, G90 absolute, G92 offsets and G92.1 reset, G93/G94 feed mode) and
 * reconstructs the *physical* axis positions (programmed + G92 offset), as the
 * backend verifier (post/verify.py) does. The result is decimated with a
 * min/max envelope per bucket so the charts stay light for 600k-line files.
 *
 * Runs in a Web Worker (workers/backplot.worker.ts) or, as a fallback, in
 * main-thread chunks. Pure module: no DOM access.
 */

export interface BackplotAxis {
  /** G-code letter */
  letter: string;
  /** carriage | crossfeed | mandrel | eye */
  role: string;
  /** Max velocity [units/min] for rapid-move timing */
  vmax: number;
  rotary: boolean;
}

export interface BackplotOptions {
  axes: BackplotAxis[];
  controller: 'linuxcnc' | 'grbl';
  /** Points per series after decimation (each bucket contributes min + max) */
  buckets?: number;
}

export interface BackplotSeries {
  letter: string;
  role: string;
  /** Decimated (x, y) vs program line */
  byLine: { x: Float64Array; y: Float64Array };
  /** Decimated (x, y) vs cumulative time [s] */
  byTime: { x: Float64Array; y: Float64Array };
  min: number;
  max: number;
}

export interface BackplotMarker {
  /** 1-based program line */
  line: number;
  /** Cumulative time at that line [s] */
  time: number;
  label: string;
}

export interface BackplotResult {
  lines: number;
  moves: number;
  rapids: number;
  pauses: number;
  /** Feed + estimated rapid time [s] */
  totalTime: number;
  /** Inverse-time (G93) feed time only [s] — comparable with the backend verification */
  feedTime: number;
  series: BackplotSeries[];
  layers: BackplotMarker[];
  resets: number;
  parseMs: number;
}

const CH_A = 65;
const CH_Z = 90;
const CH_a = 97;
const CH_z = 122;

class Grow {
  a: Float64Array;
  n = 0;
  constructor(cap = 1 << 14) {
    this.a = new Float64Array(cap);
  }
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  view(): Float64Array {
    return this.a.subarray(0, this.n);
  }
}

/** Min/max envelope decimation: at most 2 x buckets points, extremes kept, in index order. */
export function envelope(x: Float64Array, y: Float64Array, buckets: number): { x: Float64Array; y: Float64Array } {
  const n = Math.min(x.length, y.length);
  if (n <= buckets * 2) return { x: x.slice(0, n), y: y.slice(0, n) };
  const ox = new Float64Array(buckets * 2);
  const oy = new Float64Array(buckets * 2);
  let k = 0;
  for (let b = 0; b < buckets; b++) {
    const i0 = Math.floor((b * n) / buckets);
    const i1 = Math.max(i0 + 1, Math.floor(((b + 1) * n) / buckets));
    let iMin = i0;
    let iMax = i0;
    for (let i = i0 + 1; i < i1; i++) {
      if (y[i] < y[iMin]) iMin = i;
      if (y[i] > y[iMax]) iMax = i;
    }
    const first = Math.min(iMin, iMax);
    const second = Math.max(iMin, iMax);
    ox[k] = x[first];
    oy[k++] = y[first];
    ox[k] = x[second];
    oy[k++] = y[second];
  }
  return { x: ox.subarray(0, k), y: oy.subarray(0, k) };
}

/**
 * Incremental parser: `feed(text, from, to)` consumes whole lines of `text`
 * between the offsets (to must be at a line end or text.length).
 */
export class BackplotParser {
  private opts: BackplotOptions;
  private idx: Map<string, number>;
  private pos: Float64Array;
  private off: Float64Array;
  private mode93 = false;
  private motion = -1;
  private line = 0;
  private time = 0;
  private feedTime = 0;
  private moves = 0;
  private rapids = 0;
  private pauses = 0;
  private resets = 0;
  private xs = new Grow();
  private ts = new Grow();
  private ys: Grow[];
  private layers: BackplotMarker[] = [];
  private seenLayer = new Set<string>();
  private words = new Float64Array(26);
  private has = new Uint8Array(26);
  private gcodes: number[] = [];
  private mcodes: number[] = [];

  constructor(opts: BackplotOptions) {
    this.opts = opts;
    this.idx = new Map(opts.axes.map((a, i) => [a.letter.toUpperCase(), i]));
    this.pos = new Float64Array(opts.axes.length);
    this.off = new Float64Array(opts.axes.length);
    this.ys = opts.axes.map(() => new Grow());
  }

  get linesDone(): number {
    return this.line;
  }

  feed(text: string, from: number, to: number) {
    let p = from;
    while (p < to) {
      let e = text.indexOf('\n', p);
      if (e < 0 || e > to) e = to;
      this.line++;
      this.parseLine(text, p, e);
      p = e + 1;
    }
  }

  private parseLine(t: string, s: number, e: number) {
    const has = this.has;
    const words = this.words;
    has.fill(0);
    this.gcodes.length = 0;
    this.mcodes.length = 0;
    // comment-only lines: layer markers "(Layer 3 hel1: ...)"
    let i = s;
    while (i < e && (t.charCodeAt(i) === 32 || t.charCodeAt(i) === 9)) i++;
    if (i < e && t.charCodeAt(i) === 40 /* ( */) {
      const m = /^\(Layer (\d+) ([^:)]+)/.exec(t.slice(i, Math.min(e, i + 80)));
      if (m && !this.seenLayer.has(m[1])) {
        this.seenLayer.add(m[1]);
        this.layers.push({ line: this.line, time: this.time, label: `${m[1]} ${m[2].trim()}` });
      }
    }
    let any = false;
    while (i < e) {
      const c = t.charCodeAt(i);
      if (c === 40 /* ( */) {
        const close = t.indexOf(')', i);
        i = close < 0 || close > e ? e : close + 1;
        continue;
      }
      if (c === 59 /* ; */) break;
      let L = -1;
      if (c >= CH_A && c <= CH_Z) L = c - CH_A;
      else if (c >= CH_a && c <= CH_z) L = c - CH_a;
      if (L < 0) {
        i++;
        continue;
      }
      i++;
      while (i < e && t.charCodeAt(i) === 32) i++;
      const n0 = i;
      while (i < e) {
        const d = t.charCodeAt(i);
        if ((d >= 48 && d <= 57) || d === 46 || d === 45 || d === 43) i++;
        else break;
      }
      if (i === n0) continue;
      const v = Number(t.slice(n0, i));
      if (!Number.isFinite(v)) continue;
      any = true;
      if (L === 6 /* G */) this.gcodes.push(v);
      else if (L === 12 /* M */) this.mcodes.push(v);
      else {
        words[L] = v;
        has[L] = 1;
      }
    }
    if (!any) return;
    const g = this.gcodes;
    for (const m of this.mcodes) if (m === 0 || m === 1) this.pauses++;
    if (g.includes(93)) this.mode93 = true;
    if (g.includes(94)) this.mode93 = false;
    const n = this.opts.axes.length;
    if (g.some((x) => Math.abs(x - 92.1) < 1e-6)) {
      for (let k = 0; k < n; k++) {
        this.pos[k] += this.off[k];
        this.off[k] = 0;
      }
      this.resets++;
      return;
    }
    if (g.includes(92)) {
      for (const [letter, k] of this.idx) {
        const L = letter.charCodeAt(0) - CH_A;
        if (!has[L]) continue;
        const phys = this.pos[k] + this.off[k];
        this.off[k] = phys - words[L];
        this.pos[k] = words[L];
      }
      this.resets++;
      return;
    }
    // G0 / G1 are modal: axis words without a motion code continue the last one
    if (g.includes(1)) this.motion = 1;
    else if (g.includes(0)) this.motion = 0;
    const motion = this.motion;
    if (motion < 0) return;
    let moved = false;
    let dLin2 = 0;
    let dRot2 = 0;
    let rapidT = 0;
    for (const [letter, k] of this.idx) {
      const L = letter.charCodeAt(0) - CH_A;
      if (!has[L]) continue;
      const d = words[L] - this.pos[k];
      this.pos[k] = words[L];
      moved = true;
      const ax = this.opts.axes[k];
      if (ax.rotary && this.opts.controller === 'linuxcnc') dRot2 += d * d;
      else dLin2 += d * d;
      if (ax.vmax > 0) rapidT = Math.max(rapidT, (Math.abs(d) / ax.vmax) * 60);
    }
    if (!moved) return;
    if (motion === 0) {
      this.rapids++;
      this.time += rapidT;
    } else {
      this.moves++;
      const f = has[5] ? words[5] : NaN; // F
      if (this.mode93) {
        if (f > 0) {
          this.time += 60 / f;
          this.feedTime += 60 / f;
        }
      } else if (f > 0) {
        const dist = dLin2 > 0 ? Math.sqrt(dLin2) : Math.sqrt(dRot2);
        this.time += (dist / f) * 60;
      }
    }
    this.xs.push(this.line);
    this.ts.push(this.time);
    for (let k = 0; k < n; k++) this.ys[k].push(this.pos[k] + this.off[k]);
  }

  finish(parseMs: number): BackplotResult {
    const buckets = this.opts.buckets ?? 1500;
    const xs = this.xs.view();
    const ts = this.ts.view();
    const series: BackplotSeries[] = this.opts.axes.map((a, k) => {
      const y = this.ys[k].view();
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < y.length; i++) {
        if (y[i] < min) min = y[i];
        if (y[i] > max) max = y[i];
      }
      return {
        letter: a.letter,
        role: a.role,
        byLine: envelope(xs, y, buckets),
        byTime: envelope(ts, y, buckets),
        min: Number.isFinite(min) ? min : 0,
        max: Number.isFinite(max) ? max : 0,
      };
    });
    return {
      lines: this.line,
      moves: this.moves,
      rapids: this.rapids,
      pauses: this.pauses,
      totalTime: this.time,
      feedTime: this.feedTime,
      series,
      layers: this.layers,
      resets: this.resets,
      parseMs,
    };
  }
}

/** Offsets of line ends that split `text` into roughly `size`-character chunks. */
export function* chunks(text: string, size = 1 << 20): Generator<[number, number]> {
  let p = 0;
  while (p < text.length) {
    let e = Math.min(text.length, p + size);
    if (e < text.length) {
      const nl = text.indexOf('\n', e);
      e = nl < 0 ? text.length : nl;
    }
    yield [p, e];
    p = e + 1;
  }
}

/** Transferable buffers of a result (for postMessage). */
export function transferables(r: BackplotResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const s of r.series)
    for (const a of [s.byLine.x, s.byLine.y, s.byTime.x, s.byTime.y]) out.push(a.buffer as ArrayBuffer);
  return out;
}
