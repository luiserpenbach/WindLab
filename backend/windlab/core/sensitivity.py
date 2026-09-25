"""Burst sensitivity and statistical margin (first-order second-moment).

Each scattered input is perturbed by +/- one standard deviation (central differences on the cylinder
model burst, whole pressure history included: cure residual stresses, autofrettage, cracking). With the
inputs independent and the response close to linear over +/- 1 sd,

    sd_burst^2 = sum_i (d burst / d x_i * sd_i)^2

The lower bound is ``mean - 1.282 sd`` (10 % one-sided, normal) and the probability of bursting below the
required pressure follows from the normal distribution. The mean is the nominal design. The shares show
which tolerance or material scatter to tighten first.
"""
from __future__ import annotations

import math
from dataclasses import asdict

from .. import schemas as S
from .design import build, structural
from .materials import get_fiber, get_liner

Z90 = 1.2816


def _with_fiber(p: S.Project, **scale) -> S.Project:
    f = get_fiber(p.composite.fiber, p.materials)
    d = asdict(f)
    for k, v in scale.items():
        d[k] *= v
    lib = p.materials.model_copy(update={
        "fibers": [x for x in p.materials.fibers if x.id != f.id] + [S.CustomFiber(**d)]})
    return p.model_copy(update={"materials": lib})


def _with_liner(p: S.Project, **scale) -> S.Project:
    m = get_liner(p.liner.material, p.materials)
    d = asdict(m)
    for k, v in scale.items():
        d[k] *= v
    lib = p.materials.model_copy(update={
        "liners": [x for x in p.materials.liners if x.id != m.id] + [S.CustomLiner(**d)]})
    return p.model_copy(update={"materials": lib})


def _composite(p: S.Project, **upd) -> S.Project:
    return p.model_copy(update={"composite": p.composite.model_copy(update=upd)})


def _liner_geom(p: S.Project, **upd) -> S.Project:
    return p.model_copy(update={"liner": p.liner.model_copy(update=upd)})


def inputs(p: S.Project, spec: S.SensitivitySpec) -> list[tuple[str, str, callable]]:
    """(name, one-sd description, project perturbed by k standard deviations)."""
    c, lin = p.composite, p.liner
    return [
        ("Fibre strength", f"CoV {spec.fiber_strength_cov:.1%}",
         lambda k: _with_fiber(p, strength=1 + k * spec.fiber_strength_cov)),
        ("Fibre modulus", f"CoV {spec.fiber_modulus_cov:.1%}",
         lambda k: _with_fiber(p, E=1 + k * spec.fiber_modulus_cov)),
        ("Fibre tex (fibre per band)", f"CoV {spec.tex_cov:.1%}", lambda k: _with_fiber(p, tex=1 + k * spec.tex_cov)),
        ("Fibre volume fraction", f"sd {spec.vf_sd:g}",
         lambda k: _composite(p, fiber_volume_fraction=c.fiber_volume_fraction + k * spec.vf_sd)),
        ("Translation efficiency", f"CoV {spec.efficiency_cov:.1%}",
         lambda k: _composite(p, translation_efficiency=min(c.translation_efficiency * (1 + k * spec.efficiency_cov), 1.0))),
        ("Liner yield strength", f"CoV {spec.liner_yield_cov:.1%}",
         lambda k: _with_liner(p, yield_=1 + k * spec.liner_yield_cov, ultimate=1 + k * spec.liner_yield_cov)),
        ("Liner wall thickness", f"sd {spec.liner_wall_sd:g} mm",
         lambda k: _liner_geom(p, wall_thickness=lin.wall_thickness + k * spec.liner_wall_sd)),
        ("Cure (stress-free) temperature", f"sd {spec.cure_temp_sd:g} K",
         lambda k: _composite(p, cure_temperature=c.cure_temperature + k * spec.cure_temp_sd)),
    ]


def _burst(p: S.Project) -> float:
    st, _ = structural(build(p))
    return float(st.burst_pressure)


def analyse(p: S.Project, spec: S.SensitivitySpec | None = None) -> S.SensitivityResult:
    spec = spec or S.SensitivitySpec()
    req = p.requirements.meop * p.requirements.burst_factor
    nominal = _burst(p)
    items = []
    for name, desc, f in inputs(p, spec):
        try:
            hi, lo = _burst(f(1.0)), _burst(f(-1.0))
        except Exception as e:  # an input that cannot be perturbed (e.g. geometry limit): report and skip
            items.append(S.SensitivityItem(name=name, scatter=desc, burst_minus=math.nan, burst_plus=math.nan,
                                           effect=0.0, share=0.0, note=str(e)[:120]))
            continue
        items.append(S.SensitivityItem(name=name, scatter=desc, burst_minus=lo, burst_plus=hi,
                                       effect=0.5 * (hi - lo), share=0.0))
    var = sum(i.effect**2 for i in items)
    sd = math.sqrt(var)
    for i in items:
        i.share = i.effect**2 / var if var > 0 else 0.0
    items.sort(key=lambda i: -abs(i.effect))
    lower = nominal - Z90 * sd
    p_fail = 0.5 * math.erfc((nominal - req) / (sd * math.sqrt(2))) if sd > 0 else float(nominal < req)
    return S.SensitivityResult(nominal=nominal, sd=sd, cov=sd / nominal if nominal else 0.0, lower_90=lower,
                               required=req, p_below_required=p_fail, items=items,
                               notes=["Cylinder-model burst; dome-critical designs: check the progressive analysis",
                                      "Independent inputs, linearised response (FOSM)"])
