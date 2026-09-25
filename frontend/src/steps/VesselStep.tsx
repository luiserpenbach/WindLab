import type { DomeType, LinerSpec, Requirements } from '../api/types';
import { NumberField, Section, SelectField, Segmented, Switch, Field, NumberInput } from '../components/fields';
import { LineChart, type Series } from '../components/LineChart';
import { useAnalysis, useCatalog } from '../state/analysis';
import { patchSection, useProject } from '../state/projectStore';
import { layerColors } from '../viewer/colors';
import { sig } from '../util/format';
import { ChecksList } from './shared';
import { checksForStep } from './stepStatus';

export function VesselPanel() {
  const { project, update } = useProject();
  const { result } = useAnalysis();
  const { materials } = useCatalog();
  const l = project.liner;
  const r = project.requirements;
  const setL = (patch: Partial<LinerSpec>, key: string) => update(patchSection('liner', patch), `liner.${key}`);
  const setR = (patch: Partial<Requirements>, key: string) => update(patchSection('requirements', patch), `req.${key}`);
  const linerMat = materials?.liners.find((m) => m.id === l.material);
  const st = result?.structural;
  const bar = (mpa: number) => `${sig(mpa * 10, 4)} bar`;

  return (
    <>
      <Section title="Liner">
        <SelectField
          label="Material"
          value={l.material}
          options={(materials?.liners ?? []).map((m) => ({ value: m.id, label: m.name }))}
          onChange={(v) => setL({ material: v }, 'material')}
          hint={
            linerMat
              ? `E ${sig(linerMat.E / 1000, 3)} GPa · Rp0.2 ${sig(linerMat.yield, 3)} MPa · Rm ${sig(linerMat.ultimate, 3)} MPa · ρ ${linerMat.density} g/cm³`
              : undefined
          }
        />
        <NumberField
          label="Outer radius"
          unit="mm"
          value={l.radius}
          gt={0}
          step={1}
          onCommit={(v) => setL({ radius: v }, 'radius')}
        />
        <NumberField
          label="Cylinder length"
          unit="mm"
          value={l.cyl_length}
          min={0}
          step={5}
          onCommit={(v) => setL({ cyl_length: v }, 'cyl')}
        />
        <NumberField
          label="Wall thickness"
          unit="mm"
          value={l.wall_thickness}
          gt={0}
          step={0.1}
          onCommit={(v) => setL({ wall_thickness: v }, 'wall')}
        />
        <Field label="Dome type">
          <Segmented<DomeType>
            ariaLabel="Dome type"
            value={l.dome_type}
            options={[
              { value: 'isotensoid', label: 'Isotensoid' },
              { value: 'hemispherical', label: 'Hemi' },
              { value: 'elliptical', label: 'Elliptical' },
            ]}
            onChange={(v) => setL({ dome_type: v }, 'dome')}
          />
        </Field>
        {l.dome_type === 'elliptical' ? (
          <NumberField
            label="Dome aspect"
            unit="h/R"
            value={l.dome_aspect}
            gt={0.2}
            max={1.5}
            step={0.05}
            hint="Dome height / cylinder radius (0.2 – 1.5)"
            onCommit={(v) => setL({ dome_aspect: v }, 'aspect')}
          />
        ) : null}
        <NumberField
          label="Boss radius A"
          unit="mm"
          value={l.boss_radius_a}
          gt={0}
          step={1}
          hint="Polar boss, end A (z < 0)"
          onCommit={(v) => setL({ boss_radius_a: v }, 'bossA')}
        />
        <NumberField
          label="Boss radius B"
          unit="mm"
          value={l.boss_radius_b}
          gt={0}
          step={1}
          hint="Polar boss, end B (z > 0)"
          onCommit={(v) => setL({ boss_radius_b: v }, 'bossB')}
        />
        <NumberField
          label="Boss length"
          unit="mm"
          value={l.boss_length}
          min={0}
          step={1}
          hint="Protrusion beyond the dome"
          onCommit={(v) => setL({ boss_length: v }, 'bossL')}
        />
        <NumberField
          label="Shaft radius"
          unit="mm"
          value={l.shaft_radius}
          gt={0}
          step={1}
          hint="Winding shaft beyond the bosses"
          onCommit={(v) => setL({ shaft_radius: v }, 'shaft')}
        />
      </Section>

      <Section title="Requirements">
        <NumberField
          label="MEOP"
          unit="MPa"
          value={r.meop}
          gt={0}
          step={1}
          hint={`= ${bar(r.meop)} · max. expected operating pressure`}
          onCommit={(v) => setR({ meop: v }, 'meop')}
        />
        <NumberField
          label="Burst factor"
          unit="×"
          value={r.burst_factor}
          min={1}
          step={0.05}
          hint={`Required burst ${sig(r.meop * r.burst_factor, 4)} MPa (${bar(r.meop * r.burst_factor)})`}
          onCommit={(v) => setR({ burst_factor: v }, 'bf')}
        />
        <NumberField
          label="Proof factor"
          unit="×"
          value={r.proof_factor}
          min={1}
          step={0.05}
          hint={`Proof ${sig(r.meop * r.proof_factor, 4)} MPa (${bar(r.meop * r.proof_factor)})`}
          onCommit={(v) => setR({ proof_factor: v }, 'pf')}
        />
        <Field
          label="Autofrettage"
          hint={
            st
              ? `${st.autofrettage_auto ? 'Auto-selected' : 'Set'} ${sig(st.autofrettage_pressure, 4)} MPa · window ${sig(st.autofrettage_window[0], 4)} – ${sig(st.autofrettage_window[1], 4)} MPa`
              : 'Pressure that yields the liner to set compressive residual stress'
          }
        >
          <div className="inline">
            <Switch
              checked={r.autofrettage_pressure == null}
              label="Auto"
              onChange={(auto) =>
                setR(
                  {
                    autofrettage_pressure: auto
                      ? null
                      : Number(sig(st?.autofrettage_pressure ?? r.meop * r.proof_factor * 1.1, 4)),
                  },
                  'af',
                )
              }
            />
            <NumberInput
              ariaLabel="Autofrettage pressure"
              value={r.autofrettage_pressure ?? st?.autofrettage_pressure ?? null}
              disabled={r.autofrettage_pressure == null}
              unit="MPa"
              gt={0}
              step={1}
              onCommit={(v) => setR({ autofrettage_pressure: v }, 'afp')}
            />
          </div>
        </Field>
        <NumberField
          label="Stress ratio limit"
          unit="σ/σu"
          value={r.stress_ratio_limit}
          gt={0}
          max={1}
          step={0.05}
          hint="Max fibre stress at MEOP / fibre strength (stress rupture)"
          onCommit={(v) => setR({ stress_ratio_limit: v }, 'srl')}
        />
        <NumberField
          label="Design cycles"
          unit="cycles"
          value={r.design_cycles}
          min={1}
          integer
          step={100}
          onCommit={(v) => setR({ design_cycles: v }, 'cyc')}
        />
        <NumberField
          label="Fatigue scatter factor"
          unit="×"
          value={r.fatigue_scatter_factor}
          min={1}
          step={0.5}
          hint={`Liner must reach ${sig(r.design_cycles * r.fatigue_scatter_factor, 4)} cycles`}
          onCommit={(v) => setR({ fatigue_scatter_factor: v }, 'fsf')}
        />
      </Section>

      <Section title="Notes" defaultOpen={false}>
        <textarea
          className="notes"
          aria-label="Project notes"
          defaultValue={project.notes}
          key={project.notes}
          rows={4}
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== project.notes) update((p) => ({ ...p, notes: v }), 'notes');
          }}
        />
      </Section>

      {result ? <ChecksList checks={checksForStep(result.checks, 'vessel')} title="Vessel checks" /> : null}
    </>
  );
}

export function MeridianChart({ height = 240 }: { height?: number }) {
  const { result } = useAnalysis();
  const { project } = useProject();
  const colors = layerColors(project.layers);
  const series: Series[] = [];
  if (result) {
    series.push({
      id: 'lo',
      name: 'Liner outer',
      x: result.liner_outer.x,
      y: result.liner_outer.y,
      color: 'var(--liner)',
      width: 2,
    });
    series.push({
      id: 'li',
      name: 'Liner inner',
      x: result.liner_inner.x,
      y: result.liner_inner.y,
      color: 'var(--liner)',
      dash: '4 3',
      width: 1.5,
    });
    result.layers.forEach((lr) =>
      series.push({
        id: `s-${lr.id}`,
        name: `${lr.index + 1} ${lr.id}`,
        x: lr.surface.x,
        y: lr.surface.y,
        color: colors.get(lr.id),
        width: 1.5,
        hideLegend: result.layers.length > 10,
      }),
    );
  }
  return (
    <LineChart
      title="Meridian profile"
      series={series}
      xLabel="z"
      xUnit="mm"
      yLabel="r"
      yUnit="mm"
      height={height}
      yZero
      equalAspect
      emptyText="Run an analysis to see the profile"
    />
  );
}

export function VesselBottom() {
  return (
    <div className="bottom-grid one">
      <MeridianChart />
    </div>
  );
}
