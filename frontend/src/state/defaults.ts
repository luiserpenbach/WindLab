import type {
  CompositeSpec,
  ContinuousSpec,
  CustomFiber,
  CustomLiner,
  CustomResin,
  FailureLocation,
  Layer,
  LayerType,
  LinerSpec,
  MachineAxis,
  MachineSpec,
  MaterialLibrary,
  Project,
  TestKind,
  TestRecord,
} from '../api/types';
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

export function defaultContinuous(): ContinuousSpec {
  return { enabled: false, max_angle_step: 7, slippage_margin: 0.8 };
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
      temperature_min: -40,
      temperature_max: 65,
      temperature_ref: 20,
      service_life: 15,
      time_at_meop: 1,
      rupture_pf_target: 1e-6,
      hold_time: 60,
      permeation_limit: 46,
      permeation_temperature: 55,
    },
    composite: {
      fiber: 'T700S-12K',
      resin: 'Epoxy-DGEBA',
      fiber_volume_fraction: 0.6,
      translation_efficiency: 0.82,
      cure_temperature: 120,
      strength_weibull_shape: null,
      rupture_exponent: null,
    },
    materials: { fibers: [], resins: [], liners: [] },
    layers: [newLayer('helical', []), newLayer('hoop', [])],
    machine: defaultMachine(),
    continuous: defaultContinuous(),
    tests: [],
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
    pattern_number: null,
    pattern_direction: 'any',
    dwell_max: 90,
    passes: 2,
    end_offset_a: 0,
    end_offset_b: 0,
    thickness_override: null,
    band_shape: 'rectangular',
    fiber: null,
    overlap: 0,
    start_angle: 0,
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
  out.fiber = typeof l.fiber === 'string' && l.fiber ? l.fiber : null;
  out.overlap = finite(l.overlap) ? l.overlap : 0;
  out.start_angle = finite(l.start_angle) ? l.start_angle : 0;
  out.pattern_number =
    finite(l.pattern_number) && l.pattern_number >= 1 ? Math.min(60, Math.round(l.pattern_number)) : null;
  out.pattern_direction =
    l.pattern_direction === 'leading' || l.pattern_direction === 'lagging' ? l.pattern_direction : 'any';
  return out;
}

// ------------------------------------------------------------------ custom materials
/** Defaults for new custom records (mirror the backend field defaults; required fields get typical values). */
export function newCustomFiber(id: string): CustomFiber {
  return {
    id,
    name: id,
    E: 230000,
    strength: 4900,
    elongation: 0.021,
    density: 1.8,
    tex: 800,
    filaments: '12K',
    E2: 15000,
    G12: 27000,
    nu12: 0.2,
    cte1: -0.4e-6,
    cte2: 7.0e-6,
  };
}

export function newCustomResin(id: string): CustomResin {
  return { id, name: id, E: 3100, nu: 0.35, density: 1.2, cte: 60e-6 };
}

export function newCustomLiner(id: string): CustomLiner {
  return {
    id,
    name: id,
    E: 68900,
    nu: 0.33,
    yield: 276,
    ultimate: 310,
    density: 2.7,
    elongation: 0.12,
    fatigue_coeff: 386,
    fatigue_exp: -0.071,
    cte: 23.6e-6,
    k_ic: 29,
    kind: 'metal',
    max_temp: 150,
    strain_limit: 0,
    h2_permeability: 0,
    perm_activation: 0,
  };
}

function normalizeRecords<T extends { id: string; name: string }>(raw: unknown, base: (id: string) => T): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const r of raw as Partial<T>[]) {
    if (!r || typeof r.id !== 'string' || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    const d = base(r.id);
    const rec = { ...d } as Record<string, unknown>;
    for (const [k, v] of Object.entries(r)) {
      const dv = (d as Record<string, unknown>)[k];
      if (typeof dv === 'number') {
        if (finite(v)) rec[k] = v;
      } else if (typeof dv === 'string') {
        if (typeof v === 'string') rec[k] = v;
      }
    }
    if (rec.kind != null && rec.kind !== 'metal' && rec.kind !== 'polymer')
      rec.kind = (d as Record<string, unknown>).kind;
    out.push(rec as T);
  }
  return out;
}

export function normalizeMaterials(raw: unknown): MaterialLibrary {
  const m = (raw ?? {}) as Partial<Record<keyof MaterialLibrary, unknown>>;
  return {
    fibers: normalizeRecords(m.fibers, newCustomFiber),
    resins: normalizeRecords(m.resins, newCustomResin),
    // the backend alias is "yield"; accept the Python field name too
    liners: normalizeRecords(
      Array.isArray(m.liners)
        ? (m.liners as Record<string, unknown>[]).map((r) =>
            r && r.yield == null && r.yield_ != null ? { ...r, yield: r.yield_ } : r,
          )
        : m.liners,
      newCustomLiner,
    ),
  };
}

// ------------------------------------------------------------------ test records
export const TEST_KINDS: TestKind[] = ['burst', 'proof', 'autofrettage', 'cycle'];
export const FAILURE_LOCATIONS: FailureLocation[] = ['cylinder', 'dome-a', 'dome-b', 'boss', 'leak', 'none'];

export function newTestId(existing: { id: string }[]): string {
  const used = new Set(existing.map((t) => t.id));
  let i = existing.length + 1;
  while (used.has(`T${i}`)) i++;
  return `T${i}`;
}

export function newTestRecord(existing: { id: string }[], pressure = 45): TestRecord {
  return {
    id: newTestId(existing),
    serial: '',
    kind: 'burst',
    pressure,
    cycles: null,
    failure_location: 'cylinder',
    volumetric_expansion_total: null,
    volumetric_expansion_permanent: null,
    date: new Date().toISOString().slice(0, 10),
    notes: '',
  };
}

export function normalizeTests(raw: unknown): TestRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: TestRecord[] = [];
  for (const r of raw as Partial<TestRecord>[]) {
    if (!r || !finite(r.pressure) || r.pressure <= 0) continue;
    const d = newTestRecord(out, r.pressure);
    out.push({
      id: typeof r.id === 'string' && r.id && !out.some((t) => t.id === r.id) ? r.id : d.id,
      serial: typeof r.serial === 'string' ? r.serial : '',
      kind: TEST_KINDS.includes(r.kind as TestKind) ? (r.kind as TestKind) : 'burst',
      pressure: r.pressure,
      cycles: finite(r.cycles) ? Math.round(r.cycles) : null,
      failure_location: FAILURE_LOCATIONS.includes(r.failure_location as FailureLocation)
        ? (r.failure_location as FailureLocation)
        : 'cylinder',
      volumetric_expansion_total: finite(r.volumetric_expansion_total) ? r.volumetric_expansion_total : null,
      volumetric_expansion_permanent: finite(r.volumetric_expansion_permanent)
        ? r.volumetric_expansion_permanent
        : null,
      date: typeof r.date === 'string' ? r.date : '',
      notes: typeof r.notes === 'string' ? r.notes : '',
    });
  }
  return out;
}

function normalizeComposite(d: CompositeSpec, raw: Partial<CompositeSpec> | undefined): CompositeSpec {
  const c = { ...d, ...(raw ?? {}) };
  c.strength_weibull_shape = finite(c.strength_weibull_shape) ? c.strength_weibull_shape : null;
  c.rupture_exponent = finite(c.rupture_exponent) ? c.rupture_exponent : null;
  return c;
}

function normalizeContinuous(raw: Partial<ContinuousSpec> | undefined): ContinuousSpec {
  const d = defaultContinuous();
  const c = raw ?? {};
  return {
    enabled: c.enabled === true,
    max_angle_step: finite(c.max_angle_step) ? c.max_angle_step : d.max_angle_step,
    slippage_margin: finite(c.slippage_margin) ? c.slippage_margin : d.slippage_margin,
  };
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
    composite: normalizeComposite(d.composite, p.composite),
    materials: normalizeMaterials(p.materials),
    tests: normalizeTests(p.tests),
    layers,
    continuous: normalizeContinuous(p.continuous),
    machine: {
      ...dm,
      ...m,
      axes_count: m.axes_count === 2 || m.axes_count === 3 ? m.axes_count : m.axes_count === 4 ? 4 : dm.axes_count,
      carriage: { ...dm.carriage, ...(m.carriage ?? {}) },
      mandrel: { ...dm.mandrel, ...(m.mandrel ?? {}) },
      crossfeed: { ...dm.crossfeed, ...(m.crossfeed ?? {}) },
      eye: m.eye === null ? null : { ...(dm.eye as MachineAxis), ...(m.eye ?? {}) },
    },
  };
}
