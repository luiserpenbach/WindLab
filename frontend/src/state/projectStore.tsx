import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import type { Project } from '../api/types';
import { defaultProject, normalizeProject } from './defaults';

const STORAGE_KEY = 'windlab.project.v1';
const HISTORY_LIMIT = 200;
/** Edits with the same coalesce key within this window merge into one undo step. */
const COALESCE_MS = 1000;

interface State {
  project: Project;
  past: Project[];
  future: Project[];
  lastKey: string | null;
  lastTime: number;
  /** Increments on every load/replace so views can reset local state. */
  revision: number;
}

type Action =
  | { type: 'update'; fn: (p: Project) => Project; key?: string; time: number }
  | { type: 'load'; project: Project }
  | { type: 'undo' }
  | { type: 'redo' };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'update': {
      const next = a.fn(s.project);
      if (next === s.project) return s;
      const coalesce = a.key != null && a.key === s.lastKey && a.time - s.lastTime < COALESCE_MS;
      return {
        ...s,
        project: next,
        past: coalesce ? s.past : [...s.past, s.project].slice(-HISTORY_LIMIT),
        future: [],
        lastKey: a.key ?? null,
        lastTime: a.time,
      };
    }
    case 'load':
      return {
        project: a.project,
        past: [...s.past, s.project].slice(-HISTORY_LIMIT),
        future: [],
        lastKey: null,
        lastTime: 0,
        revision: s.revision + 1,
      };
    case 'undo': {
      if (!s.past.length) return s;
      const prev = s.past[s.past.length - 1];
      return {
        ...s,
        project: prev,
        past: s.past.slice(0, -1),
        future: [s.project, ...s.future],
        lastKey: null,
      };
    }
    case 'redo': {
      if (!s.future.length) return s;
      const [next, ...rest] = s.future;
      return { ...s, project: next, past: [...s.past, s.project], future: rest, lastKey: null };
    }
  }
}

function loadInitial(): State {
  let project = defaultProject();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) project = normalizeProject(JSON.parse(raw));
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return { project, past: [], future: [], lastKey: null, lastTime: 0, revision: 0 };
}

export interface ProjectStore {
  project: Project;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Apply an immutable update. Passing a `key` merges consecutive edits of the
   * same field (e.g. slider drags) into a single undo step.
   */
  update: (fn: (p: Project) => Project, key?: string) => void;
  load: (p: Project) => void;
  undo: () => void;
  redo: () => void;
}

const Ctx = createContext<ProjectStore | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadInitial);

  const update = useCallback(
    (fn: (p: Project) => Project, key?: string) =>
      dispatch({ type: 'update', fn, key, time: Date.now() }),
    [],
  );
  const load = useCallback((p: Project) => dispatch({ type: 'load', project: p }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);

  // Autosave (debounced) to localStorage.
  useEffect(() => {
    const h = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.project));
      } catch {
        /* quota / private mode: ignore */
      }
    }, 300);
    return () => window.clearTimeout(h);
  }, [state.project]);

  // Global undo / redo shortcuts. Text fields keep their native undo while focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text' && !t.dataset.numeric))) {
        return;
      }
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const value = useMemo<ProjectStore>(
    () => ({
      project: state.project,
      revision: state.revision,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
      update,
      load,
      undo,
      redo,
    }),
    [state.project, state.revision, state.past.length, state.future.length, update, load, undo, redo],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProject(): ProjectStore {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProject outside ProjectProvider');
  return v;
}

/** Typed helpers for patching one section of the project. */
export function patchSection<K extends 'liner' | 'requirements' | 'composite' | 'machine'>(
  section: K,
  patch: Partial<Project[K]>,
): (p: Project) => Project {
  return (p) => ({ ...p, [section]: { ...(p[section] as object), ...patch } });
}
