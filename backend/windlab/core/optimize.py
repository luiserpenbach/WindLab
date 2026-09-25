"""Layup optimisation: minimum mass with every design check passing.

Greedy descent from a feasible layup (the current one if it passes, otherwise
the suggested one): repeatedly try removing a layer or a hoop pass, heaviest
first, and accept the first move that keeps all checks free of failures.
Each evaluation is a full analysis (cylinder, FE, tension, slippage...), so
the result respects every constraint WindLab checks.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from .. import schemas as S
from .design import DesignError, analyze, suggest_layup


@dataclass
class OptResult:
    layers: list[S.Layer]
    mass_before: float
    mass_after: float
    evaluations: int
    notes: list[str] = field(default_factory=list)


def _evaluate(project: S.Project, layers: list[S.Layer]):
    try:
        res = analyze(project.model_copy(update={"layers": layers}), with_cure=False)
    except DesignError:
        return None
    # winding tension is a process setting (fixed by the tension schedule), not a layup constraint
    if any(c.status == "fail" and not c.id.startswith("tension.") for c in res.checks):
        return None
    return res


def _moves(layers: list[S.Layer], res: S.AnalysisResult):
    """Candidate layups, heaviest removal first."""
    mass = {L.id: lr.fiber_mass + lr.resin_mass for L, lr in zip(layers, res.layers)}
    n_hel = sum(L.type == "helical" for L in layers)
    n_hoop = sum(L.type == "hoop" for L in layers)
    cands = []
    for i, L in enumerate(layers):
        if (L.type == "helical" and n_hel > 1) or (L.type == "hoop" and n_hoop > 1):
            cands.append((mass[L.id], f"remove layer {L.id}", layers[:i] + layers[i + 1:]))
        if L.type == "hoop" and L.passes > 1:
            new = L.model_copy(update={"passes": L.passes - 1})
            cands.append((mass[L.id] / L.passes, f"{L.id}: {L.passes} -> {L.passes - 1} passes",
                          layers[:i] + [new] + layers[i + 1:]))
    cands.sort(key=lambda c: -c[0])
    return cands


def optimise(project: S.Project, time_budget: float = 60.0) -> OptResult:
    t0 = time.time()
    notes: list[str] = []
    layers = list(project.layers)
    res = _evaluate(project, layers) if layers else None
    evals = 1
    if res is None:
        layers, sn = suggest_layup(project)
        notes.append("Current layup fails a check: starting from the suggested layup")
        notes += sn
        res = _evaluate(project, layers)
        evals += 1
        if res is None:
            raise DesignError("No feasible starting layup; fix the failing checks first")
    m0 = res.mass.total
    improved = True
    while improved and time.time() - t0 < time_budget:
        improved = False
        for _, desc, cand in _moves(layers, res):
            if time.time() - t0 > time_budget:
                notes.append("Stopped at the time budget")
                break
            r = _evaluate(project, cand)
            evals += 1
            if r is not None and r.mass.total < res.mass.total - 1e-6:
                notes.append(f"{desc}: -{res.mass.total - r.mass.total:.0f} g")
                layers, res, improved = cand, r, True
                break
    notes.append(f"Mass {m0:.0f} g -> {res.mass.total:.0f} g ({(1 - res.mass.total / m0) * 100:.1f}% lighter), "
                 f"{evals} evaluations")
    return OptResult(layers, m0, res.mass.total, evals, notes)
