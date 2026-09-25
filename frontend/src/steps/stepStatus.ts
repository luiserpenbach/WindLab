import type { AnalysisResult, Check, SimulationResult, Status } from '../api/types';
import type { StepId } from '../state/uiStore';
import { worstStatus } from '../state/analysis';

/**
 * Check ids are namespaced by the backend (core/design.py): `geo.*`,
 * `layer.<id>`, `layup.*`, `burst*`, `sr.*`, `af.*`, `liner.*`, `fatigue`,
 * `dome.*`, `fe.*` (shell FE). Known prefixes are routed explicitly; anything else falls back to
 * keyword matching, then to "analysis".
 */
const PREFIX: [StepId, RegExp][] = [
  ['vessel', /^(geo|liner|af|fatigue)(\.|$)/],
  ['layup', /^(layer|layup|dome|pattern)(\.|$)/],
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

export function stepStatus(step: StepId, result: AnalysisResult | null, sim: SimulationResult | null): Status | null {
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
    case 'analysis':
      return worstStatus(checks) ?? (result.structural ? 'ok' : 'info');
    case 'simulate':
      if (!sim) return null;
      return !sim.limits_ok ? 'fail' : sim.warnings.length ? 'warn' : 'ok';
    case 'export':
      return null;
  }
}
