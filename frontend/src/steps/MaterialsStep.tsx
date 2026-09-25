import { useId, useSyncExternalStore } from 'react';
import type { CompositeSpec, Fiber, LinerKind, Resin } from '../api/types';
import { Field, NumberField, NumberInput, Section, SelectField, SliderField, Switch } from '../components/fields';
import { Icon } from '../components/Icon';
import { Banner, Button, Empty, Modal } from '../components/ui';
import { useAnalysis } from '../state/analysis';
import { newCustomFiber, newCustomLiner, newCustomResin } from '../state/defaults';
import {
  findMat,
  materialUsage,
  matOptions,
  renameMaterialRefs,
  useMaterialLists,
  type MatEntry,
  type MatKind,
} from '../state/materials';
import { patchSection, useProject } from '../state/projectStore';
import { sig } from '../util/format';
import { ChecksList, LinerTypeBadge } from './shared';
import { checksForStep } from './stepStatus';

// ------------------------------------------------------------------ field specs (table + editor)
type Rec = Record<string, number | string>;

interface NumSpec {
  key: string;
  label: string;
  /** Column header */
  short: string;
  unit: string;
  /** Displayed value = stored value x scale */
  scale?: number;
  gt?: number;
  lt?: number;
  min?: number;
  max?: number;
  step: number;
  hint?: string;
}

const CTE_UNIT = '10⁻⁶/K';

const FIBER_FIELDS: NumSpec[] = [
  { key: 'E', label: 'Tensile modulus', short: 'E', unit: 'GPa', scale: 1e-3, gt: 0, step: 1 },
  { key: 'strength', label: 'Tensile strength', short: 'σu', unit: 'MPa', gt: 0, step: 50, hint: 'Impregnated strand' },
  { key: 'elongation', label: 'Elongation', short: 'εu', unit: '%', scale: 100, gt: 0, step: 0.1 },
  { key: 'density', label: 'Density', short: 'ρ', unit: 'g/cm³', gt: 0, step: 0.01 },
  { key: 'tex', label: 'Linear density', short: 'tex', unit: 'g/km', gt: 0, step: 10 },
  { key: 'E2', label: 'Transverse modulus', short: 'E₂', unit: 'GPa', scale: 1e-3, gt: 0, step: 1 },
  { key: 'G12', label: 'Shear modulus', short: 'G₁₂', unit: 'GPa', scale: 1e-3, gt: 0, step: 1 },
  { key: 'nu12', label: 'Poisson ratio ν₁₂', short: 'ν₁₂', unit: '', min: 0, lt: 0.5, step: 0.01 },
  { key: 'cte1', label: 'Axial CTE', short: 'α₁', unit: CTE_UNIT, scale: 1e6, step: 0.1 },
  { key: 'cte2', label: 'Transverse CTE', short: 'α₂', unit: CTE_UNIT, scale: 1e6, step: 0.5 },
];

const RESIN_FIELDS: NumSpec[] = [
  { key: 'E', label: 'Modulus', short: 'E', unit: 'GPa', scale: 1e-3, gt: 0, step: 0.1 },
  { key: 'nu', label: 'Poisson ratio', short: 'ν', unit: '', min: 0, lt: 0.5, step: 0.01 },
  { key: 'density', label: 'Density', short: 'ρ', unit: 'g/cm³', gt: 0, step: 0.01 },
  { key: 'cte', label: 'CTE', short: 'α', unit: CTE_UNIT, scale: 1e6, step: 1 },
];

const LINER_FIELDS: NumSpec[] = [
  { key: 'E', label: 'Modulus', short: 'E', unit: 'GPa', scale: 1e-3, gt: 0, step: 1 },
  { key: 'nu', label: 'Poisson ratio', short: 'ν', unit: '', min: 0, lt: 0.5, step: 0.01 },
  { key: 'yield', label: 'Yield strength', short: 'Rp0.2', unit: 'MPa', gt: 0, step: 5 },
  { key: 'ultimate', label: 'Ultimate strength', short: 'Rm', unit: 'MPa', gt: 0, step: 5 },
  { key: 'density', label: 'Density', short: 'ρ', unit: 'g/cm³', gt: 0, step: 0.01 },
  { key: 'elongation', label: 'Elongation', short: 'A', unit: '%', scale: 100, gt: 0, step: 1 },
  {
    key: 'fatigue_coeff',
    label: "Fatigue coeff. σ'f",
    short: "σ'f",
    unit: 'MPa',
    gt: 0,
    step: 10,
    hint: "Basquin: σa = σ'f (2N)^b",
  },
  { key: 'fatigue_exp', label: 'Fatigue exponent b', short: 'b', unit: '', lt: 0, step: 0.005 },
  { key: 'cte', label: 'CTE', short: 'α', unit: CTE_UNIT, scale: 1e6, step: 0.5 },
  { key: 'k_ic', label: 'Fracture toughness', short: 'K_IC', unit: 'MPa√m', gt: 0, step: 1, hint: 'Leak-before-burst' },
];

/** Type IV (polymer liner) properties; shown in the editor for polymer liners only. */
const POLYMER_LINER_FIELDS: NumSpec[] = [
  {
    key: 'max_temp',
    label: 'Max. temperature',
    short: 'Tmax',
    unit: '°C',
    step: 5,
    hint: 'Highest service / processing temperature (checked against the cure and operating temperatures)',
  },
  {
    key: 'strain_limit',
    label: 'Strain limit',
    short: 'εlim',
    unit: '%',
    scale: 100,
    min: 0,
    step: 0.1,
    hint: 'Allowable liner strain at proof',
  },
  {
    key: 'h2_permeability',
    label: 'H₂ permeability',
    short: 'P(H₂)',
    unit: 'Barrer',
    min: 0,
    step: 0.1,
    hint: 'At 20 °C',
  },
  {
    key: 'perm_activation',
    label: 'Permeation activation energy',
    short: 'Ep',
    unit: 'kJ/mol',
    min: 0,
    step: 1,
    hint: 'Arrhenius temperature dependence of the permeability',
  },
];

const KIND_META: Record<MatKind, { one: string; many: string; fields: NumSpec[]; fresh: (id: string) => Rec }> = {
  fibers: {
    one: 'fibre',
    many: 'Fibres',
    fields: FIBER_FIELDS,
    fresh: (id) => newCustomFiber(id) as unknown as Rec,
  },
  resins: {
    one: 'resin',
    many: 'Resins',
    fields: RESIN_FIELDS,
    fresh: (id) => newCustomResin(id) as unknown as Rec,
  },
  liners: {
    one: 'liner material',
    many: 'Liners',
    fields: LINER_FIELDS,
    fresh: (id) => newCustomLiner(id) as unknown as Rec,
  },
};

/** Keep only the keys of the custom record (built-in liners carry a derived `hardening`). */
function toCustom(kind: MatKind, rec: Rec): Rec {
  const base = KIND_META[kind].fresh(String(rec.id));
  const out: Rec = {};
  for (const k of Object.keys(base)) out[k] = rec[k] ?? base[k];
  return out;
}

const disp = (v: unknown, f: NumSpec) =>
  typeof v === 'number' && Number.isFinite(v) ? sig(v * (f.scale ?? 1), 4) : '–';

// ------------------------------------------------------------------ shared editor state (panel + bottom)
interface EditorState {
  kind: MatKind;
  /** null = new record */
  originalId: string | null;
  draft: Rec;
}
let editorState: EditorState | null = null;
const editorListeners = new Set<() => void>();
const editorStore = {
  get: () => editorState,
  set(s: EditorState | null) {
    editorState = s;
    editorListeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    editorListeners.add(l);
    return () => editorListeners.delete(l);
  },
};
const useEditor = () => useSyncExternalStore(editorStore.subscribe, editorStore.get, editorStore.get);

let tabState: MatKind = 'fibers';
const tabListeners = new Set<() => void>();
const tabStore = {
  get: () => tabState,
  set(k: MatKind) {
    tabState = k;
    tabListeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    tabListeners.add(l);
    return () => tabListeners.delete(l);
  },
};
const useTab = () => useSyncExternalStore(tabStore.subscribe, tabStore.get, tabStore.get);

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ------------------------------------------------------------------ panel
function Props({ rows }: { rows: [string, string, string?][] }) {
  return (
    <dl className="props">
      {rows.map(([k, v, u]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            {v}
            {u ? <span className="unit"> {u}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CustomBadge({ e }: { e: MatEntry<unknown> | null }) {
  return e?.custom ? (
    <span className="type-badge t-custom" title="Project-specific material (Materials library below)">
      custom
    </span>
  ) : null;
}

function FiberCard({ e }: { e: MatEntry<Fiber> }) {
  const f = e.rec;
  return (
    <div className="card">
      <div className="card-title">
        {f.name} <span className="muted">{f.filaments}</span> <CustomBadge e={e} />
      </div>
      <Props
        rows={[
          ['Tensile modulus', sig(f.E / 1000, 4), 'GPa'],
          ['Tensile strength', sig(f.strength, 4), 'MPa'],
          ['Elongation', sig(f.elongation * 100, 3), '%'],
          ['Density', sig(f.density, 4), 'g/cm³'],
          ['Linear density', sig(f.tex, 4), 'tex'],
          ['CTE axial / transverse', `${sig(f.cte1 * 1e6, 3)} / ${sig(f.cte2 * 1e6, 3)}`, CTE_UNIT],
        ]}
      />
    </div>
  );
}

function ResinCard({ e }: { e: MatEntry<Resin> }) {
  const r = e.rec;
  return (
    <div className="card">
      <div className="card-title">
        {r.name} <CustomBadge e={e} />
      </div>
      <Props
        rows={[
          ['Modulus', sig(r.E / 1000, 3), 'GPa'],
          ['Poisson ratio', sig(r.nu, 3)],
          ['Density', sig(r.density, 4), 'g/cm³'],
          ['CTE', sig(r.cte * 1e6, 3), CTE_UNIT],
          ...(r.cure_temperature != null
            ? ([['Final cure (stress-free)', sig(r.cure_temperature, 4), '°C']] as [string, string, string][])
            : []),
        ]}
      />
      {r.cure ? <div className="muted small resin-cure">Typical cure: {r.cure}</div> : null}
    </div>
  );
}

export function MaterialsPanel() {
  const { project, update } = useProject();
  const lists = useMaterialLists();
  const { result } = useAnalysis();
  const c = project.composite;
  const rupture = result?.structural?.rupture ?? null;
  const set = (patch: Partial<CompositeSpec>, key: string) => update(patchSection('composite', patch), `comp.${key}`);
  const fiberE = findMat(lists.fibers, c.fiber);
  const resinE = findMat(lists.resins, c.resin);
  const fiber = fiberE?.rec;
  const resin = resinE?.rec;
  const vf = c.fiber_volume_fraction;
  const overrides = project.layers.filter((l) => l.fiber && l.fiber !== c.fiber);
  const ambient = project.requirements.temperature_ref;

  return (
    <>
      <Section title="Fibre">
        <SelectField
          label="Fibre"
          value={c.fiber}
          options={matOptions(lists.fibers)}
          onChange={(v) => set({ fiber: v }, 'fiber')}
        />
        {fiberE ? <FiberCard e={fiberE} /> : <Empty>{lists.loaded ? 'Unknown fibre id' : 'Loading materials…'}</Empty>}
        {overrides.length ? (
          <p className="muted small">
            Layer fibre override{overrides.length > 1 ? 's' : ''}:{' '}
            {overrides.map((l) => `${l.id} → ${findMat(lists.fibers, l.fiber)?.rec.name ?? l.fiber}`).join(', ')}
          </p>
        ) : null}
      </Section>
      <Section title="Resin">
        <SelectField
          label="Resin"
          value={c.resin}
          options={matOptions(lists.resins)}
          onChange={(v) => set({ resin: v }, 'resin')}
        />
        {resinE ? <ResinCard e={resinE} /> : null}
      </Section>
      <Section title="Composite">
        <SliderField
          label="Fibre volume fraction"
          unit="Vf"
          value={vf}
          min={0.35}
          max={0.75}
          gt={0.3}
          lt={0.8}
          step={0.01}
          hint="Cured fibre volume fraction (0.3 < Vf < 0.8)"
          onChange={(v) => set({ fiber_volume_fraction: v }, 'vf')}
        />
        <SliderField
          label="Translation efficiency"
          unit="η"
          value={c.translation_efficiency}
          min={0.5}
          max={1}
          gt={0.3}
          step={0.01}
          hint="Fraction of fibre strength realised in the vessel (calibrate it from burst tests in the Testing step)"
          onChange={(v) => set({ translation_efficiency: v }, 'eta')}
        />
        <NumberField
          label="Cure temperature"
          unit="°C"
          value={c.cure_temperature}
          min={-50}
          max={400}
          step={5}
          hint={
            <>
              Stress-free temperature of the liner/composite bond; cooling to {sig(ambient, 3)} °C ambient (ΔT{' '}
              {sig(ambient - c.cure_temperature, 3)} K) sets thermal residual stresses.
              {resin?.cure_temperature != null ? (
                Math.abs(resin.cure_temperature - c.cure_temperature) > 1e-9 ? (
                  <>
                    {' '}
                    Resin final cure: {sig(resin.cure_temperature, 4)} °C —{' '}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() =>
                        set({ cure_temperature: resin.cure_temperature ?? c.cure_temperature }, 'cureResin')
                      }
                      title="Set the stress-free temperature to the resin's final cure temperature (Ctrl+Z undoes)"
                    >
                      use {sig(resin.cure_temperature, 4)} °C
                    </button>
                  </>
                ) : (
                  ' Matches the resin’s final cure temperature.'
                )
              ) : null}
            </>
          }
          onCommit={(v) => set({ cure_temperature: v }, 'cure')}
        />
        <Field
          label="Strength Weibull shape"
          hint={
            c.strength_weibull_shape == null
              ? `Vessel burst-strength scatter for stress rupture: fibre-family default${rupture ? ` (${sig(rupture.weibull_shape, 3)}, ${rupture.family})` : ''}`
              : 'Vessel burst-strength scatter for stress rupture (higher = less scatter)'
          }
        >
          <div className="inline">
            <Switch
              checked={c.strength_weibull_shape == null}
              label="Auto"
              onChange={(auto) =>
                set({ strength_weibull_shape: auto ? null : Number(sig(rupture?.weibull_shape ?? 20, 3)) }, 'wbl')
              }
            />
            <NumberInput
              ariaLabel="Strength Weibull shape"
              value={c.strength_weibull_shape ?? rupture?.weibull_shape ?? null}
              disabled={c.strength_weibull_shape == null}
              gt={1}
              step={1}
              onCommit={(v) => set({ strength_weibull_shape: v }, 'wblv')}
            />
          </div>
        </Field>
        <Field
          label="Rupture exponent"
          hint={
            c.rupture_exponent == null
              ? `Stress-rupture power-law exponent: calibrated to the ISO 11119 / 11439 stress ratios${rupture ? ` (${sig(rupture.exponent, 3)})` : ''}`
              : 'Stress-rupture power-law exponent (user override)'
          }
        >
          <div className="inline">
            <Switch
              checked={c.rupture_exponent == null}
              label="Auto"
              onChange={(auto) =>
                set({ rupture_exponent: auto ? null : Number(sig(rupture?.exponent ?? 30, 3)) }, 'rexp')
              }
            />
            <NumberInput
              ariaLabel="Rupture exponent"
              value={c.rupture_exponent ?? rupture?.exponent ?? null}
              disabled={c.rupture_exponent == null}
              gt={1}
              step={1}
              onCommit={(v) => set({ rupture_exponent: v }, 'rexpv')}
            />
          </div>
        </Field>
        {fiber && resin ? (
          <div className="card subtle">
            <div className="card-title">Derived ply (rule of mixtures)</div>
            <Props
              rows={[
                ['E₁ (fibre dir.)', sig((vf * fiber.E + (1 - vf) * resin.E) / 1000, 4), 'GPa'],
                ['Ply density', sig(vf * fiber.density + (1 - vf) * resin.density, 4), 'g/cm³'],
                [
                  'Fibre mass fraction',
                  sig(((vf * fiber.density) / (vf * fiber.density + (1 - vf) * resin.density)) * 100, 3),
                  '%',
                ],
                ['Design fibre strength', sig(fiber.strength * c.translation_efficiency, 4), 'MPa'],
                [
                  'α₁ ply (Schapery)',
                  sig(
                    ((fiber.E * fiber.cte1 * vf + resin.E * resin.cte * (1 - vf)) /
                      (fiber.E * vf + resin.E * (1 - vf))) *
                      1e6,
                    3,
                  ),
                  CTE_UNIT,
                ],
              ]}
            />
          </div>
        ) : null}
      </Section>
      <p className="muted small">
        The materials library (built-in and project-specific records) is below the 3D view. Custom records are saved
        with the project and take precedence over built-in ones with the same id.
      </p>
      {result ? <ChecksList checks={checksForStep(result.checks, 'materials')} title="Material checks" /> : null}
      <MaterialEditor />
    </>
  );
}

// ------------------------------------------------------------------ editor modal
function MaterialEditor() {
  const ed = useEditor();
  const { project, update } = useProject();
  const lists = useMaterialLists();
  const idFieldId = useId();
  const nameFieldId = useId();
  const filId = useId();
  if (!ed) return null;
  const meta = KIND_META[ed.kind];
  const d = ed.draft;
  const id = String(d.id ?? '').trim();
  const customs = project.materials[ed.kind] as { id: string }[];
  const idTaken = customs.some((r) => r.id === id && r.id !== ed.originalId);
  const idErr = !id ? 'Id required' : idTaken ? 'A custom record with this id exists' : null;
  const builtinSame = (lists[ed.kind] as MatEntry<{ id: string; name: string }>[]).find(
    (e) => !e.custom && e.rec.id === id,
  );
  const setD = (patch: Rec) => editorStore.set({ ...ed, draft: { ...ed.draft, ...patch } });
  const liner = ed.kind === 'liners';
  const polymer = liner && d.kind === 'polymer';
  const ultBelowYield = liner && Number(d.ultimate) < Number(d.yield);
  const usage = ed.originalId ? materialUsage(project, ed.kind, ed.originalId) : [];
  const renamed = !!ed.originalId && ed.originalId !== id;

  const save = () => {
    if (idErr) return;
    const rec = { ...toCustom(ed.kind, d), id, name: String(d.name ?? '').trim() || id };
    update((p) => {
      const list = [...(p.materials[ed.kind] as unknown as Rec[])];
      const i = ed.originalId != null ? list.findIndex((r) => r.id === ed.originalId) : -1;
      if (i >= 0) list[i] = rec;
      else list.push(rec);
      const next = { ...p, materials: { ...p.materials, [ed.kind]: list } };
      return ed.originalId ? renameMaterialRefs(next, ed.kind, ed.originalId, id) : next;
    });
    editorStore.set(null);
  };

  return (
    <Modal
      title={ed.originalId ? `Edit custom ${meta.one}` : `New custom ${meta.one}`}
      open
      onClose={() => editorStore.set(null)}
      footer={
        <>
          <Button onClick={() => editorStore.set(null)}>Cancel</Button>
          <Button variant="primary" icon="check" disabled={!!idErr} onClick={save}>
            {ed.originalId ? 'Save' : 'Add to project'}
          </Button>
        </>
      }
    >
      <div className="mat-editor">
        <Field label="Id" htmlFor={idFieldId} error={idErr}>
          <input
            id={idFieldId}
            className="text"
            value={String(d.id ?? '')}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setD({ id: e.target.value })}
          />
        </Field>
        {builtinSame && !idErr ? (
          <p className="muted small mat-note">
            <Icon name="info" size={12} /> Overrides the built-in “{builtinSame.rec.name}” in this project.
          </p>
        ) : null}
        {renamed && usage.length ? (
          <p className="muted small mat-note">
            <Icon name="info" size={12} /> References ({usage.join(', ')}) follow the new id.
          </p>
        ) : null}
        <Field label="Name" htmlFor={nameFieldId}>
          <input
            id={nameFieldId}
            className="text"
            value={String(d.name ?? '')}
            autoComplete="off"
            onChange={(e) => setD({ name: e.target.value })}
          />
        </Field>
        {ed.kind === 'fibers' ? (
          <Field label="Filaments" htmlFor={filId}>
            <input
              id={filId}
              className="text"
              value={String(d.filaments ?? '')}
              placeholder="e.g. 12K"
              onChange={(e) => setD({ filaments: e.target.value })}
            />
          </Field>
        ) : null}
        {liner ? (
          <SelectField<LinerKind>
            label="Liner type"
            value={polymer ? 'polymer' : 'metal'}
            options={[
              { value: 'metal', label: 'Metal (Type III)' },
              { value: 'polymer', label: 'Polymer (Type IV)' },
            ]}
            hint={
              polymer
                ? 'No autofrettage; liner strain, cure / service temperature and H₂ permeation checks'
                : 'Autofrettage, liner fatigue and leak-before-burst checks'
            }
            onChange={(v) => setD({ kind: v })}
          />
        ) : null}
        {[...meta.fields, ...(polymer ? POLYMER_LINER_FIELDS : [])].map((f) => {
          const sc = f.scale ?? 1;
          const v = d[f.key];
          return (
            <NumberField
              key={f.key}
              label={f.label}
              unit={f.unit || undefined}
              value={typeof v === 'number' ? Number((v * sc).toPrecision(10)) : null}
              gt={f.gt}
              lt={f.lt}
              min={f.min}
              max={f.max}
              step={f.step}
              hint={f.hint}
              onCommit={(x) => setD({ [f.key]: Number((x / sc).toPrecision(10)) })}
            />
          );
        })}
        {ultBelowYield ? <Banner kind="warn">Ultimate strength is below the yield strength.</Banner> : null}
        <p className="muted small">
          Use qualified, lot-specific values: the analysis takes them as given. Undo (Ctrl+Z) reverts a save.
        </p>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ bottom: library table
export function MaterialsBottom() {
  const tab = useTab();
  const lists = useMaterialLists();
  const { project } = useProject();
  const counts = (k: MatKind) => lists[k].length;
  return (
    <div className="export-bottom">
      <div className="tabs" role="tablist" aria-label="Materials library">
        {(Object.keys(KIND_META) as MatKind[]).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? 'on' : ''}
            onClick={() => tabStore.set(k)}
          >
            {KIND_META[k].many} <span className="muted">{counts(k)}</span>
            {project.materials[k].length ? (
              <span className="tab-count">{project.materials[k].length} custom</span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="tab-body" role="tabpanel">
        <LibraryTable kind={tab} />
      </div>
    </div>
  );
}

function LibraryTable({ kind }: { kind: MatKind }) {
  const { project, update } = useProject();
  const lists = useMaterialLists();
  const meta = KIND_META[kind];
  const entries = lists[kind] as unknown as MatEntry<Rec & { id: string; name: string }>[];
  const takenIds = new Set((project.materials[kind] as { id: string }[]).map((r) => r.id));
  const allIds = new Set([...takenIds, ...entries.map((e) => e.rec.id)]);

  const openNew = () =>
    editorStore.set({
      kind,
      originalId: null,
      draft: meta.fresh(uniqueId(`custom-${meta.one.split(' ')[0]}`, allIds)),
    });
  const duplicate = (e: MatEntry<Rec & { id: string; name: string }>) =>
    editorStore.set({
      kind,
      originalId: null,
      draft: {
        ...toCustom(kind, e.rec),
        id: uniqueId(`${e.rec.id}-custom`, allIds),
        name: `${e.rec.name} (custom)`,
      },
    });
  const edit = (e: MatEntry<Rec & { id: string; name: string }>) =>
    editorStore.set({ kind, originalId: e.rec.id, draft: toCustom(kind, e.rec) });
  const remove = (id: string) =>
    update((p) => ({
      ...p,
      materials: { ...p.materials, [kind]: (p.materials[kind] as { id: string }[]).filter((r) => r.id !== id) },
    }));

  const used = (id: string) => materialUsage(project, kind, id);
  const builtinIds = new Set(entries.filter((e) => !e.custom).map((e) => e.rec.id));

  if (!lists.loaded && !entries.length) return <Empty>Loading materials…</Empty>;

  return (
    <div className="lib">
      <div className="toolbar lib-toolbar">
        <Button size="sm" icon="plus" onClick={openNew}>
          New custom {meta.one}
        </Button>
        <span className="muted small">
          Built-in values are typical datasheet numbers for preliminary design. Duplicate one as a custom record to
          enter qualified, lot-specific allowables.
        </span>
      </div>
      <div className="table-scroll lib-scroll">
        <table className="data-table lib-table">
          <thead>
            <tr>
              <th>
                Name <span className="th-unit">/ id</span>
              </th>
              {meta.fields.map((f) => (
                <th key={f.key} className="num" title={`${f.label}${f.unit ? ` [${f.unit}]` : ''}`}>
                  {f.short}
                  {f.unit ? <span className="th-unit"> {f.unit}</span> : null}
                </th>
              ))}
              <th className="lib-act">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const u = e.shadowed ? [] : used(e.rec.id);
              const dangling = e.custom && u.length > 0 && !builtinIds.has(e.rec.id);
              return (
                <tr key={`${e.custom ? 'c' : 'b'}-${e.rec.id}`} className={e.shadowed ? 'shadowed' : ''}>
                  <td>
                    <div className="lib-name">
                      <span>{e.rec.name}</span>
                      {kind === 'liners' && e.rec.kind === 'polymer' ? <LinerTypeBadge polymer /> : null}
                      {e.custom ? <span className="type-badge t-custom">custom</span> : null}
                      {e.shadowed ? (
                        <span className="type-badge t-muted" title="A custom record with this id takes precedence">
                          overridden
                        </span>
                      ) : null}
                      {u.length ? (
                        <span className="type-badge t-use" title={`Used by: ${u.join(', ')}`}>
                          in use
                        </span>
                      ) : null}
                    </div>
                    <div className="muted mono-id">{e.rec.id}</div>
                  </td>
                  {meta.fields.map((f) => (
                    <td key={f.key} className="num">
                      {disp(e.rec[f.key], f)}
                    </td>
                  ))}
                  <td className={e.custom ? 'row-actions lib-act' : 'lib-act'}>
                    {e.custom ? (
                      <>
                        <button type="button" aria-label={`Edit ${e.rec.name}`} title="Edit" onClick={() => edit(e)}>
                          <Icon name="edit" size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Duplicate ${e.rec.name}`}
                          title="Duplicate"
                          onClick={() => duplicate(e)}
                        >
                          <Icon name="copy" size={13} />
                        </button>
                        <button
                          type="button"
                          className="danger"
                          aria-label={`Delete ${e.rec.name}`}
                          title={
                            dangling
                              ? `In use (${u.join(', ')}): select another ${meta.one} first`
                              : u.length
                                ? `Delete (the built-in record with this id is used again)`
                                : 'Delete (Ctrl+Z undoes)'
                          }
                          disabled={dangling}
                          onClick={() => remove(e.rec.id)}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="copy"
                        onClick={() => duplicate(e)}
                        title="Create an editable project-specific copy"
                      >
                        Duplicate as custom
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
