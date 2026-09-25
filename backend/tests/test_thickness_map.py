import math

import numpy as np
import pytest

from windlab import schemas as S
from windlab.core.design import build
from windlab.core.thickness_map import cumulative_map, layer_map, map_result


@pytest.fixture(scope="module")
def two_layer():
    return build(S.Project(layers=[S.Layer(id="c", type="hoop"), S.Layer(id="h", type="helical")]))


def test_single_band_footprint(two_layer):
    from windlab.core import patterns as P

    bl = two_layer.layers[1]
    full = bl.pattern
    bl.pattern = P.Pattern(1, 1, 1, full.dwell, 1.0, True, 0.0)
    try:
        m = layer_map(two_layer, bl)
    finally:
        bl.pattern = full
    ring = m.t[np.argmin(np.abs(m.z))]
    cell = 2 * math.pi * bl.R_mid / len(m.phi)
    width = ring.sum() / bl.t_band * cell  # both bands of the circuit
    assert width == pytest.approx(2 * bl.spec.band_width / math.cos(bl.angle), rel=0.02)


@pytest.mark.parametrize("which", [0, 1])
def test_rectangular_bands_tile_the_cylinder(two_layer, which):
    bl = two_layer.layers[which]
    m = layer_map(two_layer, bl, shape="rectangular")
    inner = np.abs(m.z) < 100
    t = m.t[inner] / bl.t_cyl
    assert t.mean() == pytest.approx(1.0, abs=0.01)
    assert t.std() < 0.03
    assert t.min() > 0.9


def test_mean_matches_axisymmetric_model_on_dome(two_layer):
    bl = two_layer.layers[1]
    m = layer_map(two_layer, bl)
    ana = np.interp(m.s, two_layer.liner_outer.s, bl.thickness)
    dome = (np.abs(m.z) > 155) & (ana > 0.3)
    ratio = m.t.mean(axis=1)[dome] / ana[dome]
    assert np.median(ratio) == pytest.approx(1.0, abs=0.01)
    assert np.percentile(np.abs(ratio - 1), 90) < 0.03


def test_lenticular_conserves_volume_but_ridges(two_layer):
    bl = two_layer.layers[1]
    rect = layer_map(two_layer, bl, shape="rectangular")
    lent = layer_map(two_layer, bl, shape="lenticular")
    assert lent.t.sum() == pytest.approx(rect.t.sum(), rel=1e-3)
    inner = np.abs(rect.z) < 100
    assert lent.t[inner].std() > 5 * rect.t[inner].std()


def test_cumulative_and_result(two_layer):
    c = cumulative_map(two_layer, 1)
    assert c.nominal == pytest.approx(sum(bl.t_cyl for bl in two_layer.layers))
    res = map_result(two_layer, "h", True, 1.0, 720)
    assert len(res.t) == len(res.z) and len(res.t[0]) == len(res.phi)
    assert res.peak > res.analytic_peak  # local ridges exceed the band-averaged estimate
    assert res.gap_fraction < 0.005
