"""Axisymmetric laminated shell finite elements for the whole vessel.

Kirchhoff shell of revolution on the liner outer surface (reference surface),
two-node conical frustum elements: linear meridional displacement, cubic
Hermite normal displacement. DOFs per node: axial ``Uz``, radial ``Ur`` and
meridional rotation ``beta = dw/ds``.

    eps_s = du/ds                     kap_s = -d2w/ds2
    eps_t = (u sin + w cos) / r       kap_t = -(sin / r) dw/ds

with ``sin = dr/ds``, ``cos = dz/ds`` of the element and ``u``/``w`` the
meridional / outward-normal displacements.

Every element gets its own laminate: liner (inside the reference surface)
plus each wound layer with the local thickness and fibre angle from the
build-up, giving A, B, D stiffness about the reference surface (balanced
angle-ply pairs: no shear coupling).

Loads: internal pressure on the liner inner surface; the polar bosses are
treated as rigid rings (radial displacement and rotation fixed) carrying the
pressure acting on the opening area. End A is fixed axially.

The model is linear elastic. The operating pressure cycle of an autofrettaged
Type III vessel is elastic, so MEOP results (stress ranges, strain ratios)
are directly meaningful. Burst is estimated by scaling the cylinder's
nonlinear burst prediction with the FE strain distribution.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import spsolve

from .design import Build
from .materials import get_liner

_G = np.array([0.1127016653792583, 0.5, 0.8872983346207417])
_GW = np.array([5 / 18, 8 / 18, 5 / 18])


def _qbar(Q11, Q12, Q22, Q66, a):
    c, s = np.cos(a), np.sin(a)
    q11 = Q11 * c**4 + 2 * (Q12 + 2 * Q66) * s**2 * c**2 + Q22 * s**4
    q12 = (Q11 + Q22 - 4 * Q66) * s**2 * c**2 + Q12 * (s**4 + c**4)
    q22 = Q11 * s**4 + 2 * (Q12 + 2 * Q66) * s**2 * c**2 + Q22 * c**4
    return q11, q12, q22


@dataclass
class Section:
    """Laminate per element: ply boundaries and stiffness about the reference surface."""

    ABD: np.ndarray  # (n_el, 4, 4) in (eps_s, eps_t, kap_s, kap_t)
    z_bot: np.ndarray  # (n_el, n_layers + 1) boundaries; column 0 = liner inner
    angles: np.ndarray  # (n_el, n_layers) rad (layers only)
    t_liner: float


@dataclass
class FESolution:
    z: np.ndarray  # element mid axial position [mm]
    r: np.ndarray  # element mid radius [mm]
    s: np.ndarray  # element mid arclength [mm]
    eps: np.ndarray  # (n_el, 2) membrane strains at mid
    kap: np.ndarray  # (n_el, 2) curvatures at mid
    Ur: np.ndarray  # nodal radial displacement [mm]
    Uz: np.ndarray
    node_z: np.ndarray
    node_r: np.ndarray
    section: Section
    pressure: float

    def layer_fiber_strain(self, k: int) -> np.ndarray:
        """Fibre-direction strain at the mid-depth of layer k (0-based) per element."""
        zb = self.section.z_bot
        zm = 0.5 * (zb[:, k + 1] + zb[:, k + 2])
        e = self.eps + zm[:, None] * self.kap
        a = self.section.angles[:, k]
        return e[:, 0] * np.cos(a) ** 2 + e[:, 1] * np.sin(a) ** 2

    def liner_stress(self, E: float, nu: float, where: str) -> np.ndarray:
        zb = self.section.z_bot
        zz = zb[:, 0] if where == "inner" else zb[:, 1]
        e = self.eps + zz[:, None] * self.kap
        f = E / (1 - nu**2)
        return np.stack([f * (e[:, 0] + nu * e[:, 1]), f * (e[:, 1] + nu * e[:, 0])], axis=1)


def _mesh(b: Build, max_len: float = 4.0) -> np.ndarray:
    """Node indices into the liner profile, dropping near-duplicates and splitting long spans."""
    prof = b.liner_outer
    s = prof.s
    keep = [0]
    for i in range(1, len(s)):
        if s[i] - s[keep[-1]] > 0.4 or i == len(s) - 1:
            keep.append(i)
    idx = np.array(keep, dtype=float)
    out = [idx[0]]
    for a, c in zip(idx[:-1], idx[1:]):
        n = max(int(math.ceil((s[int(c)] - s[int(a)]) / max_len)), 1)
        out.extend(np.linspace(a, c, n + 1)[1:])
    return np.array(out)


def _interp_idx(arr: np.ndarray, fidx: np.ndarray) -> np.ndarray:
    return np.interp(fidx, np.arange(len(arr)), arr)


def sections(b: Build, fidx_mid: np.ndarray) -> Section:
    mat = get_liner(b.project.liner.material, b.project.materials)
    t_l = b.project.liner.wall_thickness
    n_el = len(fidx_mid)
    n_lay = len(b.layers)
    zb = np.zeros((n_el, n_lay + 2))
    wall = np.hypot(b.liner_outer.z - b.liner_inner.z, b.liner_outer.r - b.liner_inner.r)
    zb[:, 0] = -_interp_idx(wall, fidx_mid)
    angles = np.zeros((n_el, n_lay))
    for k, bl in enumerate(b.layers):
        t = np.maximum(_interp_idx(bl.thickness, fidx_mid), 0.0)
        zb[:, k + 2] = zb[:, k + 1] + t
        if bl.spec.type == "helical":
            zbase = _interp_idx(bl.base.z, fidx_mid)
            angles[:, k] = bl.gp.alpha_at_z(zbase)
        else:
            angles[:, k] = bl.angle
    ABD = np.zeros((n_el, 4, 4))

    def add(q11, q12, q22, z0, z1):
        for (i, j), q in (((0, 0), q11), ((0, 1), q12), ((1, 0), q12), ((1, 1), q22)):
            ABD[:, i, j] += q * (z1 - z0)
            ABD[:, i, j + 2] += q * 0.5 * (z1**2 - z0**2)
            ABD[:, i + 2, j] += q * 0.5 * (z1**2 - z0**2)
            ABD[:, i + 2, j + 2] += q * (z1**3 - z0**3) / 3.0

    f = mat.E / (1 - mat.nu**2)
    add(f, f * mat.nu, f, zb[:, 0], zb[:, 1])
    for k in range(n_lay):
        Q11, Q12, Q22, Q66 = b.layers[k].ply.Q()
        q11, q12, q22 = _qbar(Q11, Q12, Q22, Q66, angles[:, k])
        add(q11, q12, q22, zb[:, k + 1], zb[:, k + 2])
    return Section(ABD, zb, angles, t_l)


def solve(b: Build, pressure: float) -> FESolution:
    prof = b.liner_outer
    fidx = _mesh(b)
    zn = _interp_idx(prof.z, fidx)
    rn = _interp_idx(prof.r, fidx)
    n = len(zn)
    n_el = n - 1
    fmid = 0.5 * (fidx[1:] + fidx[:-1])
    sec = sections(b, fmid)
    dz, dr = np.diff(zn), np.diff(rn)
    L = np.hypot(dz, dr)
    c, s = dz / L, dr / L
    zi = _interp_idx(b.liner_inner.z, fidx)
    ri = _interp_idx(b.liner_inner.r, fidx)
    L_in = np.hypot(np.diff(zi), np.diff(ri))

    rows, cols, vals = [], [], []
    F = np.zeros(3 * n)
    for e in range(n_el):
        Le, ce, se = L[e], c[e], s[e]
        # local (u1, w1, b1, u2, w2, b2) <- global (Uz1, Ur1, b1, Uz2, Ur2, b2)
        T = np.zeros((6, 6))
        for o in (0, 3):
            T[o, o], T[o, o + 1] = ce, se
            T[o + 1, o], T[o + 1, o + 1] = -se, ce
            T[o + 2, o + 2] = 1.0
        Ke = np.zeros((6, 6))
        fe = np.zeros(6)
        C = sec.ABD[e]
        for xi, wg in zip(_G, _GW):
            r = rn[e] + (rn[e + 1] - rn[e]) * xi
            H = np.array([1 - 3 * xi**2 + 2 * xi**3, Le * (xi - 2 * xi**2 + xi**3), 3 * xi**2 - 2 * xi**3,
                          Le * (-(xi**2) + xi**3)])
            dH = np.array([-6 * xi + 6 * xi**2, Le * (1 - 4 * xi + 3 * xi**2), 6 * xi - 6 * xi**2,
                           Le * (-2 * xi + 3 * xi**2)]) / Le
            d2H = np.array([-6 + 12 * xi, Le * (-4 + 6 * xi), 6 - 12 * xi, Le * (-2 + 6 * xi)]) / Le**2
            Nu = np.array([1 - xi, xi])
            Bm = np.zeros((4, 6))
            Bm[0, 0], Bm[0, 3] = -1 / Le, 1 / Le
            Bm[1, [0, 3]] = Nu * se / r
            Bm[1, [1, 2, 4, 5]] = H * ce / r
            Bm[2, [1, 2, 4, 5]] = -d2H
            Bm[3, [1, 2, 4, 5]] = -se / r * dH
            dA = 2 * math.pi * r * Le * wg
            Ke += Bm.T @ C @ Bm * dA
            # pressure on the liner inner surface (its own arc length), along the outward normal
            r_in = ri[e] + (ri[e + 1] - ri[e]) * xi
            fe[[1, 2, 4, 5]] += H * pressure * 2 * math.pi * r_in * L_in[e] * wg
        Kg = T.T @ Ke @ T
        fg = T.T @ fe
        dof = np.array([3 * e, 3 * e + 1, 3 * e + 2, 3 * e + 3, 3 * e + 4, 3 * e + 5])
        rows.append(np.repeat(dof, 6))
        cols.append(np.tile(dof, 6))
        vals.append(Kg.ravel())
        F[dof] += fg
    K = coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(3 * n, 3 * n)).tocsr()
    # bosses: rigid rings carrying the pressure on the opening (inner radius) area
    F[3 * (n - 1)] += pressure * math.pi * ri[-1] ** 2
    fixed = [0, 1, 2, 3 * (n - 1) + 1, 3 * (n - 1) + 2]
    free = np.setdiff1d(np.arange(3 * n), fixed)
    U = np.zeros(3 * n)
    U[free] = spsolve(K[free][:, free].tocsc(), F[free])
    # strains at element mid-points
    eps = np.zeros((n_el, 2))
    kap = np.zeros((n_el, 2))
    Uz, Ur, Bt = U[0::3], U[1::3], U[2::3]
    for e in range(n_el):
        Le, ce, se = L[e], c[e], s[e]
        u1 = ce * Uz[e] + se * Ur[e]
        u2 = ce * Uz[e + 1] + se * Ur[e + 1]
        w1 = -se * Uz[e] + ce * Ur[e]
        w2 = -se * Uz[e + 1] + ce * Ur[e + 1]
        r = 0.5 * (rn[e] + rn[e + 1])
        wv = np.array([w1, Bt[e], w2, Bt[e + 1]])
        H = np.array([0.5, Le * 0.125, 0.5, -Le * 0.125])
        dH = np.array([-1.5, -0.25 * Le, 1.5, -0.25 * Le]) / Le
        d2H = np.array([0.0, -Le, 0.0, Le]) / Le**2
        eps[e, 0] = (u2 - u1) / Le
        eps[e, 1] = (0.5 * (u1 + u2) * se + (H @ wv) * ce) / r
        kap[e, 0] = -(d2H @ wv)
        kap[e, 1] = -se / r * (dH @ wv)
    s_nodes = np.concatenate([[0.0], np.cumsum(L)])
    return FESolution(
        z=0.5 * (zn[1:] + zn[:-1]), r=0.5 * (rn[1:] + rn[:-1]), s=0.5 * (s_nodes[1:] + s_nodes[:-1]),
        eps=eps, kap=kap, Ur=Ur, Uz=Uz, node_z=zn, node_r=rn, section=sec, pressure=pressure,
    )


@dataclass
class FEEvaluation:
    sol: FESolution
    fiber_ratio: np.ndarray  # (n_layers, n_el) fibre strain / allowable at MEOP (nan where absent)
    liner_vm_inner: np.ndarray
    liner_vm_outer: np.ndarray
    dome_burst: float
    critical_z: float
    critical_layer: int
    hotspot_factor: float
    hotspot_z: float
    hotspot_cycles: float


def evaluate(b: Build, meop: float, burst_cyl: float, cycles_cyl: float) -> FEEvaluation:
    """Linear FE at MEOP, scaled against the nonlinear cylinder model.

    * dome burst ~ cylinder burst x (peak cylinder fibre ratio / peak fibre ratio anywhere)
    * liner hot spot: peak liner von Mises range / cylinder value; with SWT and
      a local residual stress scaling like the elastic range, life scales as k^(1/b).
    """
    sol = solve(b, meop)
    mat = get_liner(b.project.liner.material, b.project.materials)
    n_lay = len(b.layers)
    ratio = np.full((n_lay, len(sol.z)), np.nan)
    thick = np.diff(sol.section.z_bot, axis=1)[:, 1:]  # layers only
    for k in range(n_lay):
        e1 = sol.layer_fiber_strain(k) / b.layers[k].ply.eps1_ult
        ratio[k] = np.where(thick[:, k] > 1e-3, e1, np.nan)
    half = b.project.liner.cyl_length / 2
    lin = b.project.liner
    cyl = np.abs(sol.z) < max(half - 20.0, 0.25 * half)
    # the bosses are rigid rings: keep the evaluation clear of the clamped edge
    rb = np.where(sol.z < 0, lin.boss_radius_a, lin.boss_radius_b)
    valid = sol.r > rb + 3.0 * lin.wall_thickness
    with np.errstate(all="ignore"):
        peak = np.nanmax(np.where(np.isnan(ratio), -np.inf, ratio), axis=0) if n_lay else np.zeros(len(sol.z))
    peak[~np.isfinite(peak)] = np.nan
    peak = np.where(valid, np.nan_to_num(peak, nan=0.0), 0.0)
    ref = float(np.max(peak[cyl])) if np.any(cyl) else float(np.max(peak))
    i_crit = int(np.argmax(peak))
    dome_burst = burst_cyl * ref / max(float(peak[i_crit]), 1e-12)
    k_crit = int(np.nanargmax(ratio[:, i_crit])) if n_lay else -1

    def vm(sg):
        return np.sqrt(sg[:, 0] ** 2 - sg[:, 0] * sg[:, 1] + sg[:, 1] ** 2)

    vi = vm(sol.liner_stress(mat.E, mat.nu, "inner"))
    vo = vm(sol.liner_stress(mat.E, mat.nu, "outer"))
    vmax = np.where(valid, np.maximum(vi, vo), 0.0)
    vref = float(np.median(vmax[cyl])) if np.any(cyl) else float(np.median(vmax))
    j = int(np.argmax(vmax))
    kf = float(vmax[j] / max(vref, 1e-12))
    cycles = float(min(cycles_cyl * kf ** (1.0 / mat.fatigue_exp), 1e9)) if kf > 0 else 1e9
    return FEEvaluation(sol, ratio, vi, vo, float(dome_burst), float(sol.z[i_crit]), k_crit, kf, float(sol.z[j]),
                        cycles)
