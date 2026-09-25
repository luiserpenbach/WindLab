import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PathResult, SimulationResult, ThicknessMapResult } from '../api/types';
import type { PathColorMode } from '../viewer/colormaps';

export type StepId = 'vessel' | 'materials' | 'layup' | 'thickness' | 'analysis' | 'machine' | 'simulate' | 'export';

export const STEPS: { id: StepId; n: number; label: string }[] = [
  { id: 'vessel', n: 1, label: 'Vessel' },
  { id: 'materials', n: 2, label: 'Materials' },
  { id: 'layup', n: 3, label: 'Layup' },
  { id: 'thickness', n: 4, label: 'Thickness' },
  { id: 'analysis', n: 5, label: 'Analysis' },
  { id: 'machine', n: 6, label: 'Machine' },
  { id: 'simulate', n: 7, label: 'Simulate' },
  { id: 'export', n: 8, label: 'Export' },
];

export type ThemePref = 'system' | 'light' | 'dark';

export interface ViewOptions {
  section: boolean;
  showLayers: boolean;
  showGrid: boolean;
}

/** Shell-FE quantity painted on the outer vessel surface (Analysis step). */
export type FeOverlay = 'none' | 'fiber' | 'liner';
/**
 * Thickness colour-scale upper end: twice the nominal thickness (nominal sits
 * mid-scale), the 99.5th percentile, or the full maximum.
 */
export type ThkScale = 'nominal' | 'robust' | 'full';

export interface OverlayOptions {
  /** Thickness step: paint the thickness map on the layer surface. */
  thk3d: boolean;
  thkScale: ThkScale;
  /** Analysis step: FE colouring of the outer surface. */
  fe: FeOverlay;
  /** Analysis step: exaggerated deformed shape at MEOP. */
  deform: boolean;
  /** Displacement magnification. */
  deformScale: number;
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
  /** Last band-level thickness map (Thickness step). */
  thk: ThicknessMapResult | null;
  setThk: (t: ThicknessMapResult | null) => void;
  overlay: OverlayOptions;
  setOverlay: (patch: Partial<OverlayOptions>) => void;
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
  const [thk, setThk] = useState<ThicknessMapResult | null>(null);
  const [overlay, setOverlayState] = useState<OverlayOptions>(() => ({
    thk3d: true,
    thkScale: readLS('windlab.thkScale', ['nominal', 'robust', 'full'] as const, 'nominal'),
    fe: readLS('windlab.feOverlay', ['none', 'fiber', 'liner'] as const, 'none'),
    deform: false,
    deformScale: 100,
  }));

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
  const setOverlay = useCallback((patch: Partial<OverlayOptions>) => {
    if (patch.fe) writeLS('windlab.feOverlay', patch.fe);
    if (patch.thkScale) writeLS('windlab.thkScale', patch.thkScale);
    setOverlayState((o) => ({ ...o, ...patch }));
  }, []);

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
      thk,
      setThk,
      overlay,
      setOverlay,
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
      thk,
      overlay,
      setOverlay,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUi(): UiState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUi outside UiProvider');
  return v;
}
