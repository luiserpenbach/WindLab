import { useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type {
  AxesCount,
  ContinuousSpec,
  Controller,
  MachineAxis,
  MachineSpec,
  RotaryReset,
  TensionOutput,
} from '../api/types';
import {
  Field,
  NumberField,
  NumberInput,
  Section,
  Segmented,
  Select,
  SelectField,
  Switch,
  TextInput,
} from '../components/fields';
import { Banner, Button, Spinner, StatusPill } from '../components/ui';
import { useAnalysis, useCatalog } from '../state/analysis';
import { axis, normalizeProject } from '../state/defaults';
import { patchSection, useProject } from '../state/projectStore';
import { useUi } from '../state/uiStore';
import { sig } from '../util/format';
import { ChecksList } from './shared';
import { checksForStep } from './stepStatus';

type AxisKey = 'carriage' | 'mandrel' | 'crossfeed' | 'eye';

const AXES_HINT: Record<AxesCount, string> = {
  2: 'Mandrel + carriage only: the eye stays at one fixed radius clear of the whole part (no crossfeed). Simplest machine; longer free fibre on the domes.',
  3: 'Mandrel, carriage and crossfeed: the eye follows the surface at the set clearance.',
  4: 'Adds payout-eye rotation so the band stays flat on the domes.',
};

const AXIS_META: Record<AxisKey, { label: string; kind: 'linear' | 'rotary'; desc: string }> = {
  carriage: { label: 'Carriage', kind: 'linear', desc: 'Eye travel along the mandrel axis' },
  mandrel: { label: 'Mandrel', kind: 'rotary', desc: 'Mandrel rotation' },
  crossfeed: { label: 'Crossfeed', kind: 'linear', desc: 'Eye radial distance' },
  eye: { label: 'Eye', kind: 'rotary', desc: 'Payout eye rotation (4-axis)' },
};

function grblHints(m: MachineSpec): { kind: 'warn' | 'info'; text: string }[] {
  if (m.controller !== 'grbl') return [];
  const out: { kind: 'warn' | 'info'; text: string }[] = [
    {
      kind: 'info',
      text: 'Stock GRBL only drives X, Y and Z. Map the mandrel to a linear letter (e.g. Y or Z) and set its scale to machine units per degree (e.g. 1 unit = 1° → scale 1).',
    },
    {
      kind: 'info',
      text: 'GRBL stores positions as 32-bit floats: a cumulative mandrel angle loses resolution after many turns. Use rotary reset “layer” or “circuit” (G92) to keep coordinates small.',
    },
  ];
  const rotLetters = /^[ABC]$/i;
  if (rotLetters.test(m.mandrel.letter))
    out.push({ kind: 'warn', text: `Mandrel letter “${m.mandrel.letter}” is not supported by stock GRBL.` });
  if (m.axes_count === 4 && m.eye && rotLetters.test(m.eye.letter))
    out.push({ kind: 'warn', text: `Eye letter “${m.eye.letter}” needs a 4-axis GRBL fork (e.g. grblHAL).` });
  if (m.tension_output === 'm67')
    out.push({
      kind: 'warn',
      text: 'GRBL has no M67 analog output. Use “spindle” (S word / PWM) for tension control.',
    });
  if (m.rotary_reset === 'none')
    out.push({ kind: 'warn', text: 'Rotary reset “none” with GRBL risks float precision loss on long programs.' });
  const letters = [
    m.carriage.letter,
    m.mandrel.letter,
    ...(m.axes_count >= 3 ? [m.crossfeed.letter] : []),
    ...(m.axes_count === 4 && m.eye ? [m.eye.letter] : []),
  ].map((x) => x.toUpperCase());
  if (new Set(letters).size !== letters.length) out.push({ kind: 'warn', text: 'Two axes share the same letter.' });
  return out;
}

export function MachinePanel() {
  const { project, update } = useProject();
  const { machines } = useCatalog();
  const { result } = useAnalysis();
  const m = project.machine;
  const lastEye = useRef<MachineAxis | null>(m.eye);
  const set = (patch: Partial<MachineSpec>, key: string) => update(patchSection('machine', patch), `mach.${key}`);
  const setAxis = (k: AxisKey, patch: Partial<MachineAxis>, key: string) =>
    update((p) => {
      const cur = p.machine[k];
      if (!cur) return p;
      return { ...p, machine: { ...p.machine, [k]: { ...cur, ...patch } } };
    }, `axis.${k}.${key}`);
  const axes: AxisKey[] =
    m.axes_count === 4
      ? ['carriage', 'mandrel', 'crossfeed', 'eye']
      : m.axes_count === 3
        ? ['carriage', 'mandrel', 'crossfeed']
        : ['carriage', 'mandrel'];
  const hints = grblHints(m);

  return (
    <>
      <Section title="Machine">
        <Field label="Preset">
          <Select
            ariaLabel="Machine preset"
            value={null}
            placeholder={machines.length ? 'Load preset…' : 'No presets'}
            options={machines.map((x) => ({ value: x.id, label: x.label }))}
            onChange={(id) => {
              const pr = machines.find((x) => x.id === id);
              if (pr) {
                const machine = normalizeProject({ machine: pr.machine }).machine;
                lastEye.current = machine.eye ?? lastEye.current;
                update((p) => ({ ...p, machine }));
              }
            }}
          />
        </Field>
        <Field label="Name">
          <TextInput value={m.name} ariaLabel="Machine name" onCommit={(v) => set({ name: v }, 'name')} />
        </Field>
        <Field label="Axes" hint={AXES_HINT[m.axes_count]}>
          <Segmented<AxesCount>
            ariaLabel="Axis count"
            value={m.axes_count}
            options={[
              { value: 2, label: '2-axis' },
              { value: 3, label: '3-axis' },
              { value: 4, label: '4-axis (eye)' },
            ]}
            onChange={(n) => {
              if (n === 4) {
                set({ axes_count: 4, eye: m.eye ?? lastEye.current ?? axis('B', 36000, 1440, null, null) }, 'axes');
              } else {
                lastEye.current = m.eye ?? lastEye.current;
                set({ axes_count: n, eye: null }, 'axes');
              }
            }}
          />
        </Field>
        <Field label="Controller">
          <Segmented<Controller>
            ariaLabel="Controller"
            value={m.controller}
            options={[
              { value: 'linuxcnc', label: 'LinuxCNC' },
              { value: 'grbl', label: 'GRBL' },
            ]}
            onChange={(v) => set({ controller: v }, 'ctrl')}
          />
        </Field>
        {hints.map((h, i) => (
          <Banner key={i} kind={h.kind}>
            {h.text}
          </Banner>
        ))}
      </Section>

      <Section title="Axes">
        <div className="table-scroll">
          <table className="data-table axis-table">
            <thead>
              <tr>
                <th />
                {axes.map((k) => (
                  <th
                    key={k}
                    scope="col"
                    title={`${AXIS_META[k].desc} [${AXIS_META[k].kind === 'linear' ? 'mm' : 'deg'}]`}
                  >
                    {AXIS_META[k].label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" title="G-code axis letter">
                  Letter
                </th>
                {axes.map((k) => (
                  <td key={k}>
                    <input
                      className="text letter"
                      aria-label={`${AXIS_META[k].label} letter`}
                      value={m[k]?.letter ?? ''}
                      maxLength={1}
                      onChange={(e) => {
                        const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
                        if (v) setAxis(k, { letter: v }, 'letter');
                      }}
                    />
                  </td>
                ))}
              </tr>
              <AxisRow
                label="Vmax"
                unit="u/min"
                title="Max velocity [machine units/min]"
                axes={axes}
                m={m}
                field="max_velocity"
                gt={0}
                step={100}
                onSet={setAxis}
              />
              <AxisRow
                label="Amax"
                unit="u/s²"
                title="Max acceleration [machine units/s²]"
                axes={axes}
                m={m}
                field="max_accel"
                gt={0}
                step={10}
                onSet={setAxis}
              />
              <AxisRow
                label="Min"
                title="Soft limit min [machine units], blank = none"
                axes={axes}
                m={m}
                field="min"
                nullable
                onSet={setAxis}
              />
              <AxisRow
                label="Max"
                title="Soft limit max [machine units], blank = none"
                axes={axes}
                m={m}
                field="max"
                nullable
                onSet={setAxis}
              />
              <AxisRow
                label="Scale"
                title="Machine units per mm (linear) or per degree (rotary)"
                axes={axes}
                m={m}
                field="scale"
                step={0.1}
                onSet={setAxis}
              />
              <tr>
                <th scope="row">Invert</th>
                {axes.map((k) => (
                  <td key={k} className="center">
                    <input
                      type="checkbox"
                      aria-label={`${AXIS_META[k].label} invert`}
                      checked={m[k]?.invert ?? false}
                      onChange={(e) => setAxis(k, { invert: e.target.checked }, 'inv')}
                    />
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Velocity in machine units/min, acceleration in units/s². Scale: machine units per mm (linear) or per degree
          (rotary). Leave limits blank for none.
        </p>
      </Section>

      <Section title="Kinematics">
        <NumberField
          label="Carriage offset"
          unit="mm"
          value={m.carriage_offset}
          step={10}
          hint="Machine carriage coordinate of the vessel mid-plane (z = 0)"
          onCommit={(v) => set({ carriage_offset: v }, 'co')}
        />
        {m.axes_count >= 3 ? (
          <NumberField
            label="Crossfeed zero radius"
            unit="mm"
            value={m.crossfeed_zero_radius}
            step={1}
            hint="Eye distance from mandrel axis when crossfeed reads 0"
            onCommit={(v) => set({ crossfeed_zero_radius: v }, 'czr')}
          />
        ) : null}
        <NumberField
          label="Eye clearance"
          unit="mm"
          value={m.eye_clearance}
          gt={0}
          step={1}
          hint={
            m.axes_count === 2
              ? 'Clearance from the largest wound radius the eye passes (it runs at one fixed radius)'
              : 'Eye clearance from the wound surface'
          }
          onCommit={(v) => set({ eye_clearance: v }, 'ec')}
        />
        <NumberField
          label="Fibre speed"
          unit="mm/s"
          value={m.fiber_speed}
          gt={0}
          step={10}
          hint={`= ${(m.fiber_speed * 0.06).toFixed(1)} m/min target delivery speed`}
          onCommit={(v) => set({ fiber_speed: v }, 'fs')}
        />
        <NumberField
          label="Samples per pass"
          unit="pts"
          value={m.samples_per_pass}
          min={20}
          max={2000}
          integer
          step={10}
          hint="Path resolution per traverse (20 – 2000)"
          onCommit={(v) => set({ samples_per_pass: v }, 'spp')}
        />
      </Section>

      <Section title="Output">
        <SelectField<TensionOutput>
          label="Tension output"
          value={m.tension_output}
          options={[
            { value: 'none', label: 'None' },
            { value: 'm67', label: 'M67 analog out (LinuxCNC)' },
            { value: 'spindle', label: 'Spindle S word / PWM' },
          ]}
          onChange={(v) => set({ tension_output: v }, 'to')}
        />
        {m.tension_output !== 'none' ? (
          <NumberField
            label="Tension scale"
            unit="/N"
            value={m.tension_scale}
            step={0.1}
            hint="Output units per newton of tension"
            onCommit={(v) => set({ tension_scale: v }, 'ts')}
          />
        ) : null}
        <SelectField<RotaryReset>
          label="Rotary reset"
          value={m.rotary_reset}
          options={[
            { value: 'none', label: 'None (cumulative angle)' },
            { value: 'layer', label: 'Every layer' },
            { value: 'circuit', label: 'Every circuit' },
          ]}
          onChange={(v) => set({ rotary_reset: v }, 'rr')}
          hint="Re-zero the mandrel coordinate (G92) to limit numeric growth"
        />
        <Field
          label="Pause between layers"
          hint={project.continuous.enabled ? 'Skipped: continuous winding is enabled' : undefined}
        >
          <Switch
            checked={m.pause_between_layers}
            onChange={(v) => set({ pause_between_layers: v }, 'pbl')}
            label={m.pause_between_layers ? 'M0 pause' : 'Continuous'}
          />
        </Field>
      </Section>

      <ContinuousSection />

      {result ? <ChecksList checks={checksForStep(result.checks, 'machine')} title="Machine checks" /> : null}
    </>
  );
}

const TRANSITION_KIND: Record<string, string> = {
  direct: 'direct',
  passes: 'passes',
  hoop: 'hoop ramp',
};

/** Continuous winding settings and the transition plan (POST /api/continuous). */
function ContinuousSection() {
  const { project, update } = useProject();
  const { continuousPlan: plan, setContinuousPlan } = useUi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = project.continuous;
  const set = (patch: Partial<ContinuousSpec>, key: string) => update(patchSection('continuous', patch), `cont.${key}`);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.continuous(project);
      setContinuousPlan({ result: r, project });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const r = plan?.result ?? null;
  const stale = !!plan && plan.project !== project;
  return (
    <Section title="Continuous winding">
      <Field
        label="Continuous"
        hint="The roving is not cut between layers; WindLab plans the transitions. Angle changes larger than the max step get transition passes at intermediate angles; hoop ↔ helical changes use a friction-limited ramp on the cylinder."
      >
        <Switch checked={c.enabled} onChange={(v) => set({ enabled: v }, 'en')} label={c.enabled ? 'On' : 'Off'} />
      </Field>
      <NumberField
        label="Max angle step"
        unit="°"
        value={c.max_angle_step}
        gt={0.5}
        max={45}
        step={1}
        hint="Largest change of cylinder winding angle across one turnaround"
        onCommit={(v) => set({ max_angle_step: v }, 'step')}
      />
      <NumberField
        label="Slippage margin"
        value={c.slippage_margin}
        gt={0.1}
        max={1}
        step={0.05}
        hint="Fraction of the layer friction the transition paths may use"
        onCommit={(v) => set({ slippage_margin: v }, 'slip')}
      />
      <div className="inline">
        <Button size="sm" icon="play" variant={!r || stale ? 'primary' : 'default'} onClick={run} disabled={busy}>
          {r ? (stale ? 'Re-plan (project changed)' : 'Re-plan transitions') : 'Plan transitions'}
        </Button>
        {busy ? <Spinner label="Planning transitions" /> : null}
      </div>
      {error ? <Banner kind="fail">{error}</Banner> : null}
      {r ? (
        <>
          {stale ? <p className="muted small stale-note">Planned for an earlier version of the project.</p> : null}
          <p className="small">
            <StatusPill status={r.feasible ? 'ok' : 'fail'}>{r.feasible ? 'Feasible' : 'Not feasible'}</StatusPill>{' '}
            {r.transitions.length} transition{r.transitions.length === 1 ? '' : 's'} · {r.total_passes} extra pass
            {r.total_passes === 1 ? '' : 'es'} · {sig(r.fibre_length / 1000, 3)} m · {sig(r.fibre_mass, 3)} g
          </p>
          {r.transitions.length ? (
            <div className="table-scroll">
              <table className="data-table compact">
                <caption>Transitions (shown in the 3D view)</caption>
                <thead>
                  <tr>
                    <th>From → to</th>
                    <th>Kind</th>
                    <th className="num" title="Transition passes">
                      n
                    </th>
                    <th title="Cylinder angle of each transition pass [°]">Angles °</th>
                    <th className="num" title="Max slippage / friction limit">
                      Slip
                    </th>
                    <th className="num" title="Fibre length [m]">
                      m
                    </th>
                    <th className="num" title="Fibre mass [g]">
                      g
                    </th>
                    <th className="num" title="Phase-matching dwell [°]">
                      Dwell °
                    </th>
                    <th>OK</th>
                  </tr>
                </thead>
                <tbody>
                  {r.transitions.map((t, i) => (
                    <tr key={i} title={t.notes.join('\n') || undefined}>
                      <td>
                        {t.from_layer} → {t.to_layer}
                        <span className="muted small">
                          {' '}
                          {sig(t.angle_from, 3)}° → {sig(t.angle_to, 3)}°
                        </span>
                      </td>
                      <td>{TRANSITION_KIND[t.kind] ?? t.kind}</td>
                      <td className="num">{t.passes}</td>
                      <td className="small">{t.angles.length ? t.angles.map((a) => sig(a, 3)).join(', ') : '–'}</td>
                      <td className={`num ${t.max_slippage > t.friction_limit ? 'bad' : ''}`}>
                        {sig(t.max_slippage, 2)} / {sig(t.friction_limit, 2)}
                      </td>
                      <td className="num">{sig(t.fibre_length / 1000, 3)}</td>
                      <td className="num">{sig(t.fibre_mass, 3)}</td>
                      <td className="num">{sig(t.dwell, 3)}</td>
                      <td>
                        <StatusPill status={t.feasible ? 'ok' : 'fail'}>{t.feasible ? 'OK' : 'No'}</StatusPill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {r.transitions.some((t) => t.notes.length) ? (
            <ul className="notes-list">
              {r.transitions.flatMap((t, i) =>
                t.notes.map((n, j) => (
                  <li key={`${i}-${j}`}>
                    <strong>
                      {t.from_layer} → {t.to_layer}:
                    </strong>{' '}
                    {n}
                  </li>
                )),
              )}
            </ul>
          ) : null}
          {r.notes.length ? (
            <ul className="notes-list">
              {r.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function AxisRow({
  label,
  unit,
  title,
  axes,
  m,
  field,
  gt,
  step,
  nullable,
  onSet,
}: {
  label: string;
  unit?: string;
  title: string;
  axes: AxisKey[];
  m: MachineSpec;
  field: 'max_velocity' | 'max_accel' | 'min' | 'max' | 'scale';
  gt?: number;
  step?: number;
  nullable?: boolean;
  onSet: (k: AxisKey, patch: Partial<MachineAxis>, key: string) => void;
}) {
  return (
    <tr>
      <th scope="row" title={title}>
        {label}
        {unit ? <span className="muted small"> {unit}</span> : null}
      </th>
      {axes.map((k) => (
        <td key={k}>
          <NumberInput
            ariaLabel={`${AXIS_META[k].label} ${title}`}
            value={m[k]?.[field] ?? null}
            gt={gt}
            step={step}
            placeholder={nullable ? '–' : undefined}
            onClear={nullable ? () => onSet(k, { [field]: null }, field) : undefined}
            onCommit={(v) => onSet(k, { [field]: v }, field)}
          />
        </td>
      ))}
    </tr>
  );
}
