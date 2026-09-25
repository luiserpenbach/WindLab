import math

import pytest

from windlab import presets
from windlab.core.design import analyze, build, permeation_rate
from windlab.core.materials import get_liner


def _t4():
    return next(e["project"] for e in presets.examples() if e["id"] == "type4-35mpa-h2")


def test_type4_checks_replace_metal_liner_checks():
    p = _t4()
    res = analyze(p)
    ids = {c.id for c in res.checks}
    assert {"liner.strain", "liner.cure", "liner.service_temp", "liner.permeation", "liner.support"} <= ids
    assert not ids & {"af.window", "af.reverse", "fatigue", "liner.lbb", "liner.meop", "fe.liner"}
    st = res.structural
    # no autofrettage: the first load is the proof test
    assert st.autofrettage_pressure == pytest.approx(p.requirements.meop * p.requirements.proof_factor)
    assert st.burst_pressure >= st.required_burst
    fails = [c.id for c in res.checks if c.status == "fail"]
    assert not fails, fails


def test_permeation_scales_with_thickness_and_temperature():
    p = _t4()
    b = build(p)
    hdpe = get_liner("HDPE")
    q = permeation_rate(b, hdpe)
    t0, t1 = p.liner.wall_thickness, 6.0
    thick = p.model_copy(update={"liner": p.liner.model_copy(update={"wall_thickness": t1, "neck_thickness": 15.0})})
    bt = build(thick)
    # Fick: flux ~ area / thickness, normalised by the (slightly smaller) water capacity
    assert permeation_rate(bt, hdpe) == pytest.approx(q * t0 / t1 * _area(bt) / _area(b)
                                                     * b.liner_inner.volume() / bt.liner_inner.volume(), rel=1e-6)
    hot = p.model_copy(update={"requirements": p.requirements.model_copy(update={"permeation_temperature": 85.0})})
    ratio = permeation_rate(build(hot), hdpe) / q
    expected = math.exp(-hdpe.perm_activation * 1e3 / 8.314 * (1 / 358.15 - 1 / 328.15))
    assert ratio == pytest.approx(expected, rel=1e-9)
    assert permeation_rate(b, get_liner("PA6")) < q  # PA6 is the better H2 barrier


def _area(b):
    import numpy as np

    prof = b.liner_inner
    return float(np.sum(2 * math.pi * 0.5 * (prof.r[1:] + prof.r[:-1]) * np.hypot(np.diff(prof.z), np.diff(prof.r))))
