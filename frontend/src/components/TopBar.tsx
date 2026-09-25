import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { ProjectListEntry } from '../api/types';
import { useAnalysis, useCatalog, worstStatus } from '../state/analysis';
import { defaultProject, normalizeProject } from '../state/defaults';
import { useProject } from '../state/projectStore';
import { useUi } from '../state/uiStore';
import { downloadText, safeFilename } from '../util/format';
import { TextInput } from './fields';
import { Icon } from './Icon';
import { Banner, Button, Modal, Spinner, StatusPill } from './ui';

function fmtModified(m: string | number): string {
  const d = typeof m === 'number' ? new Date(m < 1e12 ? m * 1000 : m) : new Date(m);
  return Number.isNaN(d.getTime()) ? String(m) : d.toLocaleString();
}

export function TopBar() {
  const { project, update, load, undo, redo, canUndo, canRedo } = useProject();
  const { result, loading } = useAnalysis();
  const { examples } = useCatalog();
  const { resolvedTheme, cycleTheme } = useUi();
  const [openDlg, setOpenDlg] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'fail'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const flashTimer = useRef(0);

  const say = (kind: 'ok' | 'fail', text: string) => {
    setFlash({ kind, text });
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), kind === 'ok' ? 2500 : 6000);
  };

  const overall = result ? worstStatus(result.checks) : null;
  const nFail = result?.checks.filter((c) => c.status === 'fail').length ?? 0;
  const nWarn = result?.checks.filter((c) => c.status === 'warn').length ?? 0;

  const save = async () => {
    const name = project.name.trim();
    if (!name) {
      say('fail', 'Give the project a name before saving');
      return;
    }
    setSaving(true);
    try {
      await api.saveProject(name, project);
      say('ok', `Saved “${name}” to server`);
    } catch (e) {
      say('fail', `Save failed: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  // Ctrl+S saves to the server.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <header className="topbar">
      <div className="brand" aria-label="WindLab">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="var(--accent)" />
          <path d="M6 16c0-4 3-6 6-6h8c3 0 6 2 6 6s-3 6-6 6h-8c-3 0-6-2-6-6z" fill="none" stroke="#fff" strokeWidth="2" />
          <path d="M11 10l10 12M21 10L11 22" stroke="#cfe3ff" strokeWidth="1.6" />
        </svg>
        <span>WindLab</span>
      </div>
      <div className="project-name">
        <TextInput
          value={project.name}
          ariaLabel="Project name"
          onCommit={(v) => update((p) => ({ ...p, name: v }), 'name')}
        />
      </div>
      <nav className="topbar-actions" aria-label="Project">
        <Button icon="file" size="sm" onClick={() => setConfirmNew(true)} title="New project">
          New
        </Button>
        <Button icon="folder" size="sm" onClick={() => setOpenDlg(true)} title="Open a project from the server or a JSON file">
          Open
        </Button>
        <Button icon="save" size="sm" onClick={save} disabled={saving} title="Save to server (Ctrl+S)">
          Save
        </Button>
        <Button
          icon="download"
          size="sm"
          title="Download the project as JSON"
          onClick={() => downloadText(`${safeFilename(project.name)}.json`, JSON.stringify(project, null, 2), 'application/json')}
        >
          Export
        </Button>
        <span className="sep" />
        <select
          className="select select-sm"
          aria-label="Load example project"
          value=""
          onChange={(e) => {
            const ex = examples.find((x) => x.id === e.target.value);
            if (!ex) return;
            if (window.confirm(`Replace the current project with the example “${ex.label}”? (Undo with Ctrl+Z)`)) {
              load(normalizeProject(ex.project));
              say('ok', `Loaded example “${ex.label}”`);
            }
          }}
        >
          <option value="" disabled>
            Examples…
          </option>
          {examples.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        <span className="sep" />
        <Button icon="undo" size="sm" variant="ghost" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo" />
        <Button icon="redo" size="sm" variant="ghost" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo" />
      </nav>
      <div className="topbar-right">
        {flash ? (
          <span className={`flash f-${flash.kind}`} role="status">
            {flash.text}
          </span>
        ) : null}
        {loading ? <Spinner size={12} label="Analysing" /> : null}
        <span title={result ? `${nFail} failing, ${nWarn} warning checks` : 'No analysis yet'}>
          <StatusPill status={overall}>
            {overall === 'fail'
              ? `${nFail} fail`
              : overall === 'warn'
                ? `${nWarn} warning${nWarn === 1 ? '' : 's'}`
                : overall
                  ? 'All checks OK'
                  : 'Not analysed'}
          </StatusPill>
        </span>
        <Button
          icon={resolvedTheme === 'dark' ? 'sun' : 'moon'}
          size="sm"
          variant="ghost"
          onClick={cycleTheme}
          title={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`}
          aria-label="Toggle theme"
        />
      </div>

      <Modal
        title="New project"
        open={confirmNew}
        onClose={() => setConfirmNew(false)}
        footer={
          <>
            <Button onClick={() => setConfirmNew(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                load(defaultProject());
                setConfirmNew(false);
              }}
            >
              Create
            </Button>
          </>
        }
      >
        <p>Start a new project with default liner, materials, a two-layer layup and the default machine? The current project can be restored with Undo.</p>
      </Modal>

      <OpenDialog
        open={openDlg}
        onClose={() => setOpenDlg(false)}
        onLoaded={(name) => {
          setOpenDlg(false);
          say('ok', `Opened “${name}”`);
        }}
      />
    </header>
  );
}

function OpenDialog({ open, onClose, onLoaded }: { open: boolean; onClose: () => void; onLoaded: (name: string) => void }) {
  const { load } = useProject();
  const [list, setList] = useState<ProjectListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    setError(null);
    setList(null);
    api.listProjects().then(
      (l) => setList([...l].sort((a, b) => String(b.modified).localeCompare(String(a.modified)))),
      (e) => {
        setError(errorMessage(e));
        setList([]);
      },
    );
  };

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const openServer = async (name: string) => {
    setBusy(true);
    try {
      const p = await api.getProject(name);
      load(normalizeProject(p));
      onLoaded(name);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Delete “${name}” from the server? This cannot be undone.`)) return;
    try {
      await api.deleteProject(name);
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const importFile = async (f: File) => {
    try {
      const text = await f.text();
      const p = normalizeProject(JSON.parse(text));
      load(p);
      onLoaded(p.name || f.name);
    } catch (e) {
      setError(`Could not import ${f.name}: ${errorMessage(e)}`);
    }
  };

  return (
    <Modal
      title="Open project"
      open={open}
      onClose={onClose}
      footer={
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = '';
            }}
          />
          <Button icon="upload" onClick={() => fileRef.current?.click()}>
            Import JSON file…
          </Button>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {error ? <Banner kind="fail">{error}</Banner> : null}
      <div className="open-list-head">
        <span>Projects on the server</span>
        <Button size="sm" variant="ghost" icon="refresh" aria-label="Refresh" onClick={refresh} />
      </div>
      {list == null ? (
        <div className="empty">
          <Spinner /> Loading…
        </div>
      ) : list.length === 0 ? (
        <div className="empty">No saved projects on the server.</div>
      ) : (
        <ul className="open-list">
          {list.map((p) => (
            <li key={p.name}>
              <button type="button" className="open-item" disabled={busy} onClick={() => openServer(p.name)}>
                <Icon name="file" />
                <span className="open-name">{p.name}</span>
                <span className="open-date">{fmtModified(p.modified)}</span>
              </button>
              <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete ${p.name}`} onClick={() => remove(p.name)} />
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
