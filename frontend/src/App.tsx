import { useEffect } from 'react';
import { Stepper } from './components/Stepper';
import { TopBar } from './components/TopBar';
import { Banner, Button, Spinner } from './components/ui';
import { useAnalysis, useCatalog } from './state/analysis';
import { useProject } from './state/projectStore';
import { STEPS, useUi } from './state/uiStore';
import { STEP_VIEWS } from './steps';
import { Viewport } from './viewer/Viewport';

export function App() {
  const { step, setStep, setThk } = useUi();
  const { revision } = useProject();
  const { error, stale, loading, retry, result } = useAnalysis();
  const catalog = useCatalog();
  const view = STEP_VIEWS[step];
  const meta = STEPS.find((s) => s.id === step)!;

  // A loaded / new project invalidates the thickness map (it is not recomputed on edits).
  useEffect(() => setThk(null), [revision, setThk]);

  // Alt+1..8 switches workflow steps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number(e.key);
      const s = STEPS.find((x) => x.n === n);
      if (s) {
        e.preventDefault();
        setStep(s.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setStep]);

  const Panel = view.Panel;
  const Bottom = view.Bottom;

  return (
    <div className="app">
      <TopBar />
      <Stepper />
      <main className="center">
        <div className="banners">
          {catalog.error ? (
            <Banner
              kind="warn"
              action={
                <Button size="sm" onClick={catalog.reload}>
                  Retry
                </Button>
              }
            >
              Could not load reference data — {catalog.error}
            </Banner>
          ) : null}
          {error ? (
            <Banner
              kind="fail"
              action={
                <Button size="sm" onClick={retry}>
                  Retry
                </Button>
              }
            >
              <strong>Analysis failed:</strong> {error}
              {result && stale ? <span className="muted"> — showing the last valid result.</span> : null}
            </Banner>
          ) : null}
        </div>
        <div className={`center-split ${Bottom ? 'with-bottom' : ''} ${view.bottomTall ? 'tall' : ''}`}>
          <Viewport />
          {Bottom ? (
            <section className="bottom" aria-label={`${meta.label} charts`}>
              <Bottom />
            </section>
          ) : null}
        </div>
      </main>
      <aside className="panel" aria-label={`${meta.label} properties`}>
        <header className="panel-head">
          <span className="panel-step">{meta.n}</span>
          <h1>{meta.label}</h1>
          {loading ? <Spinner size={12} label="Analysing" /> : null}
        </header>
        <div className="panel-body">
          <Panel />
        </div>
      </aside>
    </div>
  );
}
