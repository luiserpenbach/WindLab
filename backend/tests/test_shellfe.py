import numpy as np
import pytest

from windlab import schemas as S
from windlab.core import shellfe
from windlab.core.design import _vessel, analyze, build
from windlab.core.materials import get_liner
from windlab.core.structural import LinerState


def test_membrane_liner_only_matches_thin_shell_theory():
    p = S.Project(liner=S.LinerSpec(dome_type="hemispherical", wall_thickness=2.0, boss_radius_a=10,
                                    boss_radius_b=10, neck_thickness=2.0))
    b = build(p)
    sol = shellfe.solve(b, 1.0)
    m = get_liner("AA6061-T6")
    mem = 0.5 * (sol.liner_stress(m.E, m.nu, "inner") + sol.liner_stress(m.E, m.nu, "outer"))
    Ri, Rref, t = 98.0, 100.0, 2.0
    i = np.argmin(np.abs(sol.z))
    assert mem[i, 1] == pytest.approx(Ri / t, rel=2e-3)  # hoop: exact equilibrium p Ri / t
    assert mem[i, 0] == pytest.approx(Ri**2 / (2 * Rref * t), rel=2e-3)  # axial resultant at the reference
    j = np.argmin(np.abs(sol.z - 200.0))  # sphere, away from junction and boss
    assert mem[j, 0] == pytest.approx(mem[j, 1], rel=5e-3)


def test_junction_bending_appears():
    p = S.Project(liner=S.LinerSpec(dome_type="hemispherical", wall_thickness=2.0))
    sol = shellfe.solve(build(p), 1.0)
    i = np.argmin(np.abs(sol.z - 150.0))
    assert np.abs(sol.kap[i - 5: i + 5, 0]).max() > 50 * np.abs(sol.kap[np.argmin(np.abs(sol.z)), 0])


def test_fe_cylinder_matches_cylinder_model(sized_project):
    b = build(sized_project)
    sol = shellfe.solve(b, 10.0)
    v = _vessel(b)
    st = v.solve(10.0, LinerState(), np.zeros(2))
    i = np.argmin(np.abs(sol.z))
    assert sol.eps[i, 1] == pytest.approx(st.eps[1], rel=0.01)
    # thick overwraps: the two thin-wall models differ in how they weight the layer radii
    assert sol.eps[i, 0] == pytest.approx(st.eps[0], rel=0.06)
    for k, g in enumerate(v.groups):
        assert sol.layer_fiber_strain(k)[i] == pytest.approx(g.fiber_strain(st.eps), rel=0.06)


def test_fe_results_in_analysis(sized_project):
    res = analyze(sized_project)
    fe = res.fe
    assert fe is not None and len(fe.z) == len(fe.fiber_ratio[0])
    assert fe.dome_burst <= res.structural.burst_pressure + 1e-9
    assert {"fe.burst", "fe.liner"} <= {c.id for c in res.checks}
    assert fe.liner_hotspot_factor >= 1.0
