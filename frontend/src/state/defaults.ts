import type { Layer, LayerType, LinerSpec, MachineAxis, MachineSpec, Project } from '../api/types';
import { SCHEMA_VERSION } from '../api/types';

/** Mirrors the Pydantic defaults in backend/windlab/schemas.py. */
export function defaultMachine(): MachineSpec {
  return {
    name: 'Generic 4-axis LinuxCNC',
    axes_count: 4,
    controller: 'linuxcnc',
    carriage: axis('X', 20000, 500, -50, 1500),
    mandrel: axis('A', 36000, 720, null, null),
    crossfeed: axis('Y', 6000, 300, 0, 300),
    eye: axis('B', 36000, 1440, null, null),
    carriage_offset: 600,
    crossfeed_zero_radius: 0,
    eye_clearance: 15,
    fiber_speed: 100,
    tension_output: 'm67',
    tension_scale: 1,
    rotary_reset: 'layer',
    samples_per_pass: 160,
    pause_between_layers: true,
  };
}

export function axis(
  letter: string,
  max_velocity: number,
  max_accel: number,
  min: number | null,
  max: number | null,
): MachineAxis {
  return { letter, max_velocity, max_accel, min, max, scale: 1, invert: false };
}

export function defaultProject(): Project {
  return {
    schema_version: SCHEMA_VERSION,
    name: 'Untitled COPV',
    notes: '',
    liner: {
      material: 'AA6061-T6',
      radius: 100,
      cyl_length: 300,
      wall_thickness: 2.5,
      dome_type: 'isotensoid',
      dome_aspect: 0.6,
      boss_radius_a: 20,
      boss_radius_b: 20,
      boss_length: 30,
      shaft_radius: 12,
      neck_thickness: null,
      neck_blend_radius: null,
    },
    requirements: {
      meop: 30,
      burst_factor: 1.5,
      proof_factor: 1.25,
      autofrettage_pressure: null,
      stress_ratio_limit: 0.6,
      design_cycles: 1000,
      fatigue_scatter_factor: 4,
    },
    composite: {
      fiber: 'T700S-12K',
      resin: 'Epoxy-DGEBA',
      fiber_volume_fraction: 0.6,
      translation_efficiency: 0.82,
    },
    layers: [newLayer('helical', []), newLayer('hoop', [])],
    machine: defaultMachine(),
  };
}

export function newLayerId(type: LayerType, existing: { id: string }[]): string {
  const prefix = type === 'hoop' ? 'H' : 'X';
  const used = new Set(existing.map((l) => l.id));
  let i = 1;
  while (used.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

export function newLayer(type: LayerType, existing: { id: string }[]): Layer {
  return {
    id: newLayerId(type, existing),
    type,
    tows: 1,
    band_width: 6,
    tension: 20,
    winding: 'geodesic',
    angle: null,
    friction: 0.2,
    turnaround_offset: 0,
    turnaround_offset_b: null,
    pattern: null,
    dwell_max: 90,
    passes: 2,
    end_offset_a: 0,
    end_offset_b: 0,
    thickness_override: null,
    band_shape: 'rectangular',
  };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function normalizeLiner(d: LinerSpec, raw: Partial<LinerSpec> | undefined): LinerSpec {
  const l = { ...d, ...(raw ?? {}) };
  l.neck_thickness = finite(l.neck_thickness) ? l.neck_thickness : null;
  l.neck_blend_radius = finite(l.neck_blend_radius) ? l.neck_blend_radius : null;
  return l;
}

/** Fill missing / invalid layer fields (older files predate non-geodesic winding). */
export function normalizeLayer(raw: unknown, before: { id: string }[]): Layer {
  const l = (raw ?? {}) as Partial<Layer>;
  const type: LayerType = l.type === 'hoop' ? 'hoop' : 'helical';
  const d = newLayer(type, before);
  const out: Layer = { ...d, ...l, type };
  out.winding = l.winding === 'non-geodesic' ? 'non-geodesic' : 'geodesic';
  out.angle = finite(l.angle) ? l.angle : null;
  out.friction = finite(l.friction) ? l.friction : d.friction;
  out.turnaround_offset = finite(l.turnaround_offset) ? l.turnaround_offset : d.turnaround_offset;
  out.turnaround_offset_b = finite(l.turnaround_offset_b) ? l.turnaround_offset_b : null;
  out.band_shape = l.band_shape === 'lenticular' || l.band_shape === 'elliptical' ? l.band_shape : 'rectangular';
  return out;
}

/**
 * Fill missing fields of a (possibly older / partial) project with defaults so
 * that imported JSON never leaves the UI with undefined values.
 */
export function normalizeProject(raw: unknown): Project {
  const d = defaultProject();
  const p = (raw ?? {}) as Partial<Project>;
  const m = (p.machine ?? {}) as Partial<MachineSpec>;
  const dm = d.machine;
  const layers = Array.isArray(p.layers)
    ? p.layers.map((l, i, arr) => normalizeLayer(l, arr.slice(0, i) as Layer[]))
    : [];
  return {
    ...d,
    ...p,
    schema_version: p.schema_version ?? SCHEMA_VERSION,
    name: typeof p.name === 'string' ? p.name : d.name,
    notes: typeof p.notes === 'string' ? p.notes : '',
    liner: normalizeLiner(d.liner, p.liner),
    requirements: { ...d.requirements, ...(p.requirements ?? {}) },
    composite: { ...d.composite, ...(p.composite ?? {}) },
    layers,
    machine: {
      ...dm,
      ...m,
      carriage: { ...dm.carriage, ...(m.carriage ?? {}) },
      mandrel: { ...dm.mandrel, ...(m.mandrel ?? {}) },
      crossfeed: { ...dm.crossfeed, ...(m.crossfeed ?? {}) },
      eye: m.eye === null ? null : { ...(dm.eye as MachineAxis), ...(m.eye ?? {}) },
    },
  };
}
