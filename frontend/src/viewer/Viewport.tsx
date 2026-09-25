import { useEffect, useRef } from 'react';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/ui';
import { useAnalysis } from '../state/analysis';
import { playback } from '../state/playback';
import { useProject } from '../state/projectStore';
import { useUi } from '../state/uiStore';
import { VesselViewer } from './VesselViewer';

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<VesselViewer | null>(null);
  const { project } = useProject();
  const { result, loading } = useAnalysis();
  const ui = useUi();
  const simMode = ui.step === 'simulate';

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
    viewer.current?.setVessel({
      analysis: result,
      liner: project.liner,
      layers: project.layers,
    });
  }, [result, project.liner, project.layers]);

  useEffect(() => {
    viewer.current?.setSelectedLayer(ui.step === 'layup' || simMode ? ui.selectedLayerId : null);
  }, [ui.selectedLayerId, ui.step, simMode]);

  useEffect(() => {
    viewer.current?.setPath(simMode ? ui.path : null);
  }, [ui.path, simMode]);

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
        {simMode && ui.sim ? (
          <span>
            <i className="sw fibre" /> fibre
          </span>
        ) : null}
      </div>
    </div>
  );
}
