import math

import numpy as np
import pytest
from scipy.integrate import solve_ivp

from windlab import presets
from windlab import schemas as S
from windlab.core import cure
from windlab.core.design import build
from windlab.core.materials import get_resin


def _desktop(**comp):
    p = next(e["project"] for e in presets.examples() if e["id"] == "grbl-10mpa-1l")
    return p.model_copy(update={"composite": p.composite.model_copy(update=comp)})


def _custom_resin(heat):
    r = get_resin("Epoxy-DGEBA")
    return S.CustomResin(id="R", name="test", E=r.E, density=r.density, heat=heat)


def test_no_reaction_heat_means_no_exotherm():
    p = _desktop(resin="R")
    p = p.model_copy(update={"materials": S.MaterialLibrary(resins=[_custom_resin(0.0)])})
    for sec in cure.analyse(build(p)).sections:
        assert sec.overshoot == pytest.approx(0.0, abs=1e-9)


def test_kinetics_match_ode_when_the_wall_follows_the_oven():
    """Tiny heat of reaction and a huge film coefficient: the laminate sits at the oven temperature, so the
    degree of cure must follow the kinetics ODE integrated along the oven profile."""
    p = _desktop(resin="R", oven_htc=1e5, cure_cycle=[S.CureStep(ramp=5.0, temperature=110.0, hold=180.0)])
    p = p.model_copy(update={"materials": S.MaterialLibrary(resins=[_custom_resin(1e-6)])})
    b = build(p)
    r = cure.analyse(b).sections[0]
    resin = get_resin("R", p.materials)
    times, oven = cure.oven_profile(cure.cycle_of(b), p.requirements.temperature_ref)

    def rhs(t, y):
        T = np.interp(t, times, oven)
        TK = T + 273.15
        a = min(max(y[0], 0.0), 1.0)
        lam = resin.tg_lambda
        tg = resin.tg0 + (resin.tg_inf - resin.tg0) * lam * a / (1 - (1 - lam) * a)
        fd = 1 / (1 + math.exp(max(min((tg - T) / cure.DT_VITRIFY, 50), -50)))
        k1 = resin.A1 * math.exp(-resin.E1 / (8.314 * TK))
        k2 = resin.A2 * math.exp(-resin.E2 / (8.314 * TK))
        return [fd * (k1 + k2 * max(a, 1e-6) ** resin.m) * (1 - a) ** resin.n]

    sol = solve_ivp(rhs, (0, times[-1]), [0.0], max_step=30.0, rtol=1e-8)
    assert r.a_mid[-1] == pytest.approx(sol.y[0, -1], abs=0.01)
    assert r.min_cure == pytest.approx(sol.y[0, -1], abs=0.01)


def test_thicker_laminate_has_larger_exotherm_and_tg_limits():
    resin = get_resin("Epoxy-DGEBA")
    b = build(_desktop())
    t, oven = cure.oven_profile(cure.cycle_of(b), 20.0)
    thin = cure.simulate_section(b, cure.Section("thin", 48.5, 1.5, 2.0), t, oven)
    thick = cure.simulate_section(b, cure.Section("thick", 48.5, 1.5, 12.0), t, oven)
    assert thick["overshoot"] > thin["overshoot"] > 0
    # DiBenedetto end points: Tg of the fully cured resin is never exceeded
    assert thick["tg_final"] <= resin.tg_inf + 1e-9


def test_suggested_cycle_meets_the_limits():
    p = next(e["project"] for e in presets.examples() if e["id"] == "grbl-10mpa-1l")
    p = p.model_copy(update={"composite": p.composite.model_copy(update={"max_exotherm": 8.0})})
    b = build(p)
    steps, res, notes = cure.suggest_cycle(b)
    assert steps and notes
    comp, req = p.composite, p.requirements
    for sec in res.sections:
        assert sec.overshoot <= comp.max_exotherm
        assert sec.min_cure >= comp.min_cure
        assert sec.tg_final >= req.temperature_max + comp.tg_margin
