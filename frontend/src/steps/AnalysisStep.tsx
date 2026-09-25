import { useMemo, useState } from 'react';
import type { LoadPoint, Status, StructuralResult } from '../api/types';
import { Segmented } from '../components/fields';
import { LineChart, type Band, type Series } from '../components/LineChart';
import { Empty, Kpi, Meter, Spinner } from '../components/ui';
import { useAnalysis } from '../state/analysis';
import { useProject } from '../state/projectStore';
import { fmtCycles, fmtMass, sig } from '../util/format';
import { ThicknessChart } from './LayupStep';
import { ChecksList } from './shared';

function ratioStatus(v: number, limit: number, higherIsBetter: boolean): Status {
  const ok = higherIsBetter ? v >= limit : v <= limit;
  if (!ok) return 'fail';
  const margin = higherIsBetter ? v / limit - 1 : 1 - v / limit;
  return margin < 0.03 ? 'warn' : 'ok';
}

export function AnalysisPanel() {
  const { result, loading } = useAnalysis();
  const { project } = useProject();
  if (!result)
    return (
      <Empty>
        {loading ? (
          <>
            <Spinner /> Analysing…
          </>
        ) : (
          'No analysis result yet.'
        )}
      </Empty>
    );
  const st = result.structural;
  const req = project.requirements;
  const m = result.mass;
  const reqCycles = req.design_cycles * req.fatigue_scatter_factor;
  return (
    <>
      {st ? (
        <div className="kpi-grid">
          <Kpi
            label="Burst pressure"
            value={sig(st.burst_pressure, 4)}
            unit="MPa"
            status={ratioStatus(st.burst_pressure, st.required_burst, true)}
            sub={
              <>
                <Meter value={st.burst_pressure} limit={st.required_burst} invert />
                req. {sig(st.required_burst, 4)} MPa · {st.burst_pressure >= st.required_burst ? '+' : ''}
                {sig((st.burst_pressure / st.required_burst - 1) * 100, 3)} %
              </>
            }
          />
          <Kpi label="Burst mode" value={<span className="kpi-text">{st.burst_mode}</span>} sub={`fibre strength ${sig(st.fiber_strength, 4)} MPa`} />
          <Kpi
            label="Stress ratio hoop"
            value={sig(st.stress_ratio_hoop, 3)}
            status={ratioStatus(st.stress_ratio_hoop, req.stress_ratio_limit, false)}
            sub={
              <>
                <Meter value={st.stress_ratio_hoop} limit={req.stress_ratio_limit} />
                limit {sig(req.stress_ratio_limit, 3)} at MEOP
              </>
            }
          />
          <Kpi
            label="Stress ratio helical"
            value={sig(st.stress_ratio_helical, 3)}
            status={ratioStatus(st.stress_ratio_helical, req.stress_ratio_limit, false)}
            sub={
              <>
                <Meter value={st.stress_ratio_helical} limit={req.stress_ratio_limit} />
                limit {sig(req.stress_ratio_limit, 3)} at MEOP
              </>
            }
          />
          <Kpi
            label="Autofrettage"
            value={sig(st.autofrettage_pressure, 4)}
            unit="MPa"
            status={
              st.autofrettage_pressure >= st.autofrettage_window[0] && st.autofrettage_pressure <= st.autofrettage_window[1]
                ? 'ok'
                : 'warn'
            }
            sub={`${st.autofrettage_auto ? 'auto' : 'manual'} · window ${sig(st.autofrettage_window[0], 4)} – ${sig(st.autofrettage_window[1], 4)}`}
          />
          <Kpi
            label="Liner fatigue"
            value={fmtCycles(st.liner_fatigue_cycles)}
            unit="cycles"
            status={ratioStatus(st.liner_fatigue_cycles, reqCycles, true)}
            sub={`required ${fmtCycles(reqCycles)} (${req.design_cycles} × ${req.fatigue_scatter_factor})`}
          />
          <Kpi
            label="Mass"
            value={fmtMass(m.total)}
            sub={`liner ${fmtMass(m.liner)} · fibre ${fmtMass(m.fiber)} · resin ${fmtMass(m.resin)}`}
          />
          <Kpi label="Volume" value={sig(m.volume, 4)} unit="L" sub={`PV/W ${sig(m.pv_w, 3)} km`} />
        </div>
      ) : (
        <div className="kpi-grid">
          <Kpi label="Mass" value={fmtMass(m.total)} sub={`liner ${fmtMass(m.liner)} · fibre ${fmtMass(m.fiber)} · resin ${fmtMass(m.resin)}`} />
          <Kpi label="Volume" value={sig(m.volume, 4)} unit="L" sub={`PV/W ${sig(m.pv_w, 3)} km`} />
        </div>
      )}
      {!st ? <p className="muted small">No structural result (add helical and hoop layers).</p> : null}
      {st ? <LoadTable st={st} /> : null}
      <ChecksList checks={result.checks} title="All checks" />
    </>
  );
}

function LoadTable({ st }: { st: StructuralResult }) {
  const rows: [string, LoadPoint][] = [
    ['Residual (0)', st.residual],
    ['MEOP', st.at_meop],
    ['Proof', st.at_proof],
  ];
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption>Stress state [MPa]</caption>
        <thead>
          <tr>
            <th>State</th>
            <th className="num">p</th>
            <th className="num" title="Liner von Mises">Liner σvm</th>
            <th className="num">Liner σθ</th>
            <th className="num">Fibre hoop</th>
            <th className="num">Fibre helix</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, p]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="num">{sig(p.pressure, 4)}</td>
              <td className="num">{sig(p.liner_vm, 4)}</td>
              <td className="num">{sig(p.liner_hoop, 4)}</td>
              <td className="num">{sig(p.fiber_hoop, 4)}</td>
              <td className="num">{sig(p.fiber_helical, 4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ charts
type HistX = 'pressure' | 'step';

export function LoadHistoryChart({ height = 250 }: { height?: number }) {
  const { result } = useAnalysis();
  const [xMode, setXMode] = useState<HistX>('pressure');
  const h = result?.structural?.history ?? [];
  const { series, bands } = useMemo(() => {
    const x = h.map((p, i) => (xMode === 'pressure' ? p.pressure : i));
    const mk = (id: keyof LoadPoint, name: string, color: string, dash?: string): Series => ({
      id,
      name,
      x,
      y: h.map((p) => p[id] as number),
      color,
      dash,
      markers: h.length < 40,
    });
    const series: Series[] = [
      mk('liner_vm', 'Liner von Mises', 'var(--series-1)'),
      mk('liner_hoop', 'Liner hoop', 'var(--series-1)', '5 3'),
      mk('liner_axial', 'Liner axial', 'var(--series-7)', '2 3'),
      mk('fiber_hoop', 'Fibre hoop', 'var(--series-2)'),
      mk('fiber_helical', 'Fibre helical', 'var(--series-3)'),
    ];
    const bands: Band[] = [];
    if (xMode === 'step' && h.length) {
      let start = 0;
      for (let i = 1; i <= h.length; i++) {
        if (i === h.length || h[i].phase !== h[start].phase) {
          bands.push({ x0: Math.max(0, start - 0.5), x1: Math.min(h.length - 1, i - 0.5), label: h[start].phase });
          start = i;
        }
      }
    }
    return { series, bands };
  }, [h, xMode]);

  const phaseAt = (x: number) => h[Math.round(x)]?.phase ?? '';
  return (
    <div className="chart-with-tools">
      <div className="chart-tools">
        <Segmented<HistX>
          size="sm"
          ariaLabel="Load history x axis"
          value={xMode}
          options={[
            { value: 'pressure', label: 'vs pressure' },
            { value: 'step', label: 'vs sequence' },
          ]}
          onChange={setXMode}
        />
      </div>
      <LineChart
        title="Load history"
        series={series}
        bands={bands}
        xLabel={xMode === 'pressure' ? 'Pressure' : 'Load step'}
        xUnit={xMode === 'pressure' ? 'MPa' : undefined}
        yLabel="Stress"
        yUnit="MPa"
        height={height}
        hover={xMode === 'pressure' ? 'nearest' : 'x'}
        xFormat={xMode === 'step' ? (x) => `${Math.round(x)} (${phaseAt(x)})` : undefined}
        hlines={[{ value: 0, color: 'var(--axis)' }]}
        emptyText="No load history"
      />
    </div>
  );
}

export function DomeStressChart({ height = 250 }: { height?: number }) {
  const { result } = useAnalysis();
  const { project } = useProject();
  const st = result?.structural;
  const c = st?.dome_fiber_stress;
  const limit = st ? st.fiber_strength * project.requirements.stress_ratio_limit : null;
  return (
    <LineChart
      title="Fibre stress at MEOP along z"
      series={c ? [{ id: 'dfs', name: 'Fibre stress', x: c.x, y: c.y, color: 'var(--series-2)' }] : []}
      hlines={limit != null ? [{ value: limit, label: `limit ${sig(limit, 4)} MPa`, color: 'var(--status-critical)' }] : undefined}
      xLabel="z"
      xUnit="mm"
      yLabel="σf"
      yUnit="MPa"
      yZero
      height={height}
      emptyText="No structural result"
    />
  );
}

export function AnalysisBottom() {
  return (
    <div className="bottom-grid three">
      <LoadHistoryChart />
      <DomeStressChart />
      <ThicknessChart height={250} initialMode="total" />
    </div>
  );
}
