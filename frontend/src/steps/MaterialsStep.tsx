import type { CompositeSpec, Fiber, Resin } from '../api/types';
import { Section, SelectField, SliderField } from '../components/fields';
import { Empty } from '../components/ui';
import { useAnalysis, useCatalog } from '../state/analysis';
import { patchSection, useProject } from '../state/projectStore';
import { sig } from '../util/format';
import { ChecksList } from './shared';
import { checksForStep } from './stepStatus';

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

function FiberCard({ f }: { f: Fiber }) {
  return (
    <div className="card">
      <div className="card-title">
        {f.name} <span className="muted">{f.filaments}</span>
      </div>
      <Props
        rows={[
          ['Tensile modulus', sig(f.E / 1000, 4), 'GPa'],
          ['Tensile strength', sig(f.strength, 4), 'MPa'],
          ['Elongation', sig(f.elongation * 100, 3), '%'],
          ['Density', sig(f.density, 4), 'g/cm³'],
          ['Linear density', sig(f.tex, 4), 'tex'],
        ]}
      />
    </div>
  );
}

function ResinCard({ r }: { r: Resin }) {
  return (
    <div className="card">
      <div className="card-title">{r.name}</div>
      <Props
        rows={[
          ['Modulus', sig(r.E / 1000, 3), 'GPa'],
          ['Poisson ratio', sig(r.nu, 3)],
          ['Density', sig(r.density, 4), 'g/cm³'],
        ]}
      />
    </div>
  );
}

export function MaterialsPanel() {
  const { project, update } = useProject();
  const { materials } = useCatalog();
  const { result } = useAnalysis();
  const c = project.composite;
  const set = (patch: Partial<CompositeSpec>, key: string) => update(patchSection('composite', patch), `comp.${key}`);
  const fiber = materials?.fibers.find((f) => f.id === c.fiber);
  const resin = materials?.resins.find((r) => r.id === c.resin);
  const vf = c.fiber_volume_fraction;

  return (
    <>
      <Section title="Fibre">
        <SelectField
          label="Fibre"
          value={c.fiber}
          options={(materials?.fibers ?? []).map((f) => ({ value: f.id, label: f.name }))}
          onChange={(v) => set({ fiber: v }, 'fiber')}
        />
        {fiber ? <FiberCard f={fiber} /> : <Empty>{materials ? 'Unknown fibre id' : 'Loading materials…'}</Empty>}
      </Section>
      <Section title="Resin">
        <SelectField
          label="Resin"
          value={c.resin}
          options={(materials?.resins ?? []).map((r) => ({ value: r.id, label: r.name }))}
          onChange={(v) => set({ resin: v }, 'resin')}
        />
        {resin ? <ResinCard r={resin} /> : null}
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
          hint="Fraction of fibre strength realised in the vessel"
          onChange={(v) => set({ translation_efficiency: v }, 'eta')}
        />
        {fiber && resin ? (
          <div className="card subtle">
            <div className="card-title">Derived ply (rule of mixtures)</div>
            <Props
              rows={[
                ['E₁ (fibre dir.)', sig((vf * fiber.E + (1 - vf) * resin.E) / 1000, 4), 'GPa'],
                ['Ply density', sig(vf * fiber.density + (1 - vf) * resin.density, 4), 'g/cm³'],
                ['Fibre mass fraction', sig(((vf * fiber.density) / (vf * fiber.density + (1 - vf) * resin.density)) * 100, 3), '%'],
                ['Design fibre strength', sig(fiber.strength * c.translation_efficiency, 4), 'MPa'],
              ]}
            />
          </div>
        ) : null}
      </Section>
      {result ? <ChecksList checks={checksForStep(result.checks, 'materials')} title="Material checks" /> : null}
    </>
  );
}
