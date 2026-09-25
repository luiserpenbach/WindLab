import re

from fastapi.testclient import TestClient

from windlab.api import app
from windlab.core.optimize import optimise
from windlab.fea_export import export
from windlab.report import report_html


def test_report_contains_sections_and_charts(sized_project):
    html = report_html(sized_project)
    for h in ("Design checks", "Layup", "Structural analysis", "Manufacturing", "Assumptions"):
        assert h in html
    assert html.count("<svg") >= 5


def test_abaqus_export_is_consistent(sized_project):
    out = export(sized_project)
    inp = out["inp"]
    n_nodes = len(re.findall(r"^\d+, [-\d.]+, [-\d.]+$", inp.split("*ELEMENT")[0], flags=re.M))
    assert n_nodes == out["elements"] + 1
    assert inp.count("*SHELL SECTION") == out["elements"]
    assert inp.count("*MATERIAL") == out["materials"]
    # every referenced material is defined
    used = set(re.findall(r"^[\d.]+, 3, (\w+), 0$", inp, flags=re.M))
    defined = set(re.findall(r"^\*MATERIAL, NAME=(\w+)$", inp, flags=re.M))
    assert used <= defined
    assert inp.count("*STEP") == 6
    assert out["csv"].count("\n") == out["elements"] + 1


def test_optimiser_never_increases_mass(sized_project):
    r = optimise(sized_project, time_budget=20)
    assert r.mass_after <= r.mass_before + 1e-6
    assert len(r.layers) >= 2


def test_new_endpoints():
    c = TestClient(app)
    body = {"layers": [{"id": "c", "type": "hoop"}, {"id": "h", "type": "helical"}, {"id": "c2", "type": "hoop"}]}
    assert c.post("/api/report", json=body).status_code == 200
    assert c.post("/api/fea-export", json=body).json()["elements"] > 100
    r = c.post("/api/tension-schedule", json={"project": body})
    assert r.status_code == 200 and len(r.json()["recommended_tension"]) == 3
