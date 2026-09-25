import numpy as np
import pytest

from windlab import schemas as S
from windlab.core.design import _vessel, analyze, build
from windlab.core.materials import get_fiber, get_resin, ply_properties


def test_ply_cte_schapery():
    ply = ply_properties(get_fiber("T700S-12K"), get_resin("Epoxy-DGEBA"), 0.6, 0.82)
    assert 0.0 < ply.alpha1 < 1e-6  # carbon/epoxy: near zero along the fibre
    assert 25e-6 < ply.alpha2 < 45e-6


def test_cure_cooldown_puts_aluminium_liner_in_tension(sized_project):
    b = build(sized_project)
    v = _vessel(b)
    cure = v.cool(-100.0)
    s = cure[-1]
    assert s.liner_sigma[1] > 50  # liner shrinks more than the carbon overwrap
    # free body at zero pressure: composite + liner hoop forces cancel
    comp = sum(g.t * (g.qbar() @ (s.eps - g.alpha() * -100.0))[1] for g in v.groups)
    assert comp + v.liner.t * s.liner_sigma[1] == pytest.approx(0.0, abs=1e-6)


def test_no_thermal_stress_when_cured_at_ambient(sized_project):
    p = sized_project.model_copy(update={"composite": sized_project.composite.model_copy(
        update={"cure_temperature": sized_project.requirements.temperature_ref})})
    st = analyze(p).structural
    assert abs(st.cure_residual.liner_hoop) < 1e-6


def test_titanium_liner_less_thermal_mismatch(sized_project):
    al = analyze(sized_project).structural.cure_residual.liner_hoop
    ti = analyze(sized_project.model_copy(update={"liner": sized_project.liner.model_copy(
        update={"material": "Ti-6Al-4V"})})).structural.cure_residual.liner_hoop
    assert ti < al


def test_temperature_checks_present(sized_project):
    res = analyze(sized_project)
    ids = {c.id for c in res.checks}
    assert {"sr.temp", "liner.temp"} <= ids
    st = res.structural
    assert st.stress_ratio_worst >= max(st.stress_ratio_hoop, st.stress_ratio_helical) - 1e-9
