import math

import numpy as np
import pytest
from scipy.signal import savgol_filter

from windlab import schemas as S
from windlab.core import paths
from windlab.core.design import analyze, build
from windlab.core.geometry import liner_profiles
from windlab.core.kinematics import simulate_layer


@pytest.fixture(scope="module")
def liner():
    return liner_profiles(S.LinerSpec(dome_type="hemispherical", boss_radius_a=15, boss_radius_b=15))[0]


def test_zero_slippage_reproduces_geodesic(liner):
    r0 = 26.0
    g = paths.geodesic(liner, r0)
    ng = paths.non_geodesic(liner, 150.0, math.asin(r0 / 100.0), r0, r0)
    assert abs(ng.lam_a) < 1e-3 and abs(ng.lam_b) < 1e-3
    assert ng.advance == pytest.approx(g.advance, rel=1e-4)


@pytest.mark.parametrize("r_t", [22.0, 35.0, 45.0])
def test_turnaround_hits_target(liner, r_t):
    ng = paths.non_geodesic(liner, 150.0, math.asin(26.0 / 100.0), r_t, r_t)
    assert ng.r_a == pytest.approx(r_t, abs=0.1) and ng.r_b == pytest.approx(r_t, abs=0.1)
    # turning later (smaller radius) needs negative slippage, earlier needs positive
    assert np.sign(ng.lam_b) == np.sign(r_t - 26.0)


def test_path_curvature_matches_prescribed_slippage(liner):
    """Independent check: measure kg/kn of the 3D path by finite differences."""
    ng = paths.non_geodesic(liner, 150.0, math.asin(26.0 / 100.0), 40.0, 40.0)
    p = ng.resample(1500)
    P = np.stack([p.z, p.r * np.cos(p.phi), p.r * np.sin(p.phi)], axis=1)
    dl = np.linalg.norm(np.diff(P, axis=0), axis=1).mean()
    T = savgol_filter(P, 21, 3, deriv=1, delta=dl, axis=0)
    T /= np.linalg.norm(T, axis=1)[:, None]
    K = savgol_filter(P, 21, 3, deriv=2, delta=dl, axis=0)
    # outward surface normal from the meridian normal
    n = liner.normals()
    nz = np.interp(p.z, liner.z, n[:, 0])
    nr = np.interp(p.z, liner.z, n[:, 1])
    N = np.stack([nz, nr * np.cos(p.phi), nr * np.sin(p.phi)], axis=1)
    kn = -(K * N).sum(axis=1)
    kg = (K * np.cross(N, T)).sum(axis=1)
    dome = (np.abs(p.z) > 160) & (p.alpha < math.radians(80))  # away from turnaround and tangent line
    lam = np.abs(kg[dome] / kn[dome])
    assert np.median(lam) == pytest.approx(abs(ng.lam_b), rel=0.01)
    cyl = np.abs(p.z) < 120
    assert np.median(np.abs(kg[cyl] / kn[cyl])) < 0.01


def test_unequal_openings_balanced_auto_angle():
    p = S.Project(liner=S.LinerSpec(boss_radius_a=15, boss_radius_b=26),
                  layers=[S.Layer(id="h", type="helical", winding="non-geodesic")])
    b = build(p)
    gp = b.layers[0].gp
    assert gp.r_a == pytest.approx(18.0, abs=0.2) and gp.r_b == pytest.approx(29.0, abs=0.2)
    assert abs(gp.lam_a + gp.lam_b) < 0.02  # balanced
    t = b.layers[0].thickness
    assert np.all(np.isfinite(t)) and t.max() > 2 * b.layers[0].t_cyl
    # geodesic alternative must turn at the larger radius on both ends
    pg = p.model_copy(update={"layers": [S.Layer(id="g", type="helical")]})
    bg = build(pg)
    assert bg.layers[0].gp.r_a == pytest.approx(29.0)


def test_slippage_check_and_simulation():
    p = S.Project(layers=[S.Layer(id="h", type="helical", winding="non-geodesic", angle=20.0, friction=0.05)])
    res = analyze(p)
    chk = next(c for c in res.checks if c.id == "layer.h.slip")
    assert chk.status == "fail" and chk.value > 0.05
    b = build(p)
    mo = simulate_layer(b, b.layers[0])
    assert np.all(np.diff(mo.t) > 0) and mo.total_time > 0


def test_unreachable_turnaround_is_reported():
    p = S.Project(layers=[S.Layer(id="h", type="helical", winding="non-geodesic", angle=70.0),
                          S.Layer(id="c", type="hoop")])
    res = analyze(p)  # the analysis survives: the layer falls back to a geodesic path and is flagged
    chk = next(c for c in res.checks if c.id == "layer.h.path")
    assert chk.status == "fail" and "reachable" in chk.detail
    assert res.structural is not None
