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

    def __init__(self, z: float, r: float, phi: float, s: float) -> None:
        self.parts: list[tuple] = []
        self.z, self.r, self.phi, self.s = z, r, phi, s

    def add(self, z, r, dphi, alpha, lam, s, dwell=False) -> None:
        z, r, dphi = np.asarray(z, float), np.asarray(r, float), np.asarray(dphi, float)
        alpha, lam, s = np.asarray(alpha, float), np.asarray(lam, float), np.asarray(s, float)
        # shared point (consecutive passes meet at a turnaround up to the shooting tolerance): merge it, a
        # sub-0.05 mm segment would have an arbitrary direction and throw the eye around
        if len(z) and math.sqrt((z[0] - self.z) ** 2 + (r[0] - self.r) ** 2 + (r[0] * dphi[0]) ** 2) < 0.05:
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

    def climb(self, z1: float, r1: float, s1: float) -> None:
        """Wrap onto the surface the next piece lies on (the previous layer's own build-up): a short spiral
        instead of a radial step with an undefined fibre direction."""
        gap = math.hypot(z1 - self.z, r1 - self.r)
        if gap > 0.05:
            self.dwell(math.radians(10.0 + 5.0 * gap), z1, r1, s1)

    def path(self) -> PathPoints:
        if not self.parts:
            e = np.empty(0)
            return PathPoints(e, e, e, [0], e, e, np.empty(0, dtype=bool), e)
        cat = [np.concatenate([p[i] for p in self.parts]) for i in range(7)]
        return PathPoints(cat[0], cat[1], cat[2], [0], cat[3], cat[4], cat[5], cat[6])


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
        hp = paths.non_geodesic(surf, half, a, r_from, r_to)
        arr = (hp.z, hp.r, hp.phi - hp.phi[0], hp.alpha, hp.lam, hp.s)
        return arr, (abs(hp.lam_a), abs(hp.lam_b))
    hp = paths.non_geodesic(surf, half, a, r_to, r_from)
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

    s_end = float(src_path.s[-1]) if src_path.s is not None else 0.0
    bld = _Builder(z_end, float(src_path.r[-1]), phi_end, s_end)

    # ---------------------------------------------------------------- hoop -> hoop
    if src_hoop and dst_hoop:
        bld.climb(z_end, float(surf.radius_at(z_end)), float(_cyl_s(surf, z_end)))
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

    a0, rA0, rB0 = _ends(src, R)
    a1, rA1, rB1 = _ends(dst, R)
    d0 = 1 if (not src_hoop or src_end == "A") else -1
    ramp_lam = mu

    def r_geo(a):
        return float(np.clip(R * math.sin(a), r_min, HOOP_CAP * R))

    def turn_radius(end: str, a_prev: float, a_next: float, k: int, m: int) -> float:
        """Near-geodesic turnaround for the mean angle, blending the end layers' deviation from geodesic."""
        r0, r1 = (rA0, rA1) if end == "A" else (rB0, rB1)
        a = 0.5 * (a_prev + a_next)
        t = ((a - a0) / (a1 - a0)) if abs(a1 - a0) > 1e-9 else (k + 0.5) / max(m, 1)
        t = float(np.clip(t, 0.0, 1.0))
        dev = (1 - t) * (r0 - R * math.sin(a0)) + t * (r1 - R * math.sin(a1))
        return float(np.clip(R * math.sin(a) + dev, r_min, HOOP_CAP * R))

    # ---------------------------------------------------------------- direct join
    if not src_hoop and not dst_hoop and abs(a1 - a0) <= step + 1e-9 and abs(rA1 - rA0) <= Bw + 1e-9:
        return finish(bld, "direct", [], 0.0, True)

    best = None
    # fewest passes that keep every angle step within the limit (points = passes + non-hoop end layers)
    n_int = max(int(math.ceil(abs(a1 - a0) / step - 1e-9)), 1)
    m_min = max(n_int + 1 - (0 if src_hoop else 1) - (0 if dst_hoop else 1), 1 if (src_hoop or dst_hoop) else 2)
    for m in range(m_min, MAX_PASSES + 1):
        dirs = [d0 * (-1) ** j for j in range(m)]
        if not dst_hoop and dirs[-1] != -1:
            continue  # a helical layer starts at end A: the last pass must arrive there
        npts = m + (0 if src_hoop else 1) + (0 if dst_hoop else 1)
        if npts >= 2 and abs(a1 - a0) / (npts - 1) > step + 1e-9:
            continue
        P = np.linspace(a0, a1, npts)
        angles = list(P[(0 if src_hoop else 1): npts - (0 if dst_hoop else 1)])
        # turnaround radii: turn j follows pass j (at the end it arrives at)
        ends_at = ["B" if d > 0 else "A" for d in dirs]
        radii = []
        for j in range(m):
            if j == m - 1:
                radii.append(rA1 if not dst_hoop else r_geo(angles[j]))
            else:
                radii.append(turn_radius(ends_at[j], angles[j], angles[j + 1], j, m))
        start_r = [rA0 if (j == 0 and not src_hoop) else (r_geo(angles[0]) if j == 0 else radii[j - 1])
                   for j in range(m)]
        try:
            pieces, slips = [], []
            for j in range(m):
                arr, (sl_start, sl_end) = _pass(surf, half, angles[j], start_r[j], radii[j], dirs[j])
                used_start = j > 0 or not src_hoop
                used_end = j < m - 1 or not dst_hoop
                slips.append(max(sl_start if used_start else 0.0, sl_end if used_end else 0.0))
                pieces.append(arr)
        except GeometryError:
            continue
        max_slip = max(slips) if slips else 0.0
        cand = (max_slip, m, angles, dirs, pieces)
        if best is None or max_slip < best[0]:
            best = cand
        if max_slip <= mu:
            break
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
    if src_hoop:
        bld.climb(z_end, float(surf.radius_at(z_end)), float(_cyl_s(surf, z_end)))
    else:
        bld.climb(float(pieces[0][0][0]), float(pieces[0][1][0]), float(pieces[0][5][0]))
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


def plan(b: Build, layers: list[BuiltLayer] | None = None, spec: S.ContinuousSpec | None = None) -> Plan:
    """Continuous-winding plan: layer paths (hoops possibly reversed, azimuth continued) and transitions."""
    from .kinematics import layer_path

    layers = b.layers if layers is None else layers
    spec = spec or b.project.continuous
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
