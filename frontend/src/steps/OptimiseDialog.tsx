import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, isAbort } from '../api/client';
import type { Layer, OptimiseResult, Project } from '../api/types';
import { Field, NumberInput } from '../components/fields';
import { Banner, Button, Kpi, Modal, Progress } from '../components/ui';
import { normalizeProject } from '../state/defaults';
import { useProject } from '../state/projectStore';
import { useUi } from '../state/uiStore';
import { fmtMass, sig } from '../util/format';

const BUDGET_MIN = 5;
const BUDGET_MAX = 600;
let lastBudget = 60;

type Phase =
  | { k: 'confirm' }
  | { k: 'running'; started: number }
  | { k: 'done'; r: OptimiseResult; from: Project; layers: Layer[] }
  | { k: 'error'; msg: string };

/** Fields compared for the diff preview, with short labels. */
const DIFF_FIELDS: [keyof Layer, string][] = [
  ['type', 'type'],
  ['tows', 'tows'],
  ['band_width', 'band'],
  ['passes', 'passes'],
  ['winding', 'path'],
  ['angle', 'angle'],
  ['turnaround_offset', 'turn. A'],
  ['turnaround_offset_b', 'turn. B'],
  ['pattern', 'pattern'],
  ['end_offset_a', 'end A'],
  ['end_offset_b', 'end B'],
  ['overlap', 'overlap'],
  ['fiber', 'fibre'],
  ['thickness_override', 't override'],
  ['tension', 'tension'],
  ['friction', 'μ'],
  ['dwell_max', 'dwell'],
  ['start_angle', 'start'],
  ['band_shape', 'shape'],
];

function fmtVal(v: unknown): string {
  if (v == null) return 'auto';
  if (typeof v === 'number') return sig(v, 4);
  if (typeof v === 'object') {
    const p = v as { n_bands?: number; shift?: number };
    return p.n_bands != null ? `${p.n_bands}/${p.shift}` : JSON.stringify(v);
  }
  return String(v);
}

function layerChanges(a: Layer, b: Layer): string[] {
  const out: string[] = [];
  for (const [k, label] of DIFF_FIELDS) {
    const va = a[k];
    const vb = b[k];
    if (JSON.stringify(va ?? null) !== JSON.stringify(vb ?? null)) out.push(`${label} ${fmtVal(va)} → ${fmtVal(vb)}`);
  }
  return out;
}

interface DiffRow {
  id: string;
  type: Layer['type'];
  status: 'same' | 'changed' | 'added' | 'removed' | 'moved';
  changes: string[];
  index: number | null;
}

function diffLayers(before: Layer[], after: Layer[]): DiffRow[] {
  const old = new Map(before.map((l, i) => [l.id, { l, i }]));
  const rows: DiffRow[] = after.map((l, i) => {
    const o = old.get(l.id);
    if (!o) return { id: l.id, type: l.type, status: 'added', changes: [], index: i };
    const ch = layerChanges(o.l, l);
    return {
      id: l.id,
      type: l.type,
      status: ch.length ? 'changed' : o.i !== i ? 'moved' : 'same',
      changes: ch,
      index: i,
    };
  });
  const kept = new Set(after.map((l) => l.id));
  for (const l of before)
    if (!kept.has(l.id)) rows.push({ id: l.id, type: l.type, status: 'removed', changes: [], index: null });
  return rows;
}

const STATUS_LABEL: Record<DiffRow['status'], string> = {
  same: 'unchanged',
  changed: 'changed',
  added: 'new',
  removed: 'removed',
  moved: 'moved',
};

/** "Optimise mass" toolbar button + dialog (POST /api/optimise). */
export function OptimiseButton() {
  const { project, update } = useProject();
  const { setSelectedLayerId } = useUi();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: 'confirm' });
  const [budget, setBudget] = useState(lastBudget);
  const [now, setNow] = useState(0);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    if (phase.k !== 'running') return;
    const h = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(h);
  }, [phase.k]);
  useEffect(() => () => ctrl.current?.abort(), []);

  const start = async () => {
    lastBudget = budget;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const from = project;
    const started = performance.now();
    setNow(started);
    setPhase({ k: 'running', started });
    try {
      const r = await api.optimise(from, budget, c.signal);
      if (c.signal.aborted) return;
      const layers = normalizeProject({ ...from, layers: r.layers }).layers;
      setPhase({ k: 'done', r, from, layers });
    } catch (e) {
      if (isAbort(e) || c.signal.aborted) return;
      setPhase({ k: 'error', msg: errorMessage(e) });
    }
  };
  const cancel = () => {
    ctrl.current?.abort();
    ctrl.current = null;
    setPhase({ k: 'confirm' });
  };
  const close = () => {
    ctrl.current?.abort();
    ctrl.current = null;
    setOpen(false);
    setPhase({ k: 'confirm' });
  };
  const apply = () => {
    if (phase.k !== 'done') return;
    const layers = phase.layers;
    update((p) => ({ ...p, layers }));
    setSelectedLayerId(layers[0]?.id ?? null);
    close();
  };

  const diff = phase.k === 'done' ? diffLayers(phase.from.layers, phase.layers) : [];
  const nChanged = diff.filter((d) => d.status !== 'same').length;
  const busy = phase.k === 'running';

  return (
    <>
      <Button
        size="sm"
        icon="gauge"
        onClick={() => setOpen(true)}
        disabled={!project.layers.length}
        title="Search for the lightest layup that still passes all blocking checks (backend optimiser)"
      >
        Optimise mass
      </Button>
      <Modal
        title="Optimise mass"
        open={open}
        onClose={close}
        wide={phase.k === 'done'}
        footer={
          phase.k === 'done' ? (
            <>
              <Button onClick={close}>Discard</Button>
              <Button variant="primary" icon="check" disabled={!nChanged} onClick={apply}>
                Apply {nChanged ? `(${nChanged} change${nChanged === 1 ? '' : 's'})` : ''}
              </Button>
            </>
          ) : phase.k === 'running' ? null : (
            <>
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" icon="play" onClick={start}>
                {phase.k === 'error' ? 'Retry' : 'Start'}
              </Button>
            </>
          )
        }
      >
        {phase.k === 'confirm' || phase.k === 'error' ? (
          <>
            <p className="small">
              The optimiser removes and resizes layers (tows, passes, turnaround offsets) to minimise mass while all
              blocking checks keep passing. It re-analyses the vessel many times, so it runs for up to the time budget.
            </p>
            <Field label="Time budget" hint={`Wall-clock limit, ${BUDGET_MIN} – ${BUDGET_MAX} s`}>
              <NumberInput
                ariaLabel="Optimiser time budget"
                value={budget}
                unit="s"
                min={BUDGET_MIN}
                max={BUDGET_MAX}
                step={5}
                onCommit={setBudget}
              />
            </Field>
            <p className="muted small">
              Starts from the current {project.layers.length}-layer layup. You can review the changes before applying
              them (one undo step).
            </p>
            {phase.k === 'error' ? <Banner kind="fail">{phase.msg}</Banner> : null}
          </>
        ) : null}
        {busy ? (
          <>
            <Progress
              label={`Optimising (budget ${budget} s)…`}
              elapsed={(now - phase.started) / 1000}
              onCancel={cancel}
            />
            <p className="muted small">
              Cancel stops waiting for the result; the server finishes its current run within the time budget.
            </p>
          </>
        ) : null}
        {phase.k === 'done' ? (
          <>
            <div className="kpi-grid three">
              <Kpi label="Mass before" value={fmtMass(phase.r.mass_before)} />
              <Kpi
                label="Mass after"
                value={fmtMass(phase.r.mass_after)}
                status={phase.r.mass_after < phase.r.mass_before - 0.5 ? 'ok' : 'info'}
                sub={
                  phase.r.mass_before > 0
                    ? `${phase.r.mass_after <= phase.r.mass_before ? '−' : '+'}${fmtMass(Math.abs(phase.r.mass_before - phase.r.mass_after))} (${sig(((phase.r.mass_after - phase.r.mass_before) / phase.r.mass_before) * 100, 3)} %)`
                    : undefined
                }
              />
              <Kpi label="Evaluations" value={phase.r.evaluations.toLocaleString()} />
            </div>
            {phase.from !== project ? (
              <Banner kind="warn">
                The project changed while the optimiser ran; Apply replaces the current layers.
              </Banner>
            ) : null}
            {!nChanged ? <Banner kind="info">No lighter layup found: the current one is kept.</Banner> : null}
            <div className="table-scroll diff-scroll">
              <table className="data-table compact diff-table">
                <caption>
                  Layers {phase.from.layers.length} → {phase.layers.length}
                </caption>
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Layer</th>
                    <th>Status</th>
                    <th>Changes</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.map((d) => (
                    <tr key={`${d.status}-${d.id}`} className={`diff-${d.status}`}>
                      <td className="num muted">{d.index != null ? d.index + 1 : '–'}</td>
                      <td>
                        {d.id} <span className={`type-badge t-${d.type}`}>{d.type === 'hoop' ? 'H' : 'X'}</span>
                      </td>
                      <td>
                        <span className={`diff-status ds-${d.status}`}>{STATUS_LABEL[d.status]}</span>
                      </td>
                      <td className="diff-changes">{d.changes.join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {phase.r.notes.length ? (
              <ul className="notes-list">
                {phase.r.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </Modal>
    </>
  );
}
