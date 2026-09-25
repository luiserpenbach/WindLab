"""Meridian geometry of axisymmetric liners and wound surfaces.

A surface of revolution is described by its meridian polyline ``(z, r)``,
ordered from the polar boss of end A (negative z) to the boss of end B.
The cylinder mid-plane is at ``z = 0``.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..schemas import LinerSpec


class GeometryError(ValueError):
    pass


@dataclass
class Profile:
    z: np.ndarray
    r: np.ndarray

    def __post_init__(self) -> None:
        self.z = np.asarray(self.z, dtype=float)
        self.r = np.asarray(self.r, dtype=float)

    @property
    def s(self) -> np.ndarray:
        """Cumulative meridian arclength [mm]."""
        d = np.hypot(np.diff(self.z), np.diff(self.r))
        return np.concatenate([[0.0], np.cumsum(d)])

    def tangents(self) -> np.ndarray:
        """Unit meridian tangents (dz/ds, dr/ds), central differences."""
        dz = np.gradient(self.z)
        dr = np.gradient(self.r)
        n = np.hypot(dz, dr)
        n[n == 0] = 1.0
        return np.stack([dz / n, dr / n], axis=1)

    def normals(self) -> np.ndarray:
        """Unit outward normals (nz, nr)."""
        t = self.tangents()
        return np.stack([-t[:, 1], t[:, 0]], axis=1)

    def offset(self, t: np.ndarray) -> "Profile":
        n = self.normals()
        return Profile(self.z + t * n[:, 0], self.r + t * n[:, 1])

    def volume(self) -> float:
        """Volume enclosed by the surface between its end planes [mm3]."""
        return float(np.trapezoid(np.pi * self.r**2, self.z))

    def shell_volume(self, t: np.ndarray) -> float:
        """Volume of a shell of normal thickness t laid on this surface [mm3]."""
        return float(np.trapezoid(2.0 * np.pi * (self.r + 0.5 * t) * t, self.s))

    def radius_at(self, z: np.ndarray | float) -> np.ndarray:
        return np.interp(z, self.z, self.r)


def _isotensoid(rho0: float, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Geodesic-isotensoid (netting) dome, normalised to unit cylinder radius.

    From meridional and circumferential netting equilibrium with geodesic
    fibres (sin a = rho0/rho) the meridian slope cosine is
    ``u = rho^3 sqrt((1 - rho0^2) / (rho^2 - rho0^2))``. Returns ``(rho, h)``
    from the equator (rho = 1, h = 0) to the boss.
    """
    # u reaches 1 again just outside rho0 (the dome becomes tangent to a neck);
    # find that radius and integrate between the two integrable singularities.
    def u(rho):
        return rho**3 * np.sqrt((1 - rho0**2) / np.maximum(rho**2 - rho0**2, 1e-300))

    lo, hi = rho0 * (1 + 1e-12), np.sqrt(1.5) * rho0  # u is minimal at rho^2 = 1.5 rho0^2
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if u(mid) > 1.0:
            lo = mid
        else:
            hi = mid
    rho1 = hi
    tau = np.linspace(0.0, 1.0, n)
    # cosine spacing removes the 1/sqrt singularities at both ends
    rho = 1.0 - (1.0 - rho1) * 0.5 * (1.0 - np.cos(np.pi * tau))
    drho_dtau = -(1.0 - rho1) * 0.5 * np.pi * np.sin(np.pi * tau)
    uu = np.clip(u(rho), 0.0, 1.0)
    integrand = uu / np.sqrt(np.maximum(1.0 - uu**2, 1e-300)) * (-drho_dtau)
    # endpoints: the product tends to a finite value; take the neighbour value
    integrand[0] = integrand[1]
    integrand[-1] = integrand[-2]
    h = np.concatenate([[0.0], np.cumsum(0.5 * (integrand[1:] + integrand[:-1]) * np.diff(tau))])
    return rho, h


def dome_curve(spec: LinerSpec, boss_radius: float, n: int = 400) -> tuple[np.ndarray, np.ndarray]:
    """Outer dome meridian (r, h) from equator to boss, h = axial height beyond the tangent line."""
    R = spec.radius
    if boss_radius >= 0.9 * R:
        raise GeometryError("Boss radius must be well below the cylinder radius")
    rho_b = boss_radius / R
    if spec.dome_type == "isotensoid":
        if rho_b > 0.6:
            raise GeometryError("Isotensoid domes need a boss radius below 0.6 x cylinder radius")
        rho, h = _isotensoid(rho_b, n)
        r, hh = rho * R, h * R
        if r[-1] > boss_radius:  # close the neck down to the boss
            r = np.append(r, boss_radius)
            hh = np.append(hh, hh[-1] + (r[-2] - boss_radius) * 0.05)
        return r, hh
    # hemispherical / elliptical: parametrise by the polar angle
    b = R if spec.dome_type == "hemispherical" else spec.dome_aspect * R
    th = np.linspace(np.pi / 2, np.arcsin(rho_b), n)
    return R * np.sin(th), b * np.cos(th)


def liner_profiles(spec: LinerSpec, n_dome: int = 240, n_cyl: int = 60) -> tuple[Profile, Profile]:
    """Outer and inner liner meridians."""
    half = spec.cyl_length / 2.0
    r_a, h_a = dome_curve(spec, spec.boss_radius_a, n_dome)
    r_b, h_b = dome_curve(spec, spec.boss_radius_b, n_dome)
    z_cyl = np.linspace(-half, half, n_cyl)[1:-1]
    z = np.concatenate([(-half - h_a)[::-1], z_cyl, half + h_b])
    r = np.concatenate([r_a[::-1], np.full_like(z_cyl, spec.radius), r_b])
    outer = Profile(z, r)
    inner = outer.offset(-np.full_like(z, spec.wall_thickness))
    if np.any(inner.r <= 0):
        raise GeometryError("Liner wall thicker than the boss radius allows")
    return outer, inner


def turnaround_s(profile: Profile, r0: float, end: str) -> float:
    """Arclength where the surface radius first drops to ``r0`` walking from the mid-plane to ``end``."""
    mid = int(np.argmin(np.abs(profile.z)))
    r, s = profile.r, profile.s
    if r[mid] <= r0:
        raise GeometryError(f"Turnaround radius {r0:.1f} mm exceeds the surface radius")
    step = 1 if end == "b" else -1
    i = mid
    while 0 <= i + step < len(r):
        j = i + step
        if r[j] <= r0:
            f = (r[i] - r0) / (r[i] - r[j])
            return float(s[i] + f * (s[j] - s[i]))
        i = j
    raise GeometryError(f"Turnaround radius {r0:.1f} mm is below the boss radius at end {end.upper()}")
