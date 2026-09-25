import { useAnalysis } from '../state/analysis';
import { STEPS, useUi } from '../state/uiStore';
import { stepStatus } from '../steps/stepStatus';
import { StatusDot } from './ui';

export function Stepper() {
  const { step, setStep, sim } = useUi();
  const { result } = useAnalysis();
  return (
    <nav className="stepper" aria-label="Workflow">
      <ol>
        {STEPS.map((s) => {
          const st = stepStatus(s.id, result, sim);
          return (
            <li key={s.id}>
              <button
                type="button"
                className={`step ${s.id === step ? 'active' : ''}`}
                aria-current={s.id === step ? 'step' : undefined}
                onClick={() => setStep(s.id)}
                title={`${s.n}. ${s.label} (Alt+${s.n})`}
              >
                <span className="step-n">{s.n}</span>
                <span className="step-label">{s.label}</span>
                <StatusDot status={st} />
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
