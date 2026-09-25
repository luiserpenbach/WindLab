import math

import pytest

from windlab import presets
from windlab import schemas as S
from windlab.core import sensitivity


def test_fosm_burst_scatter():
    p = next(e["project"] for e in presets.examples() if e["id"] == "grbl-10mpa-1l")
    r = sensitivity.analyse(p)
    assert r.sd > 0 and r.lower_90 < r.nominal
    assert r.sd == pytest.approx(math.sqrt(sum(i.effect**2 for i in r.items)))
    assert sum(i.share for i in r.items) == pytest.approx(1.0)
    # a fibre-dominated burst: delivered fibre strength is the largest contributor and raises the burst
    assert r.items[0].name == "Fibre strength" and r.items[0].effect > 0
    # no scatter, no spread
    zero = S.SensitivitySpec(**{k: 0.0 for k in S.SensitivitySpec.model_fields})
    assert sensitivity.analyse(p, zero).sd == pytest.approx(0.0, abs=1e-9)
