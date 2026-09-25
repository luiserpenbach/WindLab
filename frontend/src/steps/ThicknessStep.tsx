import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, isAbort } from '../api/client';
import type { BandShape, Project, ThicknessMapResult } from '../api/types';
import { Field, Section, Segmented, Select, SelectField, Switch } from '../components/fields';
import { Heatmap } from '../components/Heatmap';
import { LineChart, type Series } from '../components/LineChart';
import { Banner, Button, Empty, Kpi, Meter, Progress, WarningList } from '../components/ui';
import { useAnalysis } from '../state/analysis';
import { useProject } from '../state/projectStore';
import { useThicknessScale } from '../state/thickness';
import { useUi, type ThkScale } from '../state/uiStore';
import { layerColors } from '../viewer/colors';
import { sig } from '../util/format';
import { useSelectedLayer } from './LayupStep';
import { THK_GAP_WARN, THK_OVERLAP_WARN, THK_PEAK_WARN } from './stepStatus';

/*
 * Band-level thickness simulation (POST /api/thickness-map). Runs take from
 * under a second to tens of seconds, so results are cached per project and
 * request; the map re-runs automatically when the layer, mode or grid
 * changes, while project edits only mark it stale.
 */

type Grid = 'coarse' | 'standard' | 'fine';
const GRIDS: Record<Grid, { resolution: number; n_phi: number; label: string }> = {
  coarse: { resolution: 2, n_phi: 360, label: 'Coarse' },
  standard: { resolution: 1, n_phi: 720, label: 'Standard' },
  fine: { resolution: 0.5, n_phi: 1440, label: 'Fine' },
};

interface Req {
  layerId: string;
  cumulative: boolean;
  grid: Grid;
}
const reqKey = (r: Req) => `${r.layerId}|${r.cumulative ? 'c' : 'l'}|${r.grid}`;

/** Recent results: newest last. Module-level so they survive step switches. */
const cache: { project: Project; key: string; result: ThicknessMapResult }[] = [];
const CACHE_MAX = 8;
/** Request options survive step switches too. */
let prefs: { cumulative: boolean; grid: Grid } = { cumulative: true, grid: 'standard' };
/** Project + key of the map currently shown. */
let shown: { project: Project; key: string } | null = null;

function cached(project: Project, key: string): ThicknessMapResult | null {
  return cache.find((c) => c.project === project && c.key === key)?.result ?? null;
}
function remember(project: Project, key: string, result: ThicknessMapResult) {
  const i = cache.findIndex((c) => c.key === key && c.project === project);
  if (i >= 0) cache.splice(i, 1);
  cache.push({ project, key, result });
  while (cache.length > CACHE_MAX) cache.shift();
}

export function ThicknessPanel() {
  const { project, update } = useProject();
  const { result } = useAnalysis();
  const ui = useUi();
  const { thk, setThk, overlay, setOverlay } = ui;
  const [sel, setSel] = useSelectedLayer();
  const [cumulative, setCumulative] = useState(prefs.cumulative);
  const [grid, setGrid] = useState<Grid>(prefs.grid);
  const [busy, setBusy] = useState<{ start: number; label: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const colors = layerColors(project.layers);
  const scale = useThicknessScale();

  useEffect(() => {
    prefs = { cumulative, grid };
  }, [cumulative, grid]);

  const run = useCallback(
    async (req: Req) => {
      ctrl.current?.abort();
      const key = reqKey(req);
      const hit = cached(project, key);
      if (hit) {
        ctrl.current = null;
        setBusy(null);
        setError(null);
        shown = { project, key };
        setThk(hit);
        return;
      }
      const c = new AbortController();
      ctrl.current = c;
      const g = GRIDS[req.grid];
      setBusy({
        start: performance.now(),
        label: `Laying bands of ${req.cumulative ? `layers 1 – ${req.layerId}` : req.layerId}…`,
      });
      setError(null);
      try {
        const r = await api.thicknessMap(
          { project, layer_id: req.layerId, cumulative: req.cumulative, resolution: g.resolution, n_phi: g.n_phi },
          c.signal,
        );
        if (c.signal.aborted) return;
        remember(project, key, r);
        shown = { project, key };
        setThk(r);
      } catch (e) {
        if (!isAbort(e)) setError(errorMessage(e));
      } finally {
        if (ctrl.current === c) {
          ctrl.current = null;
          setBusy(null);
        }
      }
    },
    [project, setThk],
  );

  const cancel = () => {
    ctrl.current?.abort();
    ctrl.current = null;
    setBusy(null);
  };

  // elapsed-time ticker while a run is in flight
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const h = window.setInterval(() => setElapsed((performance.now() - busy.start) / 1000), 100);
    return () => window.clearInterval(h);
  }, [busy]);

  // Auto-run when the request changes (not on project edits: those only mark the map stale).
  // On the first layer "cumulative" and "this layer only" are the same map.
  const first = !!sel && project.layers[0]?.id === sel.id;
  const req: Req | null = sel ? { layerId: sel.id, cumulative: cumulative && !first, grid } : null;
  const key = req ? reqKey(req) : '';
  useEffect(() => {
    if (!req) return;
    if (shown && shown.key === key && thk && thk.layer_id === req.layerId) return;
    void run(req);
  }, [key, thk === null]);

  useEffect(() => () => ctrl.current?.abort(), []);

  if (!project.layers.length) return <Empty>Add layers in step 3 to simulate the band build-up.</Empty>;

  const stale = !!thk && !!shown && shown.project !== project;
  const matches = !!thk && !!shown && shown.key === key;
  const layer = sel;
  const nodata = scale?.nodata ?? false;

  return (
    <>
      <Section title="Band simulation">
        <Field label="Layer">
          <div className="inline">
            <i className="swatch" style={{ background: layer ? colors.get(layer.id) : undefined }} />
            <Select
              ariaLabel="Layer to map"
              value={layer?.id ?? null}
              options={project.layers.map((l, i) => ({ value: l.id, label: `${i + 1}. ${l.id} (${l.type})` }))}
              onChange={(id) => setSel(id)}
            />
          </div>
        </Field>
        <Field
          label="Thickness of"
          hint={cumulative ? 'All layers up to and including this one' : 'This layer on its own'}
        >
          <Segmented<'cum' | 'own'>
            ariaLabel="Cumulative or this layer only"
            value={cumulative ? 'cum' : 'own'}
            options={[
              { value: 'cum', label: 'Cumulative' },
              { value: 'own', label: 'This layer only' },
            ]}
            onChange={(v) => setCumulative(v === 'cum')}
          />
        </Field>
        <Field
          label="Grid"
          hint={`${GRIDS[grid].resolution} mm along the meridian × ${GRIDS[grid].n_phi} around (result shown at ≤ 240 × 360)`}
        >
          <Segmented<Grid>
            ariaLabel="Simulation grid"
            value={grid}
            options={(Object.keys(GRIDS) as Grid[]).map((g) => ({ value: g, label: GRIDS[g].label }))}
            onChange={setGrid}
          />
        </Field>
        {layer ? (
          <SelectField<BandShape>
            label="Band cross-section"
            value={layer.band_shape}
            options={[
              { value: 'rectangular', label: 'Rectangular' },
              { value: 'lenticular', label: 'Lenticular' },
              { value: 'elliptical', label: 'Elliptical' },
            ]}
            hint={`Of ${layer.id} (${layer.band_width} mm band); also set in the Layup step`}
            onChange={(v) =>
              update(
                (p) => ({ ...p, layers: p.layers.map((l) => (l.id === layer.id ? { ...l, band_shape: v } : l)) }),
                `layer.${layer.id}.bandShape`,
              )
            }
          />
        ) : null}
        {busy ? (
          <Progress label={busy.label} elapsed={elapsed} onCancel={cancel} />
        ) : (
          <div className="toolbar">
            <Button
              icon="refresh"
              size="sm"
              variant={stale || !matches ? 'primary' : 'default'}
              disabled={!req}
              onClick={() => {
                if (!req) return;
                // force a fresh run for the current project
                const i = cache.findIndex((c) => c.project === project && c.key === key);
                if (i >= 0) cache.splice(i, 1);
                void run(req);
              }}
            >
              {stale ? 'Re-run (project changed)' : matches ? 'Re-run' : 'Run'}
            </Button>
            <span className="muted small">typically 1 – 10 s; outer layers take longer</span>
          </div>
        )}
        {error ? <Banner kind="fail">{error}</Banner> : null}
      </Section>

      {thk ? (
        <Section title={`Result · ${thk.cumulative ? `≤ ${thk.layer_id}` : thk.layer_id}`}>
          {stale ? <p className="muted small stale-note">Computed for an earlier version of the project.</p> : null}
          <ThicknessKpis t={thk} />
          <WarningList
            items={[
              ...thk.warnings,
              ...(nodata
                ? [
                    'Cells without a finite thickness: the backend returned no value there (shown hatched grey); the peak is unreliable',
                  ]
                : []),
            ]}
          />
        </Section>
      ) : !busy && !error ? (
        <Empty>No thickness map yet.</Empty>
      ) : null}

      <Section title="Display">
        <Field
          label="Colour scale"
          hint={
            overlay.thkScale === 'nominal'
              ? 'Viridis over 0 – 2 × nominal: nominal sits mid-scale, gaps dark, overlaps and build-up bright'
              : overlay.thkScale === 'robust'
                ? 'Viridis over 0 – 99.5th percentile (isolated hot cells saturate)'
                : 'Viridis over 0 – the largest value'
          }
        >
          <Segmented<ThkScale>
            size="sm"
            ariaLabel="Colour scale"
            value={overlay.thkScale}
            options={[
              { value: 'nominal', label: '2 × nominal' },
              { value: 'robust', label: '99.5 %' },
              { value: 'full', label: 'Full range' },
            ]}
            onChange={(v) => setOverlay({ thkScale: v })}
          />
        </Field>
        <Field label="3D view" hint="Paints the map on the layer's outer surface (layers after it are hidden)">
          <Switch checked={overlay.thk3d} label="Show on 3D surface" onChange={(v) => setOverlay({ thk3d: v })} />
        </Field>
        {thk && result && !result.layers.some((l) => l.id === thk.layer_id) ? (
          <p className="muted small">Layer {thk.layer_id} is no longer in the layup.</p>
        ) : null}
      </Section>
    </>
  );
}

function pct(v: number) {
  return v === 0 ? '0' : v < 0.001 ? '< 0.1' : sig(v * 100, 2);
}

function ThicknessKpis({ t }: { t: ThicknessMapResult }) {
  const ratio = t.peak != null && t.analytic_peak > 0 ? t.peak / t.analytic_peak : null;
  const dev = t.nominal > 0 ? t.cyl_mean / t.nominal - 1 : null;
  return (
    <div className="kpi-grid">
      <Kpi
        label="Peak vs analytic"
        value={t.peak == null ? '–' : sig(t.peak, 3)}
        unit="mm"
        status={ratio == null ? 'warn' : ratio > THK_PEAK_WARN ? 'warn' : 'ok'}
        title="Largest local thickness vs the axisymmetric band-averaged model"
        sub={
          <>
            {ratio != null ? <Meter value={ratio} limit={THK_PEAK_WARN} /> : null}
            analytic {sig(t.analytic_peak, 3)} mm · {ratio == null ? 'no finite peak' : `×${sig(ratio, 3)}`}
          </>
        }
      />
      <Kpi
        label="Cylinder mean"
        value={sig(t.cyl_mean, 3)}
        unit="mm"
        sub={`nominal ${sig(t.nominal, 3)} mm${dev != null ? ` · ${dev >= 0 ? '+' : ''}${sig(dev * 100, 2)} %` : ''}`}
      />
      <Kpi
        label="Cylinder CV"
        value={sig(t.cyl_cv * 100, 2)}
        unit="%"
        title="Coefficient of variation (std / mean) of the thickness in the cylinder"
        sub="thickness scatter in the cylinder"
      />
      <Kpi
        label="Gaps · overlaps"
        value={`${pct(t.gap_fraction)} · ${pct(t.overlap_fraction)}`}
        unit="%"
        status={t.gap_fraction > THK_GAP_WARN || t.overlap_fraction > THK_OVERLAP_WARN ? 'warn' : 'ok'}
        title={`Cylinder area below 50 % of nominal (gaps, warn > ${THK_GAP_WARN * 100} %) and above 150 % (overlaps, warn > ${THK_OVERLAP_WARN * 100} %)`}
        sub="cylinder < 50 % · > 150 % of nominal"
      />
    </div>
  );
}

// ------------------------------------------------------------------ bottom
type XMode = 'z' | 's';

export function ThicknessBottom() {
  const { thk, overlay } = useUi();
  const { resultProject } = useAnalysis();
  const { project } = useProject();
  const [xMode, setXMode] = useState<XMode>('z');
  const [hoverX, setHoverX] = useState<number | null>(null);
  const scale = useThicknessScale();
  const liner = (resultProject ?? project).liner;

  const x = thk ? (xMode === 'z' ? thk.z : thk.s) : [];
  // tangent lines (cylinder ends) in the current x coordinate
  const vlines = useMemo(() => {
    if (!thk) return [];
    const half = liner.cyl_length / 2;
    const toX = (z: number) => (xMode === 'z' ? z : interpAsc(thk.z, thk.s, z));
    return [
      { value: toX(-half), label: 'A' },
      { value: toX(half), label: 'B' },
    ];
  }, [thk, xMode, liner.cyl_length]);

  const series = useMemo<Series[]>(() => {
    if (!thk) return [];
    const num = (a: (number | null)[]) => a.map((v) => (v == null ? NaN : v));
    return [
      { id: 'max', name: 'max', x, y: num(thk.max), color: 'var(--series-2)', width: 1.25 },
      { id: 'mean', name: 'mean', x, y: num(thk.mean), color: 'var(--series-1)' },
      { id: 'min', name: 'min', x, y: num(thk.min), color: 'var(--series-3)', width: 1.25 },
      { id: 'analytic', name: 'analytic', x, y: thk.analytic, color: 'var(--text-2)', dash: '5 3', width: 1.5 },
    ];
  }, [thk, x]);

  if (!thk || !scale) return <Empty>Run the band simulation to see the thickness map.</Empty>;
  const clipY = overlay.thkScale !== 'full' && scale.clipped;
  const yMax = Math.max(scale.hi, thk.analytic_peak) * 1.08;
  const xLabel = xMode === 'z' ? 'z' : 's';
  const xTools = (
    <Segmented<XMode>
      size="sm"
      ariaLabel="Map x axis"
      value={xMode}
      options={[
        { value: 'z', label: 'vs z' },
        { value: 's', label: 'vs meridian s' },
      ]}
      onChange={setXMode}
    />
  );
  return (
    <div className="bottom-grid thk-grid">
      <Heatmap
        title={`Thickness map · ${
          thk.cumulative
            ? `layers ≤ ${thk.layer_id}`
            : project.layers[0]?.id === thk.layer_id
              ? `${thk.layer_id} (first layer)`
              : `${thk.layer_id} only`
        }`}
        x={x}
        phi={thk.phi}
        values={thk.t}
        hi={scale.hi}
        clipped={scale.clipped}
        xLabel={xLabel}
        xUnit="mm"
        valueLabel="t"
        valueUnit="mm"
        barMarks={[{ value: thk.nominal, label: 'nominal' }]}
        vlines={vlines}
        height={250}
        tools={xTools}
        onHoverX={setHoverX}
        rowInfo={(row) => (
          <div className="chart-tip-row muted">
            <span />
            <span className="chart-tip-name">
              {xMode === 'z' ? `s ${sig(thk.s[row], 4)}` : `z ${sig(thk.z[row], 4)}`} mm · r {sig(thk.r[row], 4)} mm
            </span>
            <span className="chart-tip-val">model {sig(thk.analytic[row], 3)}</span>
          </div>
        )}
      />
      <LineChart
        title="Along the meridian"
        series={series}
        xLabel={xLabel}
        xUnit="mm"
        yLabel="t"
        yUnit="mm"
        height={250}
        yDomain={clipY ? [0, yMax] : undefined}
        yZero
        vlines={hoverX != null ? [{ value: hoverX, color: 'var(--accent)' }] : undefined}
        hlines={[{ value: thk.nominal, label: `nominal ${sig(thk.nominal, 3)}`, color: 'var(--axis)' }]}
      />
    </div>
  );
}

function interpAsc(x: number[], y: number[], v: number): number {
  const n = x.length;
  if (!n) return v;
  if (v <= x[0]) return y[0];
  if (v >= x[n - 1]) return y[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (x[m] <= v) lo = m;
    else hi = m;
  }
  const dx = x[hi] - x[lo];
  return dx ? y[lo] + ((y[hi] - y[lo]) * (v - x[lo])) / dx : y[lo];
}
