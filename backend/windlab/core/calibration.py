"""Test-data correlation and calibration of the fibre translation efficiency.

Burst pressure is governed by the delivered fibre failure strain, which is
proportional to the translation efficiency; the liner share at burst is
small, so predicted burst scales almost linearly with it. The suggested
efficiency matches the mean measured/predicted ratio of cylinder bursts; the
B-basis value uses a one-sided normal tolerance factor (90% content, 95%
confidence).
"""
from __future__ import annotations

import math

import numpy as np

from .. import schemas as S
from .design import analyze

# one-sided tolerance factors k(n) for 90% content / 95% confidence (normal)
_K_B = {2: 20.581, 3: 6.155, 4: 4.162, 5: 3.407, 6: 3.006, 7: 2.755, 8: 2.582, 9: 2.454, 10: 2.355, 12: 2.210,
        15: 2.068, 20: 1.926, 30: 1.778, 50: 1.646}


def _k_b(n: int) -> float:
    keys = sorted(_K_B)
    if n <= keys[0]:
        return _K_B[keys[0]]
    if n >= keys[-1]:
        return 1.282 + (_K_B[keys[-1]] - 1.282) * math.sqrt(keys[-1] / n)
    lo = max(k for k in keys if k <= n)
    hi = min(k for k in keys if k >= n)
    return _K_B[lo] if lo == hi else _K_B[lo] + (_K_B[hi] - _K_B[lo]) * (n - lo) / (hi - lo)


def _efficiency_for(project: S.Project, burst_target: float) -> float | None:
    """Translation efficiency whose predicted cylinder burst equals ``burst_target`` (secant iteration;
    burst is nearly but not exactly proportional to the efficiency because the liner carries a share)."""
    def pb(eta: float) -> float:
        p = project.model_copy(update={"composite": project.composite.model_copy(
            update={"translation_efficiency": eta})})
        return analyze(p, with_cure=False).structural.burst_pressure

    e0 = project.composite.translation_efficiency
    b0 = pb(e0)
    e1 = min(max(e0 * burst_target / b0, 0.3), 1.0)
    b1 = pb(e1)
    for _ in range(8):
        if abs(b1 - burst_target) < 1e-3 * burst_target or abs(b1 - b0) < 1e-12:
            break
        e2 = min(max(e1 + (burst_target - b1) * (e1 - e0) / (b1 - b0), 0.3), 1.0)
        e0, b0, e1, b1 = e1, b1, e2, pb(e2)
    return e1 if abs(b1 - burst_target) < 0.01 * burst_target else None


def calibrate(project: S.Project) -> S.CalibrationResult:
    res = analyze(project)
    st, fe = res.structural, res.fe
    notes: list[str] = []
    rows: list[S.TestCorrelation] = []
    eta = project.composite.translation_efficiency
    half = project.liner.cyl_length / 2
    pred_loc = None
    if fe is not None:
        pred_loc = "cylinder" if abs(fe.critical_z) < half else ("dome-b" if fe.critical_z > 0 else "dome-a")
    burst_ratios = []
    for t in project.tests:
        pred = None
        match = None
        exp_ratio = None
        if t.kind == "burst" and st:
            # compare with the prediction for the location where it failed
            pred = st.burst_pressure if (t.failure_location == "cylinder" or fe is None) else fe.dome_burst
            if pred_loc and t.failure_location in ("cylinder", "dome-a", "dome-b"):
                match = t.failure_location == pred_loc
            if t.failure_location == "cylinder":
                burst_ratios.append(t.pressure / st.burst_pressure)
        elif t.kind == "cycle" and st and t.cycles:
            pred = min(st.liner_fatigue_cycles, fe.liner_hotspot_cycles if fe else math.inf)
            rows.append(S.TestCorrelation(id=t.id, serial=t.serial, kind=t.kind, measured=float(t.cycles),
                                          predicted=pred, ratio=t.cycles / pred if pred else None))
            continue
        elif t.kind in ("proof", "autofrettage") and st:
            pred = t.pressure
            p_ref = st.autofrettage_pressure if t.kind == "autofrettage" else project.requirements.meop * \
                project.requirements.proof_factor
            total = st.expansion_af_total if t.kind == "autofrettage" else st.expansion_proof_total
            if t.volumetric_expansion_total and total > 0 and abs(t.pressure - p_ref) / p_ref < 0.05:
                exp_ratio = t.volumetric_expansion_total / total
        rows.append(S.TestCorrelation(id=t.id, serial=t.serial, kind=t.kind, measured=t.pressure, predicted=pred,
                                      ratio=(t.pressure / pred) if (pred and t.kind == "burst") else None,
                                      location_match=match, expansion_ratio=exp_ratio))
    mean = cov = sug = bb = None
    if burst_ratios:
        r = np.array(burst_ratios)
        mean = float(r.mean())
        sug = _efficiency_for(project, mean * st.burst_pressure)
        if len(r) >= 2:
            sd = float(r.std(ddof=1))
            cov = sd / mean
            target = mean - _k_b(len(r)) * sd
            if target > 0.3 * mean:
                bb = _efficiency_for(project, target * st.burst_pressure)
            else:
                notes.append("B-basis not meaningful with this scatter / sample size (more tests needed)")
            notes.append(f"{len(r)} cylinder bursts: mean ratio {mean:.3f}, CoV {cov * 100:.1f}%")
        else:
            notes.append("One cylinder burst: the suggested efficiency is a point estimate; B-basis needs >= 2")
        if sug is None:
            notes.append("No translation efficiency in 0.3-1.0 reproduces the measured bursts: check the fibre "
                         "strength data and the test records")
    if any(r.location_match is False for r in rows):
        notes.append("Some bursts failed at a different location than predicted: review dome reinforcement and the "
                     "shell FE critical location")
    return S.CalibrationResult(tests=rows, burst_mean_ratio=mean, burst_cov=cov, current_efficiency=eta,
                               suggested_efficiency=sug, b_basis_efficiency=bb, notes=notes)
