import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api, errorMessage, isAbort } from '../api/client';
import type {
  FailureEventKind,
  FEResult,
  LinerSpec,
  LoadPoint,
  ProgressiveResult,
  Project,
  RuptureResult,
  Status,
  StructuralResult,
} from '../api/types';
import { Field, NumberField, Section, Segmented, SliderField, Switch } from '../components/fields';
import { LineChart, type Band, type RefLine, type Series } from '../components/LineChart';
import { Banner, Button, Empty, Kpi, Meter, Progress, Spinner, StatusPill } from '../components/ui';
import { useAnalysis } from '../state/analysis';
import { usePolymerLiner } from '../state/materials';
import { useProject } from '../state/projectStore';
import { useUi, type FeOverlay } from '../state/uiStore';
import { layerColors } from '../viewer/colors';
import { fmtCycles, fmtMass, sig } from '../util/format';
import { ThicknessChart } from './LayupStep';
import { ChecksList, NO_AUTOFRETTAGE_NOTE } from './shared';
import { PressureTargets } from './PressureTargets';
import { feValidMask } from '../state/fe';

function ratioStatus(v: number, limit: number, higherIsBetter: boolean): Status {
  const ok = higherIsBetter ? v >= limit : v <= limit;
  if (!ok) return 'fail';
  const margin = higherIsBetter ? v / limit - 1 : 1 - v / limit;
  return margin < 0.03 ? 'warn' : 'ok';
}

export function AnalysisPanel() {
  const { result, loading } = useAnalysis();
  const { project } = useProject();
  const polymer = usePolymerLiner();
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
            label="Stress ratio, temp. range"
            value={sig(st.stress_ratio_worst, 3)}
            status={ratioStatus(st.stress_ratio_worst, req.stress_ratio_limit, false)}
            title="Largest fibre stress ratio at MEOP over the operating temperature range (thermal stresses from the cure / stress-free temperature included)"
            sub={
              <>
                <Meter value={st.stress_ratio_worst} limit={req.stress_ratio_limit} />
                MEOP at {sig(req.temperature_min, 3)} … {sig(req.temperature_max, 3)} °C
              </>
            }
          />
          {polymer ? (
            <Kpi
              label="Autofrettage"
              value="None"
              title={NO_AUTOFRETTAGE_NOTE}
              sub="Type IV: first load is the proof test"
            />
          ) : (
            <>
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
            </>
          )}
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
      {st?.rupture ? <RuptureSection r={st.rupture} polymer={polymer} /> : null}
      {st ? <LoadTable st={st} temps={req} polymer={polymer} /> : null}
      {st ? <PressureTargets /> : null}
      <ProgressiveSection />
      <ChecksList checks={result.checks} title="All checks" />
    </>
  );
}

/** Failure probability in compact scientific notation. */
function fmtPf(v: number): string {
  if (!Number.isFinite(v)) return '–';
  if (v <= 0) return '0';
  return v >= 0.01 ? sig(v, 3) : v.toExponential(1);
}

function fmtLife(y: number): string {
  return y > 1e6 ? '> 1e6' : sig(y, 3);
}

function RuptureSection({ r, polymer }: { r: RuptureResult; polymer: boolean }) {
  const pass = r.pf <= r.target;
  return (
    <Section title="Stress-rupture reliability">
      <div className="kpi-grid">
        <Kpi
          label="Rupture Pf"
          value={fmtPf(r.pf)}
          status={pass ? 'ok' : 'fail'}
          title={`Probability of stress-rupture failure over the service life, given the vessel survived ${polymer ? 'the proof test' : 'autofrettage and proof'}`}
          sub={
            <>
              <StatusPill status={pass ? 'ok' : 'fail'}>{pass ? 'Pass' : 'Fail'}</StatusPill> target {fmtPf(r.target)}{' '}
              over {sig(r.service_life, 3)} y
            </>
          }
        />
        <Kpi label="Reliability" value={sig(r.reliability, 9)} sub={`1 − Pf · ${r.family}`} />
      </div>
      <div className="table-scroll">
        <table className="data-table compact">
          <caption>Fibre groups</caption>
          <thead>
            <tr>
              <th>Group</th>
              <th className="num" title="Fibre stress ratio at MEOP">
                σ/σu
              </th>
              <th className="num" title="Highest MEOP stress ratio that meets the target over the service life">
                allowed
              </th>
              <th className="num" title="Stress ratio at autofrettage / proof">
                AF / proof
              </th>
              <th className="num" title="Service failure probability (with proof-test credit)">
                Pf
              </th>
              <th className="num" title="Pf without credit for surviving autofrettage and proof">
                no credit
              </th>
              <th className="num" title="Service years until Pf reaches the target">
                life y
              </th>
            </tr>
          </thead>
          <tbody>
            {r.groups.map((g) => (
              <tr key={g.group}>
                <td>{g.group}</td>
                <td className={`num ${g.ratio_meop > g.allowed_ratio ? 'bad' : ''}`}>{sig(g.ratio_meop, 3)}</td>
                <td className="num">{sig(g.allowed_ratio, 3)}</td>
                <td className="num">
                  {sig(g.ratio_autofrettage, 3)} / {sig(g.ratio_proof, 3)}
                </td>
                <td className={`num ${g.pf > r.target ? 'bad' : ''}`}>{fmtPf(g.pf)}</td>
                <td className="num">{fmtPf(g.pf_no_proof_credit)}</td>
                <td className="num">{fmtLife(g.life_years)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Weibull power-law breakdown model with credit for surviving{' '}
        {polymer ? 'the proof test' : 'autofrettage and proof'}; shape {sig(r.weibull_shape, 3)}, exponent{' '}
        {sig(r.exponent, 3)}
        {r.calibrated ? ' (calibrated to the ISO 11119 / 11439 stress ratios)' : ' (user override)'}. Pf vs time is
        plotted below the 3D view.
        {polymer ? ` ${NO_AUTOFRETTAGE_NOTE}` : null}
      </p>
    </Section>
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

function LoadTable({
  st,
  temps,
  polymer,
}: {
  st: StructuralResult;
  temps: { temperature_min: number; temperature_max: number; temperature_ref: number };
  polymer: boolean;
}) {
  const t = (v: number) => `${sig(v, 3)} °C`;
  const rows: [string, LoadPoint | null, string][] = [
    [
      'After cure',
      st.cure_residual,
      `Cool-down from the stress-free temperature to ${t(temps.temperature_ref)}, before ${polymer ? 'the proof test' : 'autofrettage'}`,
    ],
    [
      'Residual (0)',
      st.residual,
      polymer
        ? `After the proof test (Type IV: no autofrettage), at 0 MPa and ${t(temps.temperature_ref)}`
        : `After autofrettage, at 0 MPa and ${t(temps.temperature_ref)}`,
    ],
    ['MEOP cold', st.meop_cold, `MEOP at ${t(temps.temperature_min)}`],
    ['MEOP', st.at_meop, `MEOP at ${t(temps.temperature_ref)}`],
    ['MEOP hot', st.meop_hot, `MEOP at ${t(temps.temperature_max)}`],
    ['Proof', st.at_proof, `Proof pressure at ${t(temps.temperature_ref)}`],
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
          {rows.map(([k, p, title]) =>
            p ? (
              <tr key={k} title={title} className={k === 'MEOP' ? 'row-strong' : undefined}>
                <td>{k}</td>
                <td className="num">{sig(p.pressure, 4)}</td>
                <td className="num">{sig(p.liner_vm, 4)}</td>
                <td className="num">{sig(p.liner_hoop, 4)}</td>
                <td className="num">{sig(p.fiber_hoop, 4)}</td>
                <td className="num">{sig(p.fiber_helical, 4)}</td>
              </tr>
            ) : null,
          )}
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

/** Stress-rupture Pf vs service time; LineChart has no log axes, so both are plotted as log10. */
export function RuptureChart({ height = 250 }: { height?: number }) {
  const { result } = useAnalysis();
  const r = result?.structural?.rupture ?? null;
  const view = useMemo(() => {
    if (!r) return null;
    const x: number[] = [];
    const y: number[] = [];
    r.curve_years.forEach((t, i) => {
      const pf = r.curve_pf[i];
      if (t > 0 && pf > 0) {
        x.push(Math.log10(t));
        y.push(Math.log10(pf));
      }
    });
    const series: Series[] = [{ id: 'pf', name: 'Pf', x, y, color: 'var(--series-1)' }];
    const hlines: RefLine[] =
      r.target > 0
        ? [{ value: Math.log10(r.target), label: `target ${fmtPf(r.target)}`, color: 'var(--status-critical)' }]
        : [];
    const vlines: RefLine[] =
      r.service_life > 0
        ? [
            {
              value: Math.log10(r.service_life),
              label: `service life ${sig(r.service_life, 3)} y`,
              color: 'var(--axis)',
            },
          ]
        : [];
    return { series, hlines, vlines };
  }, [r]);
  return (
    <LineChart
      title="Stress-rupture failure probability"
      series={view?.series ?? []}
      hlines={view?.hlines}
      vlines={view?.vlines}
      xLabel="log₁₀ time"
      xUnit="years"
      yLabel="log₁₀ Pf"
      xFormat={(x) => `${sig(Math.pow(10, x), 3)} y`}
      height={height}
      emptyText="No stress-rupture result"
    />
  );
}

// ------------------------------------------------------------------ shell FE charts
const num = (a: (number | null)[]) => a.map((v) => (v == null || !Number.isFinite(v) ? NaN : v));

/**
 * The FE clamps the liner at the bosses (rigid rings); the backend leaves
 * those elements out of the critical-point and hot-spot search and marks
 * the rest in `fe.valid`. Older backends: r > boss radius + 3 x wall.
 * Returns the clamp zone at each end as chart bands and the valid test.
 */
function bossZones(fe: FEResult, l: LinerSpec): { bands: Band[]; valid: (i: number) => boolean } {
  const ok = feValidMask(fe, l);
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
    // cylinder reference: the backend scales the cylinder burst by (cylinder reference / peak in the valid region)
    let ref = fe.fiber_ratio_ref ?? 0;
    if (!(ref > 0)) {
      const half = liner.cyl_length / 2;
      const cylBand = Math.max(half - 20, 0.25 * half);
      fe.z.forEach((z, i) => {
        if (Math.abs(z) < cylBand && Number.isFinite(max[i])) ref = Math.max(ref, max[i]);
      });
    }
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
    // cylinder reference of the hot-spot factor (the linear-elastic FE cycle: stress range = stress at MEOP)
    const ref =
      fe.liner_vm_ref > 0 ? fe.liner_vm_ref : fe.liner_hotspot_factor > 0 ? peak / fe.liner_hotspot_factor : 0;
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

// ------------------------------------------------------------------ progressive failure
/**
 * Progressive failure run (POST /api/progressive). Slow (10 s to minutes), so it
 * only runs on request; the result lives in a module store so it survives step
 * changes and is shared between the panel and the charts below the viewport.
 */
interface ProgState {
  result: ProgressiveResult | null;
  /** Project the result was computed for */
  resultFor: Project | null;
  /** performance.now() at the start of the running request */
  started: number | null;
  error: string | null;
  mesh: number;
}
let prog: ProgState = { result: null, resultFor: null, started: null, error: null, mesh: 4 };
let progCtrl: AbortController | null = null;
const progListeners = new Set<() => void>();
const progStore = {
  get: () => prog,
  set(p: Partial<ProgState>) {
    prog = { ...prog, ...p };
    progListeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    progListeners.add(l);
    return () => progListeners.delete(l);
  },
};
const useProgressive = () => useSyncExternalStore(progStore.subscribe, progStore.get, progStore.get);

async function runProgressive(project: Project) {
  progCtrl?.abort();
  const c = new AbortController();
  progCtrl = c;
  progStore.set({ started: performance.now(), error: null });
  try {
    const r = await api.progressive(project, prog.mesh, c.signal);
    if (!c.signal.aborted) progStore.set({ result: r, resultFor: project });
  } catch (e) {
    if (!isAbort(e)) progStore.set({ error: errorMessage(e) });
  } finally {
    if (progCtrl === c) {
      progCtrl = null;
      progStore.set({ started: null });
    }
  }
}

function cancelProgressive() {
  progCtrl?.abort();
  progCtrl = null;
  progStore.set({ started: null });
}

const EVENT_KIND: Record<FailureEventKind, string> = {
  iff: 'matrix cracking',
  ff: 'fibre failure',
  liner_yield: 'liner yield',
  liner_rupture: 'liner rupture',
  burst: 'burst',
};

function ProgressiveSection() {
  const { project } = useProject();
  const { result: r, resultFor, started, error, mesh } = useProgressive();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (started == null) return;
    setElapsed(0);
    const h = window.setInterval(() => setElapsed((performance.now() - started) / 1000), 100);
    return () => window.clearInterval(h);
  }, [started]);
  const busy = started != null;
  const stale = !!r && resultFor !== project;
  const pass = r ? r.burst_pressure >= r.required_burst : false;
  const p = (v: number | null) => (v == null ? '–' : sig(v, 4));
  return (
    <Section title="Progressive failure">
      <p className="muted small">
        Nonlinear shell analysis with liner plasticity, Puck matrix cracking (IFF) and fibre failure, ramped to burst.
        Takes 10 s to a few minutes.
      </p>
      <NumberField
        label="Mesh"
        unit="mm"
        value={mesh}
        min={1}
        max={20}
        step={0.5}
        hint="Max element length along the meridian"
        onCommit={(v) => progStore.set({ mesh: v })}
      />
      {busy ? (
        <Progress label="Running progressive failure analysis…" elapsed={elapsed} onCancel={cancelProgressive} />
      ) : (
        <Button
          size="sm"
          icon="play"
          variant={!r || stale ? 'primary' : 'default'}
          onClick={() => void runProgressive(project)}
        >
          {r ? (stale ? 'Re-run (project changed)' : 'Re-run progressive analysis') : 'Run progressive analysis'}
        </Button>
      )}
      {error ? <Banner kind="fail">{error}</Banner> : null}
      {r ? (
        <>
          {stale ? <p className="muted small stale-note">Computed for an earlier version of the project.</p> : null}
          <div className="kpi-grid">
            <Kpi
              label="Progressive burst"
              value={sig(r.burst_pressure, 4)}
              unit="MPa"
              status={ratioStatus(r.burst_pressure, r.required_burst, true)}
              sub={
                <>
                  <Meter value={r.burst_pressure} limit={r.required_burst} invert />
                  <StatusPill status={pass ? 'ok' : 'fail'}>{pass ? 'Pass' : 'Fail'}</StatusPill> req.{' '}
                  {sig(r.required_burst, 4)} MPa
                </>
              }
            />
            <Kpi
              label="Burst location"
              value={<span className="kpi-text">{r.burst_zone}</span>}
              sub={`layer ${r.burst_layer ?? '–'}${r.burst_z != null ? ` · z ${sig(r.burst_z, 4)} mm` : ''}`}
            />
            <Kpi
              label="First matrix crack"
              value={p(r.first_iff_pressure)}
              unit={r.first_iff_pressure == null ? undefined : 'MPa'}
              title="First inter-fibre failure (Puck IFF)"
              sub={r.first_iff_pressure == null ? 'none before burst' : 'IFF'}
            />
            <Kpi
              label="First fibre failure"
              value={p(r.first_ff_pressure)}
              unit={r.first_ff_pressure == null ? undefined : 'MPa'}
            />
            <Kpi
              label="Liner yield"
              value={p(r.liner_yield_pressure)}
              unit={r.liner_yield_pressure == null ? undefined : 'MPa'}
            />
          </div>
          <p className="muted small">Pressure–strain curve and damage along z are shown below the 3D view.</p>
          {r.events.length ? (
            <div className="table-scroll">
              <table className="data-table compact">
                <caption>Failure events</caption>
                <thead>
                  <tr>
                    <th className="num" title="Pressure [MPa]">
                      p
                    </th>
                    <th>Phase</th>
                    <th>Kind</th>
                    <th>Layer</th>
                    <th className="num" title="Axial position [mm]">
                      z
                    </th>
                    <th className="num" title="Number of such events in this phase for this layer">
                      n
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.events.map((e, i) => (
                    <tr key={i} className={e.kind === 'burst' ? 'row-strong' : undefined}>
                      <td className="num">{sig(e.pressure, 4)}</td>
                      <td>{e.phase}</td>
                      <td>{EVENT_KIND[e.kind] ?? e.kind}</td>
                      <td>{e.layer}</td>
                      <td className="num">{sig(e.z, 4)}</td>
                      <td className="num">{e.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {r.notes.length ? (
            <ul className="notes-list">
              {r.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

export function ProgressiveCurveChart({ height = 250 }: { height?: number }) {
  const { result: r } = useProgressive();
  const view = useMemo(() => {
    if (!r) return null;
    const series: Series[] = [
      {
        id: 'p',
        name: 'Pressure',
        x: r.curve_hoop_strain.map((e) => e * 100),
        y: r.curve_pressure,
        color: 'var(--series-1)',
        markers: r.curve_pressure.length < 40,
      },
    ];
    const hlines: RefLine[] = [
      { value: r.required_burst, label: `required ${sig(r.required_burst, 4)}`, color: 'var(--status-critical)' },
    ];
    if (r.first_iff_pressure != null)
      hlines.push({ value: r.first_iff_pressure, label: 'first IFF', color: 'var(--series-3)' });
    if (r.first_ff_pressure != null)
      hlines.push({ value: r.first_ff_pressure, label: 'first FF', color: 'var(--series-2)' });
    if (r.liner_yield_pressure != null)
      hlines.push({ value: r.liner_yield_pressure, label: 'liner yield', color: 'var(--series-7)' });
    return { series, hlines };
  }, [r]);
  return (
    <LineChart
      title="Progressive · pressure vs hoop strain"
      series={view?.series ?? []}
      hlines={view?.hlines}
      xLabel="Hoop strain (mid-cylinder)"
      xUnit="%"
      yLabel="Pressure"
      yUnit="MPa"
      yZero
      hover="nearest"
      height={height}
      emptyText="Run the progressive failure analysis"
    />
  );
}

type DamageMode = 'max' | 'ff' | 'iff';

/** Max over layers of a per-layer fraction at each z. */
function maxOverLayers(per: number[][], n: number): number[] {
  const out = new Array<number>(n).fill(0);
  for (const row of per) row.forEach((v, i) => (out[i] = Math.max(out[i], Number.isFinite(v) ? v : 0)));
  return out;
}

export function ProgressiveDamageChart({ height = 250 }: { height?: number }) {
  const { result: r, resultFor } = useProgressive();
  const { project } = useProject();
  const [mode, setMode] = useState<DamageMode>('max');
  const colors = useMemo(() => layerColors(project.layers), [project.layers]);
  const view = useMemo(() => {
    if (!r) return null;
    const ids = (resultFor ?? project).layers.map((l) => l.id);
    const pct = (a: number[]) => a.map((v) => v * 100);
    let series: Series[];
    if (mode === 'max') {
      series = [
        {
          id: 'ff',
          name: 'fibre failure',
          x: r.z,
          y: pct(maxOverLayers(r.ff_fraction, r.z.length)),
          color: 'var(--series-2)',
        },
        {
          id: 'iff',
          name: 'matrix cracks',
          x: r.z,
          y: pct(maxOverLayers(r.iff_fraction, r.z.length)),
          color: 'var(--series-3)',
          dash: '5 3',
        },
      ];
    } else {
      const per = mode === 'ff' ? r.ff_fraction : r.iff_fraction;
      series = per.map((y, k) => {
        const id = ids[k] ?? `#${k + 1}`;
        return {
          id,
          name: id,
          x: r.z,
          y: pct(y),
          color: colors.get(id) ?? 'var(--series-1)',
          width: 1.25,
          hideLegend: per.length > 12,
          noHover: per.length > 8,
        };
      });
    }
    const vlines: RefLine[] =
      r.burst_z != null ? [{ value: r.burst_z, label: `burst: ${r.burst_zone}`, color: 'var(--status-critical)' }] : [];
    return { series, vlines };
  }, [r, resultFor, project, mode, colors]);
  return (
    <LineChart
      title="Progressive · damage at burst"
      series={view?.series ?? []}
      vlines={view?.vlines}
      xLabel="z"
      xUnit="mm"
      yLabel={mode === 'max' ? 'Max over layers' : mode === 'ff' ? 'Fibre failure' : 'Matrix cracks'}
      yUnit="%"
      yZero
      height={height}
      emptyText="Run the progressive failure analysis"
      tools={
        <Segmented<DamageMode>
          size="sm"
          ariaLabel="Damage series"
          value={mode}
          options={[
            { value: 'max', label: 'Max' },
            { value: 'ff', label: 'FF layers' },
            { value: 'iff', label: 'IFF layers' },
          ]}
          onChange={setMode}
        />
      }
    />
  );
}

export function LinerPeeqChart({ height = 250 }: { height?: number }) {
  const { result: r } = useProgressive();
  return (
    <LineChart
      title="Progressive · liner plastic strain at burst"
      series={
        r ? [{ id: 'peeq', name: 'PEEQ', x: r.z, y: r.liner_peeq.map((v) => v * 100), color: 'var(--series-1)' }] : []
      }
      xLabel="z"
      xUnit="mm"
      yLabel="Equiv. plastic strain"
      yUnit="%"
      yZero
      height={height}
      emptyText="Run the progressive failure analysis"
    />
  );
}

export function AnalysisBottom() {
  const { result } = useAnalysis();
  const { result: prog } = useProgressive();
  const hasFe = !!result?.fe;
  return (
    <div className="bottom-grid three">
      <LoadHistoryChart />
      {hasFe ? <FiberUtilChart /> : null}
      {hasFe ? <LinerStressChart /> : null}
      <DomeStressChart />
      <ThicknessChart height={250} initialMode="total" />
      {result?.structural?.rupture ? <RuptureChart /> : null}
      {prog ? <ProgressiveCurveChart /> : null}
      {prog ? <ProgressiveDamageChart /> : null}
      {prog ? <LinerPeeqChart /> : null}
    </div>
  );
}
