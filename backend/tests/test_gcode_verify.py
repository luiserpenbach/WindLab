import numpy as np
import pytest

from windlab import presets
from windlab.core.design import build
from windlab.core.kinematics import machine_coords, simulate_layer
from windlab.post.gcode import generate
from windlab.post.verify import verify


@pytest.mark.parametrize("preset", ["linuxcnc-4axis", "grbl-3axis", "grbl-2axis"])
def test_physical_mandrel_is_continuous_and_matches_simulation(sized_project, preset):
    m = next(p["machine"] for p in presets.machine_presets() if p["id"] == preset)
    prj = sized_project.model_copy(update={"machine": m})
    ids = [L.id for L in prj.layers][:3]
    prog = generate(prj, ids)
    v = verify(prog.text, keep_positions=True)
    assert not v.errors
    # inverse-time durations add up to the planned winding time
    assert v.total_time == pytest.approx(prog.total_time, rel=1e-3)
    # no feed move jumps: the largest mandrel step stays small despite G92 rotary resets
    a = m.mandrel.letter
    assert v.max_step[a] < 30.0
    # physical mandrel motion within each layer equals the simulated cumulative rotation
    b = build(prj)
    phys = np.array(v.physical[a])
    start = 0
    for lid in ids:
        bl = next(x for x in b.layers if x.spec.id == lid)
        mo = simulate_layer(b, bl)
        mc = machine_coords(m, mo.x, mo.y, mo.a, mo.b)["mandrel"]
        n = len(mc) - 1
        seg = phys[start:start + n]
        assert seg[-1] - seg[0] == pytest.approx(mc[-1] - mc[1], abs=0.01)
        start += n
