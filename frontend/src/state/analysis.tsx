import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage, isAbort } from '../api/client';
import type {
  AnalysisResult,
  Project,
  Check,
  ExampleProject,
  MachinePreset,
  MaterialsResponse,
  Status,
} from '../api/types';
import { useProject } from './projectStore';

// ------------------------------------------------------------------ analysis
interface AnalysisState {
  /** Last successful result (kept while a newer request fails). */
  result: AnalysisResult | null;
  /** The project `result` was computed from (geometry must match the result). */
  resultProject: Project | null;
  loading: boolean;
  error: string | null;
  /** True when `result` was computed from an older project than the current one. */
  stale: boolean;
  retry: () => void;
}

const AnalysisCtx = createContext<AnalysisState | null>(null);
const DEBOUNCE_MS = 400;

export function AnalysisProvider({ children }: { children: ReactNode }) {
  const { project } = useProject();
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [resultProject, setResultProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [nonce, setNonce] = useState(0);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    setStale(true);
    const h = window.setTimeout(() => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      api
        .analyze(project, c.signal)
        .then((r) => {
          if (c.signal.aborted) return;
          setResult(r);
          setResultProject(project);
          setError(null);
          setStale(false);
        })
        .catch((e) => {
          if (isAbort(e) || c.signal.aborted) return;
          setError(errorMessage(e));
        })
        .finally(() => {
          if (ctrl.current === c) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [project, nonce]);

  useEffect(() => () => ctrl.current?.abort(), []);

  const value = useMemo<AnalysisState>(
    () => ({ result, resultProject, loading, error, stale, retry: () => setNonce((n) => n + 1) }),
    [result, resultProject, loading, error, stale],
  );
  return <AnalysisCtx.Provider value={value}>{children}</AnalysisCtx.Provider>;
}

export function useAnalysis(): AnalysisState {
  const v = useContext(AnalysisCtx);
  if (!v) throw new Error('useAnalysis outside AnalysisProvider');
  return v;
}

// ------------------------------------------------------------------ status helpers
const RANK: Record<Status, number> = { info: 0, ok: 1, warn: 2, fail: 3 };

export function worstStatus(checks: Check[] | Status[]): Status | null {
  let worst: Status | null = null;
  for (const c of checks) {
    const s = typeof c === 'string' ? c : c.status;
    if (worst === null || RANK[s] > RANK[worst]) worst = s;
  }
  return worst;
}

// ------------------------------------------------------------------ catalog
interface CatalogState {
  materials: MaterialsResponse | null;
  machines: MachinePreset[];
  examples: ExampleProject[];
  /** Examples take a few seconds the first time (backend sizes the layups). */
  examplesLoading: boolean;
  error: string | null;
  reload: () => void;
}
const CatalogCtx = createContext<CatalogState | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const [materials, setMaterials] = useState<MaterialsResponse | null>(null);
  const [machines, setMachines] = useState<MachinePreset[]>([]);
  const [examples, setExamples] = useState<ExampleProject[]>([]);
  const [examplesLoading, setExamplesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const c = new AbortController();
    setExamplesLoading(true);
    const errs: string[] = [];
    const note = (what: string) => (e: unknown) => {
      if (isAbort(e)) return;
      errs.push(`${what}: ${errorMessage(e)}`);
      setError(errs.join(' · '));
    };
    setError(null);
    api.materials(c.signal).then(setMaterials, note('materials'));
    api.machines(c.signal).then(setMachines, note('machines'));
    api
      .examples(c.signal)
      .then(setExamples, note('examples'))
      .finally(() => {
        if (!c.signal.aborted) setExamplesLoading(false);
      });
    return () => c.abort();
  }, [nonce]);

  const value = useMemo<CatalogState>(
    () => ({ materials, machines, examples, examplesLoading, error, reload: () => setNonce((n) => n + 1) }),
    [materials, machines, examples, examplesLoading, error],
  );
  return <CatalogCtx.Provider value={value}>{children}</CatalogCtx.Provider>;
}

export function useCatalog(): CatalogState {
  const v = useContext(CatalogCtx);
  if (!v) throw new Error('useCatalog outside CatalogProvider');
  return v;
}
