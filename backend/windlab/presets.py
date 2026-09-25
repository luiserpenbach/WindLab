"""Machine presets and example projects."""
from __future__ import annotations

from functools import lru_cache

from . import schemas as S

A = S.MachineAxis


def machine_presets() -> list[dict]:
    lcnc4 = S.MachineSpec()
    lcnc3 = S.MachineSpec(name="Generic 3-axis LinuxCNC", axes_count=3, eye=None)
    grbl3 = S.MachineSpec(
        name="GRBL 3-axis desktop winder",
        axes_count=3,
        controller="grbl",
        carriage=A(letter="X", max_velocity=6000, max_accel=200, min=0, max=800),
        mandrel=A(letter="Y", max_velocity=20000, max_accel=400, scale=1.0),
        crossfeed=A(letter="Z", max_velocity=1500, max_accel=100, min=0, max=150),
        eye=None,
        carriage_offset=400.0,
        crossfeed_zero_radius=30.0,
        eye_clearance=12.0,
        fiber_speed=60.0,
        tension_output="spindle",
        tension_scale=10.0,
        rotary_reset="circuit",
        samples_per_pass=120,
    )
    grbl4 = S.MachineSpec(
        name="grblHAL 4-axis winder",
        axes_count=4,
        controller="grbl",
        carriage=A(letter="X", max_velocity=8000, max_accel=250, min=0, max=1200),
        mandrel=A(letter="A", max_velocity=24000, max_accel=500),
        crossfeed=A(letter="Y", max_velocity=2000, max_accel=150, min=0, max=200),
        eye=A(letter="B", max_velocity=20000, max_accel=800),
        carriage_offset=600.0,
        crossfeed_zero_radius=30.0,
        eye_clearance=12.0,
        fiber_speed=80.0,
        tension_output="spindle",
        tension_scale=10.0,
        rotary_reset="circuit",
    )
    grbl2 = grbl3.model_copy(update={"name": "GRBL 2-axis winder (carriage + mandrel)", "axes_count": 2})
    return [
        {"id": "linuxcnc-4axis", "label": "LinuxCNC 4-axis (X carriage, Y crossfeed, A mandrel, B eye)", "machine": lcnc4},
        {"id": "linuxcnc-3axis", "label": "LinuxCNC 3-axis (X carriage, Y crossfeed, A mandrel)", "machine": lcnc3},
        {"id": "grbl-3axis", "label": "GRBL 3-axis (X carriage, Y mandrel in deg, Z crossfeed)", "machine": grbl3},
        {"id": "grbl-2axis", "label": "GRBL 2-axis (X carriage, Y mandrel in deg; eye at fixed radius)",
         "machine": grbl2},
        {"id": "grblhal-4axis", "label": "grblHAL 4-axis (X carriage, Y crossfeed, A mandrel, B eye)", "machine": grbl4},
    ]


def _machine(pid: str) -> S.MachineSpec:
    return next(p["machine"] for p in machine_presets() if p["id"] == pid)


def _examples_raw() -> list[tuple[str, str, S.Project]]:
    return [
        (
            "type3-30mpa-11l",
            "Type III, 30 MPa, 11.5 L, isotensoid domes, T700S (LinuxCNC 4-axis)",
            S.Project(name="Type III 30 MPa 11L"),
        ),
        (
            "type3-70mpa-2l",
            "Type III, 70 MPa, 2 L, hemispherical domes, T800S (LinuxCNC 4-axis)",
            S.Project(
                name="Type III 70 MPa 2L",
                liner=S.LinerSpec(radius=60, cyl_length=160, wall_thickness=3.0, dome_type="hemispherical",
                                  boss_radius_a=12, boss_radius_b=12, boss_length=25, shaft_radius=8),
                requirements=S.Requirements(meop=70, burst_factor=2.25, proof_factor=1.5, design_cycles=5000),
                composite=S.CompositeSpec(fiber="T800S-24K"),
                layers=[
                    S.Layer(id="h", type="helical", band_width=8.0, tension=30),
                    S.Layer(id="c", type="hoop", band_width=8.0, tension=40),
                ],
            ),
        ),
        (
            "type3-25mpa-unequal",
            "Type III, 25 MPa, 6 L, unequal openings, non-geodesic helicals (LinuxCNC 4-axis)",
            S.Project(
                name="Type III 25 MPa unequal openings",
                liner=S.LinerSpec(radius=80, cyl_length=260, wall_thickness=3.0, dome_type="isotensoid",
                                  boss_radius_a=14, boss_radius_b=24, boss_length=25, shaft_radius=8),
                requirements=S.Requirements(meop=25),
                layers=[
                    S.Layer(id="h", type="helical", winding="non-geodesic", band_width=6.0, tension=25,
                            friction=0.2),
                    S.Layer(id="c", type="hoop", band_width=6.0, tension=35),
                ],
            ),
        ),
        (
            "grbl-10mpa-1l",
            "Desktop demo, 10 MPa, 1 L, elliptical domes (GRBL 3-axis)",
            S.Project(
                name="Desktop 10 MPa 1L",
                liner=S.LinerSpec(radius=50, cyl_length=120, wall_thickness=1.5, dome_type="elliptical",
                                  dome_aspect=0.7, boss_radius_a=10, boss_radius_b=10, boss_length=20,
                                  shaft_radius=6),
                requirements=S.Requirements(meop=10, burst_factor=2.0, proof_factor=1.5, design_cycles=500),
                layers=[
                    S.Layer(id="h", type="helical", band_width=5.0, tension=15),
                    S.Layer(id="c", type="hoop", band_width=5.0, tension=20),
                ],
                machine=_machine("grbl-3axis"),
            ),
        ),
    ]


@lru_cache(maxsize=1)
def examples() -> list[dict]:
    from .core.design import suggest_layup

    out = []
    for eid, label, prj in _examples_raw():
        layers, _ = suggest_layup(prj)
        out.append({"id": eid, "label": label, "project": prj.model_copy(update={"layers": layers})})
    return out
