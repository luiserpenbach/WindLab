import numpy as np

from windlab import presets
from windlab.core.design import build
from windlab.core.kinematics import simulate_layer


def test_two_axis_eye_stays_on_its_radius_and_reports_slack():
    p = next(e["project"] for e in presets.examples() if e["id"] == "grbl-10mpa-1l")
    p = p.model_copy(update={"machine": presets._machine("grbl-2axis")})
    b = build(p)
    hel = next(bl for bl in b.layers if bl.spec.type == "helical")
    mo = simulate_layer(b, hel)
    assert np.ptp(mo.y) < 1e-9  # the eye cannot leave its fixed radius
    assert any("slack" in w for w in mo.warnings)
