"""Type III COPV cylinder analysis: elastic-plastic liner + linear-elastic overwrap.

Model (per unit length of the cylinder section, membrane state):

* Equilibrium is exact for a closed-end cylinder under internal pressure p
  acting on the liner inner radius R_i:
      sum_k t_k sigma_theta,k           = p R_i
      sum_k t_k (R_k / R_i) sigma_x,k   = p R_i / 2
* All layers share the axial strain and (thin-wall assumption) the hoop
  strain. Balanced helical pairs carry no in-plane shear.
* Liner: J2 plasticity in plane stress, linear isotropic hardening,
  return mapping after Simo & Taylor.
* Composite: CLT reduced stiffness per ply group; failure when the
  fibre-direction strain reaches the delivered fibre failure strain.

Not modelled (documented limitations): cure/thermal and winding-tension
residual stresses, Bauschinger effect (a 0.9 knock-down is used on the
reverse-yield check instead), dome bending, and through-thickness strain
gradients.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import brentq

from .materials import LinerMaterial, Ply

_P = np.array([[2.0, -1.0], [-1.0, 2.0]]) / 3.0


def von_mises(s: np.ndarray) -> float:
    return float(np.sqrt(max(s[0] ** 2 - s[0] * s[1] + s[1] ** 2, 0.0)))


@dataclass
class LinerState:
    eps_p: np.ndarray = field(default_factory=lambda: np.zeros(2))
    alpha: float = 0.0


class Liner:
    def __init__(self, mat: LinerMaterial, thickness: float, radius: float) -> None:
        self.mat = mat
        self.t = thickness
        self.R = radius
        E, nu = mat.E, mat.nu
        self.C = E / (1 - nu**2) * np.array([[1.0, nu], [nu, 1.0]])
        self.Cinv = np.array([[1.0, -nu], [-nu, 1.0]]) / E
        self.H = mat.hardening

    def yield_stress(self, st: LinerState) -> float:
        return self.mat.yield_ + self.H * st.alpha

    def stress(self, eps: np.ndarray, st: LinerState) -> tuple[np.ndarray, LinerState]:
        sig_tr = self.C @ (eps - st.eps_p)
        k0 = self.yield_stress(st)
        if von_mises(sig_tr) <= k0:
            return sig_tr, st
        e_el = eps - st.eps_p

        def sig_of(dg: float) -> np.ndarray:
            return np.linalg.solve(self.Cinv + dg * _P, e_el)

        def resid(dg: float) -> float:
            s = sig_of(dg)
            vm = von_mises(s)
            return vm - (k0 + self.H * dg * 2.0 / 3.0 * vm)

        r0 = resid(0.0)
        if not r0 > 1e-9 * k0:  # on the yield surface within round-off: elastic
            return sig_tr, st
        hi = 1e-6
        for _ in range(80):
            rh = resid(hi)
            if not (rh > 0) or not np.isfinite(rh):
                break
            hi *= 4.0
        while not np.isfinite(resid(hi)):
            hi *= 0.5
        dg = brentq(resid, 0.0, hi, xtol=1e-14, rtol=1e-12)
        s = sig_of(dg)
        new = LinerState(st.eps_p + dg * (_P @ s), st.alpha + dg * 2.0 / 3.0 * von_mises(s))
        return s, new


@dataclass
class PlyGroup:
    name: str  # "hoop" | "helical"
    angle: float  # rad from the axis
    t: float
    R: float  # mid radius
    ply: Ply

    def qbar(self) -> np.ndarray:
        Q11, Q12, Q22, Q66 = self.ply.Q()
        c, s = np.cos(self.angle), np.sin(self.angle)
        q11 = Q11 * c**4 + 2 * (Q12 + 2 * Q66) * s**2 * c**2 + Q22 * s**4
        q12 = (Q11 + Q22 - 4 * Q66) * s**2 * c**2 + Q12 * (s**4 + c**4)
        q22 = Q11 * s**4 + 2 * (Q12 + 2 * Q66) * s**2 * c**2 + Q22 * c**4
        return np.array([[q11, q12], [q12, q22]])

    def alpha(self) -> np.ndarray:
        """Laminate-direction CTE (axial, hoop) of the balanced pair."""
        c2, s2 = np.cos(self.angle) ** 2, np.sin(self.angle) ** 2
        a1, a2 = self.ply.alpha1, self.ply.alpha2
        return np.array([a1 * c2 + a2 * s2, a1 * s2 + a2 * c2])

    def fiber_strain(self, eps: np.ndarray, dT: float = 0.0) -> float:
        """Mechanical fibre-direction strain (total minus thermal)."""
        c, s = np.cos(self.angle), np.sin(self.angle)
        return float(eps[0] * c**2 + eps[1] * s**2 - self.ply.alpha1 * dT)


@dataclass
class State:
    p: float
    eps: np.ndarray
    liner_sigma: np.ndarray
    liner: LinerState


class Vessel:
    def __init__(self, liner: Liner, groups: list[PlyGroup], R_inner: float) -> None:
        self.liner = liner
        self.groups = groups
        self.Ri = R_inner
        K = np.zeros((2, 2))
        for g in groups:
            q = g.qbar() * g.t
            w = g.R / R_inner
            K[0] += w * q[0]
            K[1] += q[1]
        self.K = K
        self.w_l = liner.R / R_inner
        # thermal force per unit temperature change: sum w t Qbar alpha
        Ka = np.zeros(2)
        for g in groups:
            fa = g.qbar() @ g.alpha() * g.t
            Ka += np.array([g.R / R_inner * fa[0], fa[1]])
        self.Ka = Ka
        self.dT = 0.0  # current temperature minus stress-free temperature

    def _liner_force(self, sig: np.ndarray) -> np.ndarray:
        return self.liner.t * np.array([self.w_l * sig[0], sig[1]])

    def solve(self, p: float, st: LinerState, eps0: np.ndarray, dT: float | None = None) -> State:
        dT = self.dT if dT is None else dT
        N = np.array([p * self.Ri / 2.0, p * self.Ri]) + self.Ka * dT
        eps_th = self.liner.mat.cte * dT
        eps = eps0.copy()
        for _ in range(60):
            sig, new = self.liner.stress(eps - eps_th, st)
            F = self.K @ eps + self._liner_force(sig) - N
            if np.max(np.abs(F)) < 1e-9 * max(1.0, abs(N[1])):
                break
            J = self.K.copy()
            h = 1e-9
            for j in range(2):
                e2 = eps.copy()
                e2[j] += h
                s2, _ = self.liner.stress(e2 - eps_th, st)
                J[:, j] += (self._liner_force(s2) - self._liner_force(sig)) / h
            eps = eps - np.linalg.solve(J, F)
        sig, new = self.liner.stress(eps - eps_th, st)
        return State(p, eps, sig, new)

    def ramp(self, st: State, p_to: float, steps: int) -> list[State]:
        out = []
        cur = st
        for p in np.linspace(st.p, p_to, steps + 1)[1:]:
            cur = self.solve(float(p), cur.liner, cur.eps)
            out.append(cur)
        return out

    def cool(self, dT: float, steps: int = 6) -> list[State]:
        """Cure cool-down at zero pressure from the stress-free state to ``dT``; sets the vessel temperature."""
        out, cur = [], self.virgin()
        for d in np.linspace(0.0, dT, steps + 1)[1:]:
            cur = self.solve(0.0, cur.liner, cur.eps, float(d))
            out.append(cur)
        self.dT = dT
        self._initial = cur if out else self.virgin()
        return out

    def initial(self) -> State:
        """State at ambient temperature after cure (the virgin state if no cool-down was run)."""
        return getattr(self, "_initial", None) or self.virgin()

    def fiber_ratio(self, eps: np.ndarray, dT: float | None = None) -> dict[str, float]:
        dT = self.dT if dT is None else dT
        r: dict[str, float] = {}
        for g in self.groups:
            v = g.fiber_strain(eps, dT) / g.ply.eps1_ult
            r[g.name] = max(r.get(g.name, -np.inf), v)
        return r

    def fiber_stress(self, eps: np.ndarray, kind: str) -> float:
        vals = [g.fiber_strain(eps, self.dT) * g.ply.fiber_E for g in self.groups if g.name == kind]
        return float(max(vals)) if vals else 0.0

    def virgin(self) -> State:
        return State(0.0, np.zeros(2), np.zeros(2), LinerState())


@dataclass
class HistoryPoint:
    phase: str
    state: State


def run_history(v: Vessel, p_af: float, proof: float, meop: float, steps: int = 16) -> list[HistoryPoint]:
    """Pressure history from the post-cure state (call ``v.cool`` first for thermal residual stresses)."""
    pts: list[HistoryPoint] = [HistoryPoint("start", v.initial())]
    cur = pts[0].state
    for phase, target, n in (
        ("autofrettage", p_af, steps),
        ("unload", 0.0, max(steps // 2, 2)),
        ("proof", proof, max(steps // 2, 2)),
        ("unload", 0.0, max(steps // 2, 2)),
        ("meop", meop, max(steps // 2, 2)),
        ("unload", 0.0, max(steps // 2, 2)),
    ):
        seg = v.ramp(cur, target, n)
        pts.extend(HistoryPoint(phase, s) for s in seg)
        cur = seg[-1]
    return pts


def first_yield_pressure(v: Vessel) -> float:
    """Pressure of first liner yield from the post-cure state (liner response is affine until then)."""
    s0 = v.initial()
    if von_mises(s0.liner_sigma) >= v.liner.yield_stress(s0.liner) - 1e-9:
        return 0.0
    s1 = v.solve(1.0, s0.liner, s0.eps)
    d = s1.liner_sigma - s0.liner_sigma
    lo, hi = 0.0, 1.0
    while von_mises(s0.liner_sigma + hi * d) < v.liner.mat.yield_ and hi < 1e5:
        hi *= 2
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if von_mises(s0.liner_sigma + mid * d) < v.liner.mat.yield_:
            lo = mid
        else:
            hi = mid
    return hi


def reverse_yield_ratio(v: Vessel, p_af: float) -> float:
    s = v.ramp(v.initial(), p_af, 12)[-1]
    # elastic unloading trial (no reverse plasticity allowed)
    z = v.solve(0.0, s.liner, s.eps)
    return von_mises(z.liner_sigma) / v.liner.mat.yield_


def burst(v: Vessel, start: State, p_guess: float) -> tuple[float, str, State]:
    """Ramp from ``start`` until the first ply group reaches its fibre failure strain."""
    cur = start
    p_step = max(p_guess / 60.0, 0.05)
    prev_ratio = max(v.fiber_ratio(cur.eps).values())
    for _ in range(2000):
        nxt = v.solve(cur.p + p_step, cur.liner, cur.eps)
        ratios = v.fiber_ratio(nxt.eps)
        mode, r = max(ratios.items(), key=lambda kv: kv[1])
        if r >= 1.0:
            f = (1.0 - prev_ratio) / max(r - prev_ratio, 1e-12)
            pb = cur.p + f * p_step
            return pb, mode, nxt
        cur, prev_ratio = nxt, r
    return cur.p, "none", cur


def liner_fatigue_cycles(mat: LinerMaterial, s_min: np.ndarray, s_max: np.ndarray) -> float:
    """Smith-Watson-Topper life on the dominant (hoop) principal stress."""
    smax = float(max(s_max[1], s_max[0]))
    amp = 0.5 * float(max(abs(s_max[1] - s_min[1]), abs(s_max[0] - s_min[0])))
    if smax <= 0 or amp <= 0:
        return 1e9
    b = mat.fatigue_exp
    two_n = (smax * amp / mat.fatigue_coeff**2) ** (1.0 / (2.0 * b))
    return float(min(0.5 * two_n, 1e9))
