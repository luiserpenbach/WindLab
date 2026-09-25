/**
 * TypeScript mirror of backend/windlab/schemas.py.
 *
 * Units (everywhere): length mm, pressure/stress MPa, force N, angle deg,
 * time s, mass g, fibre speed mm/s, axis limits in machine units/min.
 */

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- design inputs
export type DomeType = 'isotensoid' | 'hemispherical' | 'elliptical';

export interface LinerSpec {
  /** Liner material id (see /api/materials) */
  material: string;
  /** Outer radius of the liner cylinder [mm], > 0 */
  radius: number;
  /** Length of the cylindrical section [mm], >= 0 */
  cyl_length: number;
  /** Liner wall thickness in the cylinder [mm], > 0 */
  wall_thickness: number;
  dome_type: DomeType;
  /** Elliptical dome height / radius, 0.2 < a <= 1.5 */
  dome_aspect: number;
  /** Polar boss outer radius, end A (z<0) [mm] */
  boss_radius_a: number;
  /** Polar boss outer radius, end B (z>0) [mm] */
  boss_radius_b: number;
  /** Boss/neck protrusion beyond the dome [mm] */
  boss_length: number;
  /** Winding shaft radius beyond the bosses [mm] */
  shaft_radius: number;
  /** Liner wall thickness at the boss [mm]; null = 3 x wall thickness */
  neck_thickness: number | null;
  /** Radius where the wall starts thickening towards the boss [mm]; null = auto */
  neck_blend_radius: number | null;
}

export interface Requirements {
  /** Maximum expected operating pressure [MPa] */
  meop: number;
  /** Design burst factor (burst / MEOP), >= 1 */
  burst_factor: number;
  /** Proof pressure factor (proof / MEOP), >= 1 */
  proof_factor: number;
  /** Autofrettage pressure [MPa]; null = automatically selected */
  autofrettage_pressure: number | null;
  /** Max fibre stress at MEOP / fibre strength, 0 < x <= 1 */
  stress_ratio_limit: number;
  /** Required MEOP pressure cycles, integer >= 1 */
  design_cycles: number;
  /** Liner fatigue life scatter factor, >= 1 */
  fatigue_scatter_factor: number;
}

export interface CompositeSpec {
  fiber: string;
  resin: string;
  /** 0.3 < Vf < 0.8 */
  fiber_volume_fraction: number;
  /** 0.3 < eta <= 1 */
  translation_efficiency: number;
}

export interface PatternChoice {
  /** Circuits per layer (bands around circumference), >= 1 */
  n_bands: number;
  /** Circuit advance in band positions (k in 2*pi*k/n), >= 1 */
  shift: number;
}

export type LayerType = 'hoop' | 'helical';
export type WindingType = 'geodesic' | 'non-geodesic';
export type BandShape = 'rectangular' | 'lenticular' | 'elliptical';

export interface Layer {
  id: string;
  type: LayerType;
  tows: number;
  /** [mm] */
  band_width: number;
  /** Total band tension [N] */
  tension: number;
  // helical
  /** Helical path type; non-geodesic uses friction to steer the fibre on the domes */
  winding: WindingType;
  /** Non-geodesic: winding angle on the cylinder [deg], 0 < a < 85; null = auto (balanced slippage) */
  angle: number | null;
  /** Available fibre/surface friction coefficient mu (max |kg/kn|), 0..1 */
  friction: number;
  /** Extra turnaround radius beyond boss + band/2 at end A (and B if unset) [mm] */
  turnaround_offset: number;
  /** Extra turnaround radius at end B [mm]; null = same as end A */
  turnaround_offset_b: number | null;
  /** null = auto-select best pattern */
  pattern: PatternChoice | null;
  /** Max dwell per turnaround [deg], 0..360 */
  dwell_max: number;
  // hoop
  passes: number;
  /** Hoop drop-off from tangent line, end A [mm] */
  end_offset_a: number;
  /** Hoop drop-off from tangent line, end B [mm] */
  end_offset_b: number;
  /** Override cured layer thickness in the cylinder [mm] */
  thickness_override: number | null;
  /** Band cross-section used by the band-level thickness simulation */
  band_shape: BandShape;
}

export interface MachineAxis {
  letter: string;
  /** [units/min] */
  max_velocity: number;
  /** [units/s^2] */
  max_accel: number;
  min: number | null;
  max: number | null;
  /** Machine units per mm (linear) or per degree (rotary) */
  scale: number;
  invert: boolean;
}

export type Controller = 'linuxcnc' | 'grbl';
export type TensionOutput = 'none' | 'm67' | 'spindle';
export type RotaryReset = 'none' | 'layer' | 'circuit';

export interface MachineSpec {
  name: string;
  axes_count: 3 | 4;
  controller: Controller;
  carriage: MachineAxis;
  mandrel: MachineAxis;
  crossfeed: MachineAxis;
  eye: MachineAxis | null;
  /** Machine carriage coordinate of the vessel mid-plane [mm] */
  carriage_offset: number;
  /** Eye distance from mandrel axis when crossfeed reads 0 [mm] */
  crossfeed_zero_radius: number;
  /** Eye clearance from wound surface [mm] */
  eye_clearance: number;
  /** Target fibre delivery speed [mm/s] */
  fiber_speed: number;
  tension_output: TensionOutput;
  /** Output units per N */
  tension_scale: number;
  rotary_reset: RotaryReset;
  /** 20..2000 */
  samples_per_pass: number;
  pause_between_layers: boolean;
}

export interface Project {
  schema_version: number;
  name: string;
  notes: string;
  liner: LinerSpec;
  requirements: Requirements;
  composite: CompositeSpec;
  layers: Layer[];
  machine: MachineSpec;
}

// ---------------------------------------------------------------- results
export type Status = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  id: string;
  label: string;
  status: Status;
  value: number | null;
  limit: number | null;
  unit: string;
  detail: string;
}

export interface Curve {
  x: number[];
  y: number[];
}

export interface PatternCandidate {
  n_bands: number;
  shift: number;
  pattern_number: number;
  /** [deg] */
  dwell: number;
  /** 1.0 = exact, >1 overlap */
  coverage: number;
  leading: boolean;
  score: number;
}

export interface LayerResult {
  id: string;
  index: number;
  type: LayerType;
  /** Winding angle on the cylinder from the axis [deg] */
  angle: number;
  /** Cured thickness in the cylinder [mm] */
  thickness: number;
  band_thickness: number;
  turnaround_radius: number | null;
  winding: WindingType;
  /** Turnaround radius end A [mm] (null for hoop) */
  turnaround_a: number | null;
  /** Turnaround radius end B [mm] (null for hoop) */
  turnaround_b: number | null;
  /** Signed slippage coefficient kg/kn used on dome A */
  slippage_a: number;
  /** Signed slippage coefficient kg/kn used on dome B */
  slippage_b: number;
  /** Slippage a dwell on the turnaround circle would need (informational) */
  dwell_slippage: number;
  /** Friction coefficient mu of the layer */
  friction: number;
  /** Smallest fibre normal curvature on the path [1/mm]; negative = concave (bridging) */
  min_normal_curvature: number;
  /** Path length per pass with negative normal curvature (fibre bridging) [mm] */
  bridging_length: number;
  /** Ply stress from the winding tension [MPa] */
  winding_stress: number;
  /** Ply prestress left after all layers are wound [MPa] */
  residual_prestress: number;
  /** Fraction of the winding prestress lost (0..1) */
  tension_loss: number;
  z_start: number;
  z_end: number;
  /** x = z [mm], y = thickness [mm] */
  thickness_profile: Curve;
  /** Outer surface after this layer: x = z, y = r [mm] */
  surface: Curve;
  pattern: PatternCandidate | null;
  pattern_candidates: PatternCandidate[];
  circuits: number;
  /** [m] */
  fiber_length: number;
  /** [g] */
  fiber_mass: number;
  /** [g] */
  resin_mass: number;
  /** [s] */
  wind_time: number;
  warnings: string[];
}

export interface LoadPoint {
  phase: string;
  pressure: number;
  liner_axial: number;
  liner_hoop: number;
  liner_vm: number;
  fiber_hoop: number;
  fiber_helical: number;
  strain_axial: number;
  strain_hoop: number;
}

export interface StructuralResult {
  autofrettage_pressure: number;
  autofrettage_auto: boolean;
  autofrettage_window: [number, number];
  history: LoadPoint[];
  residual: LoadPoint;
  at_meop: LoadPoint;
  at_proof: LoadPoint;
  burst_pressure: number;
  burst_mode: string;
  required_burst: number;
  stress_ratio_hoop: number;
  stress_ratio_helical: number;
  fiber_strength: number;
  liner_fatigue_cycles: number;
  netting_hoop_thickness: number;
  netting_helical_thickness: number;
  /** Netting fibre stress at MEOP along z */
  dome_fiber_stress: Curve;
}

/** Axisymmetric shell FE of the whole vessel at MEOP (linear elastic operating cycle). */
export interface FEResult {
  /** Element mid axial position [mm] */
  z: number[];
  r: number[];
  /** Liner von Mises at the inner surface, MEOP [MPa] */
  liner_vm_inner: number[];
  liner_vm_outer: number[];
  /** Per layer: fibre strain / allowable at MEOP along z (null where the layer is absent) */
  fiber_ratio: (number | null)[][];
  fiber_ratio_max: number[];
  node_z: number[];
  node_r: number[];
  /** Nodal radial displacement at MEOP [mm] */
  radial_displacement: number[];
  axial_displacement: number[];
  /** Burst estimate including the domes [MPa] */
  dome_burst: number;
  critical_z: number;
  critical_layer: string | null;
  /** Peak liner stress range / cylinder value */
  liner_hotspot_factor: number;
  liner_hotspot_z: number;
  liner_hotspot_cycles: number;
}

export interface MassResult {
  liner: number;
  fiber: number;
  resin: number;
  total: number;
  /** Internal volume [L] */
  volume: number;
  /** P*V/W at burst [km] */
  pv_w: number;
}

export interface AnalysisResult {
  liner_outer: Curve;
  liner_inner: Curve;
  layers: LayerResult[];
  structural: StructuralResult | null;
  /** Shell FE results (optional; absent when not computed) */
  fe?: FEResult | null;
  mass: MassResult;
  checks: Check[];
}

export interface PathResult {
  layer_id: string;
  /** [x, y, z] in mandrel frame, x = axis [mm] */
  points: number[][];
  /** Indices where each circuit starts */
  circuit_breaks: number[];
  /** Winding angle at each point [deg] */
  alpha: number[];
  /** Slippage coefficient kg/kn at each point */
  slippage: number[];
  /** True on dwell arcs at the turnarounds (may be empty on older backends) */
  dwell?: boolean[];
}

export interface MachineFrame {
  t: number[];
  /** Eye position along axis, part frame [mm] */
  carriage: number[];
  /** Eye distance from mandrel axis [mm] */
  crossfeed: number[];
  /** Mandrel rotation [deg], cumulative */
  mandrel: number[];
  /** Eye rotation [deg] (zeros on 3-axis) */
  eye: number[];
  /** Contact point, mandrel frame [x,y,z] */
  contact: number[][];
  free_length: number[];
}

export interface SimulationResult {
  layer_id: string;
  frames: MachineFrame;
  total_time: number;
  warnings: string[];
  limits_ok: boolean;
}

/** Band-level thickness simulation request (POST /api/thickness-map). */
export interface ThicknessMapRequest {
  project: Project;
  layer_id: string;
  /** Sum all layers up to and including this one (default true) */
  cumulative?: boolean;
  /** Grid cell size along the meridian [mm], 0.25..5 (default 1) */
  resolution?: number;
  /** Grid cells around the circumference, 90..2880 (default 720) */
  n_phi?: number;
}

/**
 * Band-level thickness map. Rows are uniform in the liner meridian arclength
 * `s`; `z` is monotonic along the rows. Values may be null where the backend
 * produced a non-finite number.
 */
export interface ThicknessMapResult {
  layer_id: string;
  cumulative: boolean;
  /** Axial position of the grid rows [mm] */
  z: number[];
  /** Liner meridian arclength of the grid rows [mm] */
  s: number[];
  /** Outer surface radius after this layer at the rows [mm] */
  r: number[];
  /** Grid columns [deg] */
  phi: number[];
  /** Thickness [mm], rows x columns (downsampled to <= 240 x 360) */
  t: (number | null)[][];
  mean: (number | null)[];
  min: (number | null)[];
  max: (number | null)[];
  /** Axisymmetric band-averaged model at the rows [mm] */
  analytic: number[];
  nominal: number;
  peak: number | null;
  analytic_peak: number;
  cyl_mean: number;
  /** Coefficient of variation of thickness in the cylinder */
  cyl_cv: number;
  /** Cylinder area below 50 % of nominal */
  gap_fraction: number;
  /** Cylinder area above 150 % of nominal */
  overlap_fraction: number;
  warnings: string[];
}

export interface TensionScheduleRequest {
  project: Project;
  /** Outermost layer tension [N]; null/omitted = keep the current one */
  target_tension?: number | null;
  /** Cap on inner layer stress vs target, 1..10 (omitted = backend default) */
  max_factor?: number;
}

export interface TensionScheduleResult {
  layer_ids: string[];
  current_tension: number[];
  /** [N] */
  recommended_tension: number[];
  /** Residual ply prestress with the current tensions [MPa] */
  residual_current: number[];
  residual_recommended: number[];
  /** Liner hoop stress from the winding prestress [MPa] */
  liner_hoop_current: number;
  liner_hoop_recommended: number;
}

export interface GcodeRequest {
  project: Project;
  layer_ids: string[] | null;
}

export interface LayerRequest {
  project: Project;
  layer_id: string;
  max_points?: number;
}

// ---------------------------------------------------------------- other endpoints
export interface Health {
  status: string;
  version: string;
}

export interface Fiber {
  id: string;
  name: string;
  /** [MPa] */
  E: number;
  /** [MPa] */
  strength: number;
  /** fraction */
  elongation: number;
  /** [g/cm3] */
  density: number;
  /** [g/km] */
  tex: number;
  filaments: string;
}

export interface Resin {
  id: string;
  name: string;
  E: number;
  nu: number;
  density: number;
}

export interface LinerMaterial {
  id: string;
  name: string;
  E: number;
  nu: number;
  yield: number;
  ultimate: number;
  density: number;
  hardening: number;
  elongation: number;
}

export interface MaterialsResponse {
  fibers: Fiber[];
  resins: Resin[];
  liners: LinerMaterial[];
}

export interface MachinePreset {
  id: string;
  label: string;
  machine: MachineSpec;
}

export interface ExampleProject {
  id: string;
  label: string;
  project: Project;
}

export interface SuggestLayupResponse {
  layers: Layer[];
  notes: string[];
}

export interface GcodeResponse {
  filename: string;
  gcode: string;
  lines: number;
  total_time: number;
  warnings: string[];
}

export interface TravellerResponse {
  markdown: string;
  html: string;
}

export interface ProjectListEntry {
  name: string;
  /** ISO timestamp or epoch seconds depending on backend; displayed as-is. */
  modified: string | number;
}

export interface OkResponse {
  ok: true;
}
