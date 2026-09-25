import numpy as np
import pytest

from windlab import schemas as S
from windlab.core import tension
from windlab.core.design import analyze, build
from windlab.core.geometry import Profile, clean_offset


def test_clean_offset_removes_loops_and_keeps_points():
    # thick offset of a small sphere-capped cylinder: normal offsetting folds near the pole
    th = np.linspace(0, np.pi / 2 - 0.3, 200)
    zc = np.linspace(-50, 50, 50)
    z = np.concatenate([-50 - 30 * np.sin(th[::-1]), zc, 50 + 30 * np.sin(th)])
    r = np.concatenate([30 * np.cos(th[::-1]), np.full(50, 30.0), 30 * np.cos(th)])
    p = Profile(z, r)
    t = np.where(np.abs(z) > 70, 25.0, 1.0)
    off = clean_offset(p.offset(t), 50.0)
    assert len(off.z) == len(z)
    # outer boundary: every point of the raw offset lies inside the cleaned envelope (per polar angle)
    side = off.z > 50
    theta = np.arctan2(off.r[side], off.z[side] - 50)
    assert np.all(np.diff(theta) <= 1e-9)


def test_tension_loss_and_schedule():
    p = S.Project(layers=[S.Layer(id=f"c{i}", type="hoop", tension=30.0) for i in range(6)])
    b = build(p)
    cur = tension.analyse(b)
    assert np.all(np.diff(cur.loss) <= 1e-12)  # inner layers lose the most
    assert cur.loss[0] > 0.3 and cur.loss[-1] == pytest.approx(0.0)
    assert cur.liner_hoop < 0
    rec = tension.schedule(b)
    after = tension.analyse(b, rec)
    assert np.allclose(after.residual_stress, after.residual_stress[-1], rtol=1e-6)
    assert np.all(np.diff(rec) <= 1e-9)  # decreasing outward


def test_low_angle_helicals_keep_tension():
    p = S.Project(layers=[S.Layer(id="h", type="helical", tension=30), S.Layer(id="c", type="hoop", passes=6)])
    tr = tension.analyse(build(p))
    assert tr.loss[0] < 0.1  # sin^2(13 deg) coupling is weak


def test_quality_fields_in_analysis(sized_project):
    res = analyze(sized_project)
    L = res.layers
    assert all(l.winding_stress > 0 for l in L)
    assert any(c.id == "tension.loss" for c in res.checks)
    hel = [l for l in L if l.type == "helical"]
    assert all(np.isfinite(l.min_normal_curvature) for l in hel)
