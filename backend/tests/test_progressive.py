import numpy as np
import pytest

from windlab import presets
from windlab.core.design import build, structural
from windlab.core.failure import puck_iff
from windlab.core.progressive import run


def test_puck_pure_modes():
    Yt, Yc, S = 50.0, 200.0, 80.0
    assert puck_iff(Yt, 0.0, Yt, Yc, S) == pytest.approx(1.0)  # mode A, pure transverse tension
    assert puck_iff(0.0, S, Yt, Yc, S) == pytest.approx(1.0)  # pure in-plane shear
    assert puck_iff(-Yc, 0.0, Yt, Yc, S) == pytest.approx(1.0)  # mode C, pure transverse compression
    # moderate transverse compression raises the shear capacity (mode B)
    assert puck_iff(-40.0, S, Yt, Yc, S) < 1.0
    # the criterion is homogeneous of degree 1 in stress
    assert puck_iff(20.0, 30.0, Yt, Yc, S) * 2 == pytest.approx(puck_iff(40.0, 60.0, Yt, Yc, S))


def test_progressive_desktop_burst():
    project = next(e["project"] for e in presets.examples() if e["id"] == "grbl-10mpa-1l")
    b = build(project)
    r = run(b, max_len=6.0)
    req = project.requirements.meop * project.requirements.burst_factor
    assert np.isfinite(r.burst_pressure) and r.burst_pressure > project.requirements.meop
    assert r.burst_pressure > req
    # the shell model captures dome/junction bending the cylinder model ignores, so it is not higher by much
    st, _ = structural(b)
    assert 0.75 * st.burst_pressure < r.burst_pressure < 1.05 * st.burst_pressure
    assert np.isfinite(r.burst_z)
    if r.first_ff_pressure is not None:
        assert r.first_ff_pressure <= r.burst_pressure + 1e-6
    assert len(r.curve_p) == len(r.curve_strain) >= 3
    assert np.all(np.diff(r.curve_p) > 0)
