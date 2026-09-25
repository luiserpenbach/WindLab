"""Helical fibre paths on surfaces of revolution: geodesic and non-geodesic.

A fibre crossing the meridian at angle ``a`` (from the meridian / vessel axis)
has normal curvature ``kn = km cos^2 a + kp sin^2 a`` and geodesic curvature
``kg``. It stays in place on a wet surface while the slippage coefficient
``lam = kg / kn`` stays within the fibre/surface friction coefficient ``mu``.

In fibre arclength ``l`` the path obeys (``r' = dr/ds`` along the meridian)::

    da/dl   = lam * kn - sin(a) r' / r
    ds/dl   = cos(a)
    dphi/dl = sin(a) / r

``lam = 0`` is the geodesic (Clairaut ``r sin a = const``). Integrating in
``l`` keeps the equations regular through the turnaround where ``a = 90 deg``.

Non-geodesic layers use a geodesic helix on the cylinder and a constant
``lam`` on each dome, found by shooting so the fibre turns around exactly at
the requested radius. This allows unequal polar openings, cylinder angles
other than the Clairaut angle and dome thickness tailoring.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from scipy.signal import savgol_filter

from .geometry import GeometryError, Profile
from .winding import geodesic_pass

HALF_PI = 0.5 * math.pi
LAMBDA_SEARCH = 0.9


@dataclass
class Leg:
    """Mid-plane -> turnaround on one side (s increasing towards that pole)."""

    s: np.ndarray
    z: np.ndarray  # oriented: positive towards this leg's pole
    r: np.ndarray
    alpha: np.ndarray
    phi: np.ndarray
    lam: np.ndarray
    r_turn: float
    lam_dome: float
    dwell_slip: float  # slippage coefficient a dwell at the turnaround circle would need

    @property
    def advance(self) -> float:
        return float(self.phi[-1])


@dataclass
class HelicalPass:
    """Turnaround A -> turnaround B, in part coordinates."""

    s: np.ndarray
    z: np.ndarray
    r: np.ndarray
    phi: np.ndarray
    alpha: np.ndarray
    lam: np.ndarray
    r_a: float
    r_b: float
    lam_a: float = 0.0
    lam_b: float = 0.0
    dwell_slip_a: float = 0.0
    dwell_slip_b: float = 0.0
    alpha_mid: float = 0.0
    legs: dict = field(default_factory=dict)  # side -> Leg (for thickness functions)

    @property
    def r0(self) -> float:
        return 0.5 * (self.r_a + self.r_b)

    @property
    def advance(self) -> float:
        return float(self.phi[-1] - self.phi[0])

    @property
    def length(self) -> float:
        dphi = np.diff(self.phi)
        rm = 0.5 * (self.r[1:] + self.r[:-1])
        return float(np.sum(np.sqrt(np.diff(self.z) ** 2 + np.diff(self.r) ** 2 + (rm * dphi) ** 2)))

    def resample(self, n: int) -> "HelicalPass":
        dphi = np.diff(self.phi)
        rm = 0.5 * (self.r[1:] + self.r[:-1])
        dl = np.sqrt(np.diff(self.z) ** 2 + np.diff(self.r) ** 2 + (rm * dphi) ** 2)
        L = np.concatenate([[0.0], np.cumsum(dl)])
        q = np.linspace(0.0, L[-1], n)
        f = lambda a: np.interp(q, L, a)  # noqa: E731
        return HelicalPass(f(self.s), f(self.z), f(self.r), f(self.phi), f(self.alpha), f(self.lam),
                           self.r_a, self.r_b, self.lam_a, self.lam_b, self.dwell_slip_a, self.dwell_slip_b,
                           self.alpha_mid, self.legs)

    def alpha_at_s(self, s: np.ndarray) -> np.ndarray:
        """Winding angle at meridian arclength s of the surface the pass lies on (90 deg beyond turnarounds)."""
        order = np.argsort(self.s)
        return np.interp(s, np.asarray(self.s)[order], self.alpha[order], left=HALF_PI, right=HALF_PI)

    def alpha_at_z(self, z: np.ndarray) -> np.ndarray:
        order = np.argsort(self.z)
        return np.interp(z, self.z[order], self.alpha[order])

    def thickness(self, base: Profile, t_cyl: float, R_mid: float, B: float) -> np.ndarray:
        """Band-averaged thickness from fibre conservation ``t r cos(a) = const`` on both domes."""
        C = t_cyl * R_mid * math.cos(self.alpha_mid)
        t = np.zeros_like(base.r)
        for side, mask in (("a", base.z < 0), ("b", base.z >= 0)):
            G_r, G = self.legs[side]
            rq = base.r[mask]
            t[mask] = C * (_G(G_r, G, rq + B / 2) - _G(G_r, G, rq - B / 2)) / B
        return np.maximum(t, 0.0)


def _G(G_r: np.ndarray, G: np.ndarray, r: np.ndarray) -> np.ndarray:
    """Cumulative integral of dr / (r cos a) from the turnaround, extended linearly beyond."""
    slope = (G[-1] - G[-2]) / max(G_r[-1] - G_r[-2], 1e-12)
    out = np.interp(r, G_r, G, left=0.0)
    hi = r > G_r[-1]
    out[hi] = G[-1] + (r[hi] - G_r[-1]) * slope
    return out


def _leg_integral(leg: Leg) -> tuple[np.ndarray, np.ndarray]:
    """G(r) = int_{r_t}^{r} dr / (r cos a) along a leg, via dG = r' dl / r (regular at the turnaround)."""
    s, r, phi = leg.s, leg.r, leg.phi
    ds, dr = np.diff(s), np.diff(r)
    rm = 0.5 * (r[1:] + r[:-1])
    dl = np.sqrt(ds**2 + (rm * np.diff(phi)) ** 2)
    with np.errstate(divide="ignore", invalid="ignore"):
        slope = np.where(np.abs(ds) > 1e-12, dr / ds, 0.0)
    dG = -slope * dl / rm  # r decreases towards the turnaround
    G = np.concatenate([[0.0], np.cumsum(dG)])
    G = G[-1] - G  # zero at the turnaround
    # monotone table in r (ascending)
    order = np.argsort(r)
    G_r, Gs = r[order], G[order]
    keep = np.concatenate([[True], np.diff(G_r) > 1e-9])
    G_r, Gs = G_r[keep], np.maximum.accumulate(Gs[keep])
    # beyond the mid-plane radius continue with the geodesic (Clairaut) integrand
    c = float(r[0] * np.sin(leg.alpha[0]))
    ext = np.linspace(G_r[-1], G_r[-1] + 80.0, 161)[1:]
    Gext = Gs[-1] + np.arccosh(ext / c) - np.arccosh(G_r[-1] / c)
    return np.concatenate([G_r, ext]), np.concatenate([Gs, Gext])


# --------------------------------------------------------------------------- surface tables
class SurfaceTable:
    """Uniformly resampled meridian with smoothed derivatives and curvatures."""

    def __init__(self, prof: Profile, h: float = 0.25) -> None:
        s = prof.s
        self.s0, self.h = 0.0, h
        n = max(int(s[-1] / h) + 1, 8)
        su = np.linspace(0.0, s[-1], n)
        self.h = su[1] - su[0]
        r = np.interp(su, s, prof.r)
        z = np.interp(su, s, prof.z)
        w = min(max(int(4.0 / self.h) | 1, 7), (n // 2) * 2 - 1)
        dr = savgol_filter(r, w, 3, deriv=1, delta=self.h)
        dz = savgol_filter(z, w, 3, deriv=1, delta=self.h)
        d2r = savgol_filter(r, w, 3, deriv=2, delta=self.h)
        d2z = savgol_filter(z, w, 3, deriv=2, delta=self.h)
        norm = np.hypot(dr, dz)
        norm[norm == 0] = 1.0
        dr, dz = dr / norm, dz / norm
        km = (dr * d2z - dz * d2r) / norm**2
        self.s = su
        self.z = z
        self.tab = np.stack([r, dr, dz, km], axis=1)
        self._xmax = len(su) - 1 - 1e-9

    @property
    def s_end(self) -> float:
        return float(self.s[-1])

    def at(self, s: np.ndarray) -> np.ndarray:
        x = np.minimum(np.maximum((s - self.s0) / self.h, 0.0), self._xmax)
        i = x.astype(np.intp)
        f = (x - i)[:, None]
        return self.tab[i] * (1.0 - f) + self.tab[i + 1] * f

    def z_at(self, s):
        return np.interp(s, self.s, self.z)


def _rhs(tab: SurfaceTable, s, a, lam):
    v = tab.at(s)
    r, dr, dz, km = v[:, 0], v[:, 1], v[:, 2], v[:, 3]
    r = np.maximum(r, 1e-6)
    sa, ca = np.sin(a), np.cos(a)
    kn = km * ca**2 + dz / r * sa**2
    return ca, lam * kn - sa * dr / r, sa / r


def _integrate(tab: SurfaceTable, s0: float, a0: float, phi0: float, lams: np.ndarray, dl: float,
               record: bool = False):
    """Integrate lanes with constant dome lam until a = 90 deg (turnaround) or the surface ends."""
    n = len(lams)
    s = np.full(n, s0)
    a = np.full(n, a0)
    phi = np.full(n, phi0)
    active = np.ones(n, dtype=bool)
    r_turn = np.full(n, np.nan)
    phi_turn = np.full(n, np.nan)
    s_turn = np.full(n, np.nan)
    hist = [(s.copy(), a.copy(), phi.copy())] if record else None
    s_stop = tab.s_end - 2 * tab.h
    max_steps = int(6 * (tab.s_end - s0) / dl) + 200
    for _ in range(max_steps):
        if not active.any():
            break
        idx = np.nonzero(active)[0]
        S, A, P, L = s[idx], a[idx], phi[idx], lams[idx]
        k1 = _rhs(tab, S, A, L)
        k2 = _rhs(tab, S + 0.5 * dl * k1[0], A + 0.5 * dl * k1[1], L)
        k3 = _rhs(tab, S + 0.5 * dl * k2[0], A + 0.5 * dl * k2[1], L)
        k4 = _rhs(tab, S + dl * k3[0], A + dl * k3[1], L)
        Sn = S + dl / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])
        An = A + dl / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
        Pn = P + dl / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2])
        turned = An >= HALF_PI
        # running onto the boss, or the fibre reversing its sense, both mean "no valid turnaround"
        ran_off = (~turned) & ((Sn >= s_stop) | (An <= 0.0))
        if turned.any():
            f = (HALF_PI - A[turned]) / np.maximum(An[turned] - A[turned], 1e-15)
            st = S[turned] + f * (Sn[turned] - S[turned])
            j = idx[turned]
            s_turn[j] = st
            r_turn[j] = tab.at(st)[:, 0]
            phi_turn[j] = P[turned] + f * (Pn[turned] - P[turned])
            Sn[turned], An[turned], Pn[turned] = st, HALF_PI, phi_turn[j]
        if ran_off.any():
            r_turn[idx[ran_off]] = -1.0  # fibre runs onto the boss: turns too late
        s[idx], a[idx], phi[idx] = Sn, An, Pn
        active[idx[turned | ran_off]] = False
        if record:
            hist.append((s.copy(), a.copy(), phi.copy()))
    return r_turn, s_turn, phi_turn, hist


def _mirror(prof: Profile) -> Profile:
    return Profile(-prof.z[::-1], prof.r[::-1])


def _tangent_s(prof: Profile, z_tan: float) -> tuple[float, float]:
    """Arclength of the mid-plane and of the tangent line (z = z_tan) on a profile."""
    s = prof.s
    order = np.argsort(prof.z)
    return float(np.interp(0.0, prof.z[order], s[order])), float(np.interp(z_tan, prof.z[order], s[order]))


class _Side:
    """One side of the vessel, oriented so the pole of interest is at the end of ``prof``."""

    def __init__(self, prof: Profile, z_tan: float) -> None:
        self.prof = prof
        self.s_mid, self.s_tan = _tangent_s(prof, z_tan)
        self.R_mid = float(np.interp(self.s_mid, prof.s, prof.r))
        self.tab = SurfaceTable(prof)

    def cylinder(self, alpha_mid: float):
        """Geodesic cylinder section by quadrature (regular: a < 90 deg there)."""
        prof = self.prof
        c = self.R_mid * math.sin(alpha_mid)
        m = (prof.s > self.s_mid) & (prof.s < self.s_tan)
        sc = np.concatenate([[self.s_mid], prof.s[m], [self.s_tan]])
        rc = np.interp(sc, prof.s, prof.r)
        if np.any(rc <= c):
            raise GeometryError("Winding angle too high: the fibre turns around on the cylinder")
        ac = np.arcsin(c / rc)
        tan_r = np.tan(ac) / rc
        phic = np.concatenate([[0.0], np.cumsum(0.5 * (tan_r[1:] + tan_r[:-1]) * np.diff(sc))])
        return sc, rc, ac, phic, np.interp(sc, prof.s, prof.z)

    def lam_for(self, alpha_mid: float, r_target: float, dl: float = 0.8, coarse: bool = False) -> float:
        sc, rc, ac, phic, zc = self.cylinder(alpha_mid)
        return _shoot(self.tab, self.s_tan, float(ac[-1]), float(phic[-1]), r_target, dl, coarse)

    def leg(self, alpha_mid: float, r_target: float, dl: float = 0.8) -> Leg:
        tab = self.tab
        sc, rc, ac, phic, zc = self.cylinder(alpha_mid)
        a_tan, phi_tan = float(ac[-1]), float(phic[-1])
        lam = _shoot(tab, self.s_tan, a_tan, phi_tan, r_target, dl)
        r_t, s_t, p_t, hist = _integrate(tab, self.s_tan, a_tan, phi_tan, np.array([lam]), dl, record=True)
        if not np.isfinite(s_t[0]):
            raise GeometryError("Fibre does not turn around before the boss; lower the angle or raise the slippage")
        hs = np.array([h[0][0] for h in hist])
        ha = np.array([h[1][0] for h in hist])
        hp = np.array([h[2][0] for h in hist])
        v = tab.at(np.array([s_t[0]]))[0]
        dwell_slip = abs(v[1]) / max(abs(v[2]), 1e-9)  # parallel circle: |kg / kn| = |r'| / |z'|
        return Leg(
            np.concatenate([sc, hs[1:]]),
            np.concatenate([zc, tab.z_at(hs[1:])]),
            np.concatenate([rc, tab.at(hs[1:])[:, 0]]),
            np.concatenate([ac, ha[1:]]),
            np.concatenate([phic, hp[1:]]),
            np.concatenate([np.zeros_like(sc), np.full(len(hs) - 1, lam)]),
            float(r_t[0]), float(lam), float(dwell_slip),
        )


def _shoot(tab: SurfaceTable, s_tan: float, a_tan: float, phi_tan: float, r_target: float, dl: float,
           coarse: bool = False) -> float:
    """Dome slippage coefficient that makes the fibre turn around at ``r_target``.

    Scans lam, brackets the sign change of r_turn - r_target closest to lam = 0,
    then refines the bracket.
    """
    lo, hi = -LAMBDA_SEARCH, LAMBDA_SEARCH
    lam = 0.0
    best: tuple[float, float] | None = None  # (lam, |r_turn - target|) of the closest valid lane so far
    for it in range(4 if coarse else 12):
        lams = np.linspace(lo, hi, 13 if it else 37)
        r_t, *_ = _integrate(tab, s_tan, a_tan, phi_tan, lams, dl if it >= 2 else max(dl, 2.0))
        valid = np.isfinite(r_t) & (r_t > 0)
        d = np.where(valid, r_t - r_target, np.nan)
        if valid.any():
            k_best = int(np.nanargmin(np.abs(d)))
            if best is None or abs(d[k_best]) < best[1]:
                best = (float(lams[k_best]), float(abs(d[k_best])))
        pairs = [j for j in range(len(lams) - 1)
                 if valid[j] and valid[j + 1] and (d[j] <= 0 <= d[j + 1] or d[j + 1] <= 0 <= d[j])]
        # the target may lie between a lane that runs onto the boss and the first lane that turns (above
        # the target): refine into that interval
        edges = [j for j in range(len(lams) - 1)
                 if (not valid[j] and valid[j + 1] and d[j + 1] >= 0) or (valid[j] and not valid[j + 1] and d[j] >= 0)]
        if not pairs and edges:
            j = min(edges, key=lambda k: abs(lams[k] + lams[k + 1]))
            lo, hi = lams[j], lams[j + 1]
            continue
        if not pairs:
            near = np.where(valid, np.abs(d), np.inf)
            k = int(np.argmin(near))
            if near[k] <= max(0.3, 0.01 * r_target):  # target at the edge of the reachable range
                return float(lams[k])
            if it == 0:
                best_r = np.nanmax(np.where(valid, r_t, np.nan)) if valid.any() else float("nan")
                worst = np.nanmin(np.where(valid, r_t, np.nan)) if valid.any() else float("nan")
                hint = "raise" if r_target > best_r else "lower"
                raise GeometryError(
                    f"Turnaround radius {r_target:.1f} mm is not reachable with |slippage| <= {LAMBDA_SEARCH} "
                    f"(reachable {worst:.1f}-{best_r:.1f} mm): {hint} the cylinder angle")
            if best is not None and best[1] <= max(0.3, 0.01 * r_target):
                return best[0]
            break
        j = min(pairs, key=lambda k: abs(lams[k] + lams[k + 1]))
        l0, l1, d0, d1 = lams[j], lams[j + 1], d[j], d[j + 1]
        lam = float(l0 - d0 * (l1 - l0) / (d1 - d0)) if d1 != d0 else float(l0)
        if it >= 2 and abs(d1 - d0) < 0.02:
            return lam
        lo, hi = l0, l1
    return lam


# --------------------------------------------------------------------------- public API
def geodesic(profile: Profile, r0: float) -> HelicalPass:
    return _cached(("geo",) + _key(profile, r0), lambda: _geodesic(profile, r0))


def _geodesic(profile: Profile, r0: float) -> HelicalPass:
    gp = geodesic_pass(profile, r0)
    alpha = np.arcsin(np.clip(r0 / np.maximum(gp.r, 1e-9), 0.0, 1.0))
    mid = int(np.argmin(np.abs(gp.z)))
    hp = HelicalPass(gp.s, gp.z, gp.r, gp.phi, alpha, np.zeros_like(gp.z), r0, r0,
                     alpha_mid=float(alpha[mid]))
    # dwell slippage at the turnarounds (parallel circle on the local slope)
    n = profile.normals()
    order = np.argsort(profile.z)
    for side, zt in (("a", gp.z[0]), ("b", gp.z[-1])):
        nz = float(np.interp(zt, profile.z[order], n[order, 0]))
        nr = float(np.interp(zt, profile.z[order], n[order, 1]))
        setattr(hp, f"dwell_slip_{side}", abs(nz) / max(abs(nr), 1e-9))
    # analytic G for geodesics: G = acosh(r / r0)
    rr = np.linspace(r0, profile.r.max() + 80.0, 1200)
    table = (rr, np.arccosh(np.maximum(rr / r0, 1.0)))
    hp.legs = {"a": table, "b": table}
    hp.alpha_mid = math.asin(r0 / float(np.interp(0.0, profile.z[order], profile.r[order])))
    return hp


_CACHE: dict = {}


def _key(profile: Profile, *args) -> tuple:
    return (hash(profile.z.tobytes()), hash(profile.r.tobytes())) + tuple(round(float(a), 9) for a in args)


def _cached(key, fn):
    if key not in _CACHE:
        if len(_CACHE) > 256:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = fn()
    return _CACHE[key]


def balanced_angle(profile: Profile, z_tan: float, r_a: float, r_b: float) -> float:
    """Cylinder angle that balances the dome slippage (lam_A = -lam_B), minimising max |lam|."""
    def run() -> float:
        side_b = _Side(profile, z_tan)
        side_a = _Side(_mirror(profile), z_tan)
        R = side_b.R_mid
        lo, hi = math.asin(min(r_a, r_b) / R), math.asin(max(r_a, r_b) / R)
        if hi - lo < 1e-6:
            return lo

        def lams(a: float) -> tuple[float, float]:
            try:
                return side_a.lam_for(a, r_a, coarse=True), side_b.lam_for(a, r_b, coarse=True)
            except GeometryError:
                return math.nan, math.nan

        # widen slightly: near an edge the exact geodesic end may be numerically unreachable
        span = hi - lo
        grid = np.linspace(max(lo - 0.15 * span, 0.01), min(hi + 0.15 * span, 1.4), 11)
        vals = [lams(a) for a in grid]
        cost = [max(abs(x), abs(y)) if math.isfinite(x) else math.inf for x, y in vals]
        k = int(np.argmin(cost))
        if not math.isfinite(cost[k]):
            raise GeometryError("No cylinder angle lets the fibre turn at both requested radii")
        # refine: bisection on lam_a + lam_b between feasible neighbours bracketing a sign change
        f = [x + y for x, y in vals]
        for j in (k - 1, k):
            if 0 <= j < len(grid) - 1 and math.isfinite(f[j]) and math.isfinite(f[j + 1]) and f[j] * f[j + 1] <= 0:
                a0, a1, f0 = grid[j], grid[j + 1], f[j]
                for _ in range(10):
                    am = 0.5 * (a0 + a1)
                    xm, ym = lams(am)
                    if not math.isfinite(xm):
                        break
                    if (xm + ym > 0) == (f0 > 0):
                        a0, f0 = am, xm + ym
                    else:
                        a1 = am
                return 0.5 * (a0 + a1)
        return float(grid[k])

    return _cached(("angle",) + _key(profile, z_tan, r_a, r_b), run)


def non_geodesic(profile: Profile, z_tan: float, alpha_mid: Optional[float], r_a: float, r_b: float) -> HelicalPass:
    """Geodesic on the cylinder at ``alpha_mid``, constant-slippage domes turning at r_a / r_b.

    ``alpha_mid = None`` picks the angle that balances the slippage on both domes.
    """
    if alpha_mid is None:
        alpha_mid = balanced_angle(profile, z_tan, r_a, r_b)
    return _cached(("ng",) + _key(profile, z_tan, alpha_mid, r_a, r_b),
                   lambda: _non_geodesic(profile, z_tan, alpha_mid, r_a, r_b))


def _non_geodesic(profile: Profile, z_tan: float, alpha_mid: float, r_a: float, r_b: float) -> HelicalPass:
    leg_b = _Side(profile, z_tan).leg(alpha_mid, r_b)
    leg_a = _Side(_mirror(profile), z_tan).leg(alpha_mid, r_a)
    s_total = profile.s[-1]
    # assemble A turnaround -> mid -> B turnaround
    sa = s_total - leg_a.s[::-1]
    za = -leg_a.z[::-1]
    pa = leg_a.advance - leg_a.phi[::-1]
    s = np.concatenate([sa, leg_b.s[1:]])
    z = np.concatenate([za, leg_b.z[1:]])
    r = np.concatenate([leg_a.r[::-1], leg_b.r[1:]])
    phi = np.concatenate([pa, leg_a.advance + leg_b.phi[1:]])
    alpha = np.concatenate([leg_a.alpha[::-1], leg_b.alpha[1:]])
    lam = np.concatenate([leg_a.lam[::-1], leg_b.lam[1:]])
    hp = HelicalPass(s, z, r, phi, alpha, lam, leg_a.r_turn, leg_b.r_turn, leg_a.lam_dome, leg_b.lam_dome,
                     leg_a.dwell_slip, leg_b.dwell_slip, alpha_mid)
    hp.legs = {"a": _leg_integral(leg_a), "b": _leg_integral(leg_b)}
    return hp
