import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PathResult, SimulationResult } from '../api/types';
import type { PathColorMode } from '../viewer/colormaps';

export type StepId = 'vessel' | 'materials' | 'layup' | 'analysis' | 'machine' | 'simulate' | 'export';

export const STEPS: { id: StepId; n: number; label: string }[] = [
  { id: 'vessel', n: 1, label: 'Vessel' },
  { id: 'materials', n: 2, label: 'Materials' },
  { id: 'layup', n: 3, label: 'Layup' },
  { id: 'analysis', n: 4, label: 'Analysis' },
  { id: 'machine', n: 5, label: 'Machine' },
  { id: 'simulate', n: 6, label: 'Simulate' },
  { id: 'export', n: 7, label: 'Export' },
];

export type ThemePref = 'system' | 'light' | 'dark';

export interface ViewOptions {
  section: boolean;
  showLayers: boolean;
  showGrid: boolean;
}

interface UiState {
  step: StepId;
  setStep: (s: StepId) => void;
  selectedLayerId: string | null;
  setSelectedLayerId: (id: string | null) => void;
  theme: ThemePref;
  resolvedTheme: 'light' | 'dark';
  cycleTheme: () => void;
  view: ViewOptions;
  setView: (patch: Partial<ViewOptions>) => void;
  /** Fibre path / simulation shown in the 3D viewport (Simulate step). */
  path: PathResult | null;
  setPath: (p: PathResult | null) => void;
  sim: SimulationResult | null;
  setSim: (s: SimulationResult | null) => void;
  /** How the fibre path is coloured in the 3D view. */
  pathColor: PathColorMode;
  setPathColor: (m: PathColorMode) => void;
}

const Ctx = createContext<UiState | null>(null);

function readLS<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* ignore */
  }
  return fallback;
}
function writeLS(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [step, setStepState] = useState<StepId>(() =>
    readLS(
      'windlab.step',
      STEPS.map((s) => s.id),
      'vessel',
    ),
  );
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>(() =>
    readLS('windlab.theme', ['system', 'light', 'dark'] as const, 'system'),
  );
  const [sysDark, setSysDark] = useState(systemDark);
  const [view, setViewState] = useState<ViewOptions>({ section: false, showLayers: true, showGrid: true });
  const [path, setPath] = useState<PathResult | null>(null);
  const [sim, setSim] = useState<SimulationResult | null>(null);
  const [pathColor, setPathColorState] = useState<PathColorMode>(() =>
    readLS('windlab.pathColor', ['layer', 'alpha', 'slip'] as const, 'layer'),
  );

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => setSysDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const resolvedTheme: 'light' | 'dark' = theme === 'system' ? (sysDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    writeLS('windlab.theme', theme);
  }, [theme]);

  const setStep = useCallback((s: StepId) => {
    setStepState(s);
    writeLS('windlab.step', s);
  }, []);
  const cycleTheme = useCallback(
    () => setTheme((t) => (t === 'system' ? (systemDark() ? 'light' : 'dark') : t === 'dark' ? 'light' : 'dark')),
    [],
  );
  const setPathColor = useCallback((m: PathColorMode) => {
    setPathColorState(m);
    writeLS('windlab.pathColor', m);
  }, []);
  const setView = useCallback((patch: Partial<ViewOptions>) => setViewState((v) => ({ ...v, ...patch })), []);

  const value = useMemo<UiState>(
    () => ({
      step,
      setStep,
      selectedLayerId,
      setSelectedLayerId,
      theme,
      resolvedTheme,
      cycleTheme,
      view,
      setView,
      path,
      setPath,
      sim,
      setSim,
      pathColor,
      setPathColor,
    }),
    [
      step,
      setStep,
      selectedLayerId,
      theme,
      resolvedTheme,
      cycleTheme,
      view,
      setView,
      path,
      sim,
      pathColor,
      setPathColor,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUi(): UiState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUi outside UiProvider');
  return v;
}
