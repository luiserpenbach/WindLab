import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { FEResult, LinerSpec } from '../api/types';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/ui';
import { useAnalysis } from '../state/analysis';
import { playback } from '../state/playback';
import { useProject } from '../state/projectStore';
import { useThicknessScale } from '../state/thickness';
import { useUi } from '../state/uiStore';
import { layerColors } from './colors';
import {
  colorPath,
  cssGradient,
  DWELL_COLOR,
  NODATA_RGB,
  utilColor,
  UTIL_FAIL,
  viridis,
  type PathColoring,
  type Rgb,
} from './colormaps';
import { VesselViewer, type Deformation, type SurfaceOverlay } from './VesselViewer';
import { sig } from '../util/format';
import { feValidMask } from '../state/fe';

const NODATA_CSS = `rgb(${NODATA_RGB.map((c) => Math.round(c * 255)).join(' ')})`;

/**
 * FE quantity along z for the surface overlay: values per element and the
 * colour domain. The domain covers the valid elements only (`fe.valid`: the
 * backend leaves the rigid-ring boss clamp zone out), where values then saturate.
 */
function feOverlayData(
  fe: FEResult,
  kind: 'fiber' | 'liner',
  liner: LinerSpec,
): { values: (number | null)[]; hi: number; max: number; clipped: boolean } {
  const values: (number | null)[] =
    kind === 'fiber'
      ? fe.fiber_ratio_max.map((v) => (v == null || !Number.isFinite(v) ? null : v))
      : fe.liner_vm_inner.map((v, i) => Math.max(v, fe.liner_vm_outer[i] ?? v));
  let max = 0;
  let hi = 0;
  const valid = feValidMask(fe, liner);
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    max = Math.max(max, v);
    if (valid[i]) hi = Math.max(hi, v);
  });
  if (!(hi > 0)) hi = max > 0 ? max : 1;
  return { values, hi, max, clipped: max > hi * 1.001 };
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<VesselViewer | null>(null);
  const { project } = useProject();
  const { result, resultProject, loading } = useAnalysis();
  const ui = useUi();
  const simMode = ui.step === 'simulate';
  const thkMode = ui.step === 'thickness';
  const feMode = ui.step === 'analysis';
  const thkScale = useThicknessScale();
  // Geometry must match the analysis result; before the first result the
  // current inputs drive a rough preview.
  const geomSrc = result && resultProject ? resultProject : project;

  useEffect(() => {
    if (!host.current) return;
    let v: VesselViewer;
    try {
      v = new VesselViewer(host.current);
    } catch (e) {
      console.warn('WebGL unavailable', e);
      return;
    }
    viewer.current = v;
    const unsub = playback.subscribe(() => v.setTime(playback.get().t));
    return () => {
      unsub();
      v.dispose();
      viewer.current = null;
    };
  }, []);

  useEffect(() => {
    // wait one frame so CSS variables for the new theme are applied
    const id = requestAnimationFrame(() =>
      viewer.current?.setTheme({
        background: cssVar('--viewport-bg', '#eef0f2'),
        grid: cssVar('--viewport-grid', '#d5d8dc'),
        gridCenter: cssVar('--viewport-grid-strong', '#b0b5bb'),
        text: cssVar('--text-2', '#444'),
      }),
    );
    return () => cancelAnimationFrame(id);
  }, [ui.resolvedTheme]);

  useEffect(() => {
    viewer.current?.setView(ui.view);
  }, [ui.view]);

  useEffect(() => {
    viewer.current?.setVessel({ analysis: result, liner: geomSrc.liner, layers: geomSrc.layers });
  }, [result, geomSrc.liner, geomSrc.layers]);

  // Surface overlays: thickness map on its layer (Thickness step) or shell FE along z (Analysis step).
  const thk = ui.thk;
  const thkOverlay = useMemo<SurfaceOverlay | null>(() => {
    if (!thkMode || !thk || !thkScale || !ui.overlay.thk3d) return null;
    if (!result?.layers.some((l) => l.id === thk.layer_id)) return null;
    return { type: 'map', map: thk, color: thkScale.color };
  }, [thkMode, thk, thkScale, ui.overlay.thk3d, result]);
  const fe = result?.fe ?? null;
  const feKind = ui.overlay.fe;
  const feLiner = geomSrc.liner;
  const feData = useMemo(
    () => (fe && feKind !== 'none' ? feOverlayData(fe, feKind, feLiner) : null),
    [fe, feKind, feLiner],
  );
  const feOverlay = useMemo<SurfaceOverlay | null>(() => {
    if (!feMode || !fe || !feData) return null;
    const { hi } = feData;
    return { type: 'z', z: fe.z, values: feData.values, color: (v: number) => viridis(v / hi) };
  }, [feMode, fe, feData]);
  const overlay = thkOverlay ?? feOverlay;
  useEffect(() => {
    viewer.current?.setOverlay(overlay);
  }, [overlay]);

  const { deform, deformScale } = ui.overlay;
  const deformation = useMemo<Deformation | null>(
    () =>
      feMode && fe && deform && deformScale > 0
        ? { z: fe.node_z, ur: fe.radial_displacement, uz: fe.axial_displacement, scale: deformScale }
        : null,
    [feMode, fe, deform, deformScale],
  );
  useEffect(() => {
    viewer.current?.setDeformation(deformation);
  }, [deformation]);

  useEffect(() => {
    const highlight = ui.step === 'layup' || (ui.step === 'thickness' && !thkOverlay);
    viewer.current?.setSelectedLayer(highlight ? ui.selectedLayerId : null);
  }, [ui.selectedLayerId, ui.step, thkOverlay]);

  useEffect(() => {
    // While simulating a layer, show the vessel as it is before that layer is wound.
    viewer.current?.setLayerCutoff(simMode ? (ui.sim?.layer_id ?? ui.path?.layer_id ?? null) : null);
  }, [simMode, ui.sim, ui.path, result]);

  // Path colouring: layer colour, or per-point winding angle / slippage utilisation.
  const pathLayerId = ui.path?.layer_id ?? null;
  const layerColor = useMemo(
    () => (pathLayerId ? layerColors(project.layers).get(pathLayerId) : undefined),
    [project.layers, pathLayerId],
  );
  // Friction of the analysed layer (falls back to the current input).
  const lr = result?.layers.find((l) => l.id === pathLayerId);
  const friction = lr?.friction ?? project.layers.find((l) => l.id === pathLayerId)?.friction ?? 0;
  // Dwell points need more slippage than the domes; those are informational.
  const dwellCut =
    lr && lr.type === 'helical' ? Math.max(Math.abs(lr.slippage_a), Math.abs(lr.slippage_b)) + 1e-3 : null;
  const coloring = useMemo(
    () => colorPath(ui.path, ui.pathColor, friction, dwellCut),
    [ui.path, ui.pathColor, friction, dwellCut],
  );

  useEffect(() => {
    viewer.current?.setPath(simMode ? ui.path : null, layerColor, coloring?.colors ?? null);
  }, [ui.path, simMode, layerColor, coloring]);

  useEffect(() => {
    viewer.current?.setSimulation(simMode ? ui.sim : null, project.machine);
    if (simMode && ui.sim) viewer.current?.fit();
  }, [ui.sim, simMode]);

  const { view, setView } = ui;

  return (
    <div className="viewport">
      <div ref={host} className="viewport-host" />
      <div className="viewport-toolbar" role="toolbar" aria-label="3D view">
        <button
          type="button"
          className="vt-btn"
          title="Fit to view"
          aria-label="Fit to view"
          onClick={() => viewer.current?.fit()}
        >
          <Icon name="fit" />
        </button>
        <button
          type="button"
          className={`vt-btn ${view.section ? 'on' : ''}`}
          aria-pressed={view.section}
          title="Section view: cut in half to see the wall build-up"
          aria-label="Section view"
          onClick={() => setView({ section: !view.section })}
        >
          <Icon name="section" />
        </button>
        <button
          type="button"
          className={`vt-btn ${view.showLayers ? 'on' : ''}`}
          aria-pressed={view.showLayers}
          title="Show composite layers"
          aria-label="Show layers"
          onClick={() => setView({ showLayers: !view.showLayers })}
        >
          <Icon name="layers" />
        </button>
        <button
          type="button"
          className={`vt-btn ${view.showGrid ? 'on' : ''}`}
          aria-pressed={view.showGrid}
          title="Show grid"
          aria-label="Show grid"
          onClick={() => setView({ showGrid: !view.showGrid })}
        >
          <Icon name="grid" />
        </button>
      </div>
      {loading ? (
        <div className="viewport-busy" aria-live="polite">
          <Spinner size={12} /> computing
        </div>
      ) : null}
      <div className="viewport-legend">
        <span>
          <i className="sw liner" /> liner
        </span>
        <span>
          <i className="sw helical" /> helical
        </span>
        <span>
          <i className="sw hoop" /> hoop
        </span>
        {simMode && ui.sim && !coloring ? (
          <span>
            <i className="sw fibre" /> fibre
          </span>
        ) : null}
      </div>
      {simMode && coloring ? <ColorLegend c={coloring} /> : null}
      {thkOverlay && thk && thkScale ? (
        <ScaleLegend
          title={`Thickness ${thk.cumulative ? `up to ${thk.layer_id}` : `of ${thk.layer_id}`} [mm]`}
          fn={viridis}
          lo="0"
          hi={`${thkScale.clipped ? '≥ ' : ''}${sig(thkScale.hi, 3)}`}
          notes={
            <>
              {ui.overlay.thkScale === 'nominal' ? (
                <div className="cl-range">nominal {sig(thk.nominal, 3)} mm at mid-scale</div>
              ) : null}
              {thkScale.clipped ? (
                <div className="cl-range">map max {sig(thkScale.max, 3)} mm (above scale)</div>
              ) : null}
              {thkScale.nodata ? (
                <div className="cl-range">
                  <i className="sw" style={{ background: NODATA_CSS }} /> no data
                </div>
              ) : null}
            </>
          }
        />
      ) : null}
      {feOverlay && feData && fe ? (
        <ScaleLegend
          title={feKind === 'fiber' ? 'Fibre utilisation ε/ε_ult @ MEOP' : 'Liner von Mises @ MEOP [MPa]'}
          fn={viridis}
          lo="0"
          hi={`${feData.clipped ? '≥ ' : ''}${sig(feData.hi, 3)}`}
          notes={
            <>
              <div className="cl-range">
                {feKind === 'fiber'
                  ? `critical ${fe.critical_layer ?? '–'} at z = ${sig(fe.critical_z, 4)} mm`
                  : `hot spot ×${sig(fe.liner_hotspot_factor, 3)} at z = ${sig(fe.liner_hotspot_z, 4)} mm`}
              </div>
              {feData.clipped ? (
                <div className="cl-range" title="Rigid-ring boss clamp: excluded from the FE evaluation">
                  boss clamp zone above scale (max {sig(feData.max, 3)})
                </div>
              ) : null}
            </>
          }
        />
      ) : null}
      {feMode && deformation ? (
        <div className="deform-badge" title="Displacements at MEOP, magnified; dashed: undeformed outer surface">
          Deformed ×{sig(deformation.scale, 3)} · MEOP
        </div>
      ) : null}
    </div>
  );
}

function ScaleLegend({
  title,
  fn,
  lo,
  hi,
  notes,
}: {
  title: string;
  fn: (t: number) => Rgb;
  lo: string;
  hi: string;
  notes?: ReactNode;
}) {
  return (
    <div className="color-legend" role="img" aria-label={`${title}: colour scale ${lo} to ${hi}`}>
      <div className="cl-title">{title}</div>
      <div className="cl-bar" style={{ background: cssGradient(fn) }} />
      <div className="cl-scale">
        <span>{lo}</span>
        <span>{hi}</span>
      </div>
      {notes}
    </div>
  );
}

function ColorLegend({ c }: { c: PathColoring }) {
  const angle = c.mode === 'alpha';
  const fmt = (v: number) => (Number.isFinite(v) ? (angle ? `${sig(v, 3)}°` : sig(v, 2)) : '∞');
  const [lo, hi] = c.domain;
  const failPos = ((UTIL_FAIL - lo) / (hi - lo)) * 100;
  return (
    <div className="color-legend" role="img" aria-label={`Path colour scale, ${fmt(c.min)} to ${fmt(c.max)}`}>
      <div className="cl-title">{angle ? 'Winding angle α' : 'Slippage utilisation |λ|/μ'}</div>
      <div
        className="cl-bar"
        style={{ background: cssGradient(angle ? viridis : (t) => utilColor(lo + t * (hi - lo))) }}
      >
        {!angle ? <i className="cl-tick" style={{ left: `${failPos}%` }} title="Friction limit (1.0)" /> : null}
      </div>
      <div className="cl-scale">
        <span>{fmt(lo)}</span>
        {angle ? (
          <span>{fmt(hi)}</span>
        ) : (
          <span style={{ left: `${failPos}%` }} className="cl-mid" title="Friction limit: |λ| = μ">
            1
          </span>
        )}
      </div>
      <div className="cl-range">
        min {fmt(c.min)} · max {fmt(c.max)}
      </div>
      {c.dwellPoints ? (
        <div
          className="cl-range"
          title="Slippage a dwell on the turnaround circle would need: informational, the dwell happens on the boss neck"
        >
          <i className="sw" style={{ background: DWELL_COLOR }} /> turnaround dwell (info only)
        </div>
      ) : null}
    </div>
  );
}
