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
    tangent: np.ndarray | None = None  # free-fibre direction at each contact (mandrel frame)

    @property
    def total_time(self) -> float:
        return float(self.t[-1]) if len(self.t) else 0.0


def layer_path(b: Build, bl: BuiltLayer, samples: int | None = None, reverse: bool = False) -> PathPoints:
    """Fibre path of a layer; ``reverse`` starts a hoop layer at end B (continuous winding)."""
    m = b.project.machine
    if bl.spec.type == "helical":
        assert bl.gp is not None and bl.pattern is not None
        p = bl.pattern
        path = helical_layer_path(bl.gp, p.n_bands, p.dwell, 2 * bl.gp.advance + 2 * p.dwell,
                                  samples or m.samples_per_pass)
    else:
        kw = {"samples_per_rev": samples} if samples else {}
        path = hoop_layer_path(bl.base, bl.z_start, bl.z_end, bl.spec.band_width, bl.spec.passes, pitch=bl.pitch,
                               reverse=reverse, **kw)
    path.phi = path.phi + math.radians(bl.spec.start_angle)  # pattern clocking
    return _dedupe(path)


def _dedupe(path: PathPoints) -> PathPoints:
    """Drop consecutive duplicate points (zero-length segments break tangents and refinement)."""
    P = path.xyz()
    keep = np.concatenate([[True], np.linalg.norm(np.diff(P, axis=0), axis=1) > 1e-7])
    if keep.all():
        return path
    new_index = np.cumsum(keep) - 1
    starts = sorted({int(new_index[c]) for c in path.circuit_starts})
    f = lambda a: None if a is None else a[keep]  # noqa: E731
    return PathPoints(path.z[keep], path.r[keep], path.phi[keep], starts, f(path.alpha), f(path.lam), f(path.dwell),
                      f(path.s))


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


def _upper_concave_hull(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Smallest concave function >= y (monotone chain on the upper hull)."""
    hull: list[int] = []
    for i in range(len(x)):
        while len(hull) >= 2:
            i0, i1 = hull[-2], hull[-1]
            # drop i1 if it lies below the chord i0 -> i
            if (y[i1] - y[i0]) * (x[i] - x[i0]) <= (y[i] - y[i0]) * (x[i1] - x[i0]):
                hull.pop()
            else:
                break
        hull.append(i)
    return np.interp(x, x[hull], y[hull])


def eye_envelope(b: Build, bl: BuiltLayer) -> tuple[np.ndarray, np.ndarray]:
    """Surface the eye travels on: concave hull of (part + bosses + shaft + clearance), floored by the machine.

    Along any free-fibre ray the distance from the axis is convex in the ray parameter while a concave
    envelope stays concave, so every ray crosses the envelope exactly once: the eye position is unique and
    varies continuously (no jumps at hoop drop-offs or the boss shoulder).
    """
    m = b.project.machine
    lin = b.project.liner
    xs, g = solid_radius(b, bl)
    w = int(max(m.eye_clearance, 1.0))
    pad = np.pad(g, w, mode="edge")
    g = np.lib.stride_tricks.sliding_window_view(pad, 2 * w + 1).max(axis=1)  # eye body width
    z0, z1 = float(bl.top.z.min()), float(bl.top.z.max())
    lo, hi = z0 - lin.boss_length - 60.0, z1 + lin.boss_length + 60.0
    inside = (xs >= lo) & (xs <= hi)
    env = np.empty_like(g)
    env[inside] = _upper_concave_hull(xs[inside], g[inside] + m.eye_clearance)
    env[xs < lo] = env[inside][0]
    env[xs > hi] = env[inside][-1]
    return xs, np.maximum(env, min_eye_radius(m))


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
    if path.s is not None:  # by meridian arclength: robust on folded build-ups
        nz = np.interp(path.s, prof.s, n[:, 0])
        nr = np.interp(path.s, prof.s, n[:, 1])
    else:
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


MAX_STEP_DEG = 5.0  # max mandrel rotation per G-code segment
MAX_STEP_MM = 10.0  # max carriage travel per G-code segment
MAX_EYE_STEP_DEG = 10.0  # max payout-eye roll per G-code segment (4-axis)


def no_slack(P: np.ndarray, lam: np.ndarray) -> np.ndarray:
    """Constant-tension eye placement along the free-fibre rays.

    The fibre fed through the eye per step is (laid length) + (change of free length). Pulling the eye in
    faster than fibre is laid would need fibre to be retracted: slack that the tensioner must take up. Any
    point further out on the ray is a valid eye position (outside the concave envelope), so keep the free
    length from shrinking faster than the laying rate.
    """
    laid = np.linalg.norm(np.diff(P, axis=0), axis=1)
    out = lam.copy()
    for i in range(1, len(out)):
        floor = out[i - 1] - laid[i - 1]
        if out[i] < floor:
            out[i] = floor
    return out


def _refine(path: PathPoints, k: np.ndarray) -> PathPoints:
    """Subdivide segment i of the path into k[i] pieces (linear in z, r, phi, alpha, lam)."""
    n = len(path.z)
    idx = np.concatenate([i + np.arange(k[i]) / k[i] for i in range(n - 1)] + [np.array([n - 1.0])])
    base = np.arange(n, dtype=float)

    def f(a):
        return None if a is None else np.interp(idx, base, a.astype(float))

    starts = [int(np.searchsorted(idx, c)) for c in path.circuit_starts]
    dwell = None if path.dwell is None else np.interp(idx, base, path.dwell.astype(float)) > 0.5
    return PathPoints(f(path.z), f(path.r), f(path.phi), starts, f(path.alpha), f(path.lam), dwell, f(path.s))


def simulate_layer(b: Build, bl: BuiltLayer) -> Motion:
    """Machine motion for a layer, adaptively refined so that no G-code segment rotates the mandrel more
    than MAX_STEP_DEG or moves the carriage more than MAX_STEP_MM (linear interpolation between samples
    must not pull the fibre off its path)."""
    return simulate_path(b, bl, layer_path(b, bl))


def simulate_path(b: Build, bl: BuiltLayer, path: PathPoints) -> Motion:
    """Machine motion for any fibre path lying on ``bl.base`` (a layer or a continuous-winding transition)."""
    mo = _simulate(b, bl, path)
    for _ in range(3):
        k = np.maximum.reduce([np.ceil(np.abs(np.diff(mo.a)) / MAX_STEP_DEG),
                               np.ceil(np.abs(np.diff(mo.x)) / MAX_STEP_MM),
                               np.ceil(np.abs(np.diff(mo.b)) / MAX_EYE_STEP_DEG)]).astype(int)
        if k.max() <= 1:
            break
        path = _refine(path, np.minimum(np.maximum(k, 1), 16))
        mo = _simulate(b, bl, path)
    da, dx = np.abs(np.diff(mo.a)), np.abs(np.diff(mo.x))
    bad = (da > 2 * MAX_STEP_DEG) | (dx > 2 * MAX_STEP_MM)
    if bad.any():
        i = int(np.argmax(np.where(bad, da / MAX_STEP_DEG + dx / MAX_STEP_MM, 0)))
        mo.warnings.append(f"Eye solution jumps {da[i]:.0f} deg / {dx[i]:.0f} mm in one segment near z = "
                           f"{mo.contact[i, 0]:.0f} mm ({int(bad.sum())} segments): the clearance envelope forces "
                           "a sudden eye repositioning there; check that region in the simulation")
    return mo


TANGENT_SMOOTHING = 6.0  # mm: the band bridges sub-band-width surface steps (hoop drop-offs)


def _tangents(path: PathPoints, base, cyl_half: float) -> np.ndarray:
    """Free-fibre directions, with the surface radius smoothed over a few mm of meridian.

    Only the radius is replaced, by a smoothed function of the axial position (independent of the
    direction of travel); near the turnarounds (near-circumferential fibre) the exact geometry is kept.
    """
    from scipy.ndimage import gaussian_filter1d

    s = base.s
    n = max(int(s[-1] / 0.5), 8)
    sq = np.linspace(0.0, s[-1], n)
    zq, rq = np.interp(sq, s, base.z), np.interp(sq, s, base.r)
    r_s = gaussian_filter1d(rq, TANGENT_SMOOTHING / (sq[1] - sq[0]), mode="nearest")
    order = np.argsort(zq)
    r_path = np.interp(path.z, zq[order], r_s[order])
    # smooth only on the cylinder section (single-valued profile; that is where hoop drop-offs are),
    # blending to the exact geometry over 10 mm towards the domes and near-circumferential fibre
    ext = 0.3 * float(np.max(base.r))
    w = np.clip((cyl_half + ext - np.abs(path.z)) / (0.4 * ext), 0.0, 1.0)
    w = w * np.clip((np.cos(path.alpha) if path.alpha is not None else np.ones_like(path.z)) / 0.2, 0.0, 1.0)
    r_use = w * r_path + (1 - w) * path.r
    P = np.stack([path.z, r_use * np.cos(path.phi), -r_use * np.sin(path.phi)], axis=1)
    T = np.gradient(P, axis=0)
    return T / np.maximum(np.linalg.norm(T, axis=1), 1e-12)[:, None]


def _simulate(b: Build, bl: BuiltLayer, path: PathPoints) -> Motion:
    m = b.project.machine
    P = path.xyz()
    T = _tangents(path, bl.base, b.project.liner.cyl_length / 2)
    xs, env = eye_envelope(b, bl)
    if m.axes_count == 2:
        # no crossfeed: the eye runs at one fixed radius clearing everything it passes
        env = np.full_like(env, float(env[(xs > P[:, 0].min() - 50) & (xs < P[:, 0].max() + 50)].max()))

    def h(lam: np.ndarray) -> np.ndarray:
        Q = P[:, 1:] + lam[:, None] * T[:, 1:]
        return np.linalg.norm(Q, axis=1) - np.interp(P[:, 0] + lam * T[:, 0], xs, env)

    # first point along the ray that is outside the envelope: coarse scan, then bisection in that interval
    grid = np.concatenate([np.linspace(0.0, 400.0, 81)[1:], np.linspace(420.0, 5000.0, 230)])
    hi = np.full(len(P), 5000.0)
    lo = np.zeros(len(P))
    found = np.zeros(len(P), dtype=bool)
    prev = 0.0
    for g_ in grid:
        ok = (~found) & (h(np.full(len(P), g_)) >= 0)
        hi = np.where(ok, g_, hi)
        lo = np.where(ok, prev, lo)
        found |= ok
        prev = g_
        if found.all():
            break
    unreachable = ~found
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        pos = h(mid) > 0
        hi = np.where(pos, mid, hi)
        lo = np.where(pos, lo, mid)
    lam = hi
    if m.axes_count == 2:
        # the eye cannot move off its fixed radius: where the free fibre would shorten faster than fibre is
        # laid, the roving goes slack and the tensioner has to take it up (report it, keep the eye where it is)
        slack = float(np.max(no_slack(P, lam) - lam, initial=0.0))
    else:
        slack = 0.0
        lam = no_slack(P, lam)
    Q = P[:, 1:] + lam[:, None] * T[:, 1:]
    x_eye = P[:, 0] + lam * T[:, 0]
    y_eye = np.linalg.norm(Q, axis=1)
    theta = np.unwrap(-np.arctan2(Q[:, 1], Q[:, 0]))

    warnings: list[str] = []
    if slack > 1.0:
        warnings.append(f"Fixed eye radius (2-axis): up to {slack:.0f} mm of roving goes slack near the turnarounds; "
                        "the tensioner must take it up (a crossfeed axis avoids this)")
    if np.any(unreachable):
        warnings.append(f"{int(unreachable.sum())} points have near-axial fibre; eye position clipped")

    # eye rotation: band width direction W = N x T rotated into the world frame
    N = _surface_normals(bl, path)
    W = np.cross(N, T)
    c, s = np.cos(theta), np.sin(theta)
    Wz = W[:, 1] * s + W[:, 2] * c
    beta = np.arctan2(Wz, W[:, 0])
    # where the band width direction is nearly along the roll axis its projection is too short to define
    # the roll: take the well-defined points and interpolate across (band orientation barely matters there)
    wxz = np.hypot(Wz, W[:, 0])
    good = wxz > 0.35
    if good.sum() >= 2 and not good.all():
        idx = np.nonzero(good)[0]
        bg = np.unwrap(2 * beta[good]) / 2
        beta = np.interp(np.arange(len(beta)), idx, bg)
    else:
        beta = np.unwrap(2 * beta) / 2  # band is symmetric: period pi
    beta -= math.pi * round(float(beta[0]) / math.pi)
    if m.axes_count < 4:
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
    return Motion(bl, t, x_eye, y_eye, np.degrees(theta), np.degrees(beta), P, free, path.circuit_starts, warnings,
                  T)


def solid_depth(b: Build, bl: BuiltLayer, x: np.ndarray, rho: np.ndarray) -> np.ndarray:
    """How far points (x, rho) lie inside the part below this layer, the bosses or the shaft [mm, >0 inside].

    Domes are tested radially from their centres on the axis (they are star-shaped, even with thick polar
    build-ups whose end faces are nearly flat), the cylinder by radius, bosses and shaft as cylinders.
    """
    lin = b.project.liner
    half = lin.cyl_length / 2.0
    prof = bl.base
    depth = np.full(x.shape, -np.inf)
    cyl = np.abs(x) <= half
    order = np.argsort(prof.z)
    depth = np.where(cyl, np.interp(x, prof.z[order], prof.r[order]) - rho, depth)
    for sign, rb in ((-1.0, lin.boss_radius_a), (1.0, lin.boss_radius_b)):
        side = np.nonzero(sign * prof.z > half)[0]
        if len(side) < 2:
            continue
        th_s = np.arctan2(prof.r[side], sign * (prof.z[side] - sign * half))
        rho_s = np.hypot(prof.r[side], prof.z[side] - sign * half)
        o = np.argsort(th_s)
        dz = sign * (x - sign * half)
        m = dz > 0
        th_p = np.arctan2(rho, dz)
        d_dome = np.interp(th_p, th_s[o], rho_s[o], left=-np.inf) - np.hypot(rho, dz)
        in_range = th_p >= th_s.min()  # beyond the pole opening the boss takes over
        depth = np.where(m & in_range, d_dome, depth)
        z_end = float(np.max(sign * prof.z[side]))
        boss = m & (dz <= z_end - half + lin.boss_length)
        depth = np.maximum(depth, np.where(boss, rb - rho, -np.inf))
        shaft = m & (dz > z_end - half + lin.boss_length)
        depth = np.maximum(depth, np.where(shaft, lin.shaft_radius - rho, -np.inf))
    return depth


def free_fibre_clearance(b: Build, bl: BuiltLayer, P: np.ndarray, T: np.ndarray, lam: np.ndarray,
                         skip: float = 5.0, samples: int = 16) -> tuple[float, float]:
    """Minimum clearance of the free fibre (contact -> eye) to the part below this layer, bosses and shaft.
    Returns (min clearance [mm], negative = cuts in, axial position of the minimum)."""
    u = np.linspace(0.0, 1.0, samples + 1)[1:]
    L = np.maximum(lam - skip, 0.0)
    pts = P[:, None, :] + (skip + L[:, None] * u[None, :])[:, :, None] * T[:, None, :]
    x = pts[:, :, 0]
    rho = np.hypot(pts[:, :, 1], pts[:, :, 2])
    c = -solid_depth(b, bl, x, rho)
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
    if m.axes_count < 3:
        mc.pop("crossfeed", None)
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
