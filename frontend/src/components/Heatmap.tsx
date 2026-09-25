import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { colorLut, NODATA_RGB, viridis, type Rgb } from '../viewer/colormaps';
import { sig } from '../util/format';
import { niceTicks } from './LineChart';

/**
 * Unrolled surface map drawn on a canvas: x = a meridian coordinate of the
 * rows (monotonic, e.g. z or s), y = azimuth 0..360 deg, colour = value.
 * Axes, colour bar and crosshair are an SVG overlay so they follow the
 * chart styles and the theme.
 *
 * Several rows can fall into one pixel column (e.g. near the poles when
 * x = z); the pixel then shows the largest of them so peaks are never lost.
 */
export interface HeatmapProps {
  /** Row coordinate (ascending). */
  x: number[];
  /** Column centres [deg], ascending in 0..360. */
  phi: number[];
  /** rows x columns; null = no data. */
  values: (number | null)[][];
  /** Colour scale upper end (lower end 0); values above saturate. */
  hi: number;
  /** Colour ramp over 0..1 (default viridis). */
  ramp?: (t: number) => Rgb;
  xLabel: string;
  xUnit?: string;
  valueLabel: string;
  valueUnit?: string;
  /** Extra marks on the colour bar (e.g. nominal). */
  barMarks?: { value: number; label: string }[];
  /** Vertical reference lines in x units. */
  vlines?: { value: number; label?: string }[];
  /** Show an arrow at the top of the colour bar (scale clipped). */
  clipped?: boolean;
  height?: number;
  title?: string;
  tools?: ReactNode;
  /** Cursor x in data units (null when the pointer leaves). */
  onHoverX?: (x: number | null) => void;
  /** Extra readout lines for a hovered row. */
  rowInfo?: (row: number) => ReactNode;
}

const PAD = { l: 52, r: 70, t: 8, b: 34 };
const BAR_W = 10;

interface Cols {
  /** For each pixel column, the first and last row it covers. */
  r0: Int32Array;
  r1: Int32Array;
}

/** Row ranges per pixel column (rows are intervals between midpoints of x). */
function pixelRows(x: number[], x0: number, x1: number, w: number): Cols {
  const n = x.length;
  const b = new Float64Array(n + 1);
  b[0] = n > 1 ? x[0] - (x[1] - x[0]) / 2 : x[0] - 0.5;
  for (let i = 1; i < n; i++) b[i] = (x[i - 1] + x[i]) / 2;
  b[n] = n > 1 ? x[n - 1] + (x[n - 1] - x[n - 2]) / 2 : x[0] + 0.5;
  const r0 = new Int32Array(w).fill(-1);
  const r1 = new Int32Array(w).fill(-1);
  const span = x1 - x0 || 1;
  let k = 0;
  for (let p = 0; p < w; p++) {
    const a = x0 + (p / w) * span;
    const c = x0 + ((p + 1) / w) * span;
    if (c <= b[0] || a >= b[n]) continue;
    while (k < n - 1 && b[k + 1] <= a) k++;
    let j = k;
    while (j < n - 1 && b[j + 1] < c) j++;
    r0[p] = k;
    r1[p] = j;
  }
  return { r0, r1 };
}

export function Heatmap({
  x,
  phi,
  values,
  hi,
  ramp = viridis,
  xLabel,
  xUnit,
  valueLabel,
  valueUnit,
  barMarks,
  vlines,
  clipped,
  height = 250,
  title,
  tools,
  onHoverX,
  rowInfo,
}: HeatmapProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [cursor, setCursor] = useState<{ px: number; py: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(40, width - PAD.l - PAD.r);
  const plotH = Math.max(40, height - PAD.t - PAD.b);
  const rows = Math.min(x.length, values.length);
  const ncol = phi.length;
  const xd = useMemo<[number, number]>(() => {
    if (!rows) return [0, 1];
    const h0 = rows > 1 ? (x[1] - x[0]) / 2 : 0.5;
    const h1 = rows > 1 ? (x[rows - 1] - x[rows - 2]) / 2 : 0.5;
    return [x[0] - h0, x[rows - 1] + h1];
  }, [x, rows]);
  const lut = useMemo(() => colorLut(ramp, 256), [ramp]);

  // ---- raster
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !rows || !ncol) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(plotW * dpr));
    const H = Math.max(1, Math.round(plotH * dpr));
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(W, H);
    const px = img.data;
    const { r0, r1 } = pixelRows(x.slice(0, rows), xd[0], xd[1], W);
    // per pixel column: max over its rows for every phi column (NaN = no data)
    const agg = new Float32Array(ncol);
    // pixel row -> phi column (phi = 0 at the bottom)
    const colOf = new Int32Array(H);
    for (let py = 0; py < H; py++) {
      const ph = 360 * (1 - (py + 0.5) / H);
      colOf[py] = Math.min(ncol - 1, Math.max(0, Math.floor((ph / 360) * ncol)));
    }
    const nd: Rgb = NODATA_RGB;
    const ndc = [nd[0] * 255, nd[1] * 255, nd[2] * 255];
    const inv = hi > 0 ? 255 / hi : 0;
    for (let p = 0; p < W; p++) {
      const a = r0[p];
      const b = r1[p];
      if (a < 0) continue;
      for (let c = 0; c < ncol; c++) {
        let m = NaN;
        for (let r = a; r <= b; r++) {
          const v = values[r][c];
          if (v != null && Number.isFinite(v) && !(v <= m)) m = v;
        }
        agg[c] = m;
      }
      for (let py = 0; py < H; py++) {
        const v = agg[colOf[py]];
        const o = (py * W + p) * 4;
        if (Number.isNaN(v)) {
          // hatched "no data"
          const stripe = ((p + py) >> 2) & 1;
          px[o] = ndc[0] - stripe * 30;
          px[o + 1] = ndc[1] - stripe * 30;
          px[o + 2] = ndc[2] - stripe * 30;
        } else {
          const k = Math.max(0, Math.min(255, Math.round(v * inv))) * 4;
          px[o] = lut[k];
          px[o + 1] = lut[k + 1];
          px[o + 2] = lut[k + 2];
        }
        px[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [x, values, rows, ncol, hi, lut, xd, plotW, plotH]);

  const sx = (v: number) => PAD.l + ((v - xd[0]) / (xd[1] - xd[0] || 1)) * plotW;
  const sy = (deg: number) => PAD.t + plotH - (deg / 360) * plotH;
  const xt = niceTicks(xd[0], xd[1], Math.max(3, Math.floor(plotW / 80)));
  const yt = [0, 90, 180, 270, 360];
  const bt = niceTicks(0, hi, Math.max(3, Math.floor(plotH / 40))).filter((v) => v <= hi + 1e-9);
  const xStep = xt.length > 1 ? xt[1] - xt[0] : 1;
  const bStep = bt.length > 1 ? bt[1] - bt[0] : 1;
  const fmtTick = (v: number, step: number) => {
    if (v === 0) return '0';
    const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    return v.toFixed(Math.min(d, 4));
  };
  const barX = PAD.l + plotW + 14;
  const gradId = useMemo(() => `hmg${Math.random().toString(36).slice(2, 8)}`, []);
  const gradStops = useMemo(
    () =>
      Array.from({ length: 13 }, (_, i) => {
        const [r, g, b] = ramp(i / 12);
        return { off: `${((i / 12) * 100).toFixed(1)}%`, color: `rgb(${r * 255} ${g * 255} ${b * 255})` };
      }),
    [ramp],
  );

  // ---- hover readout (nearest row / column)
  const readout = useMemo(() => {
    if (!cursor || !rows) return null;
    const xv = xd[0] + ((cursor.px - PAD.l) / plotW) * (xd[1] - xd[0]);
    const ph = (360 * (PAD.t + plotH - cursor.py)) / plotH;
    let lo = 0;
    let hi2 = rows - 1;
    while (hi2 - lo > 1) {
      const m = (lo + hi2) >> 1;
      if (x[m] <= xv) lo = m;
      else hi2 = m;
    }
    const row = Math.abs(x[hi2] - xv) < Math.abs(x[lo] - xv) ? hi2 : lo;
    const col = Math.min(ncol - 1, Math.max(0, Math.floor((ph / 360) * ncol)));
    return { row, col, v: values[row]?.[col] ?? null, phi: phi[col] };
  }, [cursor, rows, x, xd, plotW, plotH, ncol, values, phi]);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (px < PAD.l || px > PAD.l + plotW || py < PAD.t || py > PAD.t + plotH) {
      setCursor(null);
      onHoverX?.(null);
    } else {
      setCursor({ px, py });
      onHoverX?.(xd[0] + ((px - PAD.l) / plotW) * (xd[1] - xd[0]));
    }
  };

  return (
    <figure className="chart heatmap" ref={wrap}>
      {title || tools ? (
        <figcaption className="chart-head">
          <div className="chart-head-row">
            {title ? <span className="chart-title">{title}</span> : <span />}
            {tools ? <div className="chart-tools">{tools}</div> : null}
          </div>
        </figcaption>
      ) : null}
      <div className="chart-plot" style={{ height }}>
        {!rows || !ncol ? (
          <div className="chart-empty">No data</div>
        ) : (
          <>
            <canvas
              ref={canvas}
              className="heatmap-canvas"
              style={{ left: PAD.l, top: PAD.t, width: plotW, height: plotH }}
              aria-hidden="true"
            />
            <svg
              width={width}
              height={height}
              role="img"
              aria-label={`${title ?? valueLabel} map over ${xLabel} and azimuth`}
              onPointerMove={onMove}
              onPointerLeave={() => {
                setCursor(null);
                onHoverX?.(null);
              }}
            >
              <defs>
                <linearGradient id={gradId} x1="0" x2="0" y1="1" y2="0">
                  {gradStops.map((s) => (
                    <stop key={s.off} offset={s.off} stopColor={s.color} />
                  ))}
                </linearGradient>
              </defs>
              <g className="chart-axis">
                <rect className="heatmap-frame" x={PAD.l} y={PAD.t} width={plotW} height={plotH} />
                {xt.map((v) => (
                  <g key={`tx${v}`}>
                    <line x1={sx(v)} x2={sx(v)} y1={PAD.t + plotH} y2={PAD.t + plotH + 4} />
                    <text x={sx(v)} y={PAD.t + plotH + 15} textAnchor="middle">
                      {fmtTick(v, xStep)}
                    </text>
                  </g>
                ))}
                {yt.map((v) => (
                  <g key={`ty${v}`}>
                    <line x1={PAD.l - 4} x2={PAD.l} y1={sy(v)} y2={sy(v)} />
                    <text x={PAD.l - 6} y={sy(v) + 3.5} textAnchor="end">
                      {v}
                    </text>
                  </g>
                ))}
                <text className="chart-axis-label" x={PAD.l + plotW / 2} y={height - 4} textAnchor="middle">
                  {xLabel}
                  {xUnit ? ` [${xUnit}]` : ''}
                </text>
                <text
                  className="chart-axis-label"
                  transform={`translate(11 ${PAD.t + plotH / 2}) rotate(-90)`}
                  textAnchor="middle"
                >
                  φ [°]
                </text>
                {/* colour bar */}
                <rect x={barX} y={PAD.t} width={BAR_W} height={plotH} fill={`url(#${gradId})`} />
                {bt.map((v) => {
                  const y = PAD.t + plotH - (v / hi) * plotH;
                  return (
                    <g key={`tb${v}`}>
                      <line x1={barX + BAR_W} x2={barX + BAR_W + 3} y1={y} y2={y} />
                      <text x={barX + BAR_W + 5} y={y + 3.5}>
                        {fmtTick(v, bStep)}
                      </text>
                    </g>
                  );
                })}
                {barMarks?.map((m) =>
                  m.value > 0 && m.value <= hi ? (
                    <g key={m.label} className="heatmap-barmark">
                      <line
                        x1={barX - 3}
                        x2={barX + BAR_W}
                        y1={PAD.t + plotH - (m.value / hi) * plotH}
                        y2={PAD.t + plotH - (m.value / hi) * plotH}
                      />
                      <title>
                        {m.label} {sig(m.value, 3)}
                        {valueUnit ? ` ${valueUnit}` : ''}
                      </title>
                    </g>
                  ) : null,
                )}
                {clipped ? (
                  <path
                    className="heatmap-clip"
                    d={`M${barX} ${PAD.t - 1} L${barX + BAR_W / 2} ${PAD.t - 7} L${barX + BAR_W} ${PAD.t - 1} Z`}
                  >
                    <title>Scale clipped: larger values saturate</title>
                  </path>
                ) : null}
              </g>
              {vlines?.map((v, i) =>
                v.value > xd[0] && v.value < xd[1] ? (
                  <g key={`v${i}`} className="chart-ref heatmap-ref">
                    <line y1={PAD.t} y2={PAD.t + plotH} x1={sx(v.value)} x2={sx(v.value)} />
                    {v.label ? (
                      <text x={sx(v.value) + 3} y={PAD.t + 10}>
                        {v.label}
                      </text>
                    ) : null}
                  </g>
                ) : null,
              )}
              {cursor ? (
                <g className="heatmap-cross" pointerEvents="none">
                  <line x1={cursor.px} x2={cursor.px} y1={PAD.t} y2={PAD.t + plotH} />
                  <line x1={PAD.l} x2={PAD.l + plotW} y1={cursor.py} y2={cursor.py} />
                  {readout && readout.v != null && Number.isFinite(readout.v) ? (
                    <line
                      className="heatmap-cross-bar"
                      x1={barX - 3}
                      x2={barX + BAR_W + 3}
                      y1={PAD.t + plotH - (Math.min(readout.v, hi) / hi) * plotH}
                      y2={PAD.t + plotH - (Math.min(readout.v, hi) / hi) * plotH}
                    />
                  ) : null}
                </g>
              ) : null}
            </svg>
            {cursor && readout ? (
              <div
                className="chart-tip"
                style={{
                  left: cursor.px > width / 2 ? undefined : cursor.px + 14,
                  right: cursor.px > width / 2 ? width - cursor.px + 14 : undefined,
                  top: PAD.t + 4,
                }}
              >
                <div className="chart-tip-x">
                  {xLabel} = {sig(x[readout.row], 4)}
                  {xUnit ? ` ${xUnit}` : ''} · φ = {sig(readout.phi, 3)}°
                </div>
                <div className="chart-tip-row">
                  <span className="chart-tip-sw" style={{ background: cssSwatch(readout.v, hi, ramp) }} />
                  <span className="chart-tip-name">{valueLabel}</span>
                  <span className="chart-tip-val">
                    {readout.v == null || !Number.isFinite(readout.v) ? 'no data' : sig(readout.v, 3)}
                    {readout.v != null && valueUnit ? ` ${valueUnit}` : ''}
                  </span>
                </div>
                {rowInfo ? rowInfo(readout.row) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </figure>
  );
}

function cssSwatch(v: number | null, hi: number, ramp: (t: number) => Rgb): string {
  const [r, g, b] = v == null || !Number.isFinite(v) ? NODATA_RGB : ramp(Math.min(1, Math.max(0, v / hi)));
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}
