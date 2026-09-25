import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, errorMessage, isAbort } from '../api/client';
import type { CalibrationResult, FailureLocation, Project, TestCorrelation, TestKind, TestRecord } from '../api/types';
import { BarChart } from '../components/BarChart';
import { Field, NumberInput, parseNumber, Section, Segmented, Select, TextInput } from '../components/fields';
import { Icon } from '../components/Icon';
import { LineChart, type Series } from '../components/LineChart';
import { Banner, Button, Empty, Kpi, Modal, Spinner } from '../components/ui';
import { useAnalysis } from '../state/analysis';
import { FAILURE_LOCATIONS, newTestRecord, normalizeTests, TEST_KINDS } from '../state/defaults';
import { patchSection, useProject } from '../state/projectStore';
import { sig } from '../util/format';
import { PressureTargets } from './PressureTargets';

// ------------------------------------------------------------------ shared calibration state (panel + bottom)
interface CalState {
  result: CalibrationResult | null;
  /** Project the result was computed for. */
  forProject: Project | null;
  busy: boolean;
  error: string | null;
}
let calState: CalState = { result: null, forProject: null, busy: false, error: null };
const calListeners = new Set<() => void>();
const calStore = {
  get: () => calState,
  set(p: Partial<CalState>) {
    calState = { ...calState, ...p };
    calListeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    calListeners.add(l);
    return () => calListeners.delete(l);
  },
};
const useCal = () => useSyncExternalStore(calStore.subscribe, calStore.get, calStore.get);

const DEBOUNCE_MS = 600;
/** CompositeSpec.translation_efficiency: 0.3 < eta <= 1 */
const ETA_MIN = 0.3;
const ETA_MAX = 1;

const KIND_LABEL: Record<TestKind, string> = {
  burst: 'Burst',
  proof: 'Proof',
  autofrettage: 'Autofrettage',
  cycle: 'Cycle',
};
const LOC_LABEL: Record<FailureLocation, string> = {
  cylinder: 'Cylinder',
  'dome-a': 'Dome A',
  'dome-b': 'Dome B',
  boss: 'Boss',
  leak: 'Leak',
  none: 'None',
};

/** Recompute the calibration (POST /api/calibrate) while the Testing step is open. */
function useCalibration() {
  const { project } = useProject();
  const ctrl = useRef<AbortController | null>(null);
  const hasTests = project.tests.length > 0;
  useEffect(() => {
    if (!hasTests) {
      ctrl.current?.abort();
      calStore.set({ result: null, forProject: null, busy: false, error: null });
      return;
    }
    if (calStore.get().forProject === project) return;
    const h = window.setTimeout(() => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      calStore.set({ busy: true });
      api
        .calibrate(project, c.signal)
        .then((r) => {
          if (c.signal.aborted) return;
          calStore.set({ result: r, forProject: project, error: null });
        })
        .catch((e) => {
          if (!isAbort(e) && !c.signal.aborted) calStore.set({ error: errorMessage(e) });
        })
        .finally(() => {
          if (ctrl.current === c) calStore.set({ busy: false });
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [project, hasTests]);
  useEffect(
    () => () => {
      ctrl.current?.abort();
      calStore.set({ busy: false });
    },
    [],
  );
}

function etaStatus(v: number | null): { ok: boolean; why?: string } {
  if (v == null || !Number.isFinite(v)) return { ok: false, why: 'Not available' };
  if (v > ETA_MAX) return { ok: false, why: `Above ${ETA_MAX}: check the fibre strength data or the test records` };
  if (v <= ETA_MIN) return { ok: false, why: `Must be above ${ETA_MIN}` };
  return { ok: true };
}

// ------------------------------------------------------------------ panel
export function TestingPanel() {
  useCalibration();
  const { project, update } = useProject();
  const { result: analysis } = useAnalysis();
  const cal = useCal();
  const r = cal.result;
  const eta = project.composite.translation_efficiency;
  const stale = !!r && cal.forProject !== project;
  const bursts = project.tests.filter((t) => t.kind === 'burst');
  const applyEta = (v: number) =>
    update(patchSection('composite', { translation_efficiency: Math.round(v * 1000) / 1000 }));
  const sug = etaStatus(r?.suggested_efficiency ?? null);
  const bb = etaStatus(r?.b_basis_efficiency ?? null);
  const st = analysis?.structural ?? null;

  return (
    <>
      <Section
        title={
          <>
            Calibration {cal.busy ? <Spinner size={10} label="Calibrating" /> : null}
          </>
        }
      >
        {!project.tests.length ? (
          <Empty>Add test records below (or paste them from a spreadsheet) to correlate the model with tests.</Empty>
        ) : null}
        {cal.error ? <Banner kind="fail">{cal.error}</Banner> : null}
        {r ? (
          <>
            <div className="kpi-grid">
              <Kpi
                label="Burst ratio (mean)"
                value={r.burst_mean_ratio != null ? sig(r.burst_mean_ratio, 4) : '–'}
                status={
                  r.burst_mean_ratio == null
                    ? null
                    : Math.abs(r.burst_mean_ratio - 1) <= 0.05
                      ? 'ok'
                      : r.burst_mean_ratio < 1
                        ? 'fail'
                        : 'warn'
                }
                title="Measured / predicted burst pressure, mean over cylinder bursts"
                sub={
                  r.burst_cov != null
                    ? `CoV ${sig(r.burst_cov * 100, 3)} % · ${bursts.filter((t) => t.failure_location === 'cylinder').length} cylinder bursts`
                    : 'measured / predicted, cylinder bursts'
                }
              />
              <Kpi
                label="Translation efficiency"
                value={sig(r.current_efficiency, 3)}
                unit="η"
                sub={st ? `burst ${sig(st.burst_pressure, 4)} MPa predicted` : 'current model'}
              />
              <Kpi
                label="Suggested η"
                value={r.suggested_efficiency != null ? sig(r.suggested_efficiency, 3) : '–'}
                status={r.suggested_efficiency != null && !sug.ok ? 'warn' : null}
                title="Efficiency that makes the mean predicted cylinder burst match the tests"
                sub="matches the mean ratio"
              />
              <Kpi
                label="B-basis η"
                value={r.b_basis_efficiency != null ? sig(r.b_basis_efficiency, 3) : '–'}
                status={r.b_basis_efficiency != null && !bb.ok ? 'warn' : null}
                title="Mean − k·sd of the burst ratio (one-sided tolerance, 90 % content / 95 % confidence) times η"
                sub={r.b_basis_efficiency != null ? '90 % / 95 % tolerance' : 'needs ≥ 2 cylinder bursts'}
              />
            </div>
            <div className="toolbar">
              <Button
                size="sm"
                variant="primary"
                icon="check"
                disabled={!sug.ok || stale || cal.busy || Math.abs((r.suggested_efficiency ?? 0) - eta) < 5e-4}
                title={sug.ok ? 'Set composite.translation_efficiency (one undo step)' : sug.why}
                onClick={() => r.suggested_efficiency != null && applyEta(r.suggested_efficiency)}
              >
                Apply suggested efficiency
              </Button>
              <Button
                size="sm"
                icon="check"
                disabled={!bb.ok || stale || cal.busy || Math.abs((r.b_basis_efficiency ?? 0) - eta) < 5e-4}
                title={bb.ok ? 'Set composite.translation_efficiency (one undo step)' : bb.why}
                onClick={() => r.b_basis_efficiency != null && applyEta(r.b_basis_efficiency)}
              >
                Apply B-basis efficiency
              </Button>
            </div>
            {r.suggested_efficiency != null && !sug.ok ? (
              <Banner kind="warn">Suggested efficiency {sig(r.suggested_efficiency, 3)}: {sug.why}.</Banner>
            ) : null}
            {r.b_basis_efficiency != null && !bb.ok ? (
              <Banner kind="warn">B-basis efficiency {sig(r.b_basis_efficiency, 3)}: {bb.why}.</Banner>
            ) : null}
            {stale ? <p className="muted small">Updating for the changed project…</p> : null}
            <BurstChart r={r} />
            {r.notes.length ? (
              <ul className="notes-list">
                {r.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : project.tests.length && !cal.error ? (
          <div className="empty">
            <Spinner /> Correlating the tests…
          </div>
        ) : null}
      </Section>
      {st ? (
        <Section title="Predicted for this design" defaultOpen={false}>
          <PressureTargets compact />
        </Section>
      ) : null}
    </>
  );
}

type ChartMode = 'scatter' | 'ratio';

function BurstChart({ r }: { r: CalibrationResult }) {
  const [mode, setMode] = useState<ChartMode>('scatter');
  const { project } = useProject();
  const loc = useMemo(() => new Map(project.tests.map((t) => [t.id, t.failure_location])), [project.tests]);
  const rows = r.tests.filter((t) => t.kind === 'burst' && t.predicted != null && t.predicted > 0);
  const view = useMemo(() => {
    if (!rows.length) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of rows) {
      lo = Math.min(lo, t.measured, t.predicted!);
      hi = Math.max(hi, t.measured, t.predicted!);
    }
    const pad = Math.max((hi - lo) * 0.15, hi * 0.05);
    const d: [number, number] = [Math.max(0, lo - pad), hi + pad];
    const cyl = rows.filter((t) => loc.get(t.id) === 'cylinder');
    const other = rows.filter((t) => loc.get(t.id) !== 'cylinder');
    const series: Series[] = [
      { id: 'eq', name: 'measured = predicted', x: d, y: d, color: 'var(--axis)', dash: '5 4', width: 1.5, noHover: true },
      { id: 'p10', name: '±10 %', x: d, y: d.map((v) => v * 1.1), color: 'var(--grid)', dash: '2 3', width: 1, noHover: true },
      { id: 'm10', name: '−10 %', x: d, y: d.map((v) => v * 0.9), color: 'var(--grid)', dash: '2 3', width: 1, noHover: true, hideLegend: true },
      {
        id: 'cyl',
        name: 'cylinder bursts',
        x: cyl.map((t) => t.predicted!),
        y: cyl.map((t) => t.measured),
        color: 'var(--series-1)',
        width: 0,
        markers: true,
      },
      {
        id: 'other',
        name: 'dome / other',
        x: other.map((t) => t.predicted!),
        y: other.map((t) => t.measured),
        color: 'var(--series-2)',
        width: 0,
        markers: true,
      },
    ].filter((s) => s.x.length);
    return { series, d };
  }, [rows, loc]);
  if (!rows.length) return <p className="muted small">No burst test to compare yet.</p>;
  const tools = (
    <Segmented<ChartMode>
      size="sm"
      ariaLabel="Burst chart"
      value={mode}
      options={[
        { value: 'scatter', label: 'Measured vs predicted' },
        { value: 'ratio', label: 'Ratio' },
      ]}
      onChange={setMode}
    />
  );
  return mode === 'scatter' && view ? (
    <LineChart
      title="Burst pressure"
      series={view.series}
      xDomain={view.d}
      yDomain={view.d}
      xLabel="Predicted"
      xUnit="MPa"
      yLabel="Measured"
      yUnit="MPa"
      hover="nearest"
      height={230}
      tools={tools}
    />
  ) : (
    <div>
      <div className="chart-head-row standalone">
        <span className="chart-title">Burst ratio measured / predicted</span>
        <div className="chart-tools">{tools}</div>
      </div>
      <BarChart
        categories={rows.map((t) => `${t.id}${t.serial ? ` (${t.serial})` : ''}`)}
        tickLabels={rows.map((t) => t.id)}
        series={[{ id: 'ratio', name: 'measured / predicted', values: rows.map((t) => t.ratio ?? NaN), color: 'var(--series-1)' }]}
        hline={{ value: 1 }}
        yLabel="ratio"
        xLabel="Test"
        height={200}
      />
    </div>
  );
}

// ------------------------------------------------------------------ bottom: test records table
function updateTests(fn: (ts: TestRecord[]) => TestRecord[]) {
  return (p: Project): Project => ({ ...p, tests: fn(p.tests) });
}

export function TestingBottom() {
  const { project, update } = useProject();
  const cal = useCal();
  const { result } = useAnalysis();
  const [paste, setPaste] = useState(false);
  const tests = project.tests;
  const corr = useMemo(
    () => new Map((cal.result?.tests ?? []).map((t) => [t.id, t] as [string, TestCorrelation])),
    [cal.result],
  );
  const set = (id: string, patch: Partial<TestRecord>, key: string) =>
    update(
      updateTests((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t))),
      `test.${id}.${key}`,
    );
  const add = () =>
    update(
      updateTests((ts) => [
        ...ts,
        newTestRecord(ts, Number(sig(result?.structural?.burst_pressure ?? project.requirements.meop * 1.5, 3))),
      ]),
    );
  const duplicate = (i: number) =>
    update(
      updateTests((ts) => {
        const copy = { ...ts[i], id: newTestRecord(ts).id };
        return [...ts.slice(0, i + 1), copy, ...ts.slice(i + 1)];
      }),
    );
  const remove = (id: string) => update(updateTests((ts) => ts.filter((t) => t.id !== id)));

  return (
    <div className="test-bottom">
      <div className="toolbar test-toolbar">
        <span className="chart-title">Test records</span>
        <Button size="sm" icon="plus" onClick={add}>
          Add test
        </Button>
        <Button size="sm" icon="upload" onClick={() => setPaste(true)} title="Paste rows copied from a spreadsheet or CSV">
          Paste CSV…
        </Button>
        <span style={{ flex: 1 }} />
        <span className="muted small">
          Pressures in MPa, volumetric expansion in mL. Burst tests calibrate the fibre translation efficiency.
        </span>
      </div>
      {!tests.length ? (
        <Empty>No test records. Add burst, proof, autofrettage and cycle test results here.</Empty>
      ) : (
        <div className="table-scroll test-scroll">
          <table className="data-table test-table">
            <thead>
              <tr>
                <th>Id</th>
                <th>Serial</th>
                <th>Kind</th>
                <th className="num" title="Burst / test pressure [MPa]">
                  p MPa
                </th>
                <th>Failure</th>
                <th className="num" title="Cycles to failure or run-out (cycle tests)">
                  Cycles
                </th>
                <th className="num" title="Total volumetric expansion at test pressure [mL]">
                  ΔV tot mL
                </th>
                <th className="num" title="Permanent volumetric expansion after venting [mL]">
                  ΔV perm mL
                </th>
                <th>Date</th>
                <th>Notes</th>
                <th className="num sep-left" title="Model prediction for this test [MPa]">
                  Pred. MPa
                </th>
                <th className="num" title="Measured / predicted">
                  Ratio
                </th>
                <th title="Failure location matches the predicted critical location">Loc.</th>
                <th className="num" title="Measured / predicted total volumetric expansion">
                  ΔV ratio
                </th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tests.map((t, i) => {
                const c = corr.get(t.id);
                const ids = tests.map((x) => x.id);
                return (
                  <tr key={t.id}>
                    <td className="c-id">
                      <TextInput
                        value={t.id}
                        ariaLabel={`Test ${i + 1} id`}
                        onCommit={(v) => {
                          const id = v.trim();
                          if (id && !ids.includes(id)) set(t.id, { id }, 'id');
                        }}
                      />
                    </td>
                    <td className="c-serial">
                      <TextInput
                        value={t.serial}
                        ariaLabel={`Test ${t.id} serial`}
                        placeholder="S/N"
                        onCommit={(v) => set(t.id, { serial: v }, 'serial')}
                      />
                    </td>
                    <td>
                      <Select<TestKind>
                        className="select-sm"
                        ariaLabel={`Test ${t.id} kind`}
                        value={t.kind}
                        options={TEST_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
                        onChange={(v) => set(t.id, { kind: v }, 'kind')}
                      />
                    </td>
                    <td className="c-num">
                      <NumberInput
                        ariaLabel={`Test ${t.id} pressure`}
                        value={t.pressure}
                        gt={0}
                        step={1}
                        onCommit={(v) => set(t.id, { pressure: v }, 'p')}
                      />
                    </td>
                    <td>
                      <Select<FailureLocation>
                        className="select-sm"
                        ariaLabel={`Test ${t.id} failure location`}
                        value={t.failure_location}
                        options={FAILURE_LOCATIONS.map((k) => ({ value: k, label: LOC_LABEL[k] }))}
                        onChange={(v) => set(t.id, { failure_location: v }, 'loc')}
                      />
                    </td>
                    <td className="c-num">
                      <NumberInput
                        ariaLabel={`Test ${t.id} cycles`}
                        value={t.cycles}
                        placeholder="–"
                        integer
                        min={0}
                        step={100}
                        disabled={t.kind !== 'cycle' && t.cycles == null}
                        onCommit={(v) => set(t.id, { cycles: v }, 'cyc')}
                        onClear={() => set(t.id, { cycles: null }, 'cyc')}
                      />
                    </td>
                    <td className="c-num">
                      <NumberInput
                        ariaLabel={`Test ${t.id} total volumetric expansion`}
                        value={t.volumetric_expansion_total}
                        placeholder="–"
                        min={0}
                        step={1}
                        onCommit={(v) => set(t.id, { volumetric_expansion_total: v }, 'vt')}
                        onClear={() => set(t.id, { volumetric_expansion_total: null }, 'vt')}
                      />
                    </td>
                    <td className="c-num">
                      <NumberInput
                        ariaLabel={`Test ${t.id} permanent volumetric expansion`}
                        value={t.volumetric_expansion_permanent}
                        placeholder="–"
                        min={0}
                        step={0.5}
                        onCommit={(v) => set(t.id, { volumetric_expansion_permanent: v }, 'vp')}
                        onClear={() => set(t.id, { volumetric_expansion_permanent: null }, 'vp')}
                      />
                    </td>
                    <td className="c-date">
                      <TextInput
                        value={t.date}
                        ariaLabel={`Test ${t.id} date`}
                        placeholder="YYYY-MM-DD"
                        onCommit={(v) => set(t.id, { date: v.trim() }, 'date')}
                      />
                    </td>
                    <td className="c-notes">
                      <TextInput
                        value={t.notes}
                        ariaLabel={`Test ${t.id} notes`}
                        onCommit={(v) => set(t.id, { notes: v }, 'notes')}
                      />
                    </td>
                    <td className="num sep-left">{c?.predicted != null ? sig(c.predicted, 4) : '–'}</td>
                    <td className={`num ${c?.ratio != null ? (c.ratio < 1 ? 'bad' : '') : ''}`}>
                      {c?.ratio != null ? sig(c.ratio, 3) : '–'}
                    </td>
                    <td>
                      {c?.location_match == null ? (
                        <span className="muted">–</span>
                      ) : c.location_match ? (
                        <span className="loc-ok" title="Failed where the model predicts">
                          ✓
                        </span>
                      ) : (
                        <span className="loc-bad" title="Failed away from the predicted critical location">
                          ✗
                        </span>
                      )}
                    </td>
                    <td className="num">{c?.expansion_ratio != null ? sig(c.expansion_ratio, 3) : '–'}</td>
                    <td className="row-actions">
                      <button type="button" aria-label={`Duplicate test ${t.id}`} title="Duplicate" onClick={() => duplicate(i)}>
                        <Icon name="copy" size={13} />
                      </button>
                      <button
                        type="button"
                        className="danger"
                        aria-label={`Delete test ${t.id}`}
                        title="Delete (Ctrl+Z undoes)"
                        onClick={() => remove(t.id)}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <PasteDialog open={paste} onClose={() => setPaste(false)} />
    </div>
  );
}

// ------------------------------------------------------------------ CSV paste import
const HEADER_ALIASES: Record<string, keyof TestRecord> = {
  id: 'id',
  serial: 'serial',
  sn: 'serial',
  's/n': 'serial',
  kind: 'kind',
  type: 'kind',
  test: 'kind',
  pressure: 'pressure',
  p: 'pressure',
  cycles: 'cycles',
  failure_location: 'failure_location',
  location: 'failure_location',
  failure: 'failure_location',
  volumetric_expansion_total: 'volumetric_expansion_total',
  expansion_total: 'volumetric_expansion_total',
  total_expansion: 'volumetric_expansion_total',
  dv_total: 'volumetric_expansion_total',
  volumetric_expansion_permanent: 'volumetric_expansion_permanent',
  expansion_permanent: 'volumetric_expansion_permanent',
  permanent_expansion: 'volumetric_expansion_permanent',
  dv_permanent: 'volumetric_expansion_permanent',
  date: 'date',
  notes: 'notes',
  note: 'notes',
  comment: 'notes',
};
/** Column order when the pasted text has no header row. */
const DEFAULT_COLUMNS: (keyof TestRecord)[] = [
  'serial',
  'kind',
  'pressure',
  'failure_location',
  'volumetric_expansion_total',
  'volumetric_expansion_permanent',
  'date',
  'notes',
];

interface ParseOut {
  rows: Partial<TestRecord>[];
  errors: string[];
  columns: string[];
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normKey(h: string): { key: keyof TestRecord | null; bar: boolean } {
  const raw = h.toLowerCase().trim();
  const bar = /\bbar\b/.test(raw);
  const k = raw
    .replace(/\[.*?\]|\(.*?\)/g, '')
    .replace(/\b(mpa|bar|ml)\b/g, '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .replace(/_+$/, '');
  return { key: HEADER_ALIASES[k] ?? null, bar };
}

function parseKind(v: string): TestKind | null {
  const s = v.toLowerCase();
  if (s.startsWith('burst')) return 'burst';
  if (s.startsWith('proof')) return 'proof';
  if (s.startsWith('auto') || s === 'af') return 'autofrettage';
  if (s.startsWith('cycl') || s.startsWith('fatigue')) return 'cycle';
  return null;
}

function parseLoc(v: string): FailureLocation | null {
  const s = v.toLowerCase().replace(/[\s_]+/g, '-');
  if (!s) return null;
  if (s.startsWith('cyl')) return 'cylinder';
  if (s === 'dome-a' || s === 'a' || s === 'domea') return 'dome-a';
  if (s === 'dome-b' || s === 'b' || s === 'domeb') return 'dome-b';
  if (s.startsWith('boss') || s.startsWith('neck')) return 'boss';
  if (s.startsWith('leak')) return 'leak';
  if (s === 'none' || s === '-' || s === 'n/a' || s.startsWith('no')) return 'none';
  return null;
}

export function parseTestsText(text: string): ParseOut {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], errors: [], columns: [] };
  const first = lines[0];
  const delim = first.includes('\t') ? '\t' : first.includes(';') ? ';' : ',';
  const head = splitLine(first, delim).map(normKey);
  const hasHeader = head.some((h) => h.key === 'pressure' || h.key === 'kind');
  const cols = hasHeader ? head : DEFAULT_COLUMNS.map((key) => ({ key, bar: false }));
  const body = hasHeader ? lines.slice(1) : lines;
  const rows: Partial<TestRecord>[] = [];
  const errors: string[] = [];
  body.forEach((line, li) => {
    const cells = splitLine(line, delim);
    const rec: Partial<TestRecord> = {};
    const lineNo = li + (hasHeader ? 2 : 1);
    cols.forEach((c, i) => {
      const v = cells[i] ?? '';
      if (!c.key || v === '') return;
      switch (c.key) {
        case 'pressure':
        case 'volumetric_expansion_total':
        case 'volumetric_expansion_permanent':
        case 'cycles': {
          const n = parseNumber(delim === ',' ? v : v.replace(',', '.'));
          if (!Number.isFinite(n)) errors.push(`Line ${lineNo}: “${v}” is not a number`);
          else rec[c.key] = c.key === 'pressure' && c.bar ? n / 10 : c.key === 'cycles' ? Math.round(n) : n;
          break;
        }
        case 'kind': {
          const k = parseKind(v);
          if (k) rec.kind = k;
          else errors.push(`Line ${lineNo}: unknown test kind “${v}”`);
          break;
        }
        case 'failure_location': {
          const l = parseLoc(v);
          if (l) rec.failure_location = l;
          else errors.push(`Line ${lineNo}: unknown failure location “${v}”`);
          break;
        }
        default:
          (rec as Record<string, unknown>)[c.key] = v;
      }
    });
    if (!(typeof rec.pressure === 'number' && rec.pressure > 0)) {
      errors.push(`Line ${lineNo}: no valid pressure, skipped`);
      return;
    }
    rows.push(rec);
  });
  return {
    rows,
    errors,
    columns: cols.map((c) => (c.key ? String(c.key) : '(ignored)')),
  };
}

function PasteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { project, update } = useProject();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const parsed = useMemo(() => parseTestsText(text), [text]);
  const doImport = () => {
    update((p) => {
      const out = mode === 'append' ? [...p.tests] : [];
      for (const r of parsed.rows) {
        const d = newTestRecord(out, r.pressure);
        const id = r.id && !out.some((t) => t.id === r.id) ? r.id : d.id;
        out.push(...normalizeTests([{ ...d, ...r, id }]));
      }
      return { ...p, tests: out };
    });
    setText('');
    onClose();
  };
  return (
    <Modal
      title="Import test records"
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" disabled={!parsed.rows.length} onClick={doImport}>
            {mode === 'append' ? 'Append' : 'Replace with'} {parsed.rows.length} record{parsed.rows.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <p className="small">
        Paste rows from a spreadsheet (tab separated) or CSV (comma / semicolon). A header row maps columns by name:{' '}
        <code>serial, kind, pressure, failure_location, cycles, volumetric_expansion_total,
        volumetric_expansion_permanent, date, notes</code>{' '}
        (short forms like <code>location</code>, <code>expansion_total</code> work; a <code>pressure [bar]</code>{' '}
        column is converted to MPa). Without a header the order is: serial, kind, pressure [MPa], location, ΔV total,
        ΔV permanent, date, notes.
      </p>
      <textarea
        className="notes paste-area"
        aria-label="Pasted test data"
        rows={8}
        value={text}
        spellCheck={false}
        placeholder={'serial\tkind\tpressure\tlocation\texpansion_total\nSN-001\tburst\t52.3\tcylinder\t'}
        onChange={(e) => setText(e.target.value)}
      />
      <Field label="Mode">
        <Segmented<'append' | 'replace'>
          size="sm"
          ariaLabel="Import mode"
          value={mode}
          options={[
            { value: 'append', label: `Append to ${project.tests.length}` },
            { value: 'replace', label: 'Replace all' },
          ]}
          onChange={setMode}
        />
      </Field>
      {text.trim() ? (
        <p className="muted small">
          {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} recognised · columns: {parsed.columns.join(', ')}
        </p>
      ) : null}
      {parsed.errors.length ? (
        <Banner kind="warn">
          {parsed.errors.slice(0, 6).map((e, i) => (
            <div key={i}>{e}</div>
          ))}
          {parsed.errors.length > 6 ? <div>… {parsed.errors.length - 6} more</div> : null}
        </Banner>
      ) : null}
    </Modal>
  );
}
