import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { sig } from '../util/format';

export interface Series {
  id: string;
  name: string;
  x: number[];
  y: number[];
  /** CSS colour; defaults to categorical slot by index. */
  color?: string;
  dash?: string;
  width?: number;
  /** Draw point markers. */
  markers?: boolean;
  /** Fill area down to y = 0 (or to `fillTo` series). */
  fill?: boolean;
  /** Hide from legend (e.g. helper series). */
  hideLegend?: boolean;
  /** Hide from hover readout. */
  noHover?: boolean;
}

export interface Band {
  x0: number;
  x1: number;
  label?: string;
}
export interface RefLine {
  value: number;
  label?: string;
  color?: string;
}

export interface LineChartProps {
  series: Series[];
  xLabel?: string;
  yLabel?: string;
  xUnit?: string;
  yUnit?: string;
  height?: number;
  title?: string;
  bands?: Band[];
  vlines?: RefLine[];
  hlines?: RefLine[];
  xDomain?: [number, number];
  yDomain?: [number, number];
  /** Force y domain to include 0. */
  yZero?: boolean;
  /** Use the same scale for x and y (geometry plots). */
  equalAspect?: boolean;
  /** Custom x formatting in the readout. */
  xFormat?: (x: number) => string;
  /** Tooltip mode: interpolate at cursor x (monotonic x) or nearest point. */
  hover?: 'x' | 'nearest';
  emptyText?: string;
}

const PAD = { l: 52, r: 14, t: 10, b: 34 };

/** "Nice" tick values covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 6): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi === lo) {
    hi = lo + 1;
    lo = lo - 1;
  }
  const span = hi - lo;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  const start = Math.ceil(lo / step - 1e-9) * step;
  for (let v = start; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function niceDomain(lo: number, hi: number): [number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi === lo) return [lo - 1, hi + 1];
  const t = niceTicks(lo, hi, 6);
  const step = t.length > 1 ? t[1] - t[0] : (hi - lo) / 5;
  return [Math.floor(lo / step + 1e-9) * step, Math.ceil(hi / step - 1e-9) * step];
}

function fmtTick(v: number, step: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(1);
  const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return v.toFixed(Math.min(d, 6));
}

function isMonotonic(x: number[]): boolean {
  for (let i = 1; i < x.length; i++) if (x[i] < x[i - 1]) return false;
  return true;
}

function interp(x: number[], y: number[], xv: number): number | null {
  const n = x.length;
  if (!n || xv < x[0] || xv > x[n - 1]) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (x[m] <= xv) lo = m;
    else hi = m;
  }
  const dx = x[hi] - x[lo];
  if (dx === 0) return y[lo];
  return y[lo] + ((y[hi] - y[lo]) * (xv - x[lo])) / dx;
}

export function LineChart({
  series,
  xLabel,
  yLabel,
  xUnit,
  yUnit,
  height = 220,
  title,
  bands,
  vlines,
  hlines,
  xDomain,
  yDomain,
  yZero,
  equalAspect,
  xFormat,
  hover = 'x',
  emptyText = 'No data',
}: LineChartProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const clipId = `clip${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [width, setWidth] = useState(600);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
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

  const colored = useMemo(
    () => series.map((s, i) => ({ ...s, color: s.color ?? `var(--series-${(i % 8) + 1})` })),
    [series],
  );
  const visible = useMemo(() => colored.filter((s) => !hidden.has(s.id)), [colored, hidden]);

  const plotW = Math.max(40, width - PAD.l - PAD.r);
  const plotH = Math.max(40, height - PAD.t - PAD.b);

  const { xd, yd } = useMemo(() => {
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const s of visible) {
      const n = Math.min(s.x.length, s.y.length);
      for (let i = 0; i < n; i++) {
        const xv = s.x[i],
          yv = s.y[i];
        if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
        if (xv < x0) x0 = xv;
        if (xv > x1) x1 = xv;
        if (yv < y0) y0 = yv;
        if (yv > y1) y1 = yv;
      }
    }
    for (const h of hlines ?? []) {
      y0 = Math.min(y0, h.value);
      y1 = Math.max(y1, h.value);
    }
    if (yZero) {
      y0 = Math.min(y0, 0);
      y1 = Math.max(y1, 0);
    }
    let xd: [number, number] = xDomain ?? (Number.isFinite(x0) ? [x0, x1 === x0 ? x0 + 1 : x1] : [0, 1]);
    let yd: [number, number] = yDomain ?? niceDomain(y0, y1);
    if (equalAspect && Number.isFinite(x0)) {
      const sx = (xd[1] - xd[0]) / plotW;
      const sy = (yd[1] - yd[0]) / plotH;
      if (sx > sy) {
        const need = sx * plotH;
        const lo = yZero ? Math.min(0, yd[0]) : yd[0] - (need - (yd[1] - yd[0])) / 2;
        yd = [lo, lo + need];
      } else {
        const need = sy * plotW;
        const c = (xd[0] + xd[1]) / 2;
        xd = [c - need / 2, c + need / 2];
      }
    }
    return { xd, yd };
  }, [visible, xDomain, yDomain, yZero, equalAspect, plotW, plotH, hlines]);

  const sx = (v: number) => PAD.l + ((v - xd[0]) / (xd[1] - xd[0] || 1)) * plotW;
  const sy = (v: number) => PAD.t + plotH - ((v - yd[0]) / (yd[1] - yd[0] || 1)) * plotH;
  const ix = (px: number) => xd[0] + ((px - PAD.l) / plotW) * (xd[1] - xd[0]);

  const xt = niceTicks(xd[0], xd[1], Math.max(3, Math.floor(plotW / 80)));
  const yt = niceTicks(yd[0], yd[1], Math.max(3, Math.floor(plotH / 40)));
  const xStep = xt.length > 1 ? xt[1] - xt[0] : 1;
  const yStep = yt.length > 1 ? yt[1] - yt[0] : 1;

  const paths = useMemo(
    () =>
      visible.map((s) => {
        let d = '';
        let pen = false;
        const n = Math.min(s.x.length, s.y.length);
        for (let i = 0; i < n; i++) {
          const xv = s.x[i],
            yv = s.y[i];
          if (!Number.isFinite(xv) || !Number.isFinite(yv)) {
            pen = false;
            continue;
          }
          d += `${pen ? 'L' : 'M'}${sx(xv).toFixed(1)},${sy(yv).toFixed(1)}`;
          pen = true;
        }
        let area = '';
        if (s.fill && n > 1) {
          const base = sy(Math.max(yd[0], Math.min(yd[1], 0)));
          area = `${d}L${sx(s.x[n - 1]).toFixed(1)},${base}L${sx(s.x[0]).toFixed(1)},${base}Z`;
        }
        return { s, d, area };
      }),
    [visible, xd, yd, plotW, plotH],
  );

  // hover readout
  const readout = useMemo(() => {
    if (!cursor) return null;
    const xv = ix(cursor.px);
    const rows: { s: (typeof visible)[number]; x: number; y: number }[] = [];
    for (const s of visible) {
      if (s.noHover) continue;
      const n = Math.min(s.x.length, s.y.length);
      if (!n) continue;
      if (hover === 'x' && isMonotonic(s.x)) {
        const yv = interp(s.x, s.y, xv);
        if (yv != null && Number.isFinite(yv)) rows.push({ s, x: xv, y: yv });
      } else {
        let best = -1;
        let bd = Infinity;
        for (let i = 0; i < n; i++) {
          if (!Number.isFinite(s.x[i]) || !Number.isFinite(s.y[i])) continue;
          const dx = sx(s.x[i]) - cursor.px;
          const dy = hover === 'nearest' ? sy(s.y[i]) - cursor.py : 0;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        if (best >= 0 && bd < 60 * 60) rows.push({ s, x: s.x[best], y: s.y[best] });
      }
    }
    return { xv, rows };
  }, [cursor, visible, xd, yd, hover]);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (px < PAD.l || px > PAD.l + plotW || py < PAD.t || py > PAD.t + plotH) setCursor(null);
    else setCursor({ px, py });
  };

  const hasData = colored.some((s) => s.x.length > 0);
  const legendItems = colored.filter((s) => !s.hideLegend);
  const xf = xFormat ?? ((v: number) => sig(v, 4));

  return (
    <figure className="chart" ref={wrap}>
      {title || legendItems.length > 1 ? (
        <figcaption className="chart-head">
          {title ? <span className="chart-title">{title}</span> : <span />}
          {legendItems.length > 1 ? (
            <ul className="legend">
              {legendItems.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={hidden.has(s.id) ? 'off' : ''}
                    aria-pressed={!hidden.has(s.id)}
                    title="Toggle series"
                    onClick={() =>
                      setHidden((h) => {
                        const n = new Set(h);
                        if (n.has(s.id)) n.delete(s.id);
                        else n.add(s.id);
                        return n;
                      })
                    }
                  >
                    <svg width="16" height="8" aria-hidden="true">
                      <line
                        x1="1"
                        x2="15"
                        y1="4"
                        y2="4"
                        stroke={s.color}
                        strokeWidth={2.5}
                        strokeDasharray={s.dash}
                        strokeLinecap="round"
                      />
                    </svg>
                    {s.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </figcaption>
      ) : null}
      <div className="chart-plot" style={{ height }}>
        {!hasData ? (
          <div className="chart-empty">{emptyText}</div>
        ) : (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={title ?? `${yLabel ?? 'y'} vs ${xLabel ?? 'x'}`}
            onPointerMove={onMove}
            onPointerLeave={() => setCursor(null)}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} />
              </clipPath>
            </defs>
            {/* bands */}
            {bands?.map((b, i) => {
              const x0 = Math.max(PAD.l, sx(b.x0));
              const x1 = Math.min(PAD.l + plotW, sx(b.x1));
              if (x1 <= x0) return null;
              return (
                <g key={`b${i}`}>
                  <rect x={x0} y={PAD.t} width={x1 - x0} height={plotH} className={`chart-band ${i % 2 ? 'alt' : ''}`} />
                  {b.label && x1 - x0 > 30 ? (
                    <text x={(x0 + x1) / 2} y={PAD.t + 11} className="chart-band-label" textAnchor="middle">
                      {b.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {/* grid */}
            <g className="chart-grid">
              {yt.map((v) => (
                <line key={`gy${v}`} x1={PAD.l} x2={PAD.l + plotW} y1={sy(v)} y2={sy(v)} />
              ))}
              {xt.map((v) => (
                <line key={`gx${v}`} y1={PAD.t} y2={PAD.t + plotH} x1={sx(v)} x2={sx(v)} />
              ))}
            </g>
            {/* axes */}
            <g className="chart-axis">
              <line x1={PAD.l} x2={PAD.l + plotW} y1={PAD.t + plotH} y2={PAD.t + plotH} />
              <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={PAD.t + plotH} />
              {xt.map((v) => (
                <text key={`tx${v}`} x={sx(v)} y={PAD.t + plotH + 14} textAnchor="middle">
                  {fmtTick(v, xStep)}
                </text>
              ))}
              {yt.map((v) => (
                <text key={`ty${v}`} x={PAD.l - 6} y={sy(v) + 3.5} textAnchor="end">
                  {fmtTick(v, yStep)}
                </text>
              ))}
              {xLabel ? (
                <text className="chart-axis-label" x={PAD.l + plotW / 2} y={height - 4} textAnchor="middle">
                  {xLabel}
                  {xUnit ? ` [${xUnit}]` : ''}
                </text>
              ) : null}
              {yLabel ? (
                <text
                  className="chart-axis-label"
                  transform={`translate(11 ${PAD.t + plotH / 2}) rotate(-90)`}
                  textAnchor="middle"
                >
                  {yLabel}
                  {yUnit ? ` [${yUnit}]` : ''}
                </text>
              ) : null}
            </g>
            <g clipPath={`url(#${clipId})`}>
              {/* reference lines */}
              {hlines?.map((h, i) => (
                <g key={`h${i}`} className="chart-ref">
                  <line x1={PAD.l} x2={PAD.l + plotW} y1={sy(h.value)} y2={sy(h.value)} stroke={h.color} />
                  {h.label ? (
                    <text x={PAD.l + plotW - 4} y={sy(h.value) - 4} textAnchor="end">
                      {h.label}
                    </text>
                  ) : null}
                </g>
              ))}
              {vlines?.map((v, i) => (
                <g key={`v${i}`} className="chart-ref">
                  <line y1={PAD.t} y2={PAD.t + plotH} x1={sx(v.value)} x2={sx(v.value)} stroke={v.color} />
                  {v.label ? (
                    <text x={sx(v.value) + 4} y={PAD.t + plotH - 4}>
                      {v.label}
                    </text>
                  ) : null}
                </g>
              ))}
              {/* data */}
              {paths.map(({ s, d, area }) =>
                area ? <path key={`a${s.id}`} d={area} fill={s.color} className="chart-area" /> : null,
              )}
              {paths.map(({ s, d }) => (
                <path
                  key={s.id}
                  d={d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.width ?? 2}
                  strokeDasharray={s.dash}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
              {visible
                .filter((s) => s.markers)
                .map((s) =>
                  s.x.map((xv, i) =>
                    Number.isFinite(xv) && Number.isFinite(s.y[i]) ? (
                      <circle key={`${s.id}m${i}`} cx={sx(xv)} cy={sy(s.y[i])} r={3} fill={s.color} className="chart-marker" />
                    ) : null,
                  ),
                )}
            </g>
            {/* crosshair */}
            {cursor && readout ? (
              <g className="chart-cross" pointerEvents="none">
                <line x1={cursor.px} x2={cursor.px} y1={PAD.t} y2={PAD.t + plotH} />
                {readout.rows.map((r) => (
                  <circle key={r.s.id} cx={sx(r.x)} cy={sy(r.y)} r={4} fill={r.s.color} className="chart-marker" />
                ))}
              </g>
            ) : null}
          </svg>
        )}
        {cursor && readout && readout.rows.length ? (
          <div
            className="chart-tip"
            style={{
              left: cursor.px > width / 2 ? undefined : cursor.px + 14,
              right: cursor.px > width / 2 ? width - cursor.px + 14 : undefined,
              top: PAD.t + 4,
            }}
          >
            <div className="chart-tip-x">
              {xLabel ?? 'x'} = {hover === 'x' ? xf(readout.xv) : xf(readout.rows[0].x)}
              {xUnit ? ` ${xUnit}` : ''}
            </div>
            {readout.rows.map((r) => (
              <div key={r.s.id} className="chart-tip-row">
                <span className="chart-tip-sw" style={{ background: r.s.color }} />
                <span className="chart-tip-name">{r.s.name}</span>
                <span className="chart-tip-val">
                  {sig(r.y, 4)}
                  {yUnit ? ` ${yUnit}` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </figure>
  );
}
