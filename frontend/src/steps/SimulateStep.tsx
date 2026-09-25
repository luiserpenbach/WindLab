import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, isAbort } from '../api/client';
import type { Project, SimulationResult } from '../api/types';
import { Field, Section, Segmented, Select } from '../components/fields';
import { LineChart, type Series } from '../components/LineChart';
import { Banner, Button, Empty, Spinner, StatusPill, WarningList } from '../components/ui';
import { frameIndexAt, playback, usePlayback } from '../state/playback';
import { useProject } from '../state/projectStore';
import { useUi } from '../state/uiStore';
import { layerColors } from '../viewer/colors';
import { fmtDuration, fmtTime, sig } from '../util/format';
import { useSelectedLayer } from './LayupStep';

const SPEEDS = [1, 2, 5, 10, 20, 50];

/** Shared simulation run state (module-level so it survives step switches). */
let lastRunProject: Project | null = null;

export function SimulatePanel() {
  const { project } = useProject();
  const ui = useUi();
  const { path, sim, setPath, setSim } = ui;
  const [sel, setSel] = useSelectedLayer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const colors = layerColors(project.layers);

  const run = async (layerId: string) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(true);
    setError(null);
    playback.set({ playing: false });
    // ~5000 frames keeps playback smooth; the backend default (20000) is overkill for display.
    const req = { project, layer_id: layerId, max_points: 5000 };
    try {
      const [p, s] = await Promise.all([api.path(req, c.signal), api.simulate(req, c.signal)]);
      if (c.signal.aborted) return;
      lastRunProject = project;
      setPath(p);
      setSim(s);
      playback.reset(s.total_time || s.frames.t[s.frames.t.length - 1] || 0);
    } catch (e) {
      if (!isAbort(e)) setError(errorMessage(e));
    } finally {
      if (ctrl.current === c) setBusy(false);
    }
  };

  // Auto-run when the selected layer changes and nothing matching is loaded.
  useEffect(() => {
    if (sel && (!sim || sim.layer_id !== sel.id) && !busy) void run(sel.id);
  }, [sel?.id]);

  useEffect(() => () => ctrl.current?.abort(), []);

  const stale = !!sim && lastRunProject !== project;

  if (!project.layers.length) return <Empty>Add layers in step 3 to simulate winding.</Empty>;

  return (
    <>
      <Section title="Layer">
        <Field label="Layer">
          <Select
            ariaLabel="Layer to simulate"
            value={sel?.id ?? null}
            options={project.layers.map((l, i) => ({ value: l.id, label: `${i + 1}. ${l.id} (${l.type})` }))}
            onChange={(id) => setSel(id)}
          />
        </Field>
        <div className="toolbar">
          <i className="swatch" style={{ background: sel ? colors.get(sel.id) : undefined }} />
          <Button
            icon="refresh"
            size="sm"
            variant={stale ? 'primary' : 'default'}
            disabled={!sel || busy}
            onClick={() => sel && run(sel.id)}
          >
            {stale ? 'Re-run (project changed)' : 'Re-run'}
          </Button>
          {busy ? <Spinner size={12} label="Simulating" /> : null}
          <span style={{ flex: 1 }} />
          {path ? (
            <span className="muted small">
              {path.points.length.toLocaleString()} pts · {path.circuit_breaks.length} circuits
            </span>
          ) : null}
        </div>
        {error ? <Banner kind="fail">{error}</Banner> : null}
      </Section>

      {sim ? (
        <>
          <Section title="Playback">
            <PlaybackControls sim={sim} />
          </Section>
          <Section title="Axes">
            <AxisReadout sim={sim} />
          </Section>
          <Section title="Result">
            <div className="inline">
              <StatusPill status={sim.limits_ok ? (sim.warnings.length ? 'warn' : 'ok') : 'fail'}>
                {sim.limits_ok ? 'Within machine limits' : 'Machine limits exceeded'}
              </StatusPill>
              <span className="muted small">Layer time {fmtDuration(sim.total_time)}</span>
            </div>
            <WarningList items={sim.warnings} />
          </Section>
        </>
      ) : !busy ? (
        <Empty>No simulation yet.</Empty>
      ) : null}
    </>
  );
}

function PlaybackControls({ sim }: { sim: SimulationResult }) {
  const pb = usePlayback();
  const dur = pb.duration || sim.total_time;
  return (
    <div className="playback">
      <div className="pb-row">
        <Button
          icon="rewind"
          size="sm"
          variant="ghost"
          aria-label="Rewind"
          onClick={() => playback.set({ t: 0, playing: false })}
        />
        <Button
          icon={pb.playing ? 'pause' : 'play'}
          size="sm"
          variant="primary"
          aria-label={pb.playing ? 'Pause' : 'Play'}
          onClick={() => playback.set({ playing: !pb.playing })}
        >
          {pb.playing ? 'Pause' : 'Play'}
        </Button>
        <span className="pb-time" aria-live="off">
          {fmtTime(pb.t)} <span className="muted">/ {fmtTime(dur)}</span>
        </span>
      </div>
      <input
        type="range"
        className="range scrubber"
        aria-label="Simulation time"
        min={0}
        max={dur || 1}
        step={Math.max(dur / 2000, 0.001)}
        value={pb.t}
        onChange={(e) => playback.set({ t: Number(e.target.value) })}
      />
      <Field label="Speed">
        <Segmented<number>
          size="sm"
          ariaLabel="Playback speed"
          value={pb.speed}
          options={SPEEDS.map((s) => ({ value: s, label: `×${s}` }))}
          onChange={(s) => playback.set({ speed: s })}
        />
      </Field>
    </div>
  );
}

function AxisReadout({ sim }: { sim: SimulationResult }) {
  const pb = usePlayback();
  const { project } = useProject();
  const m = project.machine;
  const f = sim.frames;
  const i = frameIndexAt(f.t, pb.t);
  const rows: [string, string, number | undefined, string, string?][] = [
    [
      m.carriage.letter,
      'Carriage (z)',
      f.carriage[i],
      'mm',
      `machine ${sig((f.carriage[i] ?? 0) + m.carriage_offset, 5)}`,
    ],
    [
      m.crossfeed.letter,
      'Crossfeed (r)',
      f.crossfeed[i],
      'mm',
      `machine ${sig((f.crossfeed[i] ?? 0) - m.crossfeed_zero_radius, 5)}`,
    ],
    [m.mandrel.letter, 'Mandrel', f.mandrel[i], '°'],
    ...(m.axes_count === 4 && m.eye
      ? ([[m.eye.letter, 'Eye', f.eye[i], '°']] as [string, string, number | undefined, string][])
      : []),
    ['L', 'Free fibre', f.free_length[i], 'mm'],
  ];
  return (
    <div className="readout">
      {rows.map(([letter, label, v, u, sub]) => (
        <div className="ro-row" key={label}>
          <span className="ro-letter">{letter}</span>
          <span className="ro-label">{label}</span>
          <span className="ro-val">
            {v == null ? '–' : v.toFixed(2)}
            <span className="ro-unit">{u}</span>
          </span>
          {sub ? <span className="ro-sub">{sub}</span> : <span />}
        </div>
      ))}
      <div className="ro-row">
        <span className="ro-letter">t</span>
        <span className="ro-label">Time · frame</span>
        <span className="ro-val">
          {pb.t.toFixed(2)}
          <span className="ro-unit">s</span>
        </span>
        <span className="ro-sub">
          {i + 1} / {f.t.length}
        </span>
      </div>
    </div>
  );
}

/** Downsample to at most n points (keeps shape reasonably for plotting). */
function decimate(x: number[], y: number[], n = 1200): { x: number[]; y: number[] } {
  if (x.length <= n) return { x, y };
  const step = x.length / n;
  const ox: number[] = [];
  const oy: number[] = [];
  for (let k = 0; k < n; k++) {
    const i = Math.floor(k * step);
    ox.push(x[i]);
    oy.push(y[i]);
  }
  ox.push(x[x.length - 1]);
  oy.push(y[y.length - 1]);
  return { x: ox, y: oy };
}

/** Playback time sampled at `hz` so charts don't re-render on every animation frame. */
function useThrottledTime(hz = 10): number {
  const [t, setT] = useState(() => playback.get().t);
  useEffect(() => {
    let last = 0;
    let timer = 0;
    const unsub = playback.subscribe(() => {
      const s = playback.get();
      const now = performance.now();
      window.clearTimeout(timer);
      if (!s.playing || now - last > 1000 / hz) {
        last = now;
        setT(s.t);
      } else {
        // make sure the final position is shown
        timer = window.setTimeout(() => setT(playback.get().t), 1000 / hz);
      }
    });
    return () => {
      unsub();
      window.clearTimeout(timer);
    };
  }, [hz]);
  return t;
}

export function SimulateBottom() {
  const { sim, path } = useUi();
  const { project } = useProject();
  const t = useThrottledTime();
  const charts = useMemo(() => {
    if (!sim) return null;
    const f = sim.frames;
    const mk = (id: string, name: string, y: number[], color: string): Series => ({
      id,
      name,
      ...decimate(f.t, y),
      color,
    });
    return {
      lin: [
        mk('carriage', `Carriage ${project.machine.carriage.letter}`, f.carriage, 'var(--series-1)'),
        mk('crossfeed', `Crossfeed ${project.machine.crossfeed.letter}`, f.crossfeed, 'var(--series-2)'),
      ],
      rot: [mk('mandrel', `Mandrel ${project.machine.mandrel.letter}`, f.mandrel, 'var(--series-3)')],
      eye:
        project.machine.axes_count === 4
          ? [mk('eye', `Eye ${project.machine.eye?.letter ?? 'B'}`, f.eye, 'var(--series-7)')]
          : [],
      free: [mk('free', 'Free fibre length', f.free_length, 'var(--series-5)')],
    };
  }, [sim, project.machine]);
  if (!sim || !charts) return <Empty>{path ? 'Simulation pending…' : 'Select a layer to simulate.'}</Empty>;
  const vl = [{ value: t, color: 'var(--accent)' }];
  return (
    <div className="bottom-grid four">
      <LineChart
        title="Linear axes"
        series={charts.lin}
        xLabel="t"
        xUnit="s"
        yLabel="Position"
        yUnit="mm"
        height={200}
        vlines={vl}
      />
      <LineChart
        title="Mandrel angle"
        series={charts.rot}
        xLabel="t"
        xUnit="s"
        yLabel="A"
        yUnit="°"
        height={200}
        vlines={vl}
      />
      {charts.eye.length ? (
        <LineChart
          title="Eye angle"
          series={charts.eye}
          xLabel="t"
          xUnit="s"
          yLabel="B"
          yUnit="°"
          height={200}
          vlines={vl}
        />
      ) : null}
      <LineChart
        title="Free fibre length"
        series={charts.free}
        xLabel="t"
        xUnit="s"
        yLabel="L"
        yUnit="mm"
        height={200}
        vlines={vl}
        yZero
      />
    </div>
  );
}
