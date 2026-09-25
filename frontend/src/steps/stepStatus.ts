import type { AnalysisResult, Check, SimulationResult, Status } from '../api/types';
import type { StepId } from '../state/uiStore';
import { worstStatus } from '../state/analysis';

/**
 * Check ids are not enumerated in the API contract, so checks are routed to
 * workflow steps by keyword. Unmatched checks count towards "analysis".
 */
const ROUTES: [StepId, RegExp][] = [
  ['machine', /machine|axis|axes|carriage|crossfeed|mandrel|eye|velocity|accel|travel|soft.?limit|clearance/i],
  ['materials', /material|fib(re|er)_?(type|id)|resin|vf|volume.?fraction|translation/i],
  ['layup', /layer|layup|pattern|coverage|turnaround|dwell|band|hoop_?(pass|drop)|slip|friction|geodesic/i],
  ['vessel', /liner|geometry|dome|boss|opening|wall|shaft/i],
];

export function stepOfCheck(c: Check): StepId {
  const key = `${c.id} ${c.label}`;
  for (const [step, re] of ROUTES) if (re.test(key)) return step;
  return 'analysis';
}

export function checksForStep(checks: Check[], step: StepId): Check[] {
  return checks.filter((c) => stepOfCheck(c) === step);
}

export function stepStatus(
  step: StepId,
  result: AnalysisResult | null,
  sim: SimulationResult | null,
): Status | null {
  if (!result) return null;
  const checks = result.checks;
  switch (step) {
    case 'vessel':
    case 'materials':
    case 'machine': {
      const s = worstStatus(checksForStep(checks, step));
      return s ?? 'ok';
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
