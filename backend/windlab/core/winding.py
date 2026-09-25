"""Fibre paths on surfaces of revolution: geodesic helical and hoop winding.

Geodesic helical winding obeys Clairaut's relation ``r sin(a) = r0``; the
azimuth advances by ``dphi/ds = r0 / (r sqrt(r^2 - r0^2))`` along the
meridian arclength s. The 1/sqrt singularity at the turnarounds is removed by
substituting ``s = s_turn +/- w^2``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .geometry import Profile, turnaround_s


@dataclass
class GeodesicPass:
    """One pass from the end-A turnaround to the end-B turnaround."""

    s: np.ndarray  # meridian arclength samples
    z: np.ndarray
    r: np.ndarray
    phi: np.ndarray  # azimuth [rad], starts at 0
    r0: float

    @property
    def advance(self) -> float:
        return float(self.phi[-1])

    @property
    def length(self) -> float:
        dphi = np.diff(self.phi)
        rm = 0.5 * (self.r[1:] + self.r[:-1])
        return float(np.sum(np.sqrt(np.diff(self.z) ** 2 + np.diff(self.r) ** 2 + (rm * dphi) ** 2)))


def geodesic_pass(profile: Profile, r0: float, n: int = 400) -> GeodesicPass:
    s_prof = profile.s
    s_a = turnaround_s(profile, r0, "a")
    s_b = turnaround_s(profile, r0, "b")
    s_m = 0.5 * (s_a + s_b)
    half = n // 2

    def half_leg(s_t: float, sign: float) -> tuple[np.ndarray, np.ndarray]:
        w_max = np.sqrt(abs(s_m - s_t))
        # denser near the turnaround in s because s ~ w^2
        w = np.linspace(0.0, w_max, half)
        s = s_t + sign * w**2
        r = np.interp(s, s_prof, profile.r)
        # slope at the turnaround for the w -> 0 limit
        ds = 1e-6 * max(w_max**2, 1.0)
        slope = abs(np.interp(s_t + sign * ds, s_prof, profile.r) - r0) / ds
        dr = np.maximum(r - r0, 0.0)
        with np.errstate(divide="ignore", invalid="ignore"):
            g = r0 / (r * np.sqrt(dr * (r + r0))) * 2.0 * w
        g[0] = 2.0 * r0 / (r0 * np.sqrt(max(slope, 1e-9) * 2.0 * r0))
        bad = ~np.isfinite(g)
        g[bad] = g[0]
        phi = np.concatenate([[0.0], np.cumsum(0.5 * (g[1:] + g[:-1]) * np.diff(w))])
        return s, phi

    s1, p1 = half_leg(s_a, +1.0)  # from turnaround A towards the middle
    s2, p2 = half_leg(s_b, -1.0)  # from turnaround B towards the middle
    s = np.concatenate([s1, s2[::-1][1:]])
    phi = np.concatenate([p1, p1[-1] + (p2[-1] - p2[::-1])[1:]])
    z = np.interp(s, s_prof, profile.z)
    r = np.interp(s, s_prof, profile.r)
    return GeodesicPass(s=s, z=z, r=r, phi=phi, r0=r0)


def resample_pass(gp: GeodesicPass, n: int) -> GeodesicPass:
    """Resample a pass to ~n points evenly spaced in 3D path length."""
    dphi = np.diff(gp.phi)
    rm = 0.5 * (gp.r[1:] + gp.r[:-1])
    dl = np.sqrt(np.diff(gp.z) ** 2 + np.diff(gp.r) ** 2 + (rm * dphi) ** 2)
    L = np.concatenate([[0.0], np.cumsum(dl)])
    Lq = np.linspace(0.0, L[-1], n)
    return GeodesicPass(
        s=np.interp(Lq, L, gp.s),
        z=np.interp(Lq, L, gp.z),
        r=np.interp(Lq, L, gp.r),
        phi=np.interp(Lq, L, gp.phi),
        r0=gp.r0,
    )


@dataclass
class PathPoints:
    """Fibre centre-line in the mandrel frame."""

    z: np.ndarray
    r: np.ndarray
    phi: np.ndarray  # cumulative azimuth [rad]
    circuit_starts: list[int]
    alpha: Optional[np.ndarray] = None  # winding angle [rad]
    lam: Optional[np.ndarray] = None  # slippage coefficient

    def xyz(self) -> np.ndarray:
        # negative sine so the mandrel turns in the positive sense while winding
        return np.stack([self.z, self.r * np.cos(self.phi), -self.r * np.sin(self.phi)], axis=1)

    @property
    def length(self) -> float:
        p = self.xyz()
        return float(np.sum(np.linalg.norm(np.diff(p, axis=0), axis=1)))


def _dwell_arc(z: float, r: float, phi0: float, dwell: float, n: int) -> tuple[np.ndarray, ...]:
    k = max(int(np.ceil(abs(dwell) / np.radians(10.0))), 1) if dwell > 1e-9 else 0
    if k == 0:
        return np.empty(0), np.empty(0), np.empty(0)
    ph = phi0 + dwell * np.arange(1, k + 1) / k
    return np.full(k, z), np.full(k, r), ph


def helical_layer_path(
    gp, n_circuits: int, dwell: float, shift_per_circuit: float, samples: int
) -> PathPoints:
    """Full helical layer: n circuits (A->B, dwell, B->A, dwell) laid end to end.

    ``gp`` is a pass from turnaround A to turnaround B (``GeodesicPass`` or
    ``paths.HelicalPass``). ``shift_per_circuit`` is only a consistency check.
    """
    p = gp.resample(samples) if hasattr(gp, "resample") else resample_pass(gp, samples)
    alpha = getattr(p, "alpha", np.arcsin(np.clip(gp.r0 / np.maximum(p.r, 1e-9), 0, 1)))
    lam = getattr(p, "lam", np.zeros_like(p.z))
    slip = (getattr(gp, "dwell_slip_a", 0.0), getattr(gp, "dwell_slip_b", 0.0))
    zs, rs, ps, als, lms, starts = [], [], [], [], [], []

    def add(z, r, ph, al, lm):
        zs.append(z), rs.append(r), ps.append(ph), als.append(al), lms.append(lm)

    phi = 0.0
    for _ in range(n_circuits):
        starts.append(sum(len(a) for a in zs))
        add(p.z, p.r, phi + p.phi - p.phi[0], alpha, lam)  # A -> B
        phi += p.advance
        dz, dr, dp = _dwell_arc(p.z[-1], p.r[-1], phi, dwell, samples)
        add(dz, dr, dp, np.full(len(dz), np.pi / 2), np.full(len(dz), slip[1]))
        phi += dwell
        # B -> A: the same path walked backwards, still advancing in phi
        add(p.z[::-1][1:], p.r[::-1][1:], phi + (p.phi[-1] - p.phi[::-1])[1:], alpha[::-1][1:], lam[::-1][1:])
        phi += p.advance
        dz, dr, dp = _dwell_arc(p.z[0], p.r[0], phi, dwell, samples)
        add(dz, dr, dp, np.full(len(dz), np.pi / 2), np.full(len(dz), slip[0]))
        phi += dwell
    assert abs((2 * p.advance + 2 * dwell) - shift_per_circuit) < 1e-6 or shift_per_circuit == 0
    return PathPoints(np.concatenate(zs), np.concatenate(rs), np.concatenate(ps), starts,
                      np.concatenate(als), np.concatenate(lms))


def hoop_layer_path(
    profile: Profile, z_start: float, z_end: float, band_width: float, passes: int, samples_per_rev: int = 72
) -> PathPoints:
    """Hoop helix at one band width per revolution, ``passes`` traverses back and forth."""
    zs, ps, starts = [], [], []
    lo, hi = z_start + band_width / 2, z_end - band_width / 2
    if hi <= lo:
        hi = lo = 0.5 * (z_start + z_end)
    revs = max((hi - lo) / band_width, 1e-6)
    n = max(int(np.ceil(revs * samples_per_rev)), 2)
    phi = 0.0
    for k in range(passes):
        starts.append(sum(len(a) for a in zs))
        t = np.linspace(0.0, 1.0, n)
        z = lo + (hi - lo) * t if k % 2 == 0 else hi - (hi - lo) * t
        zs.append(z), ps.append(phi + 2 * np.pi * revs * t)
        phi += 2 * np.pi * revs
        # half a revolution of dwell at each reversal locks the band
        zd = np.full(samples_per_rev // 2, z[-1])
        pd = phi + np.pi * np.arange(1, len(zd) + 1) / len(zd)
        zs.append(zd), ps.append(pd)
        phi += np.pi
    z = np.concatenate(zs)
    r = profile.radius_at(z)
    alpha = np.full(len(z), np.arctan2(2 * np.pi * float(np.mean(r)), band_width))
    return PathPoints(z, r, np.concatenate(ps), starts, alpha, np.zeros(len(z)))
