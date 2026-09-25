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
            pred = fe.dome_burst if fe else st.burst_pressure
            if pred_loc and t.failure_location in ("cylinder", "dome-a", "dome-b"):
                match = t.failure_location == pred_loc
            if t.failure_location == "cylinder":
                burst_ratios.append(t.pressure / st.burst_pressure)
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
        sug = eta * mean
        if len(r) >= 2:
            sd = float(r.std(ddof=1))
            cov = sd / mean
            bb = eta * max(mean - _k_b(len(r)) * sd, 0.0)
            notes.append(f"{len(r)} cylinder bursts: mean ratio {mean:.3f}, CoV {cov * 100:.1f}%")
        else:
            notes.append("One cylinder burst: the suggested efficiency is a point estimate; B-basis needs >= 2")
        if sug > 1.0:
            notes.append("Suggested efficiency above 1: check the fibre strength data or test records")
    else:
        notes.append("No cylinder burst tests recorded: add tests to calibrate the translation efficiency")
    if any(r.location_match is False for r in rows):
        notes.append("Some bursts failed at a different location than predicted: review dome reinforcement and the "
                     "shell FE critical location")
    return S.CalibrationResult(tests=rows, burst_mean_ratio=mean, burst_cov=cov, current_efficiency=eta,
                               suggested_efficiency=sug, b_basis_efficiency=bb, notes=notes)
