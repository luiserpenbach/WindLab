import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, isAbort } from '../api/client';
import type { Project, TensionScheduleResult } from '../api/types';
import { BarChart } from '../components/BarChart';
import { Field, NumberInput, Section } from '../components/fields';
import { Banner, Button, Spinner } from '../components/ui';
import { useProject } from '../state/projectStore';
import { useUi } from '../state/uiStore';
import { layerColors } from '../viewer/colors';
import { sig } from '../util/format';

const DEBOUNCE_MS = 400;
/** Recommended tensions are applied rounded to this step [N]. */
const ROUND_N = 0.1;

const round = (v: number) => Math.round(v / ROUND_N) * ROUND_N;

/**
 * Winding tension schedule (POST /api/tension-schedule): residual ply
 * prestress per layer with the current tensions vs a schedule that keeps it
 * uniform, and a one-step "apply" (undoable).
 */
export function TensionPanel() {
  const { project, update } = useProject();
  const { setSelectedLayerId } = useUi();
  const [target, setTarget] = useState<number | null>(null);
  const [maxFactor, setMaxFactor] = useState<number | null>(null);
  const [data, setData] = useState<{ project: Project; r: TensionScheduleResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const colors = layerColors(project.layers);

  useEffect(() => {
    if (!project.layers.length) {
      setData(null);
      return;
    }
    const h = window.setTimeout(() => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setBusy(true);
      api
        .tensionSchedule(
          {
            project,
            ...(target != null ? { target_tension: target } : {}),
            ...(maxFactor != null ? { max_factor: maxFactor } : {}),
          },
          c.signal,
        )
        .then((r) => {
          if (c.signal.aborted) return;
          setData({ project, r });
          setError(null);
        })
        .catch((e) => {
          if (!isAbort(e) && !c.signal.aborted) setError(errorMessage(e));
        })
        .finally(() => {
          if (ctrl.current === c) setBusy(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [project, target, maxFactor]);

  useEffect(() => () => ctrl.current?.abort(), []);

  const r = data?.r ?? null;
  // The schedule belongs to the current layup only if the layer ids still match.
  const valid =
    !!r && r.layer_ids.length === project.layers.length && r.layer_ids.every((id, i) => project.layers[i].id === id);
  const changes = useMemo(() => {
    if (!r || !valid) return 0;
    return r.layer_ids.filter(
      (_, i) => Math.abs(round(r.recommended_tension[i]) - project.layers[i].tension) >= ROUND_N / 2,
    ).length;
  }, [r, valid, project.layers]);

  const apply = () => {
    if (!r || !valid) return;
    const rec = new Map(r.layer_ids.map((id, i) => [id, round(r.recommended_tension[i])]));
    update((p) => ({
      ...p,
      layers: p.layers.map((l) => {
        const t = rec.get(l.id);
        return t != null ? { ...l, tension: Number(t.toFixed(1)) } : l;
      }),
    }));
  };

  const outer = project.layers[project.layers.length - 1];
  const spread = (a: number[]) => (a.length ? Math.max(...a) - Math.min(...a) : 0);

  return (
    <Section title={<>Winding tension {busy ? <Spinner size={10} label="Computing tension schedule" /> : null}</>}>
      <p className="muted small tension-intro">
        Later layers compress the ones below and relax their winding prestress. The schedule raises inner-layer tension
        so every layer keeps the same residual prestress.
      </p>
      <Field label="Outermost tension" hint="Kept on the last layer; the schedule works inwards from it">
        <NumberInput
          ariaLabel="Target tension of the outermost layer"
          value={target}
          placeholder={outer ? `${sig(outer.tension, 3)} (current)` : 'current'}
          unit="N"
          gt={0}
          step={1}
          onCommit={setTarget}
          onClear={() => setTarget(null)}
        />
      </Field>
      <Field label="Max factor" hint="Cap on inner-layer winding stress vs the outermost (empty = backend default)">
        <NumberInput
          ariaLabel="Maximum tension factor"
          value={maxFactor}
          placeholder="default"
          unit="×"
          min={1}
          max={10}
          step={0.5}
          onCommit={setMaxFactor}
          onClear={() => setMaxFactor(null)}
        />
      </Field>
      {error ? <Banner kind="fail">{error}</Banner> : null}
      {r ? (
        <>
          <BarChart
            title="Residual ply prestress after winding"
            categories={r.layer_ids}
            series={[
              { id: 'cur', name: 'current', values: r.residual_current, color: 'var(--series-7)' },
              { id: 'rec', name: 'recommended', values: r.residual_recommended, color: 'var(--series-3)' },
            ]}
            yLabel="σ"
            yUnit="MPa"
            height={170}
          />
          <dl className="props tension-props">
            <div>
              <dt>Residual spread</dt>
              <dd>
                {sig(spread(r.residual_current), 3)} → {sig(spread(r.residual_recommended), 3)} MPa
              </dd>
            </div>
            <div>
              <dt title="Liner hoop stress from the winding prestress (negative = compression)">
                Liner hoop prestress
              </dt>
              <dd>
                {sig(r.liner_hoop_current, 3)} → {sig(r.liner_hoop_recommended, 3)} MPa
              </dd>
            </div>
          </dl>
          <div className="table-scroll tension-table">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Layer</th>
                  <th className="num" title="Current band tension [N]">
                    Now N
                  </th>
                  <th className="num" title="Recommended band tension [N]">
                    Rec. N
                  </th>
                  <th className="num" title="Residual prestress, current → recommended [MPa]">
                    σ res MPa
                  </th>
                </tr>
              </thead>
              <tbody>
                {r.layer_ids.map((id, i) => {
                  const d = r.recommended_tension[i] - r.current_tension[i];
                  const big = Math.abs(d) >= Math.max(0.5, 0.02 * r.current_tension[i]);
                  return (
                    <tr key={id} onClick={() => setSelectedLayerId(id)} className="clickable" title="Select layer">
                      <td className="num muted">{i + 1}</td>
                      <td>
                        <i className="swatch" style={{ background: colors.get(id) }} /> {id}
                      </td>
                      <td className="num">{sig(r.current_tension[i], 3)}</td>
                      <td className={`num ${big ? (d > 0 ? 'up' : 'down') : ''}`}>
                        {sig(round(r.recommended_tension[i]), 4)}
                        {big ? <span className="delta">{d > 0 ? '▲' : '▼'}</span> : null}
                      </td>
                      <td className="num">
                        {sig(r.residual_current[i], 3)}{' '}
                        <span className="muted">→ {sig(r.residual_recommended[i], 3)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="toolbar">
            <Button
              variant="primary"
              size="sm"
              icon="check"
              disabled={!valid || !changes || busy}
              onClick={apply}
              title="Set every layer to its recommended tension (one undo step)"
            >
              Apply recommended tensions
            </Button>
            <span className="muted small">
              {!valid
                ? 'Updating for the changed layup…'
                : changes
                  ? `${changes} layer${changes === 1 ? '' : 's'} change · Ctrl+Z undoes`
                  : 'Tensions already follow the schedule'}
            </span>
          </div>
        </>
      ) : !error ? (
        <div className="empty">
          <Spinner /> Computing the tension schedule…
        </div>
      ) : null}
    </Section>
  );
}
