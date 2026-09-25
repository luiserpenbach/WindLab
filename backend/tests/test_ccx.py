import shutil

import pytest

from windlab import presets
from windlab.ccx_export import export, run_and_compare


def _desktop():
    return next(e["project"] for e in presets.examples() if e["id"] == "grbl-10mpa-1l")


def test_ccx_deck_structure():
    meta = export(_desktop(), max_len=8.0)
    inp = meta["inp"]
    assert inp.count("*STEP") == 7 and "*EXPANSION" in inp and "*PLASTIC" in inp
    assert meta["elements"] > 100 and len(meta["midplane_nodes"]) >= 3


@pytest.mark.skipif(shutil.which("ccx") is None, reason="CalculiX (ccx) not installed")
def test_ccx_agrees_with_cylinder_model(tmp_path):
    """Independent solid FE (CalculiX) vs WindLab's cylinder model: composite hoop strain at the mid-plane."""
    rows = run_and_compare(_desktop(), str(tmp_path), max_len=8.0)
    assert {r["step"] for r in rows} >= {"CURE", "AUTOFRETTAGE", "PROOF", "MEOP"}
    for r in rows:
        if r["step"] in ("AUTOFRETTAGE", "PROOF", "MEOP"):
            assert r["windlab"] == pytest.approx(r["ccx_outer"], rel=0.06), r
