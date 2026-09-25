import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { sig } from '../util/format';
import { niceTicks } from './LineChart';

export interface BarSeries {
  id: string;
  name: string;
  values: number[];
  /** CSS colour */
  color: string;
}

/**
 * Grouped vertical bars, one group per category (e.g. per layer). Compact
 * enough for the side panel; hovering a group shows all its values.
 */
export function BarChart({
  categories,
  tickLabels,
  series,
  yLabel,
  yUnit,
  height = 180,
  title,
  hline,
}: {
  categories: string[];
  /** Short labels under the bars (default: 1-based index). */
  tickLabels?: string[];
  series: BarSeries[];
  yLabel?: string;
  yUnit?: string;
  height?: number;
  title?: ReactNode;
  hline?: { value: number; label?: string };
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(340);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => {
      const w = Math.floor(e[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const PAD = { l: 40, r: 8, t: 8, b: 30 };
  const plotW = Math.max(40, width - PAD.l - PAD.r);
  const plotH = Math.max(40, height - PAD.t - PAD.b);
  const n = categories.length;
  const [y0, y1] = useMemo(() => {
    let lo = 0;
    let hi = 0;
    for (const s of series)
      for (const v of s.values)
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
    if (hline) hi = Math.max(hi, hline.value);
    const t = niceTicks(lo, hi || 1, 5);
    const step = t.length > 1 ? t[1] - t[0] : 1;
    return [Math.floor(lo / step) * step, Math.ceil((hi || 1) / step) * step];
  }, [series, hline]);
  const sy = (v: number) => PAD.t + plotH - ((v - y0) / (y1 - y0 || 1)) * plotH;
  const yt = niceTicks(y0, y1, Math.max(3, Math.floor(plotH / 36)));
  const gw = plotW / Math.max(1, n);
  const inner = Math.min(gw * 0.8, 10 * series.length + 4);
  const bw = inner / Math.max(1, series.length);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 18))));

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left - PAD.l;
    const i = Math.floor(px / gw);
    setHover(px >= 0 && i >= 0 && i < n ? i : null);
  };

  return (
    <figure className="chart bar-chart" ref={wrap}>
      <figcaption className="chart-head">
        {title ? (
          <div className="chart-head-row">
            <span className="chart-title">{title}</span>
          </div>
        ) : null}
        <ul className="legend static">
          {series.map((s) => (
            <li key={s.id}>
              <span>
                <i className="legend-box" style={{ background: s.color }} />
                {s.name}
              </span>
            </li>
          ))}
        </ul>
      </figcaption>
      <div className="chart-plot" style={{ height }}>
        {!n ? (
          <div className="chart-empty">No data</div>
        ) : (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={typeof title === 'string' ? title : (yLabel ?? 'bar chart')}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            <g className="chart-grid">
              {yt.map((v) => (
                <line key={v} x1={PAD.l} x2={PAD.l + plotW} y1={sy(v)} y2={sy(v)} />
              ))}
            </g>
            {hover != null ? (
              <rect className="bar-hover" x={PAD.l + hover * gw} y={PAD.t} width={gw} height={plotH} />
            ) : null}
            {categories.map((c, i) => {
              const x0 = PAD.l + i * gw + (gw - inner) / 2;
              return (
                <g key={c}>
                  {series.map((s, k) => {
                    const v = s.values[i];
                    if (!Number.isFinite(v)) return null;
                    const ya = sy(Math.max(0, v));
                    const yb = sy(Math.min(0, v));
                    return (
                      <rect
                        key={s.id}
                        x={x0 + k * bw}
                        y={ya}
                        width={Math.max(1, bw - 1)}
                        height={Math.max(0.5, yb - ya)}
                        fill={s.color}
                        rx={1}
                      />
                    );
                  })}
                </g>
              );
            })}
            {hline ? (
              <g className="chart-ref">
                <line x1={PAD.l} x2={PAD.l + plotW} y1={sy(hline.value)} y2={sy(hline.value)} />
              </g>
            ) : null}
            <g className="chart-axis">
              <line x1={PAD.l} x2={PAD.l + plotW} y1={sy(0)} y2={sy(0)} />
              {yt.map((v) => (
                <text key={v} x={PAD.l - 5} y={sy(v) + 3.5} textAnchor="end">
                  {sig(v, 3)}
                </text>
              ))}
              {categories.map((c, i) =>
                i % labelEvery === 0 ? (
                  <text key={c} x={PAD.l + (i + 0.5) * gw} y={PAD.t + plotH + 13} textAnchor="middle">
                    {tickLabels?.[i] ?? i + 1}
                  </text>
                ) : null,
              )}
              {yLabel ? (
                <text
                  className="chart-axis-label"
                  transform={`translate(10 ${PAD.t + plotH / 2}) rotate(-90)`}
                  textAnchor="middle"
                >
                  {yLabel}
                  {yUnit ? ` [${yUnit}]` : ''}
                </text>
              ) : null}
              <text className="chart-axis-label" x={PAD.l + plotW / 2} y={height - 3} textAnchor="middle">
                Layer
              </text>
            </g>
          </svg>
        )}
        {hover != null ? (
          <div
            className="chart-tip"
            style={{
              left: PAD.l + (hover + 1) * gw + 6 < width - 150 ? PAD.l + (hover + 1) * gw + 6 : undefined,
              right: PAD.l + (hover + 1) * gw + 6 < width - 150 ? undefined : width - PAD.l - hover * gw + 6,
              top: PAD.t,
            }}
          >
            <div className="chart-tip-x">
              {hover + 1}. {categories[hover]}
            </div>
            {series.map((s) => (
              <div key={s.id} className="chart-tip-row">
                <span className="chart-tip-sw" style={{ background: s.color }} />
                <span className="chart-tip-name">{s.name}</span>
                <span className="chart-tip-val">
                  {sig(s.values[hover], 3)}
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
