import { useMemo, useState } from 'react';
import type { FEResult, LinerSpec, LoadPoint, Status, StructuralResult } from '../api/types';
import { Field, Section, Segmented, SliderField, Switch } from '../components/fields';
import { LineChart, type Band, type RefLine, type Series } from '../components/LineChart';
import { Empty, Kpi, Meter, Spinner } from '../components/ui';
import { useAnalysis } from '../state/analysis';
import { useProject } from '../state/projectStore';
import { useUi, type FeOverlay } from '../state/uiStore';
import { layerColors } from '../viewer/colors';
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
  const fe = result.fe ?? null;
  const liner = project.liner;
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
          <Kpi
            label="Burst mode"
            value={<span className="kpi-text">{st.burst_mode}</span>}
            sub={`fibre strength ${sig(st.fiber_strength, 4)} MPa`}
          />
          {fe ? (
            <>
              <Kpi
                label="Burst incl. domes (FE)"
                value={sig(fe.dome_burst, 4)}
                unit="MPa"
                status={ratioStatus(fe.dome_burst, st.required_burst, true)}
                title="Cylinder burst scaled by the shell-FE fibre strain distribution over the whole vessel"
                sub={
                  <>
                    <Meter value={fe.dome_burst} limit={st.required_burst} invert />
                    req. {sig(st.required_burst, 4)} · cylinder {sig(st.burst_pressure, 4)} MPa
                    {fe.dome_burst < st.burst_pressure * (1 - 1e-4)
                      ? ` (${sig((fe.dome_burst / st.burst_pressure - 1) * 100, 2)} %)`
                      : ''}
                    <br />
                    critical: {fe.critical_layer ?? '–'}, {zoneOf(fe.critical_z, liner)} (z {sig(fe.critical_z, 4)} mm)
                  </>
                }
              />
              <Kpi
                label="Liner hot spot (FE)"
                value={`×${sig(fe.liner_hotspot_factor, 3)}`}
                status={ratioStatus(fe.liner_hotspot_cycles, reqCycles, true)}
                title="Peak liner stress range / cylinder value (bending at dome and boss transitions) and the fatigue life there"
                sub={
                  <>
                    <Meter value={fe.liner_hotspot_cycles} limit={reqCycles} invert />
                    {fmtCycles(fe.liner_hotspot_cycles)} cycles (req. {fmtCycles(reqCycles)})
                    <br />
                    at {zoneOf(fe.liner_hotspot_z, liner)} (z {sig(fe.liner_hotspot_z, 4)} mm)
                  </>
                }
              />
            </>
          ) : null}
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
              st.autofrettage_pressure >= st.autofrettage_window[0] &&
              st.autofrettage_pressure <= st.autofrettage_window[1]
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
          <Kpi
            label="Mass"
            value={fmtMass(m.total)}
            sub={`liner ${fmtMass(m.liner)} · fibre ${fmtMass(m.fiber)} · resin ${fmtMass(m.resin)}`}
          />
          <Kpi label="Volume" value={sig(m.volume, 4)} unit="L" sub={`PV/W ${sig(m.pv_w, 3)} km`} />
        </div>
      )}
      {!st ? <p className="muted small">No structural result (add helical and hoop layers).</p> : null}
      {fe ? <FeViewControls fe={fe} radius={liner.radius} /> : null}
      {st ? <LoadTable st={st} /> : null}
      <ChecksList checks={result.checks} title="All checks" />
    </>
  );
}

/** Where on the vessel an axial position lies. */
function zoneOf(z: number, l: LinerSpec): string {
  const half = l.cyl_length / 2;
  return Math.abs(z) <= half ? 'cylinder' : z < 0 ? 'dome A' : 'dome B';
}

/** A 1-2-5 magnification that makes the largest radial displacement ~10 % of the vessel radius. */
function autoDeformScale(fe: FEResult, radius: number): number {
  let m = 0;
  for (const u of fe.radial_displacement) m = Math.max(m, Math.abs(u));
  if (!(m > 0)) return 100;
  const raw = (0.1 * radius) / m;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return Math.max(1, Math.min(500, (n >= 5 ? 5 : n >= 2 ? 2 : 1) * mag));
}

function FeViewControls({ fe, radius }: { fe: FEResult; radius: number }) {
  const { overlay, setOverlay } = useUi();
  return (
    <Section title="3D view · shell FE at MEOP">
      <Field
        label="Colour surface"
        hint={
          overlay.fe === 'fiber'
            ? 'Largest fibre strain / allowable of all layers at each z'
            : overlay.fe === 'liner'
              ? 'Liner von Mises (larger of inner and outer surface) at each z'
              : 'Paints the outer vessel surface by a quantity along z'
        }
      >
        <Segmented<FeOverlay>
          size="sm"
          ariaLabel="Colour the vessel surface by"
          value={overlay.fe}
          options={[
            { value: 'none', label: 'None' },
            { value: 'fiber', label: 'Fibre util.' },
            { value: 'liner', label: 'Liner vM' },
          ]}
          onChange={(v) => setOverlay({ fe: v })}
        />
      </Field>
      <Field label="Deformed shape" hint="Radial and axial displacement at MEOP, magnified; dashed: undeformed">
        <Switch
          checked={overlay.deform}
          label="Show"
          onChange={(v) =>
            setOverlay(v ? { deform: true, deformScale: autoDeformScale(fe, radius) } : { deform: false })
          }
        />
      </Field>
      {overlay.deform ? (
        <SliderField
          label="Scale factor"
          value={overlay.deformScale}
          min={1}
          max={500}
          step={1}
          unit="×"
          onChange={(v) => setOverlay({ deformScale: v })}
        />
      ) : null}
    </Section>
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
      <table className="data-table compact">
        <caption>Stress state [MPa]</caption>
        <thead>
          <tr>
            <th>State</th>
            <th className="num" title="Pressure [MPa]">
              p
            </th>
            <th className="num" title="Liner von Mises stress [MPa]">
              Liner vM
            </th>
            <th className="num" title="Liner hoop stress [MPa]">
              Liner θ
            </th>
            <th className="num" title="Hoop fibre stress [MPa]">
              F hoop
            </th>
            <th className="num" title="Helical fibre stress [MPa]">
              F helix
            </th>
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
      tools={
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
      }
    />
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
      hlines={
        limit != null
          ? [{ value: limit, label: `limit ${sig(limit, 4)} MPa`, color: 'var(--status-critical)' }]
          : undefined
      }
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

// ------------------------------------------------------------------ shell FE charts
const num = (a: (number | null)[]) => a.map((v) => (v == null || !Number.isFinite(v) ? NaN : v));

/**
 * The FE clamps the liner at the bosses (rigid rings); the backend leaves
 * r < boss radius + 3 x wall out of the critical-point and hot-spot search.
 * Returns that zone at each end as chart bands and the z range outside it.
 */
function bossZones(fe: FEResult, l: LinerSpec): { bands: Band[]; valid: (i: number) => boolean } {
  const ok = fe.z.map((z, i) => fe.r[i] > (z < 0 ? l.boss_radius_a : l.boss_radius_b) + 3 * l.wall_thickness);
  const first = ok.indexOf(true);
  const last = ok.lastIndexOf(true);
  const bands: Band[] = [];
  if (first > 0) bands.push({ x0: fe.z[0], x1: fe.z[first], label: 'boss' });
  if (last >= 0 && last < fe.z.length - 1) bands.push({ x0: fe.z[last], x1: fe.z[fe.z.length - 1], label: 'boss' });
  return { bands, valid: (i) => ok[i] };
}

/** y domain clipped to the valid region when edge spikes would flatten the curve. */
function clippedDomain(ys: number[][], valid: (i: number) => boolean): [number, number] | undefined {
  let all = 0;
  let inside = 0;
  for (const y of ys)
    y.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      all = Math.max(all, v);
      if (valid(i)) inside = Math.max(inside, v);
    });
  return inside > 0 && all > 1.5 * inside ? [0, inside * 1.15] : undefined;
}

type FiberMode = 'max' | 'layers' | 'helical' | 'hoop';

export function FiberUtilChart({ height = 250 }: { height?: number }) {
  const { result, resultProject } = useAnalysis();
  const { project } = useProject();
  const [mode, setMode] = useState<FiberMode>('max');
  const fe = result?.fe ?? null;
  const liner = (resultProject ?? project).liner;
  const colors = useMemo(() => layerColors(project.layers), [project.layers]);
  const view = useMemo(() => {
    if (!fe || !result) return null;
    const { bands, valid } = bossZones(fe, liner);
    const max = num(fe.fiber_ratio_max);
    const lrs = result.layers;
    const per: Series[] = [];
    if (mode !== 'max') {
      const pick = lrs
        .map((l, k) => ({ l, k }))
        .filter(({ l }) => mode === 'layers' || l.type === mode)
        .filter(({ k }) => fe.fiber_ratio[k]);
      const many = pick.length > 8;
      for (const { l, k } of pick)
        per.push({
          id: l.id,
          name: l.id,
          x: fe.z,
          y: num(fe.fiber_ratio[k]),
          color: colors.get(l.id) ?? 'var(--series-1)',
          width: 1.25,
          hideLegend: pick.length > 12,
          noHover: many,
        });
    }
    // cylinder reference: the backend scales the cylinder burst by (cylinder peak / peak anywhere)
    const half = liner.cyl_length / 2;
    const cylBand = Math.max(half - 20, 0.25 * half);
    let ref = 0;
    fe.z.forEach((z, i) => {
      if (Math.abs(z) < cylBand && Number.isFinite(max[i])) ref = Math.max(ref, max[i]);
    });
    let ic = 0;
    fe.z.forEach((z, i) => {
      if (Math.abs(z - fe.critical_z) < Math.abs(fe.z[ic] - fe.critical_z)) ic = i;
    });
    const series: Series[] = [
      ...per,
      { id: 'max', name: 'max (all layers)', x: fe.z, y: max, color: 'var(--text)', width: mode === 'max' ? 2 : 2.25 },
      {
        id: 'crit',
        name: 'critical',
        x: [fe.z[ic]],
        y: [max[ic]],
        color: 'var(--status-critical)',
        markers: true,
        hideLegend: true,
        noHover: true,
      },
    ];
    const hlines: RefLine[] =
      ref > 0 ? [{ value: ref, label: `cylinder peak ${sig(ref, 3)}`, color: 'var(--axis)' }] : [];
    const vlines: RefLine[] = [
      { value: fe.critical_z, label: `critical: ${fe.critical_layer ?? '–'}`, color: 'var(--status-critical)' },
    ];
    return { series, bands, hlines, vlines, yDomain: clippedDomain([max], valid) };
  }, [fe, result, liner, mode, colors]);
  return (
    <LineChart
      title="Fibre utilisation · FE"
      series={view?.series ?? []}
      bands={view?.bands}
      hlines={view?.hlines}
      vlines={view?.vlines}
      yDomain={view?.yDomain}
      xLabel="z"
      xUnit="mm"
      yLabel="ε/ε_ult @ MEOP"
      yZero
      height={height}
      emptyText="No FE result"
      tools={
        <Segmented<FiberMode>
          size="sm"
          ariaLabel="Fibre utilisation series"
          value={mode}
          options={[
            { value: 'max', label: 'Max' },
            { value: 'layers', label: 'Layers' },
            { value: 'helical', label: 'Helical' },
            { value: 'hoop', label: 'Hoop' },
          ]}
          onChange={setMode}
        />
      }
    />
  );
}

export function LinerStressChart({ height = 250 }: { height?: number }) {
  const { result, resultProject } = useAnalysis();
  const { project } = useProject();
  const fe = result?.fe ?? null;
  const liner = (resultProject ?? project).liner;
  const view = useMemo(() => {
    if (!fe) return null;
    const { bands, valid } = bossZones(fe, liner);
    const vi = num(fe.liner_vm_inner);
    const vo = num(fe.liner_vm_outer);
    let ih = 0;
    fe.z.forEach((z, i) => {
      if (Math.abs(z - fe.liner_hotspot_z) < Math.abs(fe.z[ih] - fe.liner_hotspot_z)) ih = i;
    });
    const peak = Math.max(vi[ih], vo[ih]);
    const ref = fe.liner_hotspot_factor > 0 ? peak / fe.liner_hotspot_factor : 0;
    const series: Series[] = [
      { id: 'in', name: 'inner surface', x: fe.z, y: vi, color: 'var(--series-1)' },
      { id: 'out', name: 'outer surface', x: fe.z, y: vo, color: 'var(--series-2)', dash: '5 3' },
      {
        id: 'hot',
        name: 'hot spot',
        x: [fe.z[ih]],
        y: [peak],
        color: 'var(--status-critical)',
        markers: true,
        hideLegend: true,
        noHover: true,
      },
    ];
    return {
      series,
      bands,
      hlines: ref > 0 ? [{ value: ref, label: `cylinder ${sig(ref, 3)}`, color: 'var(--axis)' }] : [],
      vlines: [
        {
          value: fe.liner_hotspot_z,
          label: `hot spot ×${sig(fe.liner_hotspot_factor, 3)}`,
          color: 'var(--status-critical)',
        },
      ],
      yDomain: clippedDomain([vi, vo], valid),
    };
  }, [fe, liner]);
  return (
    <LineChart
      title="Liner von Mises · FE"
      series={view?.series ?? []}
      bands={view?.bands}
      hlines={view?.hlines}
      vlines={view?.vlines}
      yDomain={view?.yDomain}
      xLabel="z"
      xUnit="mm"
      yLabel="σvM @ MEOP"
      yUnit="MPa"
      yZero
      height={height}
      emptyText="No FE result"
    />
  );
}

export function AnalysisBottom() {
  const { result } = useAnalysis();
  const hasFe = !!result?.fe;
  return (
    <div className="bottom-grid three">
      <LoadHistoryChart />
      {hasFe ? <FiberUtilChart /> : null}
      {hasFe ? <LinerStressChart /> : null}
      <DomeStressChart />
      <ThicknessChart height={250} initialMode="total" />
    </div>
  );
}
