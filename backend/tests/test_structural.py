import numpy as np
import pytest

from windlab import schemas as S
from windlab.core.design import _vessel, analyze, build
from windlab.core.materials import get_liner
from windlab.core.structural import Liner, LinerState, first_yield_pressure, run_history, von_mises


def test_liner_return_mapping_uniaxial():
    mat = get_liner("AA6061-T6")
    L = Liner(mat, 2.0, 100.0)
    # stress path along uniaxial tension: plastic flow must stay on the yield surface
    st = LinerState()
    for e in np.linspace(0, 0.02, 30)[1:]:
        s, st = L.stress(np.array([e, -0.5 * e]), st)
    assert von_mises(s) == pytest.approx(mat.yield_ + L.H * st.alpha, rel=1e-6)


def test_equilibrium_is_satisfied(sized_project):
    b = build(sized_project)
    v = _vessel(b)
    for p in (10.0, 30.0, 60.0):
        st = v.solve(p, LinerState(), np.zeros(2))
        hoop = sum(g.t * (g.qbar() @ st.eps)[1] for g in v.groups) + v.liner.t * st.liner_sigma[1]
        assert hoop == pytest.approx(p * v.Ri, rel=1e-6)


def test_autofrettage_leaves_compressive_liner(sized_project):
    b = build(sized_project)
    v = _vessel(b)
    py = first_yield_pressure(v)
    hist = run_history(v, 1.3 * py, 1.0 * py, 0.8 * py)
    after = next(h.state for h in hist[1:] if h.phase == "unload" and h.state.p == 0.0)
    assert after.liner_sigma[1] < -50  # compressive hoop residual
    assert v.fiber_ratio(after.eps)["hoop"] > 0  # overwrap stays in tension
    # free-body at zero pressure: composite and liner forces cancel
    comp = sum(g.t * (g.qbar() @ after.eps)[1] for g in v.groups)
    assert comp + v.liner.t * after.liner_sigma[1] == pytest.approx(0.0, abs=1e-6)


def test_sized_design_passes_all_checks(sized_project):
    res = analyze(sized_project)
    st = res.structural
    assert st.burst_pressure >= st.required_burst
    assert st.burst_mode == "hoop"
    assert [c.id for c in res.checks if c.status == "fail"] == []


def test_more_hoops_raise_burst(sized_project):
    base = analyze(sized_project).structural.burst_pressure
    extra = S.Layer(id="extra", type="hoop", passes=4)
    p2 = sized_project.model_copy(update={"layers": sized_project.layers + [extra]})
    assert analyze(p2).structural.burst_pressure > base
