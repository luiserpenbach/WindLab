"""Continuous winding: transition paths between layers without cutting the roving.

Every helical layer starts and ends at its turnaround on end A; hoop layers start at either end. Between
two layers the fibre follows a transition made of

* **direct join** (helical -> helical): the next layer leaves from the turnaround where the previous one
  arrived. Allowed when the cylinder angle changes by at most ``max_angle_step`` (default 7 deg, a common
  shop rule) and the turnaround radius by at most one band width (a dwell spirals between the radii);
* **transition passes**: complete passes at intermediate cylinder angles and turnaround radii, each dome
  leg a constant-slippage non-geodesic path whose |kg/kn| must stay within ``slippage_margin x friction``.
  Consecutive passes differ by at most ``max_angle_step``;
* **cylinder ramps** (to and from hoops): the angle changes between the hoop angle and the highest angle a
  dome turnaround comfortably allows (turnaround at ``HOOP_CAP`` x the cylinder radius) along the cylinder
  with constant slippage, ``da/dl = lam sin^2(a) / R`` (closed form below);
* **phase dwell**: a dwell of less than one band slot (2 pi / n) at the turnaround so the next helical
  layer lays exactly its planned pattern (any rotation by a multiple of 2 pi / n lays the same bands);
* hoop -> hoop: a short hoop-pitch connector; the next hoop starts at the end where the fibre is.

Transition fibre is reported (length, mass) but not counted in the laminate thickness.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .. import schemas as S
from . import paths
from .design import Build, BuiltLayer
from .geometry import GeometryError
from .winding import PathPoints

HOOP_CAP = 0.92  # turnaround radius / cylinder radius of the highest-angle transition pass
MAX_PASSES = 40
MERGE_TOL = 0.5  # mm
TRANSITION_DL = 1.6  # fibre-arclength step of transition dome legs [mm] (layers use 0.8)


@dataclass
class Transition:
    src: BuiltLayer
    dst: BuiltLayer
    kind: str  # "direct" | "passes" | "hoop"
    path: PathPoints
    angles: list[float]  # cylinder angle of each transition pass [rad]
    max_slip: float
    limit: float
    dwell: float  # phase-matching dwell [rad]
    feasible: bool
    notes: list[str] = field(default_factory=list)

    @property
    def length(self) -> float:
        return self.path.length if len(self.path.z) > 1 else 0.0

    def mass(self) -> float:
        """Fibre mass [g] (dry fibre, like the layer fibre masses)."""
        f = self.dst.fiber
        return self.length * f.tex * self.dst.spec.tows / 1e6 if f is not None else 0.0


@dataclass
class Segment:
    kind: str  # "layer" | "transition"
    layer: BuiltLayer  # surface the path lies on (a transition lies on the next layer's base)
    path: PathPoints
    label: str
    transition: Transition | None = None


@dataclass
class Plan:
    segments: list[Segment]
    transitions: list[Transition]

    @property
    def feasible(self) -> bool:
        return all(t.feasible for t in self.transitions)


# --------------------------------------------------------------------------- path pieces
class _Builder:
    """Accumulates path pieces; each piece gives its azimuth as increments from the current point."""

    def __init__(self, z: float, r: float, s: float, phi: float) -> None:
        self.parts: list[tuple] = []
        self.z, self.r, self.phi, self.s = z, r, phi, s

    def add(self, z, r, dphi, alpha, lam, s, dwell=False) -> None:
        z, r, dphi = np.asarray(z, float), np.asarray(r, float), np.asarray(dphi, float)
        alpha, lam, s = np.asarray(alpha, float), np.asarray(lam, float), np.asarray(s, float)
        # shared point (consecutive passes meet at a turnaround up to the shooting tolerance): merge it; a
        # sub-millimetre segment with no azimuth advance would be a meridional kink with an arbitrary fibre
        # direction that throws the eye around (path samples are several mm apart)
        if len(z) and math.sqrt((z[0] - self.z) ** 2 + (r[0] - self.r) ** 2 + (r[0] * dphi[0]) ** 2) < MERGE_TOL:
            z, r, dphi, alpha, lam, s = z[1:], r[1:], dphi[1:], alpha[1:], lam[1:], s[1:]
        if len(z) == 0:
            return
        phi = self.phi + dphi
        self.parts.append((z, r, phi, alpha, lam, np.full(len(z), dwell), s))
        self.z, self.r, self.phi, self.s = float(z[-1]), float(r[-1]), float(phi[-1]), float(s[-1])

    def dwell(self, dphi: float, z1: float | None = None, r1: float | None = None, s1: float | None = None,
              slip: float = 0.0) -> None:
        """Dwell arc of ``dphi`` at the current point, optionally spiralling to (z1, r1)."""
        z1 = self.z if z1 is None else z1
        r1 = self.r if r1 is None else r1
        s1 = self.s if s1 is None else s1
        if dphi <= 1e-9 and abs(z1 - self.z) < 1e-6 and abs(r1 - self.r) < 1e-6:
            return
        k = max(int(math.ceil(dphi / math.radians(5.0))), 2)
        t = np.linspace(0.0, 1.0, k + 1)[1:]
        self.add(self.z + (z1 - self.z) * t, self.r + (r1 - self.r) * t, dphi * t, np.full(k, math.pi / 2),
                 np.full(k, slip), self.s + (s1 - self.s) * t, dwell=True)

    def path(self) -> PathPoints:
        if not self.parts:
            e = np.empty(0)
            return PathPoints(e, e, e, [0], e, e, np.empty(0, dtype=bool), e)
        cat = [np.concatenate([p[i] for p in self.parts]) for i in range(7)]
        return PathPoints(cat[0], cat[1], cat[2], [0], cat[3], cat[4], cat[5], cat[6])


def _onto(surf, half: float, z: float, r: float) -> tuple[float, float, float]:
    """(z, r, s) of the point of ``surf`` at axial position z (cylinder) or at radius r (dome of that side)."""
    if abs(z) <= half:
        return z, float(surf.radius_at(z)), float(_cyl_s(surf, z))
    m = surf.z < -half if z < 0 else surf.z > half
    zs, rs, ss = surf.z[m], surf.r[m], surf.s[m]
    order = np.argsort(rs)
    rq = float(np.clip(r, rs.min(), rs.max()))
    return float(np.interp(rq, rs[order], zs[order])), rq, float(np.interp(rq, rs[order], ss[order]))


def _cyl_s(surf, z):
    order = np.argsort(surf.z)
    return np.interp(z, surf.z[order], surf.s[order])


def _ramp(R: float, a0: float, a1: float, lam_abs: float, n: int = 24):
    """Constant-slippage angle change on a cylinder of radius R. Returns (dz >= 0, phi, alpha, lam)."""
    lam = lam_abs if a1 > a0 else -lam_abs
    a = np.linspace(a0, a1, n)
    dz = R / lam * (1.0 / math.sin(a0) - 1.0 / np.sin(a))
    phi = (math.asinh(1.0 / math.tan(a0)) - np.arcsinh(1.0 / np.tan(a))) / lam
    return dz, phi, a, np.full(n, lam)


def _pass(surf, half: float, a: float, r_from: float, r_to: float, direction: int):
    """Transition pass at cylinder angle ``a`` from the turnaround at r_from to the one at r_to.

    direction +1: A -> B; -1: B -> A (the A -> B solution walked backwards, azimuth still advancing).
    Returns arrays (z, r, phi, alpha, lam, s) and the slippage of the (start, end) dome legs.
    """
    if direction > 0:
        hp = paths.non_geodesic(surf, half, a, r_from, r_to, dl=TRANSITION_DL)
        arr = (hp.z, hp.r, hp.phi - hp.phi[0], hp.alpha, hp.lam, hp.s)
        return arr, (abs(hp.lam_a), abs(hp.lam_b))
    hp = paths.non_geodesic(surf, half, a, r_to, r_from, dl=TRANSITION_DL)
    arr = (hp.z[::-1], hp.r[::-1], hp.phi[-1] - hp.phi[::-1], hp.alpha[::-1], hp.lam[::-1], hp.s[::-1])
    return arr, (abs(hp.lam_b), abs(hp.lam_a))


def _cut(arr, direction: int, z_cut: float, keep: str):
    """Keep the part of a pass after (keep="after") or before z_cut in the direction of travel."""
    z = arr[0]
    d = direction * (z - z_cut)
    m = d > 0 if keep == "after" else d < 0
    # the cylinder part is monotonic in z: phi at the cut by interpolation there
    idx = np.nonzero(m)[0]
    return tuple(x[idx] for x in arr)


def _phi_at(arr, z_cut: float, half: float) -> float:
    z, phi = arr[0], arr[2]
    cyl = np.abs(z) <= half
    zc, pc = z[cyl], phi[cyl]
    order = np.argsort(zc)
    return float(np.interp(z_cut, zc[order], pc[order]))


# --------------------------------------------------------------------------- planning
def _ends(bl: BuiltLayer, R: float) -> tuple[float, float, float]:
    if bl.spec.type == "helical" and bl.gp is not None:
        return float(bl.gp.alpha_mid), float(bl.gp.r_a), float(bl.gp.r_b)
    a = math.asin(HOOP_CAP)
    return a, HOOP_CAP * R, HOOP_CAP * R


def _hoop_start(bl: BuiltLayer, end: str) -> float:
    B = bl.spec.band_width
    lo, hi = bl.z_start + B / 2, bl.z_end - B / 2
    return lo if end == "A" else hi


class _Ctx:
    """Geometry of one transition: end-layer angles / turnaround radii and the pass specifications."""

    def __init__(self, b: Build, src: BuiltLayer, dst: BuiltLayer, spec: S.ContinuousSpec) -> None:
        self.surf = dst.base
        self.half = b.project.liner.cyl_length / 2
        self.R = R = float(self.surf.radius_at(0.0))
        lin = b.project.liner
        self.r_min = max(lin.boss_radius_a, lin.boss_radius_b) + dst.spec.band_width / 2
        self.step = math.radians(spec.max_angle_step)
        self.src_hoop, self.dst_hoop = src.spec.type == "hoop", dst.spec.type == "hoop"
        self.a0, self.rA0, self.rB0 = _ends(src, R)
        self.a1, self.rA1, self.rB1 = _ends(dst, R)

    def r_geo(self, a: float) -> float:
        return float(np.clip(self.R * math.sin(a), self.r_min, HOOP_CAP * self.R))

    def turn_radius(self, end: str, a_prev: float, a_next: float, k: int, m: int) -> float:
        """Near-geodesic turnaround for the mean angle, blending the end layers' deviation from geodesic."""
        a0, a1, R = self.a0, self.a1, self.R
        r0, r1 = (self.rA0, self.rA1) if end == "A" else (self.rB0, self.rB1)
        a = 0.5 * (a_prev + a_next)
        t = ((a - a0) / (a1 - a0)) if abs(a1 - a0) > 1e-9 else (k + 0.5) / max(m, 1)
        t = float(np.clip(t, 0.0, 1.0))
        dev = (1 - t) * (r0 - R * math.sin(a0)) + t * (r1 - R * math.sin(a1))
        return float(np.clip(R * math.sin(a) + dev, self.r_min, HOOP_CAP * self.R))

    def candidates(self, d0: int, m_start: int = 1):
        """(m, angles, dirs, start radii, end radii) for increasing pass counts m, first direction d0.

        The pass next to a helical layer turns at that layer's own radius, so its whole angle step shows up as
        deviation from the geodesic; every other leg turns at the mean-angle radius (half a step). End steps
        next to helical layers are therefore half the interior step, which evens out the slippage.
        """
        a0, a1, step = self.a0, self.a1, self.step
        src_hoop, dst_hoop = self.src_hoop, self.dst_hoop
        for m in range(max(m_start, 1 if (src_hoop or dst_hoop) else 2), MAX_PASSES + 1):
            dirs = [d0 * (-1) ** j for j in range(m)]
            if not dst_hoop and dirs[-1] != -1:
                continue  # a helical layer starts at end A: the last pass must arrive there
            npts = m + (0 if src_hoop else 1) + (0 if dst_hoop else 1)
            w = np.ones(max(npts - 1, 1))
            if not src_hoop:
                w[0] = 0.5
            if not dst_hoop:
                w[-1] = 0.5 if len(w) > 1 else w[-1]
            if abs(a1 - a0) / w.sum() > step + 1e-9:
                continue
            P = a0 + (a1 - a0) * np.concatenate([[0.0], np.cumsum(w)]) / w.sum()
            angles = [float(x) for x in P[(0 if src_hoop else 1): npts - (0 if dst_hoop else 1)]]
            # turnaround radii: turn j follows pass j (at the end it arrives at)
            ends_at = ["B" if d > 0 else "A" for d in dirs]
            radii = []
            for j in range(m):
                if j == m - 1:
                    radii.append(self.rA1 if not dst_hoop else self.r_geo(angles[j]))
                else:
                    radii.append(self.turn_radius(ends_at[j], angles[j], angles[j + 1], j, m))
            start_r = [self.rA0 if (j == 0 and not src_hoop) else (self.r_geo(angles[0]) if j == 0 else radii[j - 1])
                       for j in range(m)]
            yield m, angles, dirs, start_r, radii

    def solves(self, d0: int) -> list[tuple]:
        """non_geodesic argument tuples of the first candidate (what the planner will most likely need)."""
        for m, angles, dirs, start_r, radii in self.candidates(d0):
            return [(angles[j], start_r[j], radii[j]) if dirs[j] > 0 else (angles[j], radii[j], start_r[j])
                    for j in range(m)]
        return []


def _solve(args):
    surf, half, a, r_a, r_b = args
    try:
        return paths.non_geodesic(surf, half, a, r_a, r_b, dl=TRANSITION_DL)
    except GeometryError:
        return None


PARALLEL_MIN_SOLVES = 24


def _spawn_safe() -> bool:
    """Spawned workers re-import ``__main__``: only possible when it is a real file or module."""
    import os
    import sys

    main = sys.modules.get("__main__")
    f = getattr(main, "__file__", None)
    return getattr(main, "__spec__", None) is not None or (f is not None and os.path.exists(f))


def prefetch(b: Build, layers: list[BuiltLayer], spec: S.ContinuousSpec, workers: int | None = None) -> int:
    """Solve the transition passes the planner will most likely need in parallel processes and seed the path
    cache with them (the planner itself is sequential: each transition starts where the previous ended).
    Returns the number of passes solved."""
    import os
    from concurrent.futures import ProcessPoolExecutor
    from multiprocessing import get_context

    jobs: dict[tuple, tuple] = {}
    for src, dst in zip(layers, layers[1:]):
        if src.spec.type == "hoop" and dst.spec.type == "hoop":
            continue
        ctx = _Ctx(b, src, dst, spec)
        for d0 in ((1, -1) if ctx.src_hoop else (1,)):  # a hoop may end at either end
            for a, r_a, r_b in ctx.solves(d0):
                key = ("ng",) + paths._key(ctx.surf, ctx.half, a, r_a, r_b, TRANSITION_DL)
                if key not in paths._CACHE:
                    jobs[key] = (ctx.surf, ctx.half, a, r_a, r_b)
    workers = workers or min(os.cpu_count() or 1, 8)
    if len(jobs) < PARALLEL_MIN_SOLVES or workers < 2 or not _spawn_safe():
        return 0
    keys = list(jobs)
    try:
        with ProcessPoolExecutor(workers, mp_context=get_context("spawn")) as ex:
            for key, hp in zip(keys, ex.map(_solve, [jobs[k] for k in keys], chunksize=4)):
                if hp is not None:
                    paths._cache_put(key, hp)
    except Exception:  # no subprocesses available (sandbox, unguarded __main__ script): plan sequentially
        return 0
    return len(keys)


def _transition(b: Build, src: BuiltLayer, src_path: PathPoints, dst: BuiltLayer,
                spec: S.ContinuousSpec) -> tuple[Transition, PathPoints]:
    """Plan the transition from the end of ``src_path`` to the start of ``dst`` (both absolute azimuth)."""
    from .kinematics import _dedupe, layer_path

    surf = dst.base
    half = b.project.liner.cyl_length / 2
    R = float(surf.radius_at(0.0))
    mu = spec.slippage_margin * dst.spec.friction
    step = math.radians(spec.max_angle_step)
    Bw = dst.spec.band_width
    lin = b.project.liner
    r_min = max(lin.boss_radius_a, lin.boss_radius_b) + Bw / 2
    z_end, phi_end = float(src_path.z[-1]), float(src_path.phi[-1])
    src_end = "A" if z_end < 0 else "B"
    src_hoop, dst_hoop = src.spec.type == "hoop", dst.spec.type == "hoop"
    notes: list[str] = []

    def finish(builder: _Builder, kind, angles, max_slip, feasible, reverse=False):
        """Phase dwell, then the destination layer path shifted to continue the azimuth."""
        path = layer_path(b, dst, reverse=reverse)
        dwell = 0.0
        if dst_hoop:
            shift = builder.phi - path.phi[0]
        else:
            slot = 2 * math.pi / max(dst.pattern.n_bands if dst.pattern else 1, 1)
            dwell = (path.phi[0] - builder.phi) % slot
            jump = abs(builder.r - float(path.r[0])) > 0.3
            if jump and dwell < math.radians(20.0):  # spiral to a new turnaround radius: not too abruptly
                dwell += slot * math.ceil((math.radians(20.0) - dwell) / slot)
            s0 = float(path.s[0]) if path.s is not None else builder.s
            builder.dwell(dwell, float(path.z[0]), float(path.r[0]), s0,
                          slip=getattr(dst.gp, "dwell_slip_a", 0.0))
            shift = builder.phi - path.phi[0]
        path.phi = path.phi + shift
        tp = builder.path()
        T = Transition(src, dst, kind, _dedupe(tp) if len(tp.z) > 1 else tp, angles, max_slip, mu, dwell, feasible,
                       notes)
        return T, path

    # the previous layer's path lies on its base surface, but its last circuit is physically on top of its own
    # build-up: the transition starts at the same place on the surface it is wound on (the G-code joins the two
    # with a slow move) instead of tunnelling through the build-up
    bld = _Builder(*_onto(surf, half, z_end, float(src_path.r[-1])), phi=phi_end)

    # ---------------------------------------------------------------- hoop -> hoop
    if src_hoop and dst_hoop:
        z_to = _hoop_start(dst, src_end)
        dz = z_to - z_end
        if abs(dz) > 1e-6:
            revs = abs(dz) / dst.pitch
            n = max(int(math.ceil(revs * 36)), 2)
            z = z_end + dz * np.linspace(0, 1, n)
            bld.add(z[1:], surf.radius_at(z[1:]), (2 * math.pi * revs * np.linspace(0, 1, n))[1:],
                    np.full(n - 1, dst.angle), np.zeros(n - 1), _cyl_s(surf, z[1:]))
            bld.dwell(math.pi)
        return finish(bld, "hoop", [], 0.0, True, reverse=src_end == "B")

    ctx = _Ctx(b, src, dst, spec)
    a0, a1, rA0, rA1 = ctx.a0, ctx.a1, ctx.rA0, ctx.rA1
    d0 = 1 if (not src_hoop or src_end == "A") else -1
    ramp_lam = mu

    # ---------------------------------------------------------------- direct join
    if not src_hoop and not dst_hoop and abs(a1 - a0) <= step + 1e-9 and abs(rA1 - rA0) <= Bw + 1e-9:
        return finish(bld, "direct", [], 0.0, True)

    best = None
    m_next = 1
    while m_next <= MAX_PASSES:
        cand = next(ctx.candidates(d0, m_next), None)
        if cand is None:
            break
        m, angles, dirs, start_r, radii = cand
        m_next = m + 1
        pieces, slips = [], []
        r_prev = start_r[0]
        for j in range(m):
            used_start = j > 0 or not src_hoop
            used_end = j < m - 1 or not dst_hoop
            # a turnaround on the slope of an earlier build-up ridge needs much more friction: if the nominal
            # radius is too demanding, nudge it by a fraction of a band (the last turn of a helical is fixed)
            nudge = (0.0,) if (j == m - 1 and not dst_hoop) else (0.0, -0.25, 0.25, -0.5, 0.5)
            got = None
            for f in nudge:
                r_end = float(np.clip(radii[j] + f * Bw, ctx.r_min, HOOP_CAP * R))
                try:
                    arr, (sl_start, sl_end) = _pass(surf, half, angles[j], r_prev, r_end, dirs[j])
                except GeometryError:
                    continue
                sl = max(sl_start if used_start else 0.0, sl_end if used_end else 0.0)
                if got is None or sl < got[0]:
                    got = (sl, arr, r_end)
                if sl <= mu:
                    break
            if got is None:
                break
            slips.append(got[0])
            pieces.append(got[1])
            r_prev = got[2]
        if len(pieces) < m:
            continue
        max_slip = max(slips) if slips else 0.0
        if best is None or max_slip < best[0]:
            best = (max_slip, m, angles, dirs, pieces)
        if max_slip <= mu:
            break
        # slippage scales with the angle step (~1/m): jump close to the pass count that should suffice
        m_next = max(m + 1, int(math.ceil(m * max_slip / mu)))
    if best is None:
        notes.append("No transition path found; wind these layers separately (cut and restart)")
        return finish(bld, "passes", [], math.inf, False)
    max_slip, m, angles, dirs, pieces = best
    feasible = max_slip <= mu
    if not feasible:
        notes.append(f"Transition slippage {max_slip:.2f} exceeds {mu:.2f}; raise the friction/margin or "
                     "wind these layers separately")

    # ---------------------------------------------------------------- assemble
    a_h0, a_h1 = src.angle, dst.angle
    if not src_hoop:  # start exactly where the first pass leaves the turnaround
        bld.z, bld.r, bld.s = float(pieces[0][0][0]), float(pieces[0][1][0]), float(pieces[0][5][0])
    for j, arr in enumerate(pieces):
        d = dirs[j]
        z_, r_, ph_, al_, lm_, s_ = arr
        if j == 0 and src_hoop:
            dz, ph, al, lm = _ramp(R, a_h0, angles[0], ramp_lam)
            z_r = z_end + d * dz[-1]
            if abs(z_r) > half - 1.0:
                feasible = False
                notes.append(f"Cylinder too short for the {math.degrees(a_h0 - angles[0]):.0f} deg ramp out of "
                             f"the hoop ({dz[-1]:.0f} mm)")
            z = z_end + d * dz
            bld.add(z, surf.radius_at(z), ph, al, lm, _cyl_s(surf, z))
            p_cut = _phi_at(arr, z_r, half)
            z_, r_, ph_, al_, lm_, s_ = _cut(arr, d, z_r, "after")
            ph_ = ph_ - p_cut
        if j == m - 1 and dst_hoop:
            end = "A" if d < 0 else "B"
            z_S = _hoop_start(dst, end)
            dz, ph, al, lm = _ramp(R, angles[-1], a_h1, ramp_lam)
            z_c = z_S - d * dz[-1]
            if abs(z_c) > half - 1.0:
                feasible = False
                notes.append(f"Cylinder too short for the ramp into the hoop ({dz[-1]:.0f} mm)")
            p_cut = _phi_at((z_, r_, ph_, al_, lm_, s_), z_c, half)
            keep = d * (z_ - z_c) < 0
            phi0 = bld.phi
            bld.add(z_[keep], r_[keep], ph_[keep], al_[keep], lm_[keep], s_[keep])
            gap = p_cut - (bld.phi - phi0)
            z = z_c + d * dz
            bld.add(z, surf.radius_at(z), gap + ph, al, lm, _cyl_s(surf, z))
            bld.dwell(math.pi)  # hoop reversal locks the band
            return finish(bld, "hoop", angles, max_slip, feasible, reverse=end == "B")
        bld.add(z_, r_, ph_, al_, lm_, s_)
    return finish(bld, "passes", angles, max_slip, feasible)


def plan(b: Build, layers: list[BuiltLayer] | None = None, spec: S.ContinuousSpec | None = None,
         parallel: bool = True) -> Plan:
    """Continuous-winding plan: layer paths (hoops possibly reversed, azimuth continued) and transitions."""
    from .kinematics import layer_path

    layers = b.layers if layers is None else layers
    spec = spec or b.project.continuous
    if parallel:
        prefetch(b, layers, spec)
    segs: list[Segment] = []
    trans: list[Transition] = []
    prev: BuiltLayer | None = None
    prev_path: PathPoints | None = None
    for bl in layers:
        if prev is None:
            path = layer_path(b, bl)
        else:
            T, path = _transition(b, prev, prev_path, bl, spec)
            trans.append(T)
            segs.append(Segment("transition", bl, T.path, f"{prev.spec.id} -> {bl.spec.id}", T))
        segs.append(Segment("layer", bl, path, bl.spec.id))
        prev, prev_path = bl, path
    return Plan(segs, trans)


def to_schema(b: Build, p: Plan, max_points: int = 1500) -> S.ContinuousResult:
    from .kinematics import downsample

    out = []
    for T in p.transitions:
        pts = T.path.xyz() if len(T.path.z) else np.zeros((0, 3))
        idx = downsample(len(pts), max_points) if len(pts) else np.zeros(0, dtype=int)
        out.append(S.TransitionOut(
            from_layer=T.src.spec.id, to_layer=T.dst.spec.id, kind=T.kind,
            angle_from=math.degrees(T.src.angle), angle_to=math.degrees(T.dst.angle), passes=len(T.angles),
            angles=[round(math.degrees(a), 2) for a in T.angles],
            max_slippage=float(T.max_slip) if math.isfinite(T.max_slip) else 99.0, friction_limit=T.limit,
            fibre_length=T.length, fibre_mass=T.mass(), dwell=math.degrees(T.dwell), feasible=T.feasible,
            notes=T.notes, points=np.round(pts[idx], 3).tolist(),
        ))
    L = sum(t.fibre_length for t in out)
    notes = []
    if out:
        notes.append(f"{sum(t.passes for t in out)} transition passes, {L / 1000:.1f} m of fibre "
                     f"({sum(t.fibre_mass for t in out):.1f} g) not counted in the laminate")
    return S.ContinuousResult(transitions=out, total_passes=sum(t.passes for t in out), fibre_length=L,
                              fibre_mass=sum(t.fibre_mass for t in out), feasible=p.feasible, notes=notes)
