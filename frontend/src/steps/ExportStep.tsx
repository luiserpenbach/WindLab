import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, errorMessage } from '../api/client';
import type {
  CcxExportResponse,
  FeaExportResponse,
  GcodeResponse,
  GcodeVerification,
  MachineSpec,
  Project,
  TravellerResponse,
} from '../api/types';
import { Field, Section, Segmented } from '../components/fields';
import { Icon } from '../components/Icon';
import { LineChart, type RefLine, type Series } from '../components/LineChart';
import { Banner, Button, Empty, Kpi, Spinner, WarningList } from '../components/ui';
import { usePolymerLiner } from '../state/materials';
import { useProject } from '../state/projectStore';
import { downloadText, fmtDuration, fmtTime, safeFilename, sig } from '../util/format';
import { BackplotParser, chunks, type BackplotAxis, type BackplotResult } from '../util/gcodeBackplot';
import type { BackplotMessage, BackplotRequest } from '../workers/backplot.worker';
import { PressureTargets } from './PressureTargets';
import { NO_AUTOFRETTAGE_NOTE } from './shared';

// ------------------------------------------------------------------ local store shared by panel + bottom
interface ExportState {
  gcode: GcodeResponse | null;
  gcodeFor: Project | null;
  gcodeBusy: boolean;
  gcodeError: string | null;
  traveller: TravellerResponse | null;
  travellerFor: Project | null;
  travellerBusy: boolean;
  travellerError: string | null;
  report: { html: string; url: string } | null;
  reportFor: Project | null;
  reportBusy: boolean;
  reportError: string | null;
  /** The report window was blocked: show a link instead. */
  reportBlocked: boolean;
  fea: FeaExportResponse | null;
  feaFor: Project | null;
  feaBusy: boolean;
  feaError: string | null;
  ccx: CcxExportResponse | null;
  ccxFor: Project | null;
  ccxBusy: boolean;
  ccxError: string | null;
  backplot: BackplotResult | null;
  /** G-code response the backplot belongs to */
  backplotFor: GcodeResponse | null;
  backplotProgress: number | null;
  backplotError: string | null;
  tab: 'gcode' | 'backplot' | 'traveller';
}
let state: ExportState = {
  gcode: null,
  gcodeFor: null,
  gcodeBusy: false,
  gcodeError: null,
  traveller: null,
  travellerFor: null,
  travellerBusy: false,
  travellerError: null,
  report: null,
  reportFor: null,
  reportBusy: false,
  reportError: null,
  reportBlocked: false,
  fea: null,
  feaFor: null,
  feaBusy: false,
  feaError: null,
  ccx: null,
  ccxFor: null,
  ccxBusy: false,
  ccxError: null,
  backplot: null,
  backplotFor: null,
  backplotProgress: null,
  backplotError: null,
  tab: 'gcode',
};
const listeners = new Set<() => void>();
const store = {
  get: () => state,
  set(p: Partial<ExportState>) {
    state = { ...state, ...p };
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
const useExport = () => useSyncExternalStore(store.subscribe, store.get, store.get);

const PREVIEW_LINES = 300;

function ext(p: Project) {
  return p.machine.controller === 'grbl' ? '.gcode' : '.ngc';
}

function gcodeFilename(p: Project, r: GcodeResponse): string {
  const base = (r.filename || safeFilename(p.name)).replace(/\.(ngc|gcode|nc|tap)$/i, '');
  return `${base}${ext(p)}`;
}

// ------------------------------------------------------------------ backplot runner (Web Worker, chunked fallback)
const AXIS_ROLES = ['carriage', 'crossfeed', 'mandrel', 'eye'] as const;

function backplotAxes(m: MachineSpec): BackplotAxis[] {
  const out: BackplotAxis[] = [];
  for (const role of AXIS_ROLES) {
    const ax = m[role];
    if (!ax) continue;
    if (role === 'crossfeed' && m.axes_count < 3) continue;
    if (role === 'eye' && m.axes_count < 4) continue;
    out.push({
      letter: ax.letter.toUpperCase(),
      role,
      vmax: ax.max_velocity,
      rotary: role === 'mandrel' || role === 'eye',
    });
  }
  return out;
}

let worker: Worker | null = null;
let workerFailed = false;
let jobId = 0;

function getWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL('../workers/backplot.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<BackplotMessage>) => {
      const m = e.data;
      if (m.id !== jobId) return;
      if (m.type === 'progress') store.set({ backplotProgress: m.done / Math.max(1, m.total) });
      else if (m.type === 'done') store.set({ backplot: m.result, backplotProgress: null, backplotError: null });
      else store.set({ backplotProgress: null, backplotError: m.message });
    };
    worker.onerror = () => {
      workerFailed = true;
      worker?.terminate();
      worker = null;
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

/** Parse the program for the backplot off the main thread (or in 256 kB chunks if workers are unavailable). */
function runBackplot(r: GcodeResponse, machine: MachineSpec) {
  const id = ++jobId;
  const opts = { axes: backplotAxes(machine), controller: machine.controller, buckets: 1500 };
  store.set({ backplot: null, backplotFor: r, backplotProgress: 0, backplotError: null });
  const w = getWorker();
  if (w) {
    w.postMessage({ id, text: r.gcode, opts } satisfies BackplotRequest);
    return;
  }
  const p = new BackplotParser(opts);
  const it = chunks(r.gcode, 1 << 18);
  const t0 = performance.now();
  const step = () => {
    if (id !== jobId) return;
    const deadline = performance.now() + 12;
    let n = it.next();
    while (!n.done) {
      p.feed(r.gcode, n.value[0], n.value[1]);
      if (performance.now() > deadline) break;
      n = it.next();
    }
    if (n.done) store.set({ backplot: p.finish(performance.now() - t0), backplotProgress: null });
    else {
      store.set({ backplotProgress: n.value[1] / r.gcode.length });
      window.setTimeout(step, 0);
    }
  };
  window.setTimeout(step, 0);
}

// ------------------------------------------------------------------ panel
export function ExportPanel() {
  const { project } = useProject();
  const polymer = usePolymerLiner();
  const s = useExport();
  const [mode, setMode] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const ids = project.layers.map((l) => l.id);
  const selIds = mode === 'all' ? null : ids.filter((id) => picked.has(id));

  const genGcode = async () => {
    store.set({ gcodeBusy: true, gcodeError: null, tab: store.get().tab === 'traveller' ? 'gcode' : store.get().tab });
    try {
      const r = await api.gcode(project, selIds);
      store.set({ gcode: r, gcodeFor: project, gcodeBusy: false });
      runBackplot(r, project.machine);
    } catch (e) {
      store.set({ gcodeError: errorMessage(e), gcodeBusy: false });
    }
  };
  const genReport = async () => {
    // open the window inside the click so popup blockers allow it; fill it when the report arrives
    const w = window.open('', '_blank');
    if (w) {
      try {
        w.document.title = 'WindLab design report';
        w.document.body.style.font = '14px system-ui, sans-serif';
        w.document.body.textContent = 'Generating the design report…';
      } catch {
        /* cross-origin / closed: ignore */
      }
    }
    store.set({ reportBusy: true, reportError: null, reportBlocked: false });
    try {
      const r = await api.report(project);
      const old = store.get().report;
      if (old) URL.revokeObjectURL(old.url);
      const url = URL.createObjectURL(new Blob([r.html], { type: 'text/html;charset=utf-8' }));
      store.set({ report: { html: r.html, url }, reportFor: project, reportBusy: false });
      if (w && !w.closed) w.location.href = url;
      else store.set({ reportBlocked: true });
    } catch (e) {
      w?.close();
      store.set({ reportError: errorMessage(e), reportBusy: false });
    }
  };
  const genFea = async () => {
    store.set({ feaBusy: true, feaError: null });
    try {
      const r = await api.feaExport(project);
      store.set({ fea: r, feaFor: project, feaBusy: false });
      downloadText(r.filename, r.inp);
      window.setTimeout(() => downloadText(r.csv_filename, r.csv, 'text/csv'), 400);
    } catch (e) {
      store.set({ feaError: errorMessage(e), feaBusy: false });
    }
  };
  const genTraveller = async () => {
    store.set({ travellerBusy: true, travellerError: null, tab: 'traveller' });
    try {
      const r = await api.traveller(project);
      store.set({ traveller: r, travellerFor: project, travellerBusy: false });
    } catch (e) {
      store.set({ travellerError: errorMessage(e), travellerBusy: false });
    }
  };

  const genCcx = async () => {
    store.set({ ccxBusy: true, ccxError: null });
    try {
      const r = await api.ccxExport(project);
      store.set({ ccx: r, ccxFor: project, ccxBusy: false });
      downloadText(r.filename, r.inp);
    } catch (e) {
      store.set({ ccxError: errorMessage(e), ccxBusy: false });
    }
  };

  return (
    <>
      <Section title="G-code">
        <Field
          label="Controller"
          hint={`${project.machine.axes_count}-axis, output for ${project.machine.controller === 'grbl' ? 'GRBL (.gcode)' : 'LinuxCNC (.ngc)'} — change in the Machine step`}
        >
          <span className="value-text">{project.machine.name}</span>
        </Field>
        <Field label="Layers">
          <Segmented<'all' | 'some'>
            ariaLabel="Layer selection"
            value={mode}
            options={[
              { value: 'all', label: `All (${ids.length})` },
              { value: 'some', label: 'Selected' },
            ]}
            onChange={(m) => {
              setMode(m);
              if (m === 'some' && picked.size === 0) setPicked(new Set(ids));
            }}
          />
        </Field>
        {project.continuous.enabled ? (
          <Banner kind="info">
            Continuous winding is on: the transition paths between layers are included and pauses between layers are
            skipped (settings in the Machine step).
          </Banner>
        ) : null}
        {mode === 'some' ? (
          <fieldset className="layer-picks">
            <legend className="sr-only">Layers to export</legend>
            {project.layers.map((l, i) => (
              <label key={l.id} className="check-row">
                <input
                  type="checkbox"
                  checked={picked.has(l.id)}
                  onChange={(e) =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (e.target.checked) n.add(l.id);
                      else n.delete(l.id);
                      return n;
                    })
                  }
                />
                <span className="muted">{i + 1}.</span> {l.id}{' '}
                <span className={`type-badge t-${l.type}`}>{l.type}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="toolbar">
          <Button
            variant="primary"
            icon="code"
            disabled={s.gcodeBusy || !ids.length || (selIds != null && selIds.length === 0)}
            onClick={genGcode}
          >
            Generate G-code
          </Button>
          {s.gcodeBusy ? <Spinner size={12} /> : null}
        </div>
        {s.gcodeError ? <Banner kind="fail">{s.gcodeError}</Banner> : null}
        {s.gcode ? (
          <>
            {s.gcodeFor !== project ? (
              <Banner kind="info">Project changed since generation — regenerate before running.</Banner>
            ) : null}
            <div className="kpi-grid">
              <Kpi label="Lines" value={s.gcode.lines.toLocaleString()} />
              <Kpi label="Est. time" value={fmtDuration(s.gcode.total_time)} />
            </div>
            <WarningList items={s.gcode.warnings} />
            {s.gcode.verification ? (
              <VerificationCard v={s.gcode.verification} r={s.gcode} machine={(s.gcodeFor ?? project).machine} />
            ) : null}
            <div className="toolbar">
              <Button
                icon="download"
                onClick={() => s.gcode && downloadText(gcodeFilename(project, s.gcode), s.gcode.gcode)}
              >
                Download {ext(project)}
              </Button>
              <Button
                icon="copy"
                variant="ghost"
                onClick={() => s.gcode && navigator.clipboard?.writeText(s.gcode.gcode).catch(() => undefined)}
              >
                Copy
              </Button>
            </div>
          </>
        ) : null}
      </Section>

      <Section title="Traveller">
        <p className="muted small">
          Shop-floor work instructions: materials, layer sequence, settings and sign-off fields.
        </p>
        <div className="toolbar">
          <Button icon="file" disabled={s.travellerBusy} onClick={genTraveller}>
            Generate traveller
          </Button>
          {s.travellerBusy ? <Spinner size={12} /> : null}
        </div>
        {s.travellerError ? <Banner kind="fail">{s.travellerError}</Banner> : null}
        {s.traveller && s.travellerFor !== project ? (
          <Banner kind="info">Project changed since generation.</Banner>
        ) : null}
        <PressureTargets compact />
      </Section>

      <Section title="Report">
        <p className="muted small">
          Self-contained, printable report: requirements, materials, layup, analysis results and checks.
        </p>
        <div className="toolbar">
          <Button icon="print" disabled={s.reportBusy} onClick={genReport}>
            Design report
          </Button>
          {s.reportBusy ? <Spinner size={12} label="Generating the report" /> : null}
          {s.report ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                icon="external"
                onClick={() => s.report && window.open(s.report.url, '_blank')}
                title="Open the report in a new tab (print from there)"
              >
                Open
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="download"
                onClick={() =>
                  s.report && downloadText(`${safeFilename(project.name)}-report.html`, s.report.html, 'text/html')
                }
              >
                .html
              </Button>
            </>
          ) : null}
        </div>
        {s.reportError ? <Banner kind="fail">{s.reportError}</Banner> : null}
        {s.reportBlocked && s.report ? (
          <Banner kind="info">
            The browser blocked the new window.{' '}
            <a href={s.report.url} target="_blank" rel="noopener">
              Open the report
            </a>
          </Banner>
        ) : null}
        {s.report && s.reportFor !== project ? <Banner kind="info">Project changed since generation.</Banner> : null}
      </Section>

      <Section title="FEA export">
        <p className="muted small">
          <strong>Abaqus:</strong> axisymmetric shell model (SAX1) of liner + layup as an input deck, plus the layup
          table as CSV.
        </p>
        <div className="toolbar">
          <Button icon="download" disabled={s.feaBusy} onClick={genFea}>
            Abaqus export
          </Button>
          {s.feaBusy ? <Spinner size={12} label="Exporting" /> : null}
        </div>
        {s.feaError ? <Banner kind="fail">{s.feaError}</Banner> : null}
        {s.fea ? (
          <>
            <div className="kpi-grid">
              <Kpi label="Elements" value={s.fea.elements.toLocaleString()} sub="SAX1 shell elements" />
              <Kpi label="Materials" value={s.fea.materials} sub="material / section definitions" />
            </div>
            <div className="toolbar">
              <Button
                size="sm"
                variant="ghost"
                icon="download"
                onClick={() => s.fea && downloadText(s.fea.filename, s.fea.inp)}
              >
                {s.fea.filename}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="download"
                onClick={() => s.fea && downloadText(s.fea.csv_filename, s.fea.csv, 'text/csv')}
              >
                {s.fea.csv_filename}
              </Button>
            </div>
            {s.feaFor !== project ? <Banner kind="info">Project changed since export.</Banner> : null}
          </>
        ) : null}
        <Banner kind="warn">
          The Abaqus deck has not been validated in Abaqus by the WindLab authors. Check units (mm, MPa, N), section
          orientations, boundary conditions and loads before using its results.
        </Banner>
        <p className="muted small fea-sep">
          <strong>CalculiX:</strong> axisymmetric solid model (CAX8/CAX6, one element row per layer, liner plasticity)
          with cure cool-down, autofrettage, proof and MEOP steps. Open source; the WindLab test suite runs it against
          the cylinder model.
          {polymer ? ` ${NO_AUTOFRETTAGE_NOTE}` : null}
        </p>
        <div className="toolbar">
          <Button icon="download" disabled={s.ccxBusy} onClick={genCcx}>
            CalculiX export
          </Button>
          {s.ccxBusy ? <Spinner size={12} label="Exporting" /> : null}
        </div>
        {s.ccxError ? <Banner kind="fail">{s.ccxError}</Banner> : null}
        {s.ccx ? (
          <>
            <div className="kpi-grid three">
              <Kpi label="Elements" value={s.ccx.elements.toLocaleString()} />
              <Kpi label="Nodes" value={s.ccx.nodes.toLocaleString()} />
              <Kpi label="Materials" value={s.ccx.materials} />
            </div>
            <div className="muted small">Steps: {s.ccx.steps.join(' → ')}</div>
            <div className="toolbar">
              <Button
                size="sm"
                variant="ghost"
                icon="download"
                onClick={() => s.ccx && downloadText(s.ccx.filename, s.ccx.inp)}
              >
                {s.ccx.filename}
              </Button>
            </div>
            {s.ccxFor !== project ? <Banner kind="info">Project changed since export.</Banner> : null}
          </>
        ) : null}
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ bottom
function highlight(line: string) {
  // split off comments: ";..." or "(...)"
  const m = /^(.*?)(\s*(;.*|\(.*\)\s*)?)$/.exec(line);
  const code = m ? m[1] : line;
  const comment = m?.[2] ?? '';
  const parts = code.split(/(\s+)/).map((tok, i) => {
    const c = tok[0]?.toUpperCase();
    const cls =
      c === 'G'
        ? 'g'
        : c === 'M'
          ? 'm'
          : c === 'N'
            ? 'n'
            : c === 'F' || c === 'S'
              ? 'f'
              : /[A-Z]/.test(c ?? '')
                ? 'a'
                : '';
    return cls ? (
      <span key={i} className={`gc-${cls}`}>
        {tok}
      </span>
    ) : (
      tok
    );
  });
  return (
    <>
      {parts}
      {comment ? <span className="gc-c">{comment}</span> : null}
    </>
  );
}

/** First n lines without splitting a potentially multi-MB program. */
function headLines(text: string, n: number): string[] {
  const out: string[] = [];
  let pos = 0;
  while (out.length < n && pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 ? text.length : nl;
    out.push(text.slice(pos, end).replace(/\r$/, ''));
    if (nl < 0) break;
    pos = nl + 1;
  }
  return out;
}

/** The backend returns an HTML fragment; wrap it in a print-friendly document. */
function travellerDoc(html: string, title: string): string {
  if (/<html[\s>]/i.test(html)) return html;
  const esc = title.replace(/[<>&]/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc} – traveller</title><style>
body{font:13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:#111;margin:24px;max-width:1000px}
h1{font-size:20px;margin:0 0 6px}h2{font-size:15px;margin:18px 0 6px;border-bottom:1px solid #ccc;padding-bottom:3px}
table{border-collapse:collapse;width:100%;margin:6px 0;font-variant-numeric:tabular-nums}
th,td{border:1px solid #bbb;padding:3px 6px;text-align:left;vertical-align:top}th{background:#f0f0f0}
code,pre{font-family:ui-monospace,Menlo,Consolas,monospace}
@media print{body{margin:10mm}h2{break-after:avoid}tr{break-inside:avoid}}
</style></head><body>${html}</body></html>`;
}

function GcodeViewer({ r }: { r: GcodeResponse }) {
  const lines = useMemo(() => headLines(r.gcode, PREVIEW_LINES), [r]);
  return (
    <div className="gcode" role="region" aria-label="G-code preview" tabIndex={0}>
      <ol>
        {lines.map((l, i) => (
          <li key={i}>
            <code>{highlight(l)}</code>
          </li>
        ))}
      </ol>
      {r.lines > PREVIEW_LINES ? (
        <div className="gcode-more">
          … {(r.lines - PREVIEW_LINES).toLocaleString()} more lines — download for the full program
        </div>
      ) : null}
    </div>
  );
}

function TravellerViewer({ r }: { r: TravellerResponse }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { project } = useProject();
  const doc = useMemo(() => travellerDoc(r.html, project.name), [r, project.name]);
  return (
    <div className="traveller">
      <div className="toolbar">
        <Button icon="print" size="sm" onClick={() => frame.current?.contentWindow?.print()}>
          Print
        </Button>
        <Button
          icon="download"
          size="sm"
          onClick={() => downloadText(`${safeFilename(project.name)}-traveller.html`, doc, 'text/html')}
        >
          HTML
        </Button>
        <Button
          icon="download"
          size="sm"
          variant="ghost"
          onClick={() => downloadText(`${safeFilename(project.name)}-traveller.md`, r.markdown, 'text/markdown')}
        >
          Markdown
        </Button>
      </div>
      <iframe
        ref={frame}
        title="Traveller"
        className="traveller-frame"
        sandbox="allow-same-origin allow-modals"
        srcDoc={doc}
      />
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = {
  carriage: 'Carriage',
  crossfeed: 'Crossfeed',
  mandrel: 'Mandrel',
  eye: 'Eye',
};

function roleOf(m: MachineSpec, letter: string): string {
  for (const role of AXIS_ROLES) {
    const ax = m[role];
    if (!ax || ax.letter.toUpperCase() !== letter.toUpperCase()) continue;
    if (role === 'crossfeed' && m.axes_count < 3) continue;
    if (role === 'eye' && m.axes_count < 4) continue;
    return role;
  }
  return '';
}

function VerificationCard({ v, r, machine }: { v: GcodeVerification; r: GcodeResponse; machine: MachineSpec }) {
  const ok = !v.errors.length && v.time_matches;
  const letters = Object.keys(v.ranges).sort((a, b) => {
    const ra = AXIS_ROLES.indexOf(roleOf(machine, a) as (typeof AXIS_ROLES)[number]);
    const rb = AXIS_ROLES.indexOf(roleOf(machine, b) as (typeof AXIS_ROLES)[number]);
    return (ra < 0 ? 9 : ra) - (rb < 0 ? 9 : rb) || a.localeCompare(b);
  });
  const mandrel = machine.mandrel.letter.toUpperCase();
  const rows = letters.map((L) => {
    const [lo, hi] = v.ranges[L];
    const role = roleOf(machine, L);
    const ax = role ? machine[role as (typeof AXIS_ROLES)[number]] : null;
    return {
      L,
      lo,
      hi,
      role,
      ax,
      below: ax?.min != null && lo < ax.min - 1e-6,
      above: ax?.max != null && hi > ax.max + 1e-6,
    };
  });
  return (
    <div className={`card verify-card ${ok ? 'v-ok' : 'v-bad'}`} role="status">
      <div className="card-title verify-title">
        <span className={`status-icon s-${ok ? 'ok' : v.errors.length ? 'fail' : 'warn'}`} aria-hidden="true">
          <Icon name={ok ? 'check' : 'alert'} size={12} strokeWidth={2.6} />
        </span>
        {ok ? 'Verified' : v.errors.length ? 'Verification found problems' : 'Verified with a time mismatch'}
      </div>
      <div className="muted small">
        Independent re-interpretation of the program (G92 offsets, G93 inverse time): {v.moves.toLocaleString()} feed
        moves, {v.rapids} rapids, {v.pauses} pauses · interpreted {fmtDuration(v.interpreted_time)}{' '}
        {v.time_matches ? '= estimate' : `≠ estimate ${fmtDuration(r.total_time)}`}
      </div>
      <table className="data-table compact verify-table">
        <thead>
          <tr>
            <th>Axis</th>
            <th className="num" title="Physical position range [machine units]">
              Min
            </th>
            <th className="num">Max</th>
            <th className="num" title="Largest change in one feed move [machine units]">
              Max step
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ L, lo, hi, role, ax, below, above }) => {
            const lim =
              ax && (ax.min != null || ax.max != null)
                ? `soft limits ${ax.min ?? '−∞'} … ${ax.max ?? '∞'}`
                : 'no soft limits';
            return (
              <tr key={L}>
                <td>
                  <strong>{L}</strong> <span className="muted">{ROLE_LABEL[role] ?? ''}</span>
                </td>
                <td className={`num ${below ? 'bad' : ''}`} title={lim}>
                  {sig(lo, 6)}
                </td>
                <td className={`num ${above ? 'bad' : ''}`} title={lim}>
                  {sig(hi, 6)}
                </td>
                <td className="num" title={L === mandrel ? 'Largest mandrel increment per feed move' : undefined}>
                  {sig(v.max_step[L] ?? 0, 4)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows
        .filter((r) => r.below || r.above)
        .map((r) => (
          <div key={r.L} className="verify-limit">
            <Icon name="alert" size={12} /> {r.L} ({ROLE_LABEL[r.role]}) leaves its soft limits {r.ax?.min ?? '−∞'} …{' '}
            {r.ax?.max ?? '∞'}
          </div>
        ))}
      {v.errors.length ? (
        <ul className="verify-errors">
          {v.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type BpX = 'line' | 'time';
const BP_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-7)'];

function Backplot({ r }: { r: GcodeResponse }) {
  const s = useExport();
  const { project } = useProject();
  const [xMode, setXMode] = useState<BpX>('line');
  const bp = s.backplotFor === r ? s.backplot : null;
  const machine = (s.gcodeFor ?? project).machine;
  // time axis in s / min / h depending on the program length
  const tUnit = !bp || bp.totalTime < 600 ? 's' : bp.totalTime < 5 * 3600 ? 'min' : 'h';
  const tDiv = tUnit === 's' ? 1 : tUnit === 'min' ? 60 : 3600;
  const charts = useMemo(() => {
    if (!bp) return null;
    return bp.series.map((sr, k) => {
      const d = xMode === 'line' ? sr.byLine : sr.byTime;
      const div = xMode === 'line' ? 1 : tDiv;
      const series: Series[] = [
        {
          id: sr.letter,
          name: `${ROLE_LABEL[sr.role] ?? sr.role} ${sr.letter}`,
          x: Array.from(d.x, (v) => v / div),
          y: Array.from(d.y),
          color: BP_COLORS[k % BP_COLORS.length],
          width: 1.25,
        },
      ];
      return { sr, series };
    });
  }, [bp, xMode, tDiv]);
  const vlines: RefLine[] = useMemo(() => {
    if (!bp) return [];
    const xs = bp.layers.map((l) => (xMode === 'line' ? l.line : l.time / tDiv));
    const span = (xMode === 'line' ? bp.lines : bp.totalTime / tDiv) || 1;
    // label a layer marker only when it is far enough from the previous labelled one
    let lastLabelled = -Infinity;
    return bp.layers.map((l, i) => {
      const room = (xs[i] - lastLabelled) / span > 0.15;
      if (room) lastLabelled = xs[i];
      return { value: xs[i], label: room ? l.label : undefined, color: 'var(--axis)' };
    });
  }, [bp, xMode, tDiv]);
  if (s.backplotFor !== r || (!bp && s.backplotProgress == null && !s.backplotError))
    return (
      <Empty>
        <Button size="sm" icon="play" onClick={() => runBackplot(r, machine)}>
          Plot the program
        </Button>
      </Empty>
    );
  if (s.backplotError) return <Banner kind="fail">Backplot failed: {s.backplotError}</Banner>;
  if (!bp || !charts)
    return (
      <div className="empty" role="status">
        <Spinner /> Parsing {r.lines.toLocaleString()} lines… {Math.round((s.backplotProgress ?? 0) * 100)} %
      </div>
    );
  const unitOf = (role: string) =>
    role === 'mandrel' || role === 'eye'
      ? machine[role as 'mandrel' | 'eye']?.scale === 1
        ? '°'
        : 'units'
      : machine[role as 'carriage' | 'crossfeed']?.scale === 1
        ? 'mm'
        : 'units';
  return (
    <div className="backplot">
      <div className="toolbar backplot-bar">
        <Segmented<BpX>
          size="sm"
          ariaLabel="Backplot x axis"
          value={xMode}
          options={[
            { value: 'line', label: 'vs line' },
            { value: 'time', label: 'vs time' },
          ]}
          onChange={setXMode}
        />
        <span className="muted small">
          Physical axis positions (programmed + G92 offsets) · {bp.moves.toLocaleString()} feed moves ·{' '}
          {bp.layers.length} layers · {bp.resets} G92 resets · est. {fmtTime(bp.totalTime)} incl. rapids · parsed in{' '}
          {sig(bp.parseMs / 1000, 2)} s
          {r.verification && Math.abs(bp.feedTime - r.verification.interpreted_time) > 1e-3 * Math.max(1, bp.feedTime)
            ? ` · feed time ${fmtDuration(bp.feedTime)} differs from the backend (${fmtDuration(r.verification.interpreted_time)})`
            : ''}
        </span>
      </div>
      <div className="bottom-grid backplot-grid">
        {charts.map(({ sr, series }) => (
          <LineChart
            key={sr.letter}
            title={`${ROLE_LABEL[sr.role] ?? sr.role} ${sr.letter} · ${sig(sr.min, 5)} … ${sig(sr.max, 5)}`}
            series={series}
            vlines={vlines}
            xLabel={xMode === 'line' ? 'Line' : 't'}
            xUnit={xMode === 'line' ? undefined : tUnit}
            xFormat={xMode === 'line' ? (x) => Math.round(x).toLocaleString() : undefined}
            yLabel={sr.letter}
            yUnit={unitOf(sr.role)}
            height={170}
          />
        ))}
      </div>
    </div>
  );
}

export function ExportBottom() {
  const s = useExport();
  return (
    <div className="export-bottom">
      <div className="tabs" role="tablist" aria-label="Export output">
        <button
          type="button"
          role="tab"
          aria-selected={s.tab === 'gcode'}
          className={s.tab === 'gcode' ? 'on' : ''}
          onClick={() => store.set({ tab: 'gcode' })}
        >
          G-code preview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={s.tab === 'backplot'}
          className={s.tab === 'backplot' ? 'on' : ''}
          onClick={() => store.set({ tab: 'backplot' })}
        >
          Backplot
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={s.tab === 'traveller'}
          className={s.tab === 'traveller' ? 'on' : ''}
          onClick={() => store.set({ tab: 'traveller' })}
        >
          Traveller
        </button>
      </div>
      <div className="tab-body" role="tabpanel">
        {s.tab === 'gcode' ? (
          s.gcode ? (
            <GcodeViewer r={s.gcode} />
          ) : (
            <Empty>{s.gcodeBusy ? 'Generating…' : 'Generate G-code to preview the first 300 lines.'}</Empty>
          )
        ) : s.tab === 'backplot' ? (
          s.gcode ? (
            <Backplot r={s.gcode} />
          ) : (
            <Empty>{s.gcodeBusy ? 'Generating…' : 'Generate G-code to plot the axis motion.'}</Empty>
          )
        ) : s.traveller ? (
          <TravellerViewer r={s.traveller} />
        ) : (
          <Empty>{s.travellerBusy ? 'Generating…' : 'Generate the traveller to preview and print it.'}</Empty>
        )}
      </div>
    </div>
  );
}
