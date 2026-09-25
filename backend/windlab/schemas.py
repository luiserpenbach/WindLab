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


class CompositeSpec(BaseModel):
    fiber: str = Field("T700S-12K", description="Fibre id (see /api/materials)")
    resin: str = Field("Epoxy-DGEBA", description="Resin id (see /api/materials)")
    fiber_volume_fraction: float = Field(0.60, gt=0.3, lt=0.8)
    translation_efficiency: float = Field(
        0.82, gt=0.3, le=1.0, description="Fibre strength translation efficiency in the vessel"
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
    turnaround_offset: float = Field(
        0.0, ge=0, description="Extra turnaround radius beyond boss + band/2 [mm] (dome stagger)"
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
    axes_count: Literal[3, 4] = 4
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


class Project(BaseModel):
    schema_version: int = SCHEMA_VERSION
    name: str = "Untitled COPV"
    notes: str = ""
    liner: LinerSpec = LinerSpec()
    requirements: Requirements = Requirements()
    composite: CompositeSpec = CompositeSpec()
    layers: list[Layer] = []
    machine: MachineSpec = MachineSpec()


# --------------------------------------------------------------------------- results
Status = Literal["ok", "warn", "fail", "info"]


class Check(BaseModel):
    id: str
    label: str
    status: Status
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
    mass: MassResult
    checks: list[Check]


class PathResult(BaseModel):
    layer_id: str
    points: list[list[float]] = Field(..., description="[x, y, z] in mandrel frame, x = axis [mm]")
    circuit_breaks: list[int] = Field(..., description="Indices where each circuit starts")


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


class GcodeRequest(BaseModel):
    project: Project
    layer_ids: Optional[list[str]] = None


class LayerRequest(BaseModel):
    project: Project
    layer_id: str
    max_points: int = 20000
