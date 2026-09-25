import math

import numpy as np
import pytest

from windlab import schemas as S
from windlab.core import patterns
from windlab.core.design import build, dome_netting_stress
from windlab.core.geometry import liner_profiles
from windlab.core.winding import geodesic_pass


@pytest.mark.parametrize("dome", ["isotensoid", "hemispherical", "elliptical"])
def test_profiles_are_closed_and_monotone(dome):
    outer, inner = liner_profiles(S.LinerSpec(dome_type=dome))
    assert np.all(np.diff(outer.z) > 0)
    assert outer.r.max() == pytest.approx(100.0)
    assert outer.r[0] == pytest.approx(20.0) and outer.r[-1] == pytest.approx(20.0)
    assert np.all(outer.r - inner.r > 0)


def test_hemisphere_volume():
    spec = S.LinerSpec(dome_type="hemispherical", boss_radius_a=1.0, boss_radius_b=1.0, cyl_length=200)
    outer, _ = liner_profiles(spec, n_dome=2000)
    exact = math.pi * 100**2 * 200 + 4 / 3 * math.pi * 100**3
    assert outer.volume() == pytest.approx(exact, rel=2e-3)


def test_isotensoid_height():
    # classic result: a geodesic isotensoid with a small opening is ~0.6 R high
    outer, _ = liner_profiles(S.LinerSpec(dome_type="isotensoid", boss_radius_a=10, boss_radius_b=10))
    h = (outer.z[-1] - outer.z[0] - 300) / 2
    assert 0.55 * 100 < h < 0.65 * 100


@pytest.mark.parametrize("r0", [15.0, 30.0, 50.0])
def test_geodesic_advance_matches_great_circle(r0):
    # on a hemisphere-capped cylinder: pi from the two domes + L tan(a) / R on the cylinder
    spec = S.LinerSpec(dome_type="hemispherical", boss_radius_a=10, boss_radius_b=10, cyl_length=300)
    outer, _ = liner_profiles(spec, n_dome=1000)
    gp = geodesic_pass(outer, r0, n=1000)
    a = math.asin(r0 / 100)
    assert gp.advance == pytest.approx(math.pi + 300 * math.tan(a) / 100, rel=1e-5)
    # Clairaut: r sin(a) = r0 along the whole path
    dphi = np.gradient(gp.phi)
    dl = np.hypot(np.gradient(gp.z), np.gradient(gp.r))
    sin_a = gp.r * dphi / np.hypot(dl, gp.r * dphi)
    mid = slice(20, -20)
    assert np.allclose(gp.r[mid] * sin_a[mid], r0, rtol=2e-2)


def test_patterns_close_and_cover():
    adv = 3.1
    cands = patterns.candidates(adv, 100.0, math.radians(15), 6.0, math.radians(60))
    assert cands
    for c in cands:
        slots = {(i * c.shift) % c.n_bands for i in range(c.n_bands)}
        assert len(slots) == c.n_bands  # every band slot visited once
        total = 2 * adv + 2 * c.dwell
        assert (total - 2 * math.pi * c.shift / c.n_bands) % (2 * math.pi) == pytest.approx(0, abs=1e-9) or \
            (total - 2 * math.pi * c.shift / c.n_bands) % (2 * math.pi) == pytest.approx(2 * math.pi, abs=1e-9)
        assert c.coverage >= 1.0
        assert 0 <= c.dwell <= math.radians(60)
        assert (c.pattern_number * c.shift) % c.n_bands in (1, c.n_bands - 1)


def test_isotensoid_netting_is_uniform():
    p = S.Project(layers=[S.Layer(id="a", type="helical")])
    b = build(p)
    z, s = dome_netting_stress(b, 30.0)
    assert np.nanmax(s) / np.nanmin(s) < 1.15


def test_helical_thickness_on_cylinder_and_growth_on_dome():
    p = S.Project(layers=[S.Layer(id="a", type="helical")])
    bl = build(p).layers[0]
    t_mid = np.interp(0.0, bl.base.z, bl.thickness)
    assert t_mid == pytest.approx(bl.t_cyl, rel=1e-3)
    assert bl.thickness.max() > 3 * bl.t_cyl  # build-up near the polar opening
    assert np.all(np.isfinite(bl.thickness))


@pytest.mark.parametrize("target,direction", [(2, "leading"), (5, "lagging"), (3, "any")])
def test_pattern_style_selection(target, direction):
    from windlab.core.design import build

    L = S.Layer(id="h", type="helical", pattern_number=target, pattern_direction=direction, dwell_max=180)
    p = build(S.Project(layers=[L])).layers[0].pattern
    assert p.pattern_number == target
    if direction != "any":
        assert p.leading == (direction == "leading")
