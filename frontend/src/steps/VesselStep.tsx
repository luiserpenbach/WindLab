import type { DomeType, LinerSpec, Requirements } from '../api/types';
import { NumberField, Section, SelectField, Segmented, Switch, Field, NumberInput } from '../components/fields';
import { LineChart, type Series } from '../components/LineChart';
import { Banner, Button } from '../components/ui';
import { useAnalysis } from '../state/analysis';
import { findMat, matOptions, useMaterialLists } from '../state/materials';
import { patchSection, useProject } from '../state/projectStore';
import { layerColors } from '../viewer/colors';
import { sig } from '../util/format';
import { ChecksList } from './shared';
import { checksForStep } from './stepStatus';

export function VesselPanel() {
  const { project, update } = useProject();
  const { result } = useAnalysis();
  const lists = useMaterialLists();
  const l = project.liner;
  const r = project.requirements;
  const setL = (patch: Partial<LinerSpec>, key: string) => update(patchSection('liner', patch), `liner.${key}`);
  const setR = (patch: Partial<Requirements>, key: string) => update(patchSection('requirements', patch), `req.${key}`);
  const linerE = findMat(lists.liners, l.material);
  const linerMat = linerE?.rec;
  const st = result?.structural;
  const bar = (mpa: number) => `${sig(mpa * 10, 4)} bar`;
  // Mirrors the backend's auto values (core/geometry.py) for display.
  const autoNeckT = 3 * l.wall_thickness;
  const autoBlend = (rb: number) => Math.min(Math.max(1.8 * rb, rb + 15), 0.6 * l.radius);
  const autoBlendA = autoBlend(l.boss_radius_a);
  const autoBlendB = autoBlend(l.boss_radius_b);
  const geodesicHelicals = project.layers.filter((x) => x.type === 'helical' && x.winding !== 'non-geodesic');
  const unequalBosses = l.boss_radius_a !== l.boss_radius_b;
  const tempErr = r.temperature_min > r.temperature_max ? 'Minimum is above maximum' : null;
  // One update = one undo step for all layers.
  const switchToNonGeodesic = () =>
    update((p) => ({
      ...p,
      layers: p.layers.map((x) => (x.type === 'helical' ? { ...x, winding: 'non-geodesic' as const } : x)),
    }));

  return (
    <>
      <Section title="Liner">
        <SelectField
          label="Material"
          value={l.material}
          options={matOptions(lists.liners)}
          onChange={(v) => setL({ material: v }, 'material')}
          hint={
            linerMat
              ? `${linerE?.custom ? 'Custom · ' : ''}E ${sig(linerMat.E / 1000, 3)} GPa · Rp0.2 ${sig(linerMat.yield, 3)} MPa · Rm ${sig(linerMat.ultimate, 3)} MPa · ρ ${linerMat.density} g/cm³ · K_IC ${sig(linerMat.k_ic, 3)} MPa√m`
              : lists.loaded
                ? 'Unknown material id: add it to the materials library (Materials step)'
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
        {unequalBosses && geodesicHelicals.length ? (
          <Banner kind="info">
            <strong>Unequal polar openings.</strong> Geodesic helicals turn at the larger boss radius on both ends.
            Non-geodesic winding uses friction to turn close to each boss.{' '}
            <span className="muted">
              {geodesicHelicals.length === 1
                ? `Layer ${geodesicHelicals[0].id} is geodesic.`
                : `${geodesicHelicals.length} helical layers are geodesic.`}
            </span>
            <div className="banner-actions">
              <Button size="sm" onClick={switchToNonGeodesic} title="One undo step (Ctrl+Z)">
                Switch helicals to non-geodesic
              </Button>
            </div>
          </Banner>
        ) : null}
        <NumberField
          label="Boss length"
          unit="mm"
          value={l.boss_length}
          min={0}
          step={1}
          hint="Protrusion beyond the dome"
          onCommit={(v) => setL({ boss_length: v }, 'bossL')}
        />
        <Field
          label="Neck thickness"
          hint={
            l.neck_thickness == null
              ? `Auto: 3 × wall = ${sig(autoNeckT, 3)} mm · liner wall at the boss`
              : 'Liner wall thickness at the boss'
          }
        >
          <div className="inline">
            <Switch
              checked={l.neck_thickness == null}
              label="Auto"
              onChange={(auto) => setL({ neck_thickness: auto ? null : Number(sig(autoNeckT, 3)) }, 'neckTAuto')}
            />
            <NumberInput
              ariaLabel="Neck thickness"
              value={l.neck_thickness ?? autoNeckT}
              disabled={l.neck_thickness == null}
              unit="mm"
              gt={0}
              step={0.1}
              onCommit={(v) => setL({ neck_thickness: v }, 'neckT')}
            />
          </div>
        </Field>
        <Field
          label="Neck blend radius"
          hint={
            l.neck_blend_radius == null
              ? `Auto: A ${sig(autoBlendA, 3)} mm · B ${sig(autoBlendB, 3)} mm · wall thickens inside this radius`
              : 'Radius where the wall starts thickening towards the boss (both ends; no effect at a boss at or above it)'
          }
        >
          <div className="inline">
            <Switch
              checked={l.neck_blend_radius == null}
              label="Auto"
              onChange={(auto) =>
                setL({ neck_blend_radius: auto ? null : Number(sig(Math.max(autoBlendA, autoBlendB), 3)) }, 'neckRAuto')
              }
            />
            <NumberInput
              ariaLabel="Neck blend radius"
              value={l.neck_blend_radius}
              placeholder="auto"
              disabled={l.neck_blend_radius == null}
              unit="mm"
              gt={0}
              step={1}
              onCommit={(v) => setL({ neck_blend_radius: v }, 'neckR')}
            />
          </div>
        </Field>
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
        <Field
          label="Operating temp."
          hint={`Stress ratio and liner stress are checked at MEOP at both ends (${sig(r.temperature_max - r.temperature_min, 3)} K range)`}
          error={tempErr}
        >
          <div className="inline range-pair">
            <NumberInput
              ariaLabel="Minimum operating temperature"
              value={r.temperature_min}
              unit="°C"
              min={-273}
              step={5}
              className="numin-short-unit"
              onCommit={(v) => setR({ temperature_min: v }, 'tmin')}
            />
            <span className="muted" aria-hidden="true">
              to
            </span>
            <NumberInput
              ariaLabel="Maximum operating temperature"
              value={r.temperature_max}
              unit="°C"
              min={-273}
              step={5}
              className="numin-short-unit"
              onCommit={(v) => setR({ temperature_max: v }, 'tmax')}
            />
          </div>
        </Field>
        <NumberField
          label="Ambient (test)"
          unit="°C"
          value={r.temperature_ref}
          min={-273}
          step={1}
          hint={`Temperature of autofrettage and proof; cure / stress-free ${sig(project.composite.cure_temperature, 4)} °C (Materials step)`}
          onCommit={(v) => setR({ temperature_ref: v }, 'tref')}
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
