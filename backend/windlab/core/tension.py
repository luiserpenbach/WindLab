"""Winding tension: prestress loss while the laminate builds up, and schedule design.

Thin-ring model of the cylinder section. Winding layer k at ply-level stress
``sw_k = T_k / (B_k t_band,k)`` presses on the stack below with
``q_k = sw_k t_k sin^2(a_k) / R_k``. The stack below (liner + earlier layers)
contracts by ``d_eps_theta = -q_k R_k / S_k`` with ``S_k = sum_j E_theta,j t_j``;
earlier layer j loses ``E1 sin^2(a_j) * d_eps_theta`` of fibre-direction stress.

Low-angle helicals barely lose tension; inner hoops can go slack, which leaves
wrinkles and voids. The inverse problem (final prestress equal in every
layer) is triangular and solved from the outside in.

Neglected: axial coupling, cure shrinkage/thermal effects, resin squeeze-out
and viscoelastic relaxation; treat results as a relative guide.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .design import Build
from .materials import get_liner


@dataclass
class TensionResult:
    layer_ids: list[str]
    winding_stress: np.ndarray  # ply-level stress at winding [MPa]
    residual_stress: np.ndarray  # after all layers are wound [MPa]
    loss: np.ndarray  # fraction of winding stress lost
    liner_hoop: float  # liner hoop stress from winding [MPa]
    tension: np.ndarray  # applied tensions [N]


def _stack(b: Build):
    lin = b.project.liner
    mat = get_liner(lin.material)
    Q11, Q12, Q22, Q66 = b.ply.Q()
    a = np.array([bl.angle for bl in b.layers])
    t = np.array([bl.t_cyl for bl in b.layers])
    R = np.array([bl.R_mid + 0.5 * bl.t_cyl for bl in b.layers])
    c, s = np.cos(a), np.sin(a)
    E_theta = Q11 * s**4 + 2 * (Q12 + 2 * Q66) * s**2 * c**2 + Q22 * c**4
    area = np.array([bl.spec.band_width * bl.t_band for bl in b.layers])  # ply area of one band [mm2]
    liner_k = mat.E / (1 - mat.nu**2) * lin.wall_thickness
    return a, t, R, E_theta, area, liner_k, mat


def analyse(b: Build, tensions: np.ndarray | None = None) -> TensionResult:
    a, t, R, E_theta, area, liner_k, mat = _stack(b)
    T = np.array([bl.spec.tension for bl in b.layers]) if tensions is None else np.asarray(tensions, float)
    sw = T / area
    n = len(sw)
    res = sw.copy()
    liner = 0.0
    E1 = b.ply.E1
    for k in range(n):
        S_k = liner_k + float(np.sum(E_theta[:k] * t[:k]))
        q = sw[k] * t[k] * math.sin(a[k]) ** 2 / R[k]
        d_eps = -q * R[k] / S_k
        res[:k] += E1 * np.sin(a[:k]) ** 2 * d_eps
        liner += mat.E / (1 - mat.nu**2) * d_eps
    loss = np.where(sw > 0, 1.0 - res / np.maximum(sw, 1e-12), 0.0)
    return TensionResult([bl.spec.id for bl in b.layers], sw, res, loss, liner, T)


def schedule(b: Build, target_tension: float | None = None, max_factor: float = 3.0) -> np.ndarray:
    """Tensions [N] giving the same residual ply stress in every layer.

    ``target_tension`` sets the outermost layer's tension (default: its current
    value); inner layers get more, capped at ``max_factor`` x the target stress.
    """
    a, t, R, E_theta, area, liner_k, mat = _stack(b)
    n = len(a)
    if n == 0:
        return np.zeros(0)
    T_out = b.layers[-1].spec.tension if target_tension is None else target_tension
    target = T_out / area[-1]
    S = np.array([liner_k + float(np.sum(E_theta[:k] * t[:k])) for k in range(n)])
    E1 = b.ply.E1
    sw = np.zeros(n)
    for j in range(n - 1, -1, -1):
        later = sum(sw[k] * t[k] * math.sin(a[k]) ** 2 / S[k] for k in range(j + 1, n))
        sw[j] = min(target + E1 * math.sin(a[j]) ** 2 * later, max_factor * target)
    return sw * area
