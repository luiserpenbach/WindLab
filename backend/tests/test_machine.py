import re

import numpy as np
import pytest

from windlab import presets
from windlab.core.design import build
from windlab.core.kinematics import eye_envelope, simulate_layer
from windlab.post.gcode import generate


def _first(b, kind):
    return next(i for i, bl in enumerate(b.layers) if bl.spec.type == kind)


@pytest.mark.parametrize("kind", ["hoop", "helical"])
def test_eye_lies_on_free_fibre_ray(sized_project, kind):
    b = build(sized_project)
    which = _first(b, kind)
    mo = simulate_layer(b, b.layers[which])
    P = mo.contact
    T = np.gradient(P, axis=0)
    T /= np.linalg.norm(T, axis=1)[:, None]
    th = np.radians(mo.a)
    c, s = np.cos(th), np.sin(th)
    # rotate contact + tangent into the world frame; the eye must be on that ray in the plane z = 0
    Py, Pz = P[:, 1] * c - P[:, 2] * s, P[:, 1] * s + P[:, 2] * c
    Ty, Tz = T[:, 1] * c - T[:, 2] * s, T[:, 1] * s + T[:, 2] * c
    lam = mo.free
    assert np.allclose(Pz + lam * Tz, 0.0, atol=1e-3)
    assert np.allclose(Py + lam * Ty, mo.y, atol=1e-3)
    assert np.allclose(P[:, 0] + lam * T[:, 0], mo.x, atol=1e-3)
    xs, env = eye_envelope(b, b.layers[which])
    assert np.all(mo.y >= np.interp(mo.x, xs, env) - 1e-3)
    assert np.all(np.diff(mo.t) > 0)


def test_hoop_eye_roll_is_small_and_helical_turns(sized_project):
    b = build(sized_project)
    hoop = simulate_layer(b, b.layers[_first(b, "hoop")])
    hel = simulate_layer(b, b.layers[_first(b, "helical")])
    assert np.abs(hoop.b).max() < 2.0
    assert np.abs(hel.b).max() > 45.0


@pytest.mark.parametrize("preset", ["linuxcnc-4axis", "linuxcnc-3axis", "grbl-3axis", "grblhal-4axis"])
def test_gcode_is_well_formed(sized_project, preset):
    m = next(p["machine"] for p in presets.machine_presets() if p["id"] == preset)
    prj = sized_project.model_copy(update={"machine": m})
    hel = next(L.id for L in prj.layers if L.type == "helical")
    prog = generate(prj, [prj.layers[0].id, hel])
    mode = "G94"
    letters = {m.carriage.letter, m.crossfeed.letter, m.mandrel.letter} | ({m.eye.letter} if m.axes_count == 4 else set())
    n_moves = 0
    for ln in prog.lines:
        code = re.sub(r"\(.*?\)", "", ln).strip()
        if not code:
            continue
        for g in ("G93", "G94"):
            if code.replace(" ", "") == g:
                mode = g
        if code.startswith("G1"):
            n_moves += 1
            assert mode == "G93"
            assert re.search(r"F[0-9.]+$", code)
            used = set(re.findall(r"([A-Z])-?[0-9.]+", code)) - {"G", "F"}
            assert used == letters
        if m.controller == "grbl":
            assert len(code) <= 70
    assert n_moves > 1000
    assert prog.lines[-1] in ("M2", "%")
    if preset == "grblhal-4axis":
        assert any("grblHAL" in w for w in prog.warnings)


def test_rotary_reset_bounds_mandrel_values(sized_project):
    m = next(p["machine"] for p in presets.machine_presets() if p["id"] == "grbl-3axis")
    prj = sized_project.model_copy(update={"machine": m})
    prog = generate(prj, [next(L.id for L in prj.layers if L.type == "helical")])
    ys = [float(v) for v in re.findall(r"^G1.*?Y(-?[0-9.]+)", prog.text, flags=re.M)]
    assert max(ys) < 3 * 360
