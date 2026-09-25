"""Project data model shared by the core, the API and the web UI.

Unit conventions (everywhere, no exceptions):
    length      mm
    pressure    MPa
    stress      MPa
    force       N
    angle       deg (in the data model; radians internally)
    time        s
    mass        g
    velocity    mm/s for fibre speed; axis limits in machine units/min
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

SCHEMA_VERSION = 1


# --------------------------------------------------------------------------- design inputs
class LinerSpec(BaseModel):
    material: str = Field("AA6061-T6", description="Liner material id (see /api/materials)")
    radius: float = Field(100.0, gt=0, description="Outer radius of the liner cylinder [mm]")
    cyl_length: float = Field(300.0, ge=0, description="Length of the cylindrical section [mm]")
    wall_thickness: float = Field(2.5, gt=0, description="Liner wall thickness in the cylinder [mm]")
    dome_type: Literal["isotensoid", "hemispherical", "elliptical"] = "isotensoid"
    dome_aspect: float = Field(0.6, gt=0.2, le=1.5, description="Elliptical dome height / radius")
    boss_radius_a: float = Field(20.0, gt=0, description="Polar boss outer radius, end A (z<0) [mm]")
    boss_radius_b: float = Field(20.0, gt=0, description="Polar boss outer radius, end B (z>0) [mm]")
    boss_length: float = Field(30.0, ge=0, description="Boss/neck protrusion beyond the dome [mm]")
    shaft_radius: float = Field(12.0, gt=0, description="Winding shaft radius beyond the bosses [mm]")
    neck_thickness: Optional[float] = Field(
        None, gt=0, description="Liner wall thickness at the boss [mm]; null = 3 x wall thickness"
    )
    neck_blend_radius: Optional[float] = Field(
        None, gt=0, description="Radius where the wall starts thickening towards the boss [mm]; null = auto"
    )


class Requirements(BaseModel):
    meop: float = Field(30.0, gt=0, description="Maximum expected operating pressure [MPa]")
    burst_factor: float = Field(1.5, ge=1.0, description="Design burst factor (burst / MEOP)")
    proof_factor: float = Field(1.25, ge=1.0, description="Proof pressure factor (proof / MEOP)")
    autofrettage_pressure: Optional[float] = Field(
        None, description="Autofrettage pressure [MPa]; null = automatically selected"
    )
    stress_ratio_limit: float = Field(
        0.6, gt=0, le=1, description="Max fibre stress at MEOP / fibre strength (stress rupture)"
    )
    design_cycles: int = Field(1000, ge=1, description="Required MEOP pressure cycles")
    fatigue_scatter_factor: float = Field(4.0, ge=1, description="Liner fatigue life scatter factor")
    temperature_min: float = Field(-40.0, description="Minimum operating temperature [degC]")
    temperature_max: float = Field(65.0, description="Maximum operating temperature [degC]")
    temperature_ref: float = Field(20.0, description="Ambient temperature of autofrettage / proof [degC]")


class CustomFiber(BaseModel):
    id: str
    name: str
    E: float = Field(..., gt=0, description="Axial tensile modulus [MPa]")
    strength: float = Field(..., gt=0, description="Impregnated strand tensile strength [MPa]")
    elongation: float = Field(0.02, gt=0)
    density: float = Field(..., gt=0, description="[g/cm3]")
    tex: float = Field(..., gt=0, description="Linear density [g/km]")
    filaments: str = ""
    E2: float = Field(15_000.0, gt=0, description="Transverse fibre modulus [MPa]")
    G12: float = Field(27_000.0, gt=0, description="Fibre shear modulus [MPa]")
    nu12: float = 0.2
    cte1: float = Field(-0.4e-6, description="Axial CTE [1/K]")
    cte2: float = Field(7.0e-6, description="Transverse CTE [1/K]")


class CustomResin(BaseModel):
    id: str
    name: str
    E: float = Field(..., gt=0)
    nu: float = 0.35
    density: float = Field(..., gt=0)
    cte: float = Field(60e-6, description="CTE [1/K]")


class CustomLiner(BaseModel):
    id: str
    name: str
    E: float = Field(..., gt=0)
    nu: float = 0.33
    yield_: float = Field(..., gt=0, alias="yield")
    ultimate: float = Field(..., gt=0)
    density: float = Field(..., gt=0)
    elongation: float = Field(0.1, gt=0)
    fatigue_coeff: float = Field(..., gt=0, description="Basquin sigma'_f [MPa]")
    fatigue_exp: float = Field(..., lt=0, description="Basquin exponent b")
    cte: float = Field(23.6e-6, description="CTE [1/K]")
    k_ic: float = Field(29.0, gt=0, description="Fracture toughness [MPa sqrt(m)]")

    model_config = {"populate_by_name": True}


class MaterialLibrary(BaseModel):
    """Project-specific materials; they take precedence over the built-in database."""

    fibers: list[CustomFiber] = []
    resins: list[CustomResin] = []
    liners: list[CustomLiner] = []


class CompositeSpec(BaseModel):
    fiber: str = Field("T700S-12K", description="Fibre id (see /api/materials)")
    resin: str = Field("Epoxy-DGEBA", description="Resin id (see /api/materials)")
    fiber_volume_fraction: float = Field(0.60, gt=0.3, lt=0.8)
    translation_efficiency: float = Field(
        0.82, gt=0.3, le=1.0, description="Fibre strength translation efficiency in the vessel"
    )
    cure_temperature: float = Field(
        120.0, description="Stress-free temperature of the liner/composite bond (cure) [degC]"
    )


class PatternChoice(BaseModel):
    n_bands: int = Field(..., ge=1, description="Circuits per layer (bands around circumference)")
    shift: int = Field(..., ge=1, description="Circuit advance in band positions (k in 2πk/n)")


class Layer(BaseModel):
    id: str
    type: Literal["hoop", "helical"]
    tows: int = Field(1, ge=1, description="Number of tows in the band")
    band_width: float = Field(6.0, gt=0, description="Band width [mm]")
    tension: float = Field(20.0, ge=0, description="Total band tension [N]")
    # helical
    winding: Literal["geodesic", "non-geodesic"] = Field(
        "geodesic", description="Helical path type; non-geodesic uses friction to steer the fibre on the domes"
    )
    angle: Optional[float] = Field(
        None, gt=0, lt=85, description="Non-geodesic: winding angle on the cylinder [deg]; null = auto"
    )
    friction: float = Field(
        0.2, ge=0, le=1, description="Available fibre/surface friction coefficient (max slippage |kg/kn|)"
    )
    turnaround_offset: float = Field(
        0.0, ge=0, description="Extra turnaround radius beyond boss + band/2 at end A (and B if unset) [mm]"
    )
    turnaround_offset_b: Optional[float] = Field(
        None, ge=0, description="Extra turnaround radius at end B [mm]; null = same as end A"
    )
    pattern: Optional[PatternChoice] = Field(None, description="null = auto-select best pattern")
    dwell_max: float = Field(90.0, ge=0, le=360, description="Max dwell per turnaround [deg]")
    # hoop
    passes: int = Field(2, ge=1, description="Hoop traverses (each deposits one band thickness)")
    end_offset_a: float = Field(0.0, ge=0, description="Hoop drop-off from tangent line, end A [mm]")
    end_offset_b: float = Field(0.0, ge=0, description="Hoop drop-off from tangent line, end B [mm]")
    thickness_override: Optional[float] = Field(
        None, gt=0, description="Override cured layer thickness in the cylinder [mm]"
    )
    band_shape: Literal["rectangular", "lenticular", "elliptical"] = Field(
        "rectangular", description="Band cross-section used by the band-level thickness simulation"
    )
    fiber: Optional[str] = Field(None, description="Fibre override for this layer (e.g. a glass outer layer)")
    overlap: float = Field(0.0, ge=0, le=0.9, description="Hoop: band overlap fraction (pitch = band x (1 - overlap))")
    start_angle: float = Field(0.0, ge=0, lt=360, description="Pattern clocking: mandrel angle at layer start [deg]")


class MachineAxis(BaseModel):
    letter: str = Field(..., description="G-code axis letter")
    max_velocity: float = Field(..., gt=0, description="Max velocity [units/min]")
    max_accel: float = Field(..., gt=0, description="Max acceleration [units/s^2]")
    min: Optional[float] = Field(None, description="Soft limit min [machine units]")
    max: Optional[float] = Field(None, description="Soft limit max [machine units]")
    scale: float = Field(1.0, description="Machine units per mm (linear) or per degree (rotary)")
    invert: bool = False


class MachineSpec(BaseModel):
    name: str = "Generic 4-axis LinuxCNC"
    axes_count: Literal[2, 3, 4] = Field(
        4, description="2: mandrel + carriage (eye at fixed radius), 3: + crossfeed, 4: + eye rotation"
    )
    controller: Literal["linuxcnc", "grbl"] = "linuxcnc"
    carriage: MachineAxis = MachineAxis(letter="X", max_velocity=20000, max_accel=500, min=-50, max=1500)
    mandrel: MachineAxis = MachineAxis(letter="A", max_velocity=36000, max_accel=720)
    crossfeed: MachineAxis = MachineAxis(letter="Y", max_velocity=6000, max_accel=300, min=0, max=300)
    eye: Optional[MachineAxis] = MachineAxis(letter="B", max_velocity=36000, max_accel=1440)
    carriage_offset: float = Field(
        600.0, description="Machine carriage coordinate of the vessel mid-plane (z=0) [mm]"
    )
    crossfeed_zero_radius: float = Field(
        0.0, description="Eye distance from mandrel axis when crossfeed axis reads 0 [mm]"
    )
    eye_clearance: float = Field(15.0, gt=0, description="Eye clearance from wound surface [mm]")
    fiber_speed: float = Field(100.0, gt=0, description="Target fibre delivery speed [mm/s]")
    tension_output: Literal["none", "m67", "spindle"] = "m67"
    tension_scale: float = Field(1.0, description="Output units per N of tension")
    rotary_reset: Literal["none", "layer", "circuit"] = "layer"
    samples_per_pass: int = Field(160, ge=20, le=2000)
    pause_between_layers: bool = True


class TestRecord(BaseModel):
    id: str
    serial: str = ""
    kind: Literal["burst", "proof", "autofrettage", "cycle"] = "burst"
    pressure: float = Field(..., gt=0, description="Burst / test pressure [MPa]")
    cycles: Optional[int] = Field(None, description="Cycle test: cycles to failure (or run-out)")
    failure_location: Literal["cylinder", "dome-a", "dome-b", "boss", "leak", "none"] = "cylinder"
    volumetric_expansion_total: Optional[float] = Field(None, description="Measured at test pressure [mL]")
    volumetric_expansion_permanent: Optional[float] = Field(None, description="Measured after venting [mL]")
    date: str = ""
    notes: str = ""


class Project(BaseModel):
    schema_version: int = SCHEMA_VERSION
    name: str = "Untitled COPV"
    notes: str = ""
    liner: LinerSpec = LinerSpec()
    requirements: Requirements = Requirements()
    composite: CompositeSpec = CompositeSpec()
    materials: MaterialLibrary = MaterialLibrary()
    layers: list[Layer] = []
    machine: MachineSpec = MachineSpec()
    tests: list[TestRecord] = []


# --------------------------------------------------------------------------- results
Status = Literal["ok", "warn", "fail", "info"]


class Check(BaseModel):
    id: str
    label: str
    status: Status
    refs: list[str] = Field(default_factory=list, description="Ids of the layers this check refers to")
    value: Optional[float] = None
    limit: Optional[float] = None
    unit: str = ""
    detail: str = ""


class Curve(BaseModel):
    """Generic x/y series along the vessel meridian or over pressure."""

    x: list[float]
    y: list[float]


class PatternCandidate(BaseModel):
    n_bands: int
    shift: int
    pattern_number: int = Field(..., description="Circuits until a band lands adjacent to band 0")
    dwell: float = Field(..., description="Dwell per turnaround [deg]")
    coverage: float = Field(..., description="Band coverage ratio (1.0 = exact, >1 overlap)")
    leading: bool = Field(..., description="True if the pattern advances in rotation direction")
    score: float


class LayerResult(BaseModel):
    id: str
    index: int
    type: Literal["hoop", "helical"]
    angle: float = Field(..., description="Winding angle on the cylinder from the axis [deg]")
    thickness: float = Field(..., description="Cured thickness in the cylinder [mm]")
    band_thickness: float
    turnaround_radius: Optional[float] = None
    winding: Literal["geodesic", "non-geodesic"] = "geodesic"
    turnaround_a: Optional[float] = Field(None, description="Turnaround radius end A [mm]")
    turnaround_b: Optional[float] = Field(None, description="Turnaround radius end B [mm]")
    slippage_a: float = Field(0.0, description="Slippage coefficient kg/kn used on dome A")
    slippage_b: float = Field(0.0, description="Slippage coefficient kg/kn used on dome B")
    dwell_slippage: float = Field(0.0, description="Slippage a dwell on the turnaround circle would need")
    friction: float = 0.0
    min_normal_curvature: float = Field(0.0, description="Smallest fibre normal curvature on the path [1/mm]")
    bridging_length: float = Field(0.0, description="Path length per pass with negative normal curvature [mm]")
    bridging_gap: float = Field(0.0, description="Largest estimated fibre lift-off over concave surface [mm]")
    winding_stress: float = Field(0.0, description="Ply stress from the winding tension [MPa]")
    residual_prestress: float = Field(0.0, description="Ply prestress left after all layers are wound [MPa]")
    tension_loss: float = Field(0.0, description="Fraction of the winding prestress lost")
    z_start: float
    z_end: float
    thickness_profile: Curve = Field(..., description="x = z [mm], y = thickness [mm]")
    surface: Curve = Field(..., description="Outer surface after this layer: x = z, y = r [mm]")
    pattern: Optional[PatternCandidate] = None
    pattern_candidates: list[PatternCandidate] = []
    circuits: int = 0
    fiber_length: float = Field(0.0, description="Fibre band length [m]")
    fiber_mass: float = Field(0.0, description="Dry fibre mass [g]")
    resin_mass: float = Field(0.0, description="Resin mass [g]")
    wind_time: float = Field(0.0, description="Estimated winding time [s]")
    warnings: list[str] = []


class LoadPoint(BaseModel):
    phase: str
    pressure: float
    liner_axial: float
    liner_hoop: float
    liner_vm: float
    fiber_hoop: float
    fiber_helical: float
    strain_axial: float
    strain_hoop: float


class StructuralResult(BaseModel):
    autofrettage_pressure: float
    autofrettage_auto: bool
    autofrettage_window: tuple[float, float]
    history: list[LoadPoint]
    residual: LoadPoint
    at_meop: LoadPoint
    at_proof: LoadPoint
    cure_residual: Optional[LoadPoint] = Field(None, description="State after cure cool-down, before autofrettage")
    meop_cold: Optional[LoadPoint] = None
    meop_hot: Optional[LoadPoint] = None
    stress_ratio_worst: float = Field(0.0, description="Max fibre stress ratio at MEOP over the temperature range")
    expansion_af_total: float = Field(0.0, description="Volumetric expansion at autofrettage pressure [mL]")
    expansion_af_permanent: float = Field(0.0, description="Permanent volumetric expansion after autofrettage [mL]")
    expansion_proof_total: float = Field(0.0, description="Volumetric expansion at proof [mL]")
    expansion_proof_permanent: float = Field(0.0, description="Additional permanent expansion from proof [mL]")
    burst_pressure: float
    burst_mode: str
    required_burst: float
    stress_ratio_hoop: float
    stress_ratio_helical: float
    fiber_strength: float
    liner_fatigue_cycles: float
    netting_hoop_thickness: float
    netting_helical_thickness: float
    dome_fiber_stress: Curve = Field(..., description="Netting fibre stress at MEOP along z")


class FEResult(BaseModel):
    """Axisymmetric shell FE of the whole vessel at MEOP (linear elastic operating cycle)."""

    z: list[float] = Field(..., description="Element mid axial position [mm]")
    r: list[float]
    liner_vm_inner: list[float] = Field(..., description="Liner von Mises at the inner surface, MEOP [MPa]")
    liner_vm_outer: list[float]
    fiber_ratio: list[list[Optional[float]]] = Field(
        ..., description="Per layer: fibre strain / allowable at MEOP along z (null where the layer is absent)"
    )
    fiber_ratio_max: list[float]
    node_z: list[float]
    node_r: list[float]
    radial_displacement: list[float] = Field(..., description="Nodal radial displacement at MEOP [mm]")
    axial_displacement: list[float]
    valid: list[bool] = Field(default_factory=list,
                              description="Elements outside the rigid-boss clamp zone (used for peaks/hot spots)")
    fiber_ratio_ref: float = Field(0.0, description="Cylinder reference fibre utilisation (burst scaling)")
    liner_vm_ref: float = Field(0.0, description="Cylinder reference liner stress range (hot-spot factor)")
    dome_burst: float = Field(..., description="Burst estimate including the domes [MPa]")
    critical_z: float
    critical_layer: Optional[str]
    liner_hotspot_factor: float = Field(..., description="Peak liner stress range / cylinder value")
    liner_hotspot_z: float
    liner_hotspot_cycles: float


class MassResult(BaseModel):
    liner: float
    fiber: float
    resin: float
    total: float
    volume: float = Field(..., description="Internal volume [L]")
    pv_w: float = Field(..., description="Performance factor P*V/W at burst [km]")


class AnalysisResult(BaseModel):
    liner_outer: Curve
    liner_inner: Curve
    layers: list[LayerResult]
    structural: Optional[StructuralResult]
    fe: Optional[FEResult] = None
    mass: MassResult
    checks: list[Check]


class PathResult(BaseModel):
    layer_id: str
    points: list[list[float]] = Field(..., description="[x, y, z] in mandrel frame, x = axis [mm]")
    circuit_breaks: list[int] = Field(..., description="Indices where each circuit starts")
    alpha: list[float] = Field(default_factory=list, description="Winding angle at each point [deg]")
    slippage: list[float] = Field(default_factory=list, description="Slippage coefficient kg/kn at each point")
    dwell: list[bool] = Field(default_factory=list, description="True on dwell arcs at the turnarounds")


class MachineFrame(BaseModel):
    t: list[float]
    carriage: list[float] = Field(..., description="Eye position along axis, part frame z [mm]")
    crossfeed: list[float] = Field(..., description="Eye distance from mandrel axis [mm]")
    mandrel: list[float] = Field(..., description="Mandrel rotation [deg], cumulative")
    eye: list[float] = Field(..., description="Eye rotation [deg] (zeros on 3-axis)")
    contact: list[list[float]] = Field(..., description="Contact point, mandrel frame [x,y,z]")
    free_length: list[float]


class SimulationResult(BaseModel):
    layer_id: str
    frames: MachineFrame
    total_time: float
    warnings: list[str]
    limits_ok: bool


class ThicknessMapRequest(BaseModel):
    project: Project
    layer_id: str
    cumulative: bool = Field(True, description="Sum all layers up to and including this one")
    resolution: float = Field(1.0, ge=0.25, le=5.0, description="Grid cell size along the meridian [mm]")
    n_phi: int = Field(720, ge=90, le=2880, description="Grid cells around the circumference")


class ThicknessMapResult(BaseModel):
    layer_id: str
    cumulative: bool
    z: list[float] = Field(..., description="Axial position of the grid rows [mm]")
    s: list[float] = Field(..., description="Liner meridian arclength of the grid rows [mm]")
    r: list[float] = Field(..., description="Outer surface radius after this layer at the rows [mm]")
    z_surface: list[float] = Field(default_factory=list, description="Axial position of that surface point [mm]")
    phi: list[float] = Field(..., description="Grid columns [deg]")
    t: list[list[float]] = Field(..., description="Thickness [mm], rows x columns (downsampled)")
    mean: list[float]
    min: list[float]
    max: list[float]
    analytic: list[float] = Field(..., description="Axisymmetric band-averaged model at the rows [mm]")
    nominal: float
    peak: float
    analytic_peak: float
    cyl_mean: float
    cyl_cv: float = Field(..., description="Coefficient of variation of thickness in the cylinder")
    gap_fraction: float = Field(..., description="Cylinder area below 50% of nominal")
    overlap_fraction: float = Field(..., description="Cylinder area above 150% of nominal")
    warnings: list[str] = []


class TensionScheduleRequest(BaseModel):
    project: Project
    target_tension: Optional[float] = Field(None, gt=0, description="Outermost layer tension [N]")
    max_factor: float = Field(5.0, ge=1.0, le=10.0, description="Cap on inner layer stress vs target")


class TensionScheduleResult(BaseModel):
    layer_ids: list[str]
    current_tension: list[float]
    recommended_tension: list[float]
    residual_current: list[float] = Field(..., description="Residual ply prestress with current tensions [MPa]")
    residual_recommended: list[float]
    liner_hoop_current: float
    liner_hoop_recommended: float


class OptimiseRequest(BaseModel):
    project: Project
    time_budget: float = Field(60.0, ge=5, le=600, description="Wall-clock budget [s]")


class OptimiseResult(BaseModel):
    layers: list[Layer]
    mass_before: float
    mass_after: float
    evaluations: int
    notes: list[str]


class TestCorrelation(BaseModel):
    id: str
    serial: str
    kind: str
    measured: float
    predicted: Optional[float]
    ratio: Optional[float] = Field(None, description="Measured / predicted")
    location_match: Optional[bool] = None
    expansion_ratio: Optional[float] = Field(None, description="Measured / predicted total volumetric expansion")


class CalibrationResult(BaseModel):
    tests: list[TestCorrelation]
    burst_mean_ratio: Optional[float]
    burst_cov: Optional[float]
    current_efficiency: float
    suggested_efficiency: Optional[float] = Field(None, description="Translation efficiency matching the mean")
    b_basis_efficiency: Optional[float] = Field(None, description="Mean - k*sd (one-sided tolerance, 90%/95%)")
    notes: list[str]


class GcodeRequest(BaseModel):
    project: Project
    layer_ids: Optional[list[str]] = None


class LayerRequest(BaseModel):
    project: Project
    layer_id: str
    max_points: int = 20000
