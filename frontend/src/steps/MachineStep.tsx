import { useRef } from 'react';
import type { Controller, MachineAxis, MachineSpec, RotaryReset, TensionOutput } from '../api/types';
import { Field, NumberField, NumberInput, Section, Segmented, Select, SelectField, Switch, TextInput } from '../components/fields';
import { Banner } from '../components/ui';
import { useAnalysis, useCatalog } from '../state/analysis';
import { axis, normalizeProject } from '../state/defaults';
import { patchSection, useProject } from '../state/projectStore';
import { ChecksList } from './shared';
import { checksForStep } from './stepStatus';

type AxisKey = 'carriage' | 'mandrel' | 'crossfeed' | 'eye';

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
  if (rotLetters.test(m.mandrel.letter)) out.push({ kind: 'warn', text: `Mandrel letter “${m.mandrel.letter}” is not supported by stock GRBL.` });
  if (m.axes_count === 4 && m.eye && rotLetters.test(m.eye.letter))
    out.push({ kind: 'warn', text: `Eye letter “${m.eye.letter}” needs a 4-axis GRBL fork (e.g. grblHAL).` });
  if (m.tension_output === 'm67') out.push({ kind: 'warn', text: 'GRBL has no M67 analog output. Use “spindle” (S word / PWM) for tension control.' });
  if (m.rotary_reset === 'none') out.push({ kind: 'warn', text: 'Rotary reset “none” with GRBL risks float precision loss on long programs.' });
  const letters = [m.carriage.letter, m.mandrel.letter, m.crossfeed.letter, ...(m.axes_count === 4 && m.eye ? [m.eye.letter] : [])].map((x) => x.toUpperCase());
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
    update(
      (p) => {
        const cur = p.machine[k];
        if (!cur) return p;
        return { ...p, machine: { ...p.machine, [k]: { ...cur, ...patch } } };
      },
      `axis.${k}.${key}`,
    );
  const axes: AxisKey[] = m.axes_count === 4 ? ['carriage', 'mandrel', 'crossfeed', 'eye'] : ['carriage', 'mandrel', 'crossfeed'];
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
        <Field label="Axes">
          <Segmented<3 | 4>
            ariaLabel="Axis count"
            value={m.axes_count}
            options={[
              { value: 3, label: '3-axis' },
              { value: 4, label: '4-axis (eye)' },
            ]}
            onChange={(n) => {
              if (n === 3) {
                lastEye.current = m.eye ?? lastEye.current;
                set({ axes_count: 3, eye: null }, 'axes');
              } else {
                set({ axes_count: 4, eye: m.eye ?? lastEye.current ?? axis('B', 36000, 1440, null, null) }, 'axes');
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
                <th>Axis</th>
                <th title="G-code letter">Ltr</th>
                <th className="num" title="Max velocity [units/min]">Vmax</th>
                <th className="num" title="Max acceleration [units/s²]">Amax</th>
                <th className="num" title="Soft limit min [machine units], blank = none">Min</th>
                <th className="num" title="Soft limit max [machine units], blank = none">Max</th>
                <th className="num" title="Machine units per mm (linear) or per degree (rotary)">Scale</th>
                <th title="Invert direction">Inv</th>
              </tr>
            </thead>
            <tbody>
              {axes.map((k) => {
                const a = m[k];
                if (!a) return null;
                const meta = AXIS_META[k];
                const u = meta.kind === 'linear' ? 'mm' : '°';
                return (
                  <tr key={k}>
                    <th scope="row" title={meta.desc}>
                      {meta.label}
                      <span className="muted small"> {meta.kind === 'linear' ? 'lin' : 'rot'}</span>
                    </th>
                    <td>
                      <input
                        className="text letter"
                        aria-label={`${meta.label} letter`}
                        value={a.letter}
                        maxLength={1}
                        onChange={(e) => {
                          const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
                          if (v) setAxis(k, { letter: v }, 'letter');
                        }}
                      />
                    </td>
                    <td>
                      <NumberInput ariaLabel={`${meta.label} max velocity [units/min]`} value={a.max_velocity} gt={0} step={100} onCommit={(v) => setAxis(k, { max_velocity: v }, 'v')} />
                    </td>
                    <td>
                      <NumberInput ariaLabel={`${meta.label} max acceleration [units/s²]`} value={a.max_accel} gt={0} step={10} onCommit={(v) => setAxis(k, { max_accel: v }, 'a')} />
                    </td>
                    <td>
                      <NumberInput ariaLabel={`${meta.label} soft limit min`} value={a.min} placeholder="–" onClear={() => setAxis(k, { min: null }, 'min')} onCommit={(v) => setAxis(k, { min: v }, 'min')} />
                    </td>
                    <td>
                      <NumberInput ariaLabel={`${meta.label} soft limit max`} value={a.max} placeholder="–" onClear={() => setAxis(k, { max: null }, 'max')} onCommit={(v) => setAxis(k, { max: v }, 'max')} />
                    </td>
                    <td>
                      <NumberInput ariaLabel={`${meta.label} scale [units/${u}]`} value={a.scale} step={0.1} onCommit={(v) => setAxis(k, { scale: v }, 'scale')} />
                    </td>
                    <td className="center">
                      <input type="checkbox" aria-label={`${meta.label} invert`} checked={a.invert} onChange={(e) => setAxis(k, { invert: e.target.checked }, 'inv')} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">Velocity in units/min, acceleration in units/s². Scale: machine units per mm (linear) or per degree (rotary). Leave limits blank for none.</p>
      </Section>

      <Section title="Kinematics">
        <NumberField label="Carriage offset" unit="mm" value={m.carriage_offset} step={10} hint="Machine carriage coordinate of the vessel mid-plane (z = 0)" onCommit={(v) => set({ carriage_offset: v }, 'co')} />
        <NumberField label="Crossfeed zero radius" unit="mm" value={m.crossfeed_zero_radius} step={1} hint="Eye distance from mandrel axis when crossfeed reads 0" onCommit={(v) => set({ crossfeed_zero_radius: v }, 'czr')} />
        <NumberField label="Eye clearance" unit="mm" value={m.eye_clearance} gt={0} step={1} hint="Eye clearance from the wound surface" onCommit={(v) => set({ eye_clearance: v }, 'ec')} />
        <NumberField label="Fibre speed" unit="mm/s" value={m.fiber_speed} gt={0} step={10} hint={`= ${(m.fiber_speed * 0.06).toFixed(1)} m/min target delivery speed`} onCommit={(v) => set({ fiber_speed: v }, 'fs')} />
        <NumberField label="Samples per pass" unit="pts" value={m.samples_per_pass} min={20} max={2000} integer step={10} hint="Path resolution per traverse (20 – 2000)" onCommit={(v) => set({ samples_per_pass: v }, 'spp')} />
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
          <NumberField label="Tension scale" unit="/N" value={m.tension_scale} step={0.1} hint="Output units per newton of tension" onCommit={(v) => set({ tension_scale: v }, 'ts')} />
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
        <Field label="Pause between layers">
          <Switch checked={m.pause_between_layers} onChange={(v) => set({ pause_between_layers: v }, 'pbl')} label={m.pause_between_layers ? 'M0 pause' : 'Continuous'} />
        </Field>
      </Section>

      {result ? <ChecksList checks={checksForStep(result.checks, 'machine')} title="Machine checks" /> : null}
    </>
  );
}
