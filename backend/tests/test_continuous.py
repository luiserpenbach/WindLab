import math

import numpy as np
import pytest

from windlab import presets
from windlab.core.continuous import _ramp, plan
from windlab.core.design import build
from windlab.core.kinematics import layer_path
from windlab.post.gcode import generate
from windlab.post.verify import verify


def _desktop(**cont):
    p = next(e["project"] for e in presets.examples() if e["id"] == "grbl-10mpa-1l")
    return p.model_copy(update={"continuous": p.continuous.model_copy(update=cont)})


def test_cylinder_ramp_closed_form():
    """Constant-slippage ramp on a cylinder: da/dl = lam sin^2(a) / R (non-geodesic path equation)."""
    R, lam = 50.0, 0.15
    dz, phi, a, lm = _ramp(R, math.radians(65), math.radians(88), lam, n=400)
    dl = np.hypot(np.diff(dz), R * np.diff(phi))
    am = 0.5 * (a[1:] + a[:-1])
    np.testing.assert_allclose(np.diff(a) / dl, lam * np.sin(am) ** 2 / R, rtol=2e-3)
    np.testing.assert_allclose(np.diff(dz) / dl, np.cos(am), rtol=2e-3)
    down = _ramp(R, math.radians(88), math.radians(65), lam)
    assert down[0][-1] == pytest.approx(dz[-1], rel=1e-9) and down[3][0] < 0


def test_plan_continuity_and_limits():
    p = _desktop(enabled=True)
    b = build(p)
    pl = plan(b)
    assert len(pl.transitions) == len(b.layers) - 1 and pl.feasible
    step = math.radians(p.continuous.max_angle_step)
    for T in pl.transitions:
        assert T.max_slip <= T.limit + 1e-9
        pts = ([] if T.src.spec.type == "hoop" else [T.src.angle]) + T.angles + \
              ([] if T.dst.spec.type == "hoop" else [T.dst.angle])
        assert all(abs(x - y) <= step + 1e-6 for x, y in zip(pts, pts[1:]))
    segs = [s for s in pl.segments if len(s.path.z) > 1]
    for s0, s1 in zip(segs, segs[1:]):
        gap = np.linalg.norm(s1.path.xyz()[0] - s0.path.xyz()[-1])
        step_max = np.linalg.norm(np.diff(s1.path.xyz(), axis=0), axis=1).max()
        assert gap <= max(step_max, 1.0) + 1e-6, (s0.label, s1.label, gap)  # no jump beyond one path step
        assert s1.path.phi[0] >= s0.path.phi[-1] - 1e-9
    for s in segs:
        assert np.all(np.diff(s.path.phi) >= -1e-9), s.label  # the mandrel never turns backwards
    # helical layers lay exactly their planned pattern: azimuth shift is a multiple of the band slot
    for s in pl.segments:
        if s.kind == "layer" and s.layer.spec.type == "helical":
            slot = 2 * math.pi / s.layer.pattern.n_bands
            shift = s.path.phi[0] - layer_path(b, s.layer).phi[0]
            assert abs((shift / slot) - round(shift / slot)) < 1e-6


def test_direct_join_and_angle_step():
    p = _desktop(enabled=True)
    hel = next(L for L in p.layers if L.type == "helical")
    same = p.model_copy(update={"layers": [hel, hel.model_copy(update={"id": "hel_b", "start_angle": 33.0})]})
    T = plan(build(same)).transitions[0]
    assert T.kind == "direct" and T.angles == [] and T.feasible
    # a finer angle step needs more transition passes
    b = build(p)
    coarse = sum(len(T.angles) for T in plan(b).transitions)
    fine = sum(len(T.angles) for T in plan(b, spec=p.continuous.model_copy(update={"max_angle_step": 4.0})).transitions)
    assert fine > coarse


def test_continuous_gcode_verifies():
    p = _desktop(enabled=True)
    prog = generate(p)
    v = verify(prog.text)
    assert not v.errors
    assert v.total_time == pytest.approx(prog.total_time, rel=1e-3)
    assert prog.text.count("M0") <= 1  # no stops between layers: the roving is never cut
    assert "Transition" in prog.text
    sep = generate(_desktop(enabled=False))
    assert sep.text.count("M0") == len(p.layers)
