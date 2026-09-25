"""Winding machine kinematics (3-axis and 4-axis).

Machine model (world frame, mandrel axis = world x):

* mandrel rotation ``A`` about +x,
* carriage ``X`` along the mandrel axis,
* crossfeed: radial distance of the payout eye from the axis, the eye moving
  in the horizontal plane through the axis (world z = 0, y > 0),
* 4-axis only: payout eye rotation about the crossfeed direction (world y),
  keeping the band flat on the surface.

For every point P on the fibre path (mandrel frame) with tangent T, the free
fibre leaves the mandrel along T, so the eye sits on the ray ``P + lam*T``.
The eye path is an envelope at ``clearance`` from the wound part; ``lam`` is
the ray length where the ray meets that envelope. The mandrel angle is the
rotation that brings this point into the eye plane.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .. import schemas as S
from .design import Build, BuiltLayer
from .winding import PathPoints, helical_layer_path, hoop_layer_path


@dataclass
class Motion:
    layer: BuiltLayer
    t: np.ndarray  # time at each point [s]
    x: np.ndarray  # eye axial position, part frame [mm]
    y: np.ndarray  # eye radius [mm]
    a: np.ndarray  # mandrel angle, cumulative [deg]
    b: np.ndarray  # eye angle [deg]
    contact: np.ndarray  # contact points, mandrel frame (N,3)
    free: np.ndarray  # free fibre length [mm]
    circuit_starts: list[int]
    warnings: list[str]

    @property
    def total_time(self) -> float:
        return float(self.t[-1]) if len(self.t) else 0.0


def layer_path(b: Build, bl: BuiltLayer) -> PathPoints:
    m = b.project.machine
    if bl.spec.type == "helical":
        assert bl.gp is not None and bl.pattern is not None
        p = bl.pattern
        return helical_layer_path(bl.gp, p.n_bands, p.dwell, 2 * bl.gp.advance + 2 * p.dwell, m.samples_per_pass)
    return hoop_layer_path(bl.base, bl.z_start, bl.z_end, bl.spec.band_width, bl.spec.passes)


def profile_envelope(prof, xs: np.ndarray) -> np.ndarray:
    """Max radius of a (possibly folded) meridian polyline in each x bin (bins centred on xs)."""
    s = prof.s
    n = max(int(s[-1] / 0.25), 2)
    sq = np.linspace(0.0, s[-1], n)
    zq, rq = np.interp(sq, s, prof.z), np.interp(sq, s, prof.r)
    h = xs[1] - xs[0]
    idx = np.round((zq - xs[0]) / h).astype(int)
    ok = (idx >= 0) & (idx < len(xs))
    g = np.zeros(len(xs))
    np.maximum.at(g, idx[ok], rq[ok])
    # fill empty bins inside the profile span by interpolation
    inside = (xs >= prof.z.min()) & (xs <= prof.z.max())
    empty = inside & (g == 0)
    if empty.any():
        g[empty] = np.interp(xs[empty], xs[~empty & inside], g[~empty & inside])
    return g


def solid_radius(b: Build, bl: BuiltLayer, which: str = "top") -> tuple[np.ndarray, np.ndarray]:
    """Outer radius of liner + wound layers (incl. this one for 'top') + bosses/shaft vs x."""
    lin = b.project.liner
    top = bl.top if which == "top" else bl.base
    z0, z1 = float(top.z.min()), float(top.z.max())
    xs = np.arange(math.floor(z0) - lin.boss_length - 800, math.ceil(z1) + lin.boss_length + 800, 1.0)
    g = profile_envelope(top, xs)
    g = np.where((xs < z0) & (xs >= z0 - lin.boss_length), lin.boss_radius_a, g)
    g = np.where((xs > z1) & (xs <= z1 + lin.boss_length), lin.boss_radius_b, g)
    g = np.where((xs < z0 - lin.boss_length) | (xs > z1 + lin.boss_length), lin.shaft_radius, g)
    return xs, g


def eye_envelope(b: Build, bl: BuiltLayer) -> tuple[np.ndarray, np.ndarray]:
    m = b.project.machine
    xs, g = solid_radius(b, bl)
    w = int(max(m.eye_clearance, 1.0))
    # running max over +/- clearance keeps the clearance in all directions (approx.)
    pad = np.pad(g, w, mode="edge")
    win = np.lib.stride_tricks.sliding_window_view(pad, 2 * w + 1).max(axis=1)
    return xs, np.maximum(win + m.eye_clearance, min_eye_radius(m))


def min_eye_radius(m: S.MachineSpec) -> float:
    """Closest the eye can physically get to the mandrel axis (crossfeed soft limit)."""
    ax = m.crossfeed
    lim = ax.max if ax.invert else ax.min
    if lim is None:
        return 0.0
    return m.crossfeed_zero_radius + (-1.0 if ax.invert else 1.0) * lim / (ax.scale or 1.0)


def _surface_normals(bl: BuiltLayer, path: PathPoints) -> np.ndarray:
    prof = bl.base
    n = prof.normals()
    order = np.argsort(prof.z)
    nz = np.interp(path.z, prof.z[order], n[order, 0])
    nr = np.interp(path.z, prof.z[order], n[order, 1])
    return np.stack([nz, nr * np.cos(path.phi), -nr * np.sin(path.phi)], axis=1)


def _axis_rate(ax: S.MachineAxis) -> tuple[float, float]:
    """Per-part-unit velocity [units/s] and acceleration limits."""
    s = abs(ax.scale) or 1.0
    return ax.max_velocity / 60.0 / s, ax.max_accel / s


def plan_times(q: np.ndarray, fibre_step: np.ndarray, v_fibre: float, vmax: np.ndarray, amax: np.ndarray) -> np.ndarray:
    """Segment durations respecting fibre speed, axis velocity and (approx.) acceleration limits.

    q: (N, k) axis positions in part units; returns dt (N-1,).
    """
    dq = np.abs(np.diff(q, axis=0))
    dt = np.maximum(fibre_step / v_fibre, (dq / vmax).max(axis=1))
    dt = np.maximum(dt, 1e-4)
    for _ in range(200):
        v = np.diff(q, axis=0) / dt[:, None]
        dv = np.abs(np.diff(v, axis=0))
        allow = amax[None, :] * 0.5 * (dt[1:] + dt[:-1])[:, None]
        ratio = (dv / allow).max(axis=1)
        if ratio.max() <= 1.02:
            break
        f = np.sqrt(np.maximum(ratio, 1.0))
        grow = np.ones_like(dt)
        grow[1:] = np.maximum(grow[1:], f)
        grow[:-1] = np.maximum(grow[:-1], f)
        dt *= np.minimum(grow, 1.5)
    return dt


def simulate_layer(b: Build, bl: BuiltLayer) -> Motion:
    m = b.project.machine
    path = layer_path(b, bl)
    P = path.xyz()
    T = np.gradient(P, axis=0)
    T /= np.maximum(np.linalg.norm(T, axis=1), 1e-12)[:, None]
    xs, env = eye_envelope(b, bl)

    # vectorised bisection for the free fibre length lam
    lo = np.zeros(len(P))
    hi = np.full(len(P), 5000.0)

    def h(lam: np.ndarray) -> np.ndarray:
        Q = P[:, 1:] + lam[:, None] * T[:, 1:]
        return np.linalg.norm(Q, axis=1) - np.interp(P[:, 0] + lam * T[:, 0], xs, env)

    unreachable = h(hi) < 0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        pos = h(mid) > 0
        hi = np.where(pos, mid, hi)
        lo = np.where(pos, lo, mid)
    lam = hi
    Q = P[:, 1:] + lam[:, None] * T[:, 1:]
    x_eye = P[:, 0] + lam * T[:, 0]
    y_eye = np.linalg.norm(Q, axis=1)
    theta = np.unwrap(-np.arctan2(Q[:, 1], Q[:, 0]))

    warnings: list[str] = []
    if np.any(unreachable):
        warnings.append(f"{int(unreachable.sum())} points have near-axial fibre; eye position clipped")

    # eye rotation: band width direction W = N x T rotated into the world frame
    N = _surface_normals(bl, path)
    W = np.cross(N, T)
    c, s = np.cos(theta), np.sin(theta)
    Wz = W[:, 1] * s + W[:, 2] * c
    beta = np.arctan2(Wz, W[:, 0])
    beta = np.unwrap(2 * beta) / 2  # band is symmetric: period pi
    beta -= math.pi * round(float(beta[0]) / math.pi)
    if m.axes_count == 3:
        beta = np.zeros_like(beta)

    axes = [m.carriage, m.crossfeed, m.mandrel] + ([m.eye] if m.axes_count == 4 and m.eye else [])
    q = np.stack([x_eye, y_eye, np.degrees(theta)] + ([np.degrees(beta)] if len(axes) == 4 else []), axis=1)
    rates = np.array([_axis_rate(a) for a in axes])
    step = np.linalg.norm(np.diff(P, axis=0), axis=1)
    dt = plan_times(q, step, m.fiber_speed, rates[:, 0], rates[:, 1])
    t = np.concatenate([[0.0], np.cumsum(dt)])

    free = lam * np.linalg.norm(T, axis=1)
    if free.max() > 600:
        warnings.append(f"Free fibre up to {free.max():.0f} mm (low winding angle); expect band narrowing")

    warnings += check_limits(m, x_eye, y_eye, np.degrees(theta), np.degrees(beta))
    clear, z_hit = free_fibre_clearance(b, bl, P, T, lam)
    if clear < -2.0:
        warnings.append(f"Free fibre cuts {-clear:.1f} mm into earlier build-up/boss near z = {z_hit:.0f} mm: it will "
                        "rub or bridge there; review turnaround offsets and the boss shoulder")
    return Motion(bl, t, x_eye, y_eye, np.degrees(theta), np.degrees(beta), P, free, path.circuit_starts, warnings)


def free_fibre_clearance(b: Build, bl: BuiltLayer, P: np.ndarray, T: np.ndarray, lam: np.ndarray,
                         skip: float = 5.0, samples: int = 16) -> tuple[float, float]:
    """Minimum radial clearance of the free fibre (contact -> eye) to the solid (wound part below this
    layer, bosses, shaft). Returns (min clearance [mm], axial position of the minimum)."""
    xs, gs = solid_radius(b, bl, "base")
    u = np.linspace(0.0, 1.0, samples + 1)[1:]
    L = np.maximum(lam - skip, 0.0)
    pts = P[:, None, :] + (skip + L[:, None] * u[None, :])[:, :, None] * T[:, None, :]
    x = pts[:, :, 0]
    rho = np.hypot(pts[:, :, 1], pts[:, :, 2])
    g = np.interp(x, xs, gs)
    c = rho - g
    c = np.where(lam[:, None] > skip, c, np.inf)
    k = int(np.argmin(c))
    return float(c.flat[k]), float(x.flat[k])


def to_machine(ax: S.MachineAxis, v: np.ndarray, offset: float = 0.0) -> np.ndarray:
    return offset + (-1.0 if ax.invert else 1.0) * ax.scale * v


def machine_coords(m: S.MachineSpec, x, y, a, b) -> dict[str, np.ndarray]:
    out = {
        "carriage": to_machine(m.carriage, np.asarray(x), m.carriage_offset),
        "crossfeed": to_machine(m.crossfeed, np.asarray(y) - m.crossfeed_zero_radius),
        "mandrel": to_machine(m.mandrel, np.asarray(a)),
    }
    if m.axes_count == 4 and m.eye:
        out["eye"] = to_machine(m.eye, np.asarray(b))
    return out


def check_limits(m: S.MachineSpec, x, y, a, b) -> list[str]:
    w = []
    mc = machine_coords(m, x, y, a, b)
    for key, ax in (("carriage", m.carriage), ("crossfeed", m.crossfeed), ("eye", m.eye)):
        if key not in mc or ax is None:
            continue
        v = mc[key]
        if ax.min is not None and v.min() < ax.min - 1e-6:
            w.append(f"{key} axis {ax.letter} below soft limit: {v.min():.1f} < {ax.min}")
        if ax.max is not None and v.max() > ax.max + 1e-6:
            w.append(f"{key} axis {ax.letter} above soft limit: {v.max():.1f} > {ax.max}")
    return w


def downsample(n: int, max_points: int) -> np.ndarray:
    if n <= max_points:
        return np.arange(n)
    return np.unique(np.linspace(0, n - 1, max_points).astype(int))
