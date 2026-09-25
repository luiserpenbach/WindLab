from fastapi.testclient import TestClient

from windlab.api import app


def test_api_roundtrip(tmp_path, monkeypatch, sized_project):
    import windlab.api as api

    monkeypatch.setattr(api, "PROJECT_DIR", tmp_path)
    c = TestClient(app)
    assert c.get("/api/health").json()["status"] == "ok"
    body = sized_project.model_dump()
    r = c.post("/api/analyze", json=body)
    assert r.status_code == 200 and r.json()["structural"]["burst_mode"] == "hoop"
    lid = body["layers"][2]["id"]
    r = c.post("/api/simulate", json={"project": body, "layer_id": lid, "max_points": 500})
    assert r.status_code == 200 and len(r.json()["frames"]["t"]) == 500
    r = c.post("/api/path", json={"project": body, "layer_id": lid, "max_points": 800})
    assert r.status_code == 200 and len(r.json()["points"]) == 800
    assert c.post("/api/traveller", json=body).json()["markdown"].startswith("# Winding traveller")
    assert c.put("/api/projects/my tank", json=body).json() == {"ok": True}
    assert c.get("/api/projects").json()[0]["name"] == "my tank"
    assert c.get("/api/projects/my tank").json()["name"] == body["name"]
    assert c.get("/api/projects/.hidden").status_code == 400


def test_infeasible_design_is_422():
    c = TestClient(app)
    r = c.post("/api/analyze", json={"liner": {"boss_radius_a": 95}})
    assert r.status_code == 422
    r = c.post("/api/analyze", json={"layers": [{"id": "x", "type": "helical", "turnaround_offset": 90}]})
    assert r.status_code == 422
