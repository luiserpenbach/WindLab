import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, errorMessage } from '../api/client';
import type { GcodeResponse, Project, TravellerResponse } from '../api/types';
import { Field, Section, Segmented } from '../components/fields';
import { Banner, Button, Empty, Kpi, Spinner, WarningList } from '../components/ui';
import { useProject } from '../state/projectStore';
import { downloadText, fmtDuration, safeFilename } from '../util/format';

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
  tab: 'gcode' | 'traveller';
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

// ------------------------------------------------------------------ panel
export function ExportPanel() {
  const { project } = useProject();
  const s = useExport();
  const [mode, setMode] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const ids = project.layers.map((l) => l.id);
  const selIds = mode === 'all' ? null : ids.filter((id) => picked.has(id));

  const genGcode = async () => {
    store.set({ gcodeBusy: true, gcodeError: null, tab: 'gcode' });
    try {
      const r = await api.gcode(project, selIds);
      store.set({ gcode: r, gcodeFor: project, gcodeBusy: false });
    } catch (e) {
      store.set({ gcodeError: errorMessage(e), gcodeBusy: false });
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

  return (
    <>
      <Section title="G-code">
        <Field
          label="Controller"
          hint={`Output for ${project.machine.controller === 'grbl' ? 'GRBL (.gcode)' : 'LinuxCNC (.ngc)'} — change in step 5`}
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
        ) : s.traveller ? (
          <TravellerViewer r={s.traveller} />
        ) : (
          <Empty>{s.travellerBusy ? 'Generating…' : 'Generate the traveller to preview and print it.'}</Empty>
        )}
      </div>
    </div>
  );
}
