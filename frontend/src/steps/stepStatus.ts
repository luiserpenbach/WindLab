import type { AnalysisResult, Check, SimulationResult, Status, ThicknessMapResult } from '../api/types';
import type { StepId } from '../state/uiStore';
import { worstStatus } from '../state/analysis';

/**
 * Check ids are namespaced by the backend (core/design.py): `geo.*`,
 * `layer.<id>[.slip|.path]`, `layup.*` (e.g. `layup.bridging`), `tension.*`,
 * `burst*`, `sr.*` (incl. `sr.temp`, `sr.reliability`), `af.*`, `liner.*` (incl. `liner.temp`, `liner.lbb`;
 * Type IV: `liner.strain`, `liner.cure`, `liner.service_temp`, `liner.permeation`, and `liner.support`,
 * which is routed to the layup),
 * `fatigue`, `dome.*`, `fe.*` (shell FE). Checks also carry `refs` (layer ids);
 * their rows link to those layers.
 * Known prefixes are routed explicitly; anything else falls back to keyword
 * matching, then to "analysis".
 */
const PREFIX: [StepId, RegExp][] = [
  // Type IV: internal support pressure against the winding tension (set per layer).
  ['layup', /^liner\.support$/],
  ['vessel', /^(geo|liner|af|fatigue)(\.|$)/],
  ['layup', /^(layer|layup|dome|pattern|tension)(\.|$)/],
  ['materials', /^(mat|material|composite)(\.|$)/],
  ['machine', /^(machine|mach|axis|kin)(\.|$)/],
  ['analysis', /^(burst|sr|mass|fe)(\.|$)/],
];
const KEYWORDS: [StepId, RegExp][] = [
  ['machine', /machine|axis|axes|carriage|crossfeed|velocity|accel|soft.?limit/i],
  ['materials', /material|resin|volume.?fraction|translation/i],
  ['layup', /layer|layup|pattern|coverage|turnaround|dwell|band/i],
  ['vessel', /liner|geometry|boss|opening|shaft/i],
];

export function stepOfCheck(c: Check): StepId {
  for (const [step, re] of PREFIX) if (re.test(c.id)) return step;
  const key = `${c.id} ${c.label}`;
  for (const [step, re] of KEYWORDS) if (re.test(key)) return step;
  return 'analysis';
}

export function checksForStep(checks: Check[], step: StepId): Check[] {
  return checks.filter((c) => stepOfCheck(c) === step);
}

/** Thresholds the backend uses for its thickness-map warnings. */
export const THK_GAP_WARN = 0.005;
export const THK_OVERLAP_WARN = 0.05;
export const THK_PEAK_WARN = 1.25;

/** Status of a band-level thickness map: warn on backend warnings or gaps/overlaps. */
export function thicknessStatus(t: ThicknessMapResult | null): Status | null {
  if (!t) return null;
  if (t.peak == null || t.t.some((row) => row.some((v) => v == null))) return 'warn';
  if (t.warnings.length) return 'warn';
  if (t.gap_fraction > THK_GAP_WARN || t.overlap_fraction > THK_OVERLAP_WARN) return 'warn';
  return 'ok';
}

export function stepStatus(
  step: StepId,
  result: AnalysisResult | null,
  sim: SimulationResult | null,
  thk: ThicknessMapResult | null = null,
): Status | null {
  if (!result) return null;
  const checks = result.checks;
  switch (step) {
    case 'vessel':
    case 'materials': {
      const s = worstStatus(checksForStep(checks, step));
      return s ?? 'ok';
    }
    case 'machine': {
      // /api/analyze has no machine checks today; machine limits come from the simulation.
      const statuses: Status[] = checksForStep(checks, 'machine').map((c) => c.status);
      if (sim && !sim.limits_ok) statuses.push('fail');
      return worstStatus(statuses) ?? (sim ? 'ok' : null);
    }
    case 'layup': {
      const statuses: Status[] = checksForStep(checks, 'layup').map((c) => c.status);
      if (!result.layers.length) statuses.push('warn');
      if (result.layers.some((l) => l.warnings.length)) statuses.push('warn');
      return worstStatus(statuses) ?? 'ok';
    }
    case 'thickness':
      return thicknessStatus(thk);
    case 'analysis':
      return worstStatus(checks) ?? (result.structural ? 'ok' : 'info');
    case 'simulate':
      if (!sim) return null;
      return !sim.limits_ok ? 'fail' : sim.warnings.length ? 'warn' : 'ok';
    case 'testing':
    case 'export':
      return null;
  }
}
