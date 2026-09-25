import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type {
  BandShape,
  Check,
  Layer,
  LayerResult,
  LayerType,
  PatternCandidate,
  SuggestLayupResponse,
  WindingType,
} from '../api/types';
import {
  Field,
  NumberField,
  NumberInput,
  Section,
  Segmented,
  SelectField,
  Switch,
  TextInput,
} from '../components/fields';
import { Icon } from '../components/Icon';
import { LineChart, type Series } from '../components/LineChart';
import { Banner, Button, Empty, Modal, Spinner, StatusIcon, WarningList } from '../components/ui';
import { useAnalysis } from '../state/analysis';
import { newLayer, newLayerId, normalizeProject } from '../state/defaults';
import { useProject } from '../state/projectStore';
import { useUi } from '../state/uiStore';
import { layerColors } from '../viewer/colors';
import { UTIL_FAIL, UTIL_MAX, utilisation, utilStatus } from '../viewer/colormaps';
import { fmtDuration, fmtMass, sig } from '../util/format';
import { ChecksList, worstCheck } from './shared';
import { checksForStep } from './stepStatus';
import { MeridianChart } from './VesselStep';

function useLayerResults(): Map<string, LayerResult> {
  const { result } = useAnalysis();
  return useMemo(() => new Map((result?.layers ?? []).map((l) => [l.id, l])), [result]);
}

/** Checks that belong to one layer's own sub-checks (`layer.<id>.*`, e.g. slippage). */
export function layerSubChecks(checks: Check[] | undefined, id: string): Check[] {
  const pre = `layer.${id}.`;
  return (checks ?? []).filter((c) => c.id.startsWith(pre));
}

/** Ensure a layer is selected when layers exist. */
export function useSelectedLayer(): [Layer | null, (id: string | null) => void] {
  const { project } = useProject();
  const { selectedLayerId, setSelectedLayerId } = useUi();
  const sel = project.layers.find((l) => l.id === selectedLayerId) ?? null;
  useEffect(() => {
    if (!sel && project.layers.length) setSelectedLayerId(project.layers[0].id);
  }, [sel, project.layers, setSelectedLayerId]);
  return [sel ?? project.layers[0] ?? null, setSelectedLayerId];
}

export function LayupPanel() {
  const { project, update } = useProject();
  const results = useLayerResults();
  const { result } = useAnalysis();
  const [sel, setSel] = useSelectedLayer();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [suggest, setSuggest] = useState<{
    busy: boolean;
    data: SuggestLayupResponse | null;
    error: string | null;
  } | null>(null);
  const colors = layerColors(project.layers);
  const layers = project.layers;

  const setLayers = (fn: (ls: Layer[]) => Layer[], key?: string) =>
    update((p) => ({ ...p, layers: fn(p.layers) }), key);

  const add = (type: LayerType) => {
    const l = newLayer(type, layers);
    const at = sel ? layers.findIndex((x) => x.id === sel.id) + 1 : layers.length;
    setLayers((ls) => [...ls.slice(0, at), l, ...ls.slice(at)]);
    setSel(l.id);
  };
  const move = (id: string, delta: number) =>
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= ls.length) return ls;
      const out = [...ls];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });
  const moveTo = (id: string, to: number) =>
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id);
      if (i < 0) return ls;
      const out = [...ls];
      const [x] = out.splice(i, 1);
      out.splice(to > i ? to - 1 : to, 0, x);
      return out;
    });
  const duplicate = (id: string) => {
    const i = layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const src = layers[i];
    const copy: Layer = { ...src, pattern: src.pattern ? { ...src.pattern } : null, id: newLayerId(src.type, layers) };
    setLayers((ls) => [...ls.slice(0, i + 1), copy, ...ls.slice(i + 1)]);
    setSel(copy.id);
  };
  const remove = (id: string) => {
    const i = layers.findIndex((l) => l.id === id);
    setLayers((ls) => ls.filter((l) => l.id !== id));
    const next = layers[i + 1] ?? layers[i - 1];
    setSel(next ? next.id : null);
  };

  const runSuggest = async () => {
    setSuggest({ busy: true, data: null, error: null });
    try {
      const data = await api.suggestLayup(project);
      setSuggest({ busy: false, data, error: null });
    } catch (e) {
      setSuggest({ busy: false, data: null, error: errorMessage(e) });
    }
  };

  const totals = useMemo(() => {
    let t = 0,
      m = 0,
      time = 0,
      len = 0;
    for (const r of results.values()) {
      t += r.thickness;
      m += r.fiber_mass + r.resin_mass;
      time += r.wind_time;
      len += r.fiber_length;
    }
    return { t, m, time, len };
  }, [results]);

  return (
    <>
      <div className="toolbar">
        <Button size="sm" icon="plus" onClick={() => add('helical')}>
          Helical
        </Button>
        <Button size="sm" icon="plus" onClick={() => add('hoop')}>
          Hoop
        </Button>
        <span style={{ flex: 1 }} />
        <Button
          size="sm"
          icon="wand"
          onClick={runSuggest}
          title="Ask the backend for a layup that meets the requirements"
        >
          Suggest layup
        </Button>
      </div>

      {layers.length === 0 ? (
        <Empty>No layers yet. Add a helical and a hoop layer, or use “Suggest layup”.</Empty>
      ) : (
        <table className="layer-table">
          <thead>
            <tr>
              <th className="c-idx">#</th>
              <th className="c-name">Layer</th>
              <th className="num c-ang">Angle</th>
              <th className="num c-t" title="Cured thickness in the cylinder">
                t mm
              </th>
              <th className="num c-circ" title="Circuits">
                Circ
              </th>
              <th className="c-act" aria-label="Reorder" />
            </tr>
          </thead>
          <tbody>
            {layers.map((l, i) => {
              const r = results.get(l.id);
              const active = sel?.id === l.id;
              const ng = l.type === 'helical' && l.winding === 'non-geodesic';
              const sub = worstCheck(layerSubChecks(result?.checks, l.id));
              return (
                <tr
                  key={l.id}
                  className={`${active ? 'active' : ''} ${dragId === l.id ? 'dragging' : ''} ${overIdx === i ? 'drop-before' : ''} ${overIdx === layers.length && i === layers.length - 1 ? 'drop-after' : ''}`}
                  onClick={() => setSel(l.id)}
                  draggable
                  onDragStart={(e) => {
                    setDragId(l.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', l.id);
                  }}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setOverIdx(e.clientY > rect.top + rect.height / 2 ? i + 1 : i);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverIdx(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId != null && overIdx != null) moveTo(dragId, overIdx);
                    setDragId(null);
                    setOverIdx(null);
                  }}
                >
                  <td className="muted grip" title="Drag to reorder">
                    {i + 1}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="layer-name"
                      aria-pressed={active}
                      onKeyDown={(e) => {
                        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                          e.preventDefault();
                          move(l.id, e.key === 'ArrowUp' ? -1 : 1);
                        }
                      }}
                      title="Select (Alt+↑/↓ to reorder)"
                    >
                      <i className="swatch" style={{ background: colors.get(l.id) }} />
                      <span>{l.id}</span>
                      <span className={`type-badge t-${l.type}`} title={l.type}>
                        {l.type === 'hoop' ? 'H' : 'X'}
                      </span>
                      {ng ? (
                        <span
                          className="type-badge t-ng"
                          title={`Non-geodesic, cylinder angle ${l.angle == null ? 'auto (balanced)' : `${sig(l.angle, 3)}°`}, μ ${sig(l.friction, 3)}`}
                        >
                          NG
                        </span>
                      ) : null}
                      {sub && (sub.status === 'fail' || sub.status === 'warn') ? (
                        <span
                          className={`warn-mark m-${sub.status}`}
                          title={`${sub.label}: ${sig(sub.value ?? 0, 3)} / ${sig(sub.limit ?? 0, 3)}`}
                        >
                          <Icon name={sub.status === 'fail' ? 'x' : 'alert'} size={12} />
                        </span>
                      ) : null}
                      {r?.warnings.length ? (
                        <span className="warn-mark" title={r.warnings.join('\n')}>
                          <Icon name="alert" size={12} />
                        </span>
                      ) : null}
                    </button>
                  </td>
                  <td
                    className="num"
                    title={
                      ng
                        ? l.angle == null
                          ? 'Cylinder angle: auto (balanced slippage)'
                          : 'Cylinder angle: set'
                        : undefined
                    }
                  >
                    {r ? `${sig(r.angle, 3)}°` : ng && l.angle != null ? `${sig(l.angle, 3)}°` : '–'}
                  </td>
                  <td className="num">{r ? sig(r.thickness, 3) : '–'}</td>
                  <td className="num">{r ? r.circuits : '–'}</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      aria-label={`Move ${l.id} up`}
                      disabled={i === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        move(l.id, -1);
                      }}
                    >
                      <Icon name="up" size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${l.id} down`}
                      disabled={i === layers.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        move(l.id, 1);
                      }}
                    >
                      <Icon name="down" size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td />
              <td className="muted" colSpan={2}>
                Total · {fmtMass(totals.m)} · {fmtDuration(totals.time)}
              </td>
              <td className="num">{sig(totals.t, 3)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      )}

      {sel ? (
        <LayerEditor
          key={sel.id}
          layer={sel}
          result={results.get(sel.id) ?? null}
          checks={layerSubChecks(result?.checks, sel.id)}
          allIds={layers.map((l) => l.id)}
          onChange={(patch, key) =>
            setLayers((ls) => ls.map((l) => (l.id === sel.id ? { ...l, ...patch } : l)), `layer.${sel.id}.${key}`)
          }
          onRename={(id) => {
            setLayers((ls) => ls.map((l) => (l.id === sel.id ? { ...l, id } : l)));
            setSel(id);
          }}
          onDuplicate={() => duplicate(sel.id)}
          onDelete={() => remove(sel.id)}
        />
      ) : null}

      {result ? <ChecksList checks={checksForStep(result.checks, 'layup')} title="Layup checks" /> : null}

      <Modal
        title="Suggested layup"
        open={!!suggest}
        onClose={() => setSuggest(null)}
        footer={
          <>
            <Button onClick={() => setSuggest(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!suggest?.data?.layers.length}
              onClick={() => {
                const d = suggest?.data;
                if (!d) return;
                const layersN = normalizeProject({ ...project, layers: d.layers }).layers;
                update((p) => ({ ...p, layers: layersN }));
                setSel(layersN[0]?.id ?? null);
                setSuggest(null);
              }}
            >
              Replace {layers.length} layer{layers.length === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        {suggest?.busy ? (
          <div className="empty">
            <Spinner /> Computing a layup…
          </div>
        ) : suggest?.error ? (
          <Banner kind="fail">{suggest.error}</Banner>
        ) : suggest?.data ? (
          <>
            <p className="muted">
              The current {layers.length} layer{layers.length === 1 ? '' : 's'} will be replaced (undo with Ctrl+Z).
            </p>
            <ol className="suggest-list">
              {suggest.data.layers.map((l) => (
                <li key={l.id}>
                  <span className={`type-badge t-${l.type}`}>{l.type}</span> <strong>{l.id}</strong>{' '}
                  <span className="muted">
                    {l.tows} tow · {l.band_width} mm band
                    {l.type === 'helical' && l.winding === 'non-geodesic' ? ' · non-geodesic' : ''}
                    {l.type === 'hoop'
                      ? ` · ${l.passes} passes`
                      : l.turnaround_offset
                        ? ` · +${l.turnaround_offset} mm turnaround`
                        : ''}
                  </span>
                </li>
              ))}
            </ol>
            {suggest.data.notes.length ? (
              <ul className="notes-list">
                {suggest.data.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </Modal>
    </>
  );
}

function LayerEditor({
  layer: l,
  result: r,
  checks,
  allIds,
  onChange,
  onRename,
  onDuplicate,
  onDelete,
}: {
  layer: Layer;
  result: LayerResult | null;
  checks: Check[];
  allIds: string[];
  onChange: (patch: Partial<Layer>, key: string) => void;
  onRename: (id: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [idErr, setIdErr] = useState<string | null>(null);
  return (
    <>
      <Section
        title={`Layer ${l.id}`}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              icon="copy"
              onClick={onDuplicate}
              title="Duplicate layer"
              aria-label={`Duplicate ${l.id}`}
            />
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              className="btn-danger"
              onClick={onDelete}
              title="Delete layer"
              aria-label={`Delete ${l.id}`}
            />
          </>
        }
      >
        <Field label="Id" error={idErr}>
          <TextInput
            value={l.id}
            ariaLabel="Layer id"
            onCommit={(v) => {
              const id = v.trim();
              if (!id) return setIdErr('Id required');
              if (id !== l.id && allIds.includes(id)) return setIdErr('Id already used');
              setIdErr(null);
              onRename(id);
            }}
          />
        </Field>
        <Field label="Type">
          <Segmented<LayerType>
            ariaLabel="Layer type"
            value={l.type}
            options={[
              { value: 'helical', label: 'Helical' },
              { value: 'hoop', label: 'Hoop' },
            ]}
            onChange={(v) => onChange({ type: v }, 'type')}
          />
        </Field>
        <NumberField
          label="Tows"
          unit="tows"
          value={l.tows}
          min={1}
          integer
          onCommit={(v) => onChange({ tows: v }, 'tows')}
        />
        <NumberField
          label="Band width"
          unit="mm"
          value={l.band_width}
          gt={0}
          step={0.5}
          onCommit={(v) => onChange({ band_width: v }, 'bw')}
        />
        <NumberField
          label="Tension"
          unit="N"
          value={l.tension}
          min={0}
          step={1}
          hint="Total band tension"
          onCommit={(v) => onChange({ tension: v }, 'tension')}
        />
        <SelectField<BandShape>
          label="Band cross-section"
          value={l.band_shape}
          options={[
            { value: 'rectangular', label: 'Rectangular' },
            { value: 'lenticular', label: 'Lenticular' },
            { value: 'elliptical', label: 'Elliptical' },
          ]}
          hint="Band profile used by the band-level thickness simulation"
          onChange={(v) => onChange({ band_shape: v }, 'bandShape')}
        />
        {l.type === 'helical' ? (
          <>
            <HelicalPathFields layer={l} result={r} onChange={onChange} />
            <NumberField
              label="Max dwell"
              unit="°"
              value={l.dwell_max}
              min={0}
              max={360}
              step={5}
              hint="Maximum mandrel dwell per turnaround"
              onCommit={(v) => onChange({ dwell_max: v }, 'dwell')}
            />
          </>
        ) : (
          <>
            <NumberField
              label="Passes"
              unit="passes"
              value={l.passes}
              min={1}
              integer
              hint="Each traverse deposits one band thickness"
              onCommit={(v) => onChange({ passes: v }, 'passes')}
            />
            <NumberField
              label="End offset A"
              unit="mm"
              value={l.end_offset_a}
              min={0}
              step={1}
              hint="Drop-off from tangent line, end A"
              onCommit={(v) => onChange({ end_offset_a: v }, 'eoa')}
            />
            <NumberField
              label="End offset B"
              unit="mm"
              value={l.end_offset_b}
              min={0}
              step={1}
              hint="Drop-off from tangent line, end B"
              onCommit={(v) => onChange({ end_offset_b: v }, 'eob')}
            />
          </>
        )}
        <Field
          label="Thickness"
          hint={
            l.thickness_override == null ? 'Computed from band thickness' : 'Overrides the computed cured thickness'
          }
        >
          <div className="inline">
            <Switch
              checked={l.thickness_override == null}
              label="Auto"
              onChange={(auto) =>
                onChange({ thickness_override: auto ? null : Number(sig(r?.thickness ?? 0.5, 3)) || 0.5 }, 'tovr')
              }
            />
            <NumberInput
              ariaLabel="Thickness override"
              value={l.thickness_override ?? r?.thickness ?? null}
              disabled={l.thickness_override == null}
              unit="mm"
              gt={0}
              step={0.05}
              onCommit={(v) => onChange({ thickness_override: v }, 'tov')}
            />
          </div>
        </Field>
      </Section>

      {r ? <LayerResultCard r={r} checks={checks} /> : null}

      {l.type === 'helical' ? (
        <Section title="Winding pattern">
          <PatternTable layer={l} result={r} onPick={(pattern) => onChange({ pattern }, 'pattern')} />
        </Section>
      ) : null}
    </>
  );
}

function HelicalPathFields({
  layer: l,
  result: r,
  onChange,
}: {
  layer: Layer;
  result: LayerResult | null;
  onChange: (patch: Partial<Layer>, key: string) => void;
}) {
  const ng = l.winding === 'non-geodesic';
  const sameB = l.turnaround_offset_b == null;
  return (
    <>
      <Field
        label="Path"
        hint={
          ng
            ? 'Friction steers the fibre on the domes, so each end can turn at its own radius'
            : 'Shortest path on the surface; needs no friction'
        }
      >
        <Segmented<WindingType>
          ariaLabel="Path type"
          value={l.winding}
          options={[
            { value: 'geodesic', label: 'Geodesic' },
            { value: 'non-geodesic', label: 'Non-geodesic' },
          ]}
          onChange={(v) => onChange({ winding: v }, 'winding')}
        />
      </Field>
      {ng ? (
        <>
          <Field
            label="Cylinder angle"
            hint={
              l.angle == null
                ? r && r.winding === 'non-geodesic'
                  ? `Auto → ${sig(r.angle, 3)}°, balances slippage on both domes`
                  : 'Auto: the angle that balances slippage on both domes'
                : 'Winding angle on the cylinder (0 – 85°)'
            }
          >
            <div className="inline">
              <Switch
                checked={l.angle == null}
                label="Auto (balanced)"
                onChange={(auto) =>
                  onChange(
                    { angle: auto ? null : Math.min(84, Math.max(1, Number(sig(r?.angle ?? 30, 3)) || 30)) },
                    'angleAuto',
                  )
                }
              />
              <NumberInput
                ariaLabel="Cylinder angle"
                value={l.angle ?? r?.angle ?? null}
                precision={4}
                className="numin-short-unit"
                disabled={l.angle == null}
                unit="°"
                gt={0}
                lt={85}
                step={1}
                onCommit={(v) => onChange({ angle: v }, 'angle')}
              />
            </div>
          </Field>
          <NumberField
            label="Friction μ"
            unit="μ"
            value={l.friction}
            min={0}
            max={1}
            step={0.01}
            hint="Available fibre/surface friction: the largest |kg/kn| the band holds without sliding"
            onCommit={(v) => onChange({ friction: v }, 'mu')}
          />
        </>
      ) : null}
      <NumberField
        label="Turnaround A"
        unit="mm"
        value={l.turnaround_offset}
        min={0}
        step={1}
        hint={`Turnaround offset: extra radius beyond boss + band/2 at end A${sameB ? ' (and B)' : ''}`}
        onCommit={(v) => onChange({ turnaround_offset: v }, 'tao')}
      />
      <Field
        label="Turnaround B"
        hint={ng ? 'Turnaround offset at end B' : 'Geodesic paths use the larger turnaround radius at both ends'}
      >
        <div className="inline">
          <Switch
            checked={sameB}
            label="Same as A"
            onChange={(same) => onChange({ turnaround_offset_b: same ? null : l.turnaround_offset }, 'taoBSame')}
          />
          <NumberInput
            ariaLabel="Turnaround offset B"
            value={l.turnaround_offset_b ?? l.turnaround_offset}
            disabled={sameB}
            unit="mm"
            min={0}
            step={1}
            onCommit={(v) => onChange({ turnaround_offset_b: v }, 'taoB')}
          />
        </div>
      </Field>
    </>
  );
}

/** |lambda|/mu utilisation bar: green < 0.8, amber < 1, red >= 1. */
function SlipBar({ label, lambda, mu }: { label: string; lambda: number; mu: number }) {
  const u = utilisation(lambda, mu);
  const st = utilStatus(u);
  const pct = Math.min(100, (u / UTIL_MAX) * 100);
  const lim = (UTIL_FAIL / UTIL_MAX) * 100;
  const pctText = Number.isFinite(u) ? `${Math.round(u * 100)} %` : '∞';
  return (
    <div
      className={`slip-row s-${st}`}
      title={`Slippage kg/kn ${sig(lambda, 3)} on dome ${label}; available friction μ ${sig(mu, 3)} → ${pctText} utilised`}
    >
      <span className="slip-label">Slippage {label}</span>
      <div
        className="slip-bar"
        role="meter"
        aria-label={`Slippage utilisation dome ${label}`}
        aria-valuemin={0}
        aria-valuemax={UTIL_MAX}
        aria-valuenow={Number.isFinite(u) ? Number(u.toFixed(3)) : UTIL_MAX}
      >
        <div className="slip-fill" style={{ width: `${pct}%` }} />
        <i className="slip-limit" style={{ left: `${lim}%` }} />
      </div>
      <span className="slip-val">
        {sig(lambda, 3)}
        <span className="muted"> / {sig(mu, 3)}</span>
        <strong>{pctText}</strong>
      </span>
    </div>
  );
}

function LayerResultCard({ r, checks }: { r: LayerResult; checks: Check[] }) {
  const helical = r.type === 'helical';
  const ng = helical && r.winding === 'non-geodesic';
  const ta = r.turnaround_a ?? r.turnaround_radius;
  const tb = r.turnaround_b ?? r.turnaround_radius;
  const rows: [string, string][] = [
    [helical ? 'Cylinder angle' : 'Winding angle', `${sig(r.angle, 4)}°`],
    ...(helical ? ([['Path', ng ? 'Non-geodesic' : 'Geodesic']] as [string, string][]) : []),
    ['Cured thickness', `${sig(r.thickness, 3)} mm`],
    ['Band thickness', `${sig(r.band_thickness, 3)} mm`],
    ...(helical && ta != null && tb != null
      ? ([
          ['Turnaround radius A', `${sig(ta, 4)} mm`],
          ['Turnaround radius B', `${sig(tb, 4)} mm`],
        ] as [string, string][])
      : []),
    ['Extent z', `${sig(r.z_start, 4)} … ${sig(r.z_end, 4)} mm`],
    ['Circuits', String(r.circuits)],
    ['Fibre length', `${sig(r.fiber_length, 4)} m`],
    ['Fibre / resin', `${fmtMass(r.fiber_mass)} / ${fmtMass(r.resin_mass)}`],
    ['Wind time', fmtDuration(r.wind_time)],
  ];
  const worst = worstCheck(checks);
  return (
    <div className={`card result-card ${worst ? `rc-${worst.status}` : ''}`}>
      <div className="card-title">Computed</div>
      <dl className="props two">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {ng ? (
        <div className="slip-block">
          <SlipBar label="A" lambda={r.slippage_a} mu={r.friction} />
          <SlipBar label="B" lambda={r.slippage_b} mu={r.friction} />
        </div>
      ) : null}
      {helical ? (
        <div
          className="dwell-slip muted small"
          title={
            'Slippage |kg/kn| a dwell (mandrel rotation with the eye parked) on the turnaround circle would need. ' +
            'It is usually large on steep dome shoulders; in practice the dwell happens on the boss neck, so this ' +
            'is for information only and is not checked.'
          }
        >
          <Icon name="info" size={12} />
          <span>Dwell slippage {sig(r.dwell_slippage, 3)} on the turnaround circle · informational</span>
        </div>
      ) : null}
      {checks.map((c) => (
        <div key={c.id} className={`check c-${c.status} layer-check`} title={c.detail || undefined}>
          <StatusIcon status={c.status} />
          <div className="check-main">
            <div className="check-label">{c.label}</div>
            {c.detail ? <div className="check-detail">{c.detail}</div> : null}
          </div>
          {c.value != null ? (
            <div className="check-val">
              {sig(c.value, 3)}
              {c.limit != null ? <span className="check-lim"> / {sig(c.limit, 3)}</span> : null}
            </div>
          ) : null}
        </div>
      ))}
      <WarningList items={r.warnings} />
    </div>
  );
}

function samePattern(
  a: { n_bands: number; shift: number } | null | undefined,
  b: { n_bands: number; shift: number } | null | undefined,
) {
  return !!a && !!b && a.n_bands === b.n_bands && a.shift === b.shift;
}

function PatternTable({
  layer,
  result,
  onPick,
}: {
  layer: Layer;
  result: LayerResult | null;
  onPick: (p: { n_bands: number; shift: number } | null) => void;
}) {
  const cands: PatternCandidate[] = result?.pattern_candidates ?? [];
  const auto = layer.pattern == null;
  const active = result?.pattern;
  const pinnedMissing = !auto && !cands.some((c) => samePattern(c, layer.pattern));
  return (
    <>
      <div className="pattern-mode">
        <Segmented<'auto' | 'manual'>
          ariaLabel="Pattern selection"
          size="sm"
          value={auto ? 'auto' : 'manual'}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'manual', label: 'Pick' },
          ]}
          onChange={(v) => {
            if (v === 'auto') onPick(null);
            else if (active) onPick({ n_bands: active.n_bands, shift: active.shift });
            else if (cands[0]) onPick({ n_bands: cands[0].n_bands, shift: cands[0].shift });
          }}
        />
        <span className="muted small">
          {auto
            ? active
              ? `Auto → ${active.n_bands} bands, shift ${active.shift}`
              : 'Best-scoring pattern is used'
            : `Pinned: ${layer.pattern!.n_bands} bands, shift ${layer.pattern!.shift}`}
        </span>
      </div>
      {!auto ? (
        <div className="inline pattern-manual">
          <NumberField
            label="Bands"
            unit="n"
            value={layer.pattern!.n_bands}
            min={1}
            integer
            onCommit={(v) => onPick({ ...layer.pattern!, n_bands: v })}
          />
          <NumberField
            label="Shift"
            unit="k"
            value={layer.pattern!.shift}
            min={1}
            integer
            onCommit={(v) => onPick({ ...layer.pattern!, shift: v })}
          />
        </div>
      ) : null}
      {pinnedMissing && result ? (
        <Banner kind="warn">The pinned pattern is not among the feasible candidates.</Banner>
      ) : null}
      {cands.length ? (
        <div className="table-scroll">
          <table className="data-table pattern-table">
            <thead>
              <tr>
                <th className="num" title="Circuits per layer">
                  Bands
                </th>
                <th className="num" title="Circuit advance k">
                  Shift
                </th>
                <th className="num" title="Circuits until a band lands adjacent to band 0">
                  Pattern
                </th>
                <th className="num" title="Dwell per turnaround">
                  Dwell °
                </th>
                <th className="num" title="Coverage (100 % exact, >100 % overlap)">
                  Cover %
                </th>
                <th title="Advance direction">Dir</th>
              </tr>
            </thead>
            <tbody>
              {cands.map((c) => {
                const isActive = samePattern(c, active);
                const pinned = samePattern(c, layer.pattern);
                return (
                  <tr
                    key={`${c.n_bands}-${c.shift}`}
                    className={`${isActive ? 'active' : ''} ${pinned ? 'pinned' : ''}`}
                    tabIndex={0}
                    aria-selected={isActive}
                    onClick={() => onPick({ n_bands: c.n_bands, shift: c.shift })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onPick({ n_bands: c.n_bands, shift: c.shift });
                      }
                    }}
                    title={`Score ${sig(c.score, 3)} — click to pin this pattern`}
                  >
                    <td className="num">{c.n_bands}</td>
                    <td className="num">{c.shift}</td>
                    <td className="num">{c.pattern_number}</td>
                    <td className="num">{sig(c.dwell, 3)}</td>
                    <td className={`num ${c.coverage < 1 ? 'bad' : ''}`}>{(c.coverage * 100).toFixed(1)}</td>
                    <td>{c.leading ? 'lead' : 'lag'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{result ? 'No feasible pattern candidates.' : 'Waiting for analysis…'}</Empty>
      )}
    </>
  );
}

// ------------------------------------------------------------------ bottom: thickness chart
type ThkMode = 'stacked' | 'layers' | 'total';

function resample(results: LayerResult[], n = 400) {
  let z0 = Infinity,
    z1 = -Infinity;
  for (const r of results)
    for (const z of r.thickness_profile.x) {
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
  if (!Number.isFinite(z0)) return { z: [] as number[], ys: [] as number[][] };
  const z = Array.from({ length: n }, (_, i) => z0 + ((z1 - z0) * i) / (n - 1));
  const ys = results.map((r) => {
    const { x, y } = r.thickness_profile;
    return z.map((zz) => {
      if (!x.length) return 0;
      const asc = x[x.length - 1] >= x[0];
      const lo = asc ? x[0] : x[x.length - 1];
      const hi = asc ? x[x.length - 1] : x[0];
      if (zz < lo || zz > hi) return 0;
      for (let i = 1; i < x.length; i++) {
        const a = x[i - 1],
          b = x[i];
        if ((zz >= a && zz <= b) || (zz <= a && zz >= b)) {
          const t = b === a ? 0 : (zz - a) / (b - a);
          return y[i - 1] + t * (y[i] - y[i - 1]);
        }
      }
      return 0;
    });
  });
  return { z, ys };
}

export function ThicknessChart({ height = 230, initialMode = 'stacked' }: { height?: number; initialMode?: ThkMode }) {
  const { result } = useAnalysis();
  const { project } = useProject();
  const [mode, setMode] = useState<ThkMode>(initialMode);
  const colors = useMemo(() => layerColors(project.layers), [project.layers]);
  const series = useMemo<Series[]>(() => {
    const lrs = result?.layers ?? [];
    if (!lrs.length) return [];
    if (mode === 'layers') {
      return lrs.map((r) => ({
        id: r.id,
        name: r.id,
        x: r.thickness_profile.x,
        y: r.thickness_profile.y,
        color: colors.get(r.id),
        width: 1.5,
        hideLegend: lrs.length > 10,
      }));
    }
    const { z, ys } = resample(lrs);
    const cum = z.map(() => 0);
    const out: Series[] = [];
    ys.forEach((y, k) => {
      for (let i = 0; i < z.length; i++) cum[i] += y[i];
      if (mode === 'stacked')
        out.push({
          id: lrs[k].id,
          name: `≤ ${lrs[k].id}`,
          x: z,
          y: [...cum],
          color: colors.get(lrs[k].id),
          width: 1.5,
          hideLegend: lrs.length > 10,
        });
    });
    if (mode === 'total') out.push({ id: 'total', name: 'Total', x: z, y: cum, color: 'var(--series-1)', fill: true });
    return out;
  }, [result, mode, colors]);
  return (
    <LineChart
      title="Composite thickness along z"
      series={series}
      xLabel="z"
      xUnit="mm"
      yLabel="t"
      yUnit="mm"
      height={height}
      yZero
      emptyText="No layer results yet"
      tools={
        <Segmented<ThkMode>
          size="sm"
          ariaLabel="Thickness chart mode"
          value={mode}
          options={[
            { value: 'stacked', label: 'Stacked' },
            { value: 'layers', label: 'Per layer' },
            { value: 'total', label: 'Total' },
          ]}
          onChange={setMode}
        />
      }
    />
  );
}

export function LayupBottom() {
  return (
    <div className="bottom-grid two">
      <ThicknessChart />
      <MeridianChart height={230} />
    </div>
  );
}
