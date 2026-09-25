"""FastAPI application: JSON API under /api and the built web UI at /."""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, presets
from . import schemas as S
from .core import materials
from .core.design import DesignError, analyze, build, suggest_layup
from .core.geometry import GeometryError
from .core.kinematics import downsample, layer_path, simulate_layer
from .manufacturing import traveller
from .post.gcode import generate


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # example layups are sized on first use; warm them in the background
    threading.Thread(target=presets.examples, daemon=True).start()
    yield


app = FastAPI(title="WindLab", version=__version__, lifespan=_lifespan)
app.add_middleware(GZipMiddleware, minimum_size=4096)  # G-code and thickness maps are large JSON payloads
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                   allow_methods=["*"], allow_headers=["*"])

PROJECT_DIR = Path(os.environ.get("WINDLAB_PROJECTS", Path.home() / ".windlab" / "projects"))
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,99}$")


def _design_errors(fn):
    try:
        return fn()
    except (DesignError, GeometryError, KeyError, ValueError) as e:
        msg = e.args[0] if e.args else str(e)
        raise HTTPException(status_code=422, detail=str(msg)) from e


def _layer(b, layer_id: str):
    for bl in b.layers:
        if bl.spec.id == layer_id:
            return bl
    raise HTTPException(status_code=404, detail=f"Layer '{layer_id}' not found")


@app.get("/api/health")
def health():
    return {"status": "ok", "version": __version__}


@app.get("/api/materials")
def get_materials():
    return materials.catalog()


@app.get("/api/machines")
def get_machines():
    return presets.machine_presets()


@app.get("/api/examples")
def get_examples():
    return presets.examples()


@app.post("/api/analyze", response_model=S.AnalysisResult)
def post_analyze(project: S.Project):
    return _design_errors(lambda: analyze(project))


@app.post("/api/suggest-layup")
def post_suggest(project: S.Project, progressive: bool = False):
    """``?progressive=true`` also verifies (and if needed thickens) the layup with the progressive-failure
    analysis; this takes up to a few minutes."""
    layers, notes = _design_errors(lambda: suggest_layup(project, progressive=progressive))
    return {"layers": layers, "notes": notes}


@app.post("/api/path", response_model=S.PathResult)
def post_path(req: S.LayerRequest):
    def run():
        b = build(req.project)
        bl = _layer(b, req.layer_id)
        path = layer_path(b, bl)
        pts = path.xyz()
        idx = downsample(len(pts), req.max_points)
        breaks = sorted({int(np.searchsorted(idx, c)) for c in path.circuit_starts})
        alpha = np.degrees(path.alpha[idx]) if path.alpha is not None else np.zeros(len(idx))
        lam = path.lam[idx] if path.lam is not None else np.zeros(len(idx))
        return S.PathResult(layer_id=req.layer_id, points=np.round(pts[idx], 3).tolist(), circuit_breaks=breaks,
                            alpha=np.round(alpha, 3).tolist(), slippage=np.round(lam, 4).tolist(),
                            dwell=(path.dwell[idx].tolist() if path.dwell is not None else [False] * len(idx)))

    return _design_errors(run)


@app.post("/api/simulate", response_model=S.SimulationResult)
def post_simulate(req: S.LayerRequest):
    def run():
        b = build(req.project)
        bl = _layer(b, req.layer_id)
        mo = simulate_layer(b, bl)
        idx = downsample(len(mo.t), req.max_points)
        r = lambda a: np.round(a[idx], 4).tolist()  # noqa: E731
        frames = S.MachineFrame(
            t=r(mo.t), carriage=r(mo.x), crossfeed=r(mo.y), mandrel=r(mo.a), eye=r(mo.b),
            contact=np.round(mo.contact[idx], 3).tolist(), free_length=r(mo.free),
        )
        return S.SimulationResult(layer_id=req.layer_id, frames=frames, total_time=mo.total_time,
                                  warnings=mo.warnings, limits_ok=not any("limit" in w for w in mo.warnings))

    return _design_errors(run)


@app.post("/api/thickness-map", response_model=S.ThicknessMapResult)
def post_thickness_map(req: S.ThicknessMapRequest):
    from .core.thickness_map import map_result

    return _design_errors(lambda: map_result(build(req.project), req.layer_id, req.cumulative,
                                             req.resolution, req.n_phi))


@app.post("/api/tension-schedule", response_model=S.TensionScheduleResult)
def post_tension_schedule(req: S.TensionScheduleRequest):
    from .core import tension

    def run():
        b = build(req.project)
        cur = tension.analyse(b)
        rec_t = tension.schedule(b, req.target_tension, req.max_factor)
        rec = tension.analyse(b, rec_t)
        r = lambda a: np.round(np.asarray(a, dtype=float), 3).tolist()  # noqa: E731
        return S.TensionScheduleResult(
            layer_ids=cur.layer_ids, current_tension=r(cur.tension), recommended_tension=r(rec_t),
            residual_current=r(cur.residual_stress), residual_recommended=r(rec.residual_stress),
            liner_hoop_current=cur.liner_hoop, liner_hoop_recommended=rec.liner_hoop,
        )

    return _design_errors(run)


@app.post("/api/gcode")
def post_gcode(req: S.GcodeRequest):
    def run():
        from .post.verify import verify

        prog = generate(req.project, req.layer_ids)
        text = prog.text
        ver = verify(text)
        m = req.project.machine
        mandrel = m.mandrel.letter
        verification = {
            "moves": ver.moves, "rapids": ver.rapids, "pauses": ver.pauses,
            "interpreted_time": ver.total_time,
            "time_matches": abs(ver.total_time - prog.total_time) <= 1e-3 * max(prog.total_time, 1.0),
            "ranges": {k: list(v) for k, v in ver.ranges.items()},
            "max_step": ver.max_step,
            "max_mandrel_step": ver.max_step.get(mandrel, 0.0),
            "errors": ver.errors[:20],
        }
        return {"filename": prog.filename, "gcode": text, "lines": len(prog.lines),
                "total_time": prog.total_time, "warnings": prog.warnings, "verification": verification}

    return _design_errors(run)


@app.post("/api/optimise", response_model=S.OptimiseResult)
def post_optimise(req: S.OptimiseRequest):
    from .core.optimize import optimise

    def run():
        r = optimise(req.project, req.time_budget)
        return S.OptimiseResult(layers=r.layers, mass_before=r.mass_before, mass_after=r.mass_after,
                                evaluations=r.evaluations, notes=r.notes)

    return _design_errors(run)


@app.post("/api/fea-export")
def post_fea_export(project: S.Project):
    from .fea_export import export

    return _design_errors(lambda: export(project))


@app.post("/api/calibrate", response_model=S.CalibrationResult)
def post_calibrate(project: S.Project):
    from .core.calibration import calibrate

    return _design_errors(lambda: calibrate(project))


@app.post("/api/ccx-export")
def post_ccx_export(project: S.Project):
    from .ccx_export import export

    def run():
        r = export(project)
        return {k: r[k] for k in ("filename", "inp", "elements", "nodes", "materials", "steps")}

    return _design_errors(run)


@app.post("/api/sensitivity", response_model=S.SensitivityResult)
def post_sensitivity(req: S.SensitivityRequest):
    """Burst scatter from material / process scatter (FOSM on the cylinder model, ~5-15 s)."""
    from .core.sensitivity import analyse

    return _design_errors(lambda: analyse(req.project, req.spec))


@app.post("/api/suggest-cure", response_model=S.CureSuggestion)
def post_suggest_cure(project: S.Project):
    """Shortest cure cycle meeting the exotherm, degree-of-cure, Tg and liner-temperature limits (seconds to ~1 min)."""
    from .core.cure import suggest_cycle

    def run():
        steps, res, notes = suggest_cycle(build(project))
        return S.CureSuggestion(cure_cycle=steps, cure_temperature=max(c.temperature for c in steps), result=res,
                                notes=notes)

    return _design_errors(run)


@app.post("/api/continuous", response_model=S.ContinuousResult)
def post_continuous(project: S.Project):
    """Continuous-winding plan: transition passes between all layers (uses ``project.continuous`` settings,
    whether or not continuous winding is enabled for G-code)."""
    from .core.continuous import plan, to_schema

    def run():
        b = build(project)
        return to_schema(b, plan(b))

    return _design_errors(run)


@app.post("/api/progressive", response_model=S.ProgressiveResultOut)
def post_progressive(req: S.ProgressiveRequest):
    """Progressive failure analysis (nonlinear shell with liner plasticity, Puck IFF, fibre failure).
    Takes ~10 s to a few minutes depending on the layup."""
    from .core.progressive import run, to_schema

    def go():
        b = build(req.project)
        return to_schema(b, run(b, max_len=req.mesh))

    return _design_errors(go)


@app.post("/api/report")
def post_report(project: S.Project, progressive: bool = False):
    """``?progressive=true`` adds the progressive-failure analysis (10 s to minutes)."""
    from .report import report_html

    return _design_errors(lambda: {"html": report_html(project, progressive)})


@app.post("/api/traveller")
def post_traveller(project: S.Project):
    return _design_errors(lambda: traveller(project))


# --------------------------------------------------------------------------- project storage
_RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(10)} | {f"LPT{i}" for i in range(10)}


def _path(name: str) -> Path:
    if not _NAME.fullmatch(name) or ".." in name or name.split(".")[0].strip().upper() in _RESERVED:
        raise HTTPException(status_code=400, detail="Invalid project name")
    return PROJECT_DIR / f"{name}.json"


@app.get("/api/projects")
def list_projects():
    if not PROJECT_DIR.exists():
        return []
    out = []
    for p in sorted(PROJECT_DIR.glob("*.json")):
        out.append({"name": p.stem, "modified": _dt.datetime.fromtimestamp(p.stat().st_mtime).isoformat()})
    return out


@app.get("/api/projects/{name}", response_model=S.Project)
def get_project(name: str):
    p = _path(name)
    if not p.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    return S.Project.model_validate(json.loads(p.read_text()))


@app.put("/api/projects/{name}")
def put_project(name: str, project: S.Project):
    p = _path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(project.model_dump_json(indent=2))
    return {"ok": True}


@app.delete("/api/projects/{name}")
def delete_project(name: str):
    p = _path(name)
    if p.exists():
        p.unlink()
    return {"ok": True}


# --------------------------------------------------------------------------- static web UI
_DIST = Path(os.environ.get("WINDLAB_WEB", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
if _DIST.exists():
    if (_DIST / "assets").exists():
        app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        f = (_DIST / full_path).resolve()
        if full_path and f.is_file() and _DIST.resolve() in f.parents:
            return FileResponse(f)
        return FileResponse(_DIST / "index.html")
