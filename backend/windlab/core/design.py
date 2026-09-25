"""Design orchestration: layer build-up, structural analysis, checks, sizing."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .. import schemas as S
from . import patterns as pat
from .geometry import GeometryError, Profile, clean_offset, liner_profiles
from .materials import Fiber, Ply, band_thickness, get_fiber, get_liner, get_resin, ply_properties
from .structural import (
    Liner,
    PlyGroup,
    Vessel,
    burst,
    first_yield_pressure,
    liner_fatigue_cycles,
    reverse_yield_ratio,
    run_history,
    von_mises,
)
from . import paths
from .paths import HelicalPass

REVERSE_YIELD_LIMIT = 0.9  # Bauschinger knock-down on the compressive reverse-yield check
AF_FIBER_RATIO_LIMIT = 0.75  # max fibre strain ratio allowed during autofrettage
BRIDGE_GAP = 0.05  # mm: fibre lift-off over concave surface worth reporting


class DesignError(ValueError):
    pass


@dataclass
class BuiltLayer:
    spec: S.Layer
    index: int
    base: Profile
    top: Profile
    thickness: np.ndarray
    t_cyl: float
    t_band: float
    angle: float  # rad at mid-plane
    R_mid: float  # radius at mid-plane of the base surface
    r0: Optional[float] = None
    gp: Optional[HelicalPass] = None
    pattern: Optional[pat.Pattern] = None
    candidates: list[pat.Pattern] = field(default_factory=list)
    z_start: float = 0.0
    z_end: float = 0.0
    warnings: list[str] = field(default_factory=list)
    ply: Optional[Ply] = None  # this layer's ply properties (fibre override aware)
    fiber: Optional[Fiber] = None

    @property
    def pitch(self) -> float:
        return self.spec.band_width * (1.0 - self.spec.overlap)

    @property
    def circuits(self) -> int:
        if self.spec.type == "helical":
            return self.pattern.n_bands if self.pattern else 0
        return self.spec.passes

    def fiber_path_length(self) -> float:
        """Band centre-line length [mm]."""
        if self.spec.type == "helical":
            assert self.gp is not None and self.pattern is not None
            per_circuit = 2 * self.gp.length + 2 * self.pattern.dwell * self.gp.r0
            return self.pattern.n_bands * per_circuit
        length = self.z_end - self.z_start - self.spec.band_width
        revs = max(length, 0.0) / self.pitch
        rev_len = 2 * math.pi * self.R_mid
        return self.spec.passes * (revs * math.hypot(rev_len, self.pitch) + 0.5 * rev_len)


@dataclass
class Build:
    project: S.Project
    liner_outer: Profile
    liner_inner: Profile
    fiber: Fiber
    ply: Ply
    layers: list[BuiltLayer]
    tension: Optional[dict] = None  # layer index -> (winding stress, residual, loss)
    path_errors: dict = field(default_factory=dict)  # layer id -> reason its requested path failed

    @property
    def outer(self) -> Profile:
        return self.layers[-1].top if self.layers else self.liner_outer


def build(project: S.Project) -> Build:
    lin = project.liner
    try:
        outer, inner = liner_profiles(lin)
    except GeometryError as e:
        raise DesignError(str(e)) from e
    comp = project.composite
    lib = project.materials
    fiber = get_fiber(comp.fiber, lib)
    resin = get_resin(comp.resin, lib)
    ply = ply_properties(fiber, resin, comp.fiber_volume_fraction, comp.translation_efficiency)
    half = lin.cyl_length / 2.0

    layers: list[BuiltLayer] = []
    path_errors: dict[str, str] = {}
    surf = outer
    for i, L in enumerate(project.layers):
        fiber_L = get_fiber(L.fiber, lib) if L.fiber else fiber
        ply_L = ply if fiber_L is fiber else ply_properties(fiber_L, resin, comp.fiber_volume_fraction,
                                                            comp.translation_efficiency)
        t_b = band_thickness(fiber_L, L.tows, L.band_width, comp.fiber_volume_fraction)
        R_mid = float(surf.radius_at(0.0))
        warnings: list[str] = []
        if L.type == "helical":
            off_b = L.turnaround_offset if L.turnaround_offset_b is None else L.turnaround_offset_b
            r_a = lin.boss_radius_a + L.band_width / 2 + L.turnaround_offset
            r_b = lin.boss_radius_b + L.band_width / 2 + off_b
            if max(r_a, r_b) >= 0.95 * R_mid:
                raise DesignError(f"Layer {i + 1}: turnaround radius {max(r_a, r_b):.1f} mm too close to the "
                                  "cylinder radius")
            try:
                if L.winding == "geodesic":
                    r0 = max(r_a, r_b)
                    gp = paths.geodesic(surf, r0)
                    if abs(r_a - r_b) > 1e-6:
                        warnings.append(f"Geodesic path turns at {r0:.1f} mm at both ends; use non-geodesic "
                                        "winding to turn closer to the smaller boss")
                else:
                    a_mid = math.radians(L.angle) if L.angle else None
                    try:
                        gp = paths.non_geodesic(surf, half, a_mid, r_a, r_b)
                    except GeometryError as e:
                        # keep the analysis alive: fall back to a geodesic path and flag the layer
                        gp = paths.geodesic(surf, max(r_a, r_b))
                        path_errors[L.id] = str(e)
                        warnings.append(f"Non-geodesic path not feasible ({e}); showing a geodesic path instead")
                    r0 = gp.r0
            except GeometryError as e:
                raise DesignError(f"Layer {i + 1}: {e}") from e
            angle = gp.alpha_mid
            cands = pat.candidates(gp.advance, R_mid, angle, L.band_width, math.radians(L.dwell_max))
            if L.pattern is not None:
                try:
                    chosen = pat.evaluate(gp.advance, R_mid, angle, L.band_width, L.pattern.n_bands, L.pattern.shift)
                except ValueError as e:
                    raise DesignError(f"Layer {i + 1}: {e}") from e
                if chosen.coverage < 0.999:
                    warnings.append(f"Pattern leaves gaps: coverage {chosen.coverage * 100:.1f}%")
                if chosen.dwell > math.radians(L.dwell_max) + 1e-9:
                    warnings.append(f"Dwell {math.degrees(chosen.dwell):.1f} deg exceeds the limit")
            elif cands:
                chosen = cands[0]
            else:
                wide = pat.candidates(gp.advance, R_mid, angle, L.band_width, math.pi, max_overlap=0.3)
                if not wide:
                    raise DesignError(f"Layer {i + 1}: no closing pattern found")
                chosen = wide[0]
                warnings.append("No pattern within the dwell limit; using the best available")
            t_cyl = L.thickness_override or 2 * t_b * chosen.coverage
            t = gp.thickness(surf, t_cyl, R_mid, L.band_width)
            bl = BuiltLayer(L, i, surf, clean_offset(surf.offset(t), half), t, t_cyl, t_b, angle, R_mid, r0, gp, chosen, cands,
                            float(surf.z[0]), float(surf.z[-1]), warnings)
        else:
            z_s, z_e = -half + L.end_offset_a, half - L.end_offset_b
            if z_e - z_s < 2 * L.band_width:
                raise DesignError(f"Layer {i + 1}: hoop length is shorter than two band widths")
            t_h = L.thickness_override or L.passes * t_b / (1.0 - L.overlap)
            n = surf.normals()
            edge = np.minimum(surf.z - z_s, z_e - surf.z)
            t = t_h * np.clip(0.5 + edge / L.band_width, 0.0, 1.0) * (np.abs(n[:, 1]) > 0.9)
            angle = math.atan2(2 * math.pi * R_mid, L.band_width * (1.0 - L.overlap))
            bl = BuiltLayer(L, i, surf, clean_offset(surf.offset(t), half), t, t_h, t_b, angle, R_mid, z_start=z_s, z_end=z_e,
                            warnings=warnings)
        bl.ply, bl.fiber = ply_L, fiber_L
        layers.append(bl)
        surf = bl.top
    return Build(project, outer, inner, fiber, ply, layers, path_errors=path_errors)


# --------------------------------------------------------------------------- structural
def _vessel(b: Build) -> Vessel:
    lin = b.project.liner
    mat = get_liner(lin.material, b.project.materials)
    liner = Liner(mat, lin.wall_thickness, lin.radius - lin.wall_thickness / 2)
    groups = [
        PlyGroup(bl.spec.type, bl.angle, bl.t_cyl, bl.R_mid + bl.t_cyl / 2, bl.ply)
        for bl in b.layers
    ]
    return Vessel(liner, groups, lin.radius - lin.wall_thickness)


def autofrettage_window(v: Vessel, proof: float, p_burst_est: float) -> tuple[float, float]:
    p_lo = max(proof, 1.05 * first_yield_pressure(v))
    # highest pressure that unloads without compressive reverse yielding
    lo, hi = 0.0, max(p_burst_est, p_lo) * 1.2
    for _ in range(22):  # ~1e-6 relative: far below the other model uncertainties
        mid = 0.5 * (lo + hi)
        if reverse_yield_ratio(v, mid) <= REVERSE_YIELD_LIMIT:
            lo = mid
        else:
            hi = mid
    p_hi = lo
    # fibres must not be over-strained during autofrettage
    p_hi = min(p_hi, AF_FIBER_RATIO_LIMIT * p_burst_est)
    return p_lo, p_hi


def _load_point(v: Vessel, phase: str, st) -> S.LoadPoint:
    return S.LoadPoint(
        phase=phase,
        pressure=st.p,
        liner_axial=float(st.liner_sigma[0]),
        liner_hoop=float(st.liner_sigma[1]),
        liner_vm=von_mises(st.liner_sigma),
        fiber_hoop=v.fiber_stress(st.eps, "hoop"),
        fiber_helical=v.fiber_stress(st.eps, "helical"),
        strain_axial=float(st.eps[0]),
        strain_hoop=float(st.eps[1]),
    )


def netting_thickness(b: Build, p: float) -> tuple[float, float]:
    lin = b.project.liner
    mat = get_liner(lin.material, b.project.materials)
    Ri = lin.radius - lin.wall_thickness
    X = b.ply.E1 * b.ply.eps1_ult
    hel = [bl for bl in b.layers if bl.spec.type == "helical"]
    boss = max(lin.boss_radius_a, lin.boss_radius_b)
    if hel:
        a = float(np.mean([bl.angle for bl in hel]))
    else:
        a = math.asin(min((boss + 3.0) / lin.radius, 0.9))
    t_l = lin.wall_thickness
    t_hel = max(0.0, (p * Ri / 2 - t_l * mat.yield_ / 2) / (X * math.cos(a) ** 2))
    t_hoop = max(0.0, (p * Ri - t_l * mat.yield_) / X - t_hel * math.sin(a) ** 2)
    return t_hoop, t_hel


def dome_netting_stress(b: Build, p: float) -> tuple[np.ndarray, np.ndarray]:
    """Helical ply stress from meridional netting equilibrium along the vessel."""
    base = b.liner_outer
    u = np.abs(base.tangents()[:, 0])
    denom = np.zeros_like(base.r)
    r_excl = 0.0
    for bl in b.layers:
        if bl.spec.type != "helical":
            continue
        cos2 = np.cos(bl.gp.alpha_at_s(bl.base.s)) ** 2
        denom += bl.thickness * cos2
        # netting is meaningless inside the turnaround bands (boss and liner carry load there)
        r_excl = max(r_excl, max(bl.gp.r_a, bl.gp.r_b) + 2 * bl.spec.band_width)
    valid = (denom > 1e-6) & (base.r > r_excl) & (u > 0.05)
    sig = np.where(valid, p * base.r / (2 * np.maximum(u, 1e-9) * np.maximum(denom, 1e-12)), np.nan)
    return base.z[valid], sig[valid]


def structural(b: Build) -> tuple[S.StructuralResult, dict]:
    req = b.project.requirements
    v = _vessel(b)
    if not b.layers:
        raise DesignError("No layers")
    proof = req.meop * req.proof_factor
    p_req = req.meop * req.burst_factor
    # elastic-only burst estimate for window sizing
    T_cure = b.project.composite.cure_temperature
    cure = v.cool(req.temperature_ref - T_cure)
    pb_est, _, _ = burst(v, v.initial(), p_req)
    p_lo, p_hi = autofrettage_window(v, proof, pb_est)
    auto = req.autofrettage_pressure is None
    if auto:
        p_af = p_lo + 0.75 * (p_hi - p_lo) if p_hi > p_lo else p_lo
    else:
        p_af = float(req.autofrettage_pressure)

    hist = run_history(v, p_af, proof, req.meop)
    pts = [_load_point(v, h.phase, h.state) for h in hist]
    phases = [h.phase for h in hist]
    i_af_end = phases.index("proof") - 1
    i_proof = max(i for i, ph in enumerate(phases) if ph == "proof")
    i_meop = max(i for i, ph in enumerate(phases) if ph == "meop")
    residual_state = hist[i_af_end].state
    meop_state = hist[i_meop].state
    # fibres may already fail during the pressure history (autofrettage above the burst capacity)
    pb = mode = None
    for h0, h1 in zip(hist[:-1], hist[1:]):
        r0 = max(v.fiber_ratio(h0.state.eps).values())
        r1s = v.fiber_ratio(h1.state.eps)
        m1, r1 = max(r1s.items(), key=lambda kv: kv[1])
        if r1 >= 1.0 > r0 and h1.state.p > h0.state.p:
            pb = h0.state.p + (1.0 - r0) / (r1 - r0) * (h1.state.p - h0.state.p)
            mode = m1
            break
    if pb is None:
        pb, mode, _ = burst(v, hist[-1].state, pb_est)
    ratios = v.fiber_ratio(meop_state.eps)
    mat = get_liner(b.project.liner.material, b.project.materials)
    # MEOP at the operating temperature extremes (elastic reload from the final state)
    fin = hist[-1].state
    temp_pts, sr_worst, liner_temp, temp_plastic = {}, max(ratios.values()), 0.0, 0.0
    for key, T in (("cold", req.temperature_min), ("hot", req.temperature_max)):
        dT = T - T_cure
        s_T = v.solve(req.meop, fin.liner, fin.eps, dT)
        saved, v.dT = v.dT, dT
        temp_pts[key] = _load_point(v, f"meop_{key}", s_T)
        sr_worst = max(sr_worst, max(v.fiber_ratio(s_T.eps).values()))
        liner_temp = max(liner_temp, von_mises(s_T.liner_sigma) / v.liner.yield_stress(fin.liner))
        temp_plastic = max(temp_plastic, s_T.liner.alpha - fin.liner.alpha)
        z0 = v.solve(0.0, fin.liner, fin.eps, dT)  # unpressurised at T: reverse yield in the cold
        liner_temp = max(liner_temp, von_mises(z0.liner_sigma) / v.liner.yield_stress(fin.liner))
        temp_plastic = max(temp_plastic, z0.liner.alpha - fin.liner.alpha)
        v.dT = saved
    cycles = liner_fatigue_cycles(mat, hist[-1].state.liner_sigma, meop_state.liner_sigma)
    t_hoop, t_hel = netting_thickness(b, p_req)
    dz, ds = dome_netting_stress(b, req.meop)
    # volumetric expansion (cylinder strain field applied to the internal volume; domes are stiffer, so this
    # slightly over-predicts the total; water-jacket targets should be confirmed on the first articles)
    V = b.liner_inner.volume() / 1000.0  # mL
    ev = lambda st_: 2 * (st_.eps[1] - v.initial().eps[1]) + (st_.eps[0] - v.initial().eps[0])  # noqa: E731
    i_af_peak = phases.index("unload") - 1
    exp = dict(
        expansion_af_total=V * ev(hist[i_af_peak].state),
        expansion_af_permanent=V * ev(residual_state),
        expansion_proof_total=V * (ev(hist[i_proof].state) - ev(residual_state)),  # water jacket: from post-AF
        expansion_proof_permanent=V * (ev(hist[max(i for i in range(i_proof, i_meop) if phases[i] == "unload")].state)
                                       - ev(residual_state)),
    )
    exp = {k: (0.0 if abs(v_) < 1e-6 else v_) for k, v_ in exp.items()}
    res = S.StructuralResult(
        **exp,
        autofrettage_pressure=p_af,
        autofrettage_auto=auto,
        autofrettage_window=(p_lo, p_hi),
        history=pts,
        residual=pts[i_af_end],
        at_meop=pts[i_meop],
        at_proof=pts[i_proof],
        cure_residual=_load_point(v, "cure", cure[-1]) if cure else None,
        meop_cold=temp_pts["cold"],
        meop_hot=temp_pts["hot"],
        stress_ratio_worst=sr_worst,
        burst_pressure=pb,
        burst_mode=mode,
        required_burst=p_req,
        stress_ratio_hoop=ratios.get("hoop", 0.0),
        stress_ratio_helical=ratios.get("helical", 0.0),
        fiber_strength=b.ply.fiber_strength,
        liner_fatigue_cycles=cycles,
        netting_hoop_thickness=t_hoop,
        netting_helical_thickness=t_hel,
        dome_fiber_stress=S.Curve(x=dz.tolist(), y=ds.tolist()),
    )
    extra = {
        "helical_ratio_at_burst": v.fiber_ratio(_burst_state(v, hist[-1].state, pb).eps).get("helical", 0.0),
        "reverse_yield_ratio": von_mises(residual_state.liner_sigma) / mat.yield_,
        "meop_yield_ratio": von_mises(meop_state.liner_sigma) / (mat.yield_ + v.liner.H * meop_state.liner.alpha),
        "proof_plastic": hist[i_proof].state.liner.alpha - residual_state.liner.alpha,
        "af_fiber_ratio": max(v.fiber_ratio(hist[phases.index("unload") - 1].state.eps).values()),
        "liner_temp_ratio": liner_temp,
        "liner_temp_plastic": temp_plastic,
        "cyl_helical_stress": _cyl_value(dz, ds),
        "dome_helical_stress": _dome_max(b, dz, ds),
    }
    return res, extra


def _burst_state(v: Vessel, st, p: float):
    return v.solve(p, st.liner, st.eps)


def _cyl_value(z: np.ndarray, s: np.ndarray) -> float:
    if len(z) == 0:
        return float("nan")
    return float(np.interp(0.0, z, s))


def _dome_max(b: Build, z: np.ndarray, s: np.ndarray) -> float:
    half = b.project.liner.cyl_length / 2
    m = np.abs(z) > half + 1.0
    return float(np.nanmax(s[m])) if np.any(m) else float("nan")


# --------------------------------------------------------------------------- mass & checks
def mass(b: Build, p_burst: float) -> S.MassResult:
    lin = b.project.liner
    mat = get_liner(lin.material, b.project.materials)
    liner_g = (b.liner_outer.volume() - b.liner_inner.volume()) * mat.density / 1000.0
    Vf = b.project.composite.fiber_volume_fraction
    resin = get_resin(b.project.composite.resin, b.project.materials)
    vols = [(bl.base.shell_volume(bl.thickness), bl.fiber or b.fiber) for bl in b.layers]  # mm3
    fiber_g = sum(v * Vf * f.density for v, f in vols) / 1000.0
    resin_g = sum(v for v, _ in vols) * (1 - Vf) * resin.density / 1000.0
    total = liner_g + fiber_g + resin_g
    vol_l = b.liner_inner.volume() / 1e6
    pvw = p_burst * 1e6 * vol_l * 1e-3 / (total / 1000.0 * 9.80665) / 1000.0 if total > 0 else 0.0
    return S.MassResult(liner=liner_g, fiber=fiber_g, resin=resin_g, total=total, volume=vol_l, pv_w=pvw)


def _chk(id_, label, ok, warn=False, value=None, limit=None, unit="", detail="", refs=None) -> S.Check:
    status = "ok" if ok else ("warn" if warn else "fail")
    return S.Check(id=id_, label=label, status=status, value=value, limit=limit, unit=unit, detail=detail,
                   refs=refs or [])


def checks(b: Build, st: Optional[S.StructuralResult], extra: dict) -> list[S.Check]:
    req = b.project.requirements
    out: list[S.Check] = []
    lin = b.project.liner
    if lin.boss_radius_a != lin.boss_radius_b:
        out.append(S.Check(id="geo.boss", label="Unequal polar openings", status="info",
                           detail="Geodesic paths use one turnaround radius, set by the larger boss."))
    for bl in b.layers:
        for w in bl.warnings:
            if w.startswith("Non-geodesic path not feasible"):
                continue
            out.append(S.Check(id=f"layer.{bl.spec.id}", label=f"Layer {bl.index + 1}", status="warn", detail=w,
                               refs=[bl.spec.id]))
    for bl in b.layers:
        if bl.spec.id in b.path_errors:
            out.append(S.Check(id=f"layer.{bl.spec.id}.path", label=f"Layer {bl.index + 1} path", status="fail",
                               detail=b.path_errors[bl.spec.id], refs=[bl.spec.id]))
            continue
        if bl.gp is None or bl.spec.winding != "non-geodesic":
            continue
        lam = max(abs(bl.gp.lam_a), abs(bl.gp.lam_b))
        mu = bl.spec.friction
        out.append(_chk(f"layer.{bl.spec.id}.slip", f"Layer {bl.index + 1} slippage", lam <= mu,
                        warn=lam <= 1.25 * mu, value=lam, limit=mu, refs=[bl.spec.id],
                        detail="Required |kg/kn| on the domes vs. available friction; above it the fibre slides"))
    if st is None:
        out.append(S.Check(id="layup.empty", label="Layup", status="fail", detail="Add layers or use Suggest layup"))
        return out
    out.append(_chk("burst", "Burst pressure", st.burst_pressure >= st.required_burst,
                    value=st.burst_pressure, limit=st.required_burst, unit="MPa",
                    detail=f"First failure: {st.burst_mode} fibres"))
    has_hoop = any(bl.spec.type == "hoop" for bl in b.layers)
    out.append(_chk("burst.mode", "Hoop-first failure", st.burst_mode == "hoop" or not has_hoop, warn=True,
                    detail="A hoop-dominated burst in the cylinder is the preferred, predictable failure mode."))
    hr = extra.get("helical_ratio_at_burst", 0.0)
    if st.burst_mode == "hoop":
        out.append(_chk("burst.balance", "Helical reserve at burst", hr < 0.95, warn=True, value=hr, limit=0.95,
                        detail="Helical fibre strain / allowable when the hoops fail; >0.95 risks a dome burst."))
    lim = req.stress_ratio_limit
    out.append(_chk("sr.hoop", "Stress ratio hoop @MEOP", st.stress_ratio_hoop <= lim,
                    value=st.stress_ratio_hoop, limit=lim, detail="Fibre stress / delivered strength (stress rupture)"))
    out.append(_chk("sr.helical", "Stress ratio helical @MEOP", st.stress_ratio_helical <= lim,
                    value=st.stress_ratio_helical, limit=lim))
    out.append(_chk("sr.temp", "Stress ratio over temperature range", st.stress_ratio_worst <= lim,
                    value=st.stress_ratio_worst, limit=lim,
                    detail=f"MEOP at {req.temperature_min:g} to {req.temperature_max:g} degC incl. cure residual "
                           "stresses"))
    out.append(_chk("liner.temp", "Liner elastic over temperature range", extra["liner_temp_plastic"] <= 1e-7,
                    value=extra["liner_temp_ratio"], limit=1.0,
                    detail="Liner von Mises / yield at 0 and MEOP, at the minimum and maximum temperature"))
    # leak-before-burst: a through-wall liner crack of length 2t must be stable at MEOP (all temperatures)
    lmat = get_liner(b.project.liner.material, b.project.materials)
    sig = max(st.at_meop.liner_hoop, (st.meop_cold.liner_hoop if st.meop_cold else 0.0),
              (st.meop_hot.liner_hoop if st.meop_hot else 0.0), 0.0)
    K = sig * math.sqrt(math.pi * b.project.liner.wall_thickness * 1e-3)
    out.append(_chk("liner.lbb", "Leak-before-burst (liner)", K <= lmat.k_ic, value=K / lmat.k_ic, limit=1.0,
                    detail=f"Through crack 2t = {2 * b.project.liner.wall_thickness:g} mm at MEOP hoop stress "
                           f"{sig:.0f} MPa: K = {K:.1f} vs K_Ic {lmat.k_ic:g} MPa*sqrt(m) (overwrap restraint "
                           "ignored: conservative)"))
    p_lo, p_hi = st.autofrettage_window
    out.append(_chk("af.window", "Autofrettage window", p_hi >= p_lo, value=st.autofrettage_pressure,
                    unit="MPa", detail=f"Feasible range {p_lo:.1f} - {p_hi:.1f} MPa"))
    out.append(_chk("af.reverse", "No reverse yield after autofrettage",
                    extra["reverse_yield_ratio"] <= REVERSE_YIELD_LIMIT + 1e-6,
                    value=extra["reverse_yield_ratio"], limit=REVERSE_YIELD_LIMIT,
                    detail="Residual liner von Mises / yield (0.9 allows for the Bauschinger effect)"))
    out.append(_chk("af.fiber", "Fibre strain during autofrettage", extra["af_fiber_ratio"] <= AF_FIBER_RATIO_LIMIT,
                    warn=extra["af_fiber_ratio"] < 1.0, value=extra["af_fiber_ratio"], limit=AF_FIBER_RATIO_LIMIT,
                    detail="Fibres would fail during autofrettage" if extra["af_fiber_ratio"] >= 1.0 else ""))
    out.append(_chk("liner.meop", "Liner elastic at MEOP", extra["meop_yield_ratio"] <= 1.0 + 1e-6,
                    value=extra["meop_yield_ratio"], limit=1.0))
    out.append(_chk("liner.proof", "Liner elastic at proof", extra["proof_plastic"] <= 1e-6, warn=True,
                    detail="Proof below the autofrettage pressure keeps the liner elastic."))
    need = req.design_cycles * req.fatigue_scatter_factor
    out.append(_chk("fatigue", "Liner fatigue life", st.liner_fatigue_cycles >= need,
                    value=st.liner_fatigue_cycles, limit=need, unit="cycles",
                    detail="SWT estimate with indicative S-N data; confirm by test."))
    tr = extra.get("tension")
    if tr is not None and len(tr.loss):
        worst = int(np.argmax(tr.loss))
        out.append(_chk("tension.loss", "Winding prestress retained", tr.loss[worst] <= 0.6, warn=tr.residual_stress[worst] > 0,
                        value=float(tr.loss[worst]), limit=0.6, refs=[b.layers[worst].spec.id],
                        detail=(f"Layer {worst + 1} loses {tr.loss[worst] * 100:.0f}% of its winding prestress as later "
                                "layers compress it (slack inner layers wrinkle). Use the tension schedule.")
                        if tr.loss[worst] > 0.6 else
                        f"Largest loss {tr.loss[worst] * 100:.0f}% (layer {worst + 1}); inner layers keep their prestress."))
    bridging = [(bl, normal_curvature(bl)) for bl in b.layers if bl.gp is not None]
    bridging = [(bl, kn) for bl, kn in bridging if kn[2] > BRIDGE_GAP]
    if bridging:
        worst = max(bridging, key=lambda x: x[1][2])
        names = ", ".join(str(bl.index + 1) for bl, _ in bridging)
        out.append(S.Check(id="layup.bridging", label="Fibre bridging", status="warn", value=worst[1][2], unit="mm",
                           limit=BRIDGE_GAP, refs=[bl.spec.id for bl, _ in bridging],
                           detail=f"Layers {names} cross concave surface near their turnarounds or drop-offs and "
                                  f"lift off it (largest gap about {worst[1][2]:.2f} mm under layer "
                                  f"{worst[0].index + 1}). Adjust turnaround offsets so turnarounds do not land "
                                  "just inside earlier build-up ridges, or taper hoop drop-offs."))
    fe = extra.get("fe")
    if fe is not None:
        half = b.project.liner.cyl_length / 2
        where = "cylinder" if abs(fe.critical_z) < half else ("dome B" if fe.critical_z > 0 else "dome A")
        out.append(_chk("fe.burst", "Burst incl. domes (FE)", fe.dome_burst >= st.required_burst,
                        value=fe.dome_burst, limit=st.required_burst, unit="MPa",
                        detail=f"Critical: layer {fe.critical_layer} in the {where} (z = {fe.critical_z:.0f} mm). "
                               "Cylinder burst scaled by the FE fibre strain distribution."))
        out.append(_chk("fe.liner", "Liner fatigue hot spot (FE)", fe.liner_hotspot_cycles >= need,
                        value=fe.liner_hotspot_cycles, limit=need, unit="cycles",
                        detail=f"Liner stress range {fe.liner_hotspot_factor:.2f}x the cylinder value at "
                               f"z = {fe.liner_hotspot_z:.0f} mm (bending at dome/boss transitions)."))
    cyl, dome = extra["cyl_helical_stress"], extra["dome_helical_stress"]
    if np.isfinite(cyl) and np.isfinite(dome) and cyl > 0:
        ratio = dome / cyl
        out.append(_chk("dome.netting", "Dome / cylinder helical stress", ratio <= 1.1, warn=True, value=ratio,
                        limit=1.1, detail="Netting estimate; >1 means the dome is the critical helical zone."))
    return out


def analyze(project: S.Project) -> S.AnalysisResult:
    b = build(project)
    st: Optional[S.StructuralResult] = None
    extra: dict = {}
    if b.layers:
        from . import tension

        tr = tension.analyse(b)
        b.tension = {i: (float(tr.winding_stress[i]), float(tr.residual_stress[i]), float(tr.loss[i]))
                      for i in range(len(b.layers))}
        extra["tension"] = tr
    if b.layers:
        st, st_extra = structural(b)
        extra.update(st_extra)
    layer_results = [layer_result(b, bl) for bl in b.layers]
    fe = None
    if st is not None:
        fe = fe_result(b, st)
        extra["fe"] = fe
    m = mass(b, st.burst_pressure if st else 0.0)
    return S.AnalysisResult(
        liner_outer=S.Curve(x=b.liner_outer.z.tolist(), y=b.liner_outer.r.tolist()),
        liner_inner=S.Curve(x=b.liner_inner.z.tolist(), y=b.liner_inner.r.tolist()),
        layers=layer_results,
        structural=st,
        fe=fe,
        mass=m,
        checks=checks(b, st, extra),
    )


def fe_result(b: Build, st: S.StructuralResult) -> S.FEResult:
    from . import shellfe

    ev = shellfe.evaluate(b, b.project.requirements.meop, st.burst_pressure, st.liner_fatigue_cycles)
    sol = ev.sol
    rnd = lambda a: np.round(np.asarray(a, dtype=float), 5).tolist()  # noqa: E731
    ratio = [[None if not np.isfinite(v) else round(float(v), 5) for v in row] for row in ev.fiber_ratio]
    fr = np.where(np.isnan(ev.fiber_ratio), -np.inf, ev.fiber_ratio)
    peak = np.maximum(fr.max(axis=0), 0.0) if len(b.layers) else np.zeros(len(sol.z))
    return S.FEResult(
        z=rnd(sol.z), r=rnd(sol.r), liner_vm_inner=rnd(ev.liner_vm_inner), liner_vm_outer=rnd(ev.liner_vm_outer),
        fiber_ratio=ratio, fiber_ratio_max=rnd(peak), node_z=rnd(sol.node_z), node_r=rnd(sol.node_r),
        radial_displacement=rnd(sol.Ur), axial_displacement=rnd(sol.Uz),
        valid=[bool(x) for x in ev.valid], fiber_ratio_ref=ev.fiber_ref, liner_vm_ref=ev.liner_ref,
        dome_burst=ev.dome_burst, critical_z=ev.critical_z,
        critical_layer=b.layers[ev.critical_layer].spec.id if ev.critical_layer >= 0 else None,
        liner_hotspot_factor=ev.hotspot_factor, liner_hotspot_z=ev.hotspot_z,
        liner_hotspot_cycles=ev.hotspot_cycles,
    )


def normal_curvature(bl: BuiltLayer) -> tuple[float, float, float]:
    """Fibre normal curvature along one pass.

    Returns (min kn [1/mm], path length with kn < 0 [mm], largest bridging gap [mm]). Over a concave
    stretch of length L the tensioned fibre spans a chord and leaves a gap of about |kn| L^2 / 8.
    """
    if bl.gp is None:
        return 1.0 / max(bl.R_mid, 1e-9), 0.0, 0.0
    tab = paths.SurfaceTable(bl.base)
    gp = bl.gp
    v = tab.at(np.asarray(gp.s))
    r = np.maximum(v[:, 0], 1e-6)
    kn = v[:, 3] * np.cos(gp.alpha) ** 2 + v[:, 2] / r * np.sin(gp.alpha) ** 2
    dl = np.sqrt(np.diff(gp.z) ** 2 + np.diff(gp.r) ** 2 + (0.5 * (gp.r[1:] + gp.r[:-1]) * np.diff(gp.phi)) ** 2)
    neg = (kn[1:] < -1e-5) & (kn[:-1] < -1e-5)
    gap, run_len, run_k = 0.0, 0.0, 0.0
    for is_neg, d, k in zip(neg, dl, 0.5 * (kn[1:] + kn[:-1])):
        if is_neg:
            run_len += d
            run_k = max(run_k, -k)
        else:
            gap = max(gap, run_k * run_len**2 / 8.0)
            run_len, run_k = 0.0, 0.0
    gap = max(gap, run_k * run_len**2 / 8.0)
    return float(kn.min()), float(dl[neg].sum()), float(gap)


def _pattern_out(p: pat.Pattern) -> S.PatternCandidate:
    return S.PatternCandidate(
        n_bands=p.n_bands, shift=p.shift, pattern_number=p.pattern_number,
        dwell=math.degrees(p.dwell), coverage=float(p.coverage), leading=p.leading, score=float(p.score),
    )


def layer_result(b: Build, bl: BuiltLayer) -> S.LayerResult:
    comp = b.project.composite
    resin = get_resin(comp.resin, b.project.materials)
    L_mm = bl.fiber_path_length()
    fb = bl.fiber or b.fiber
    fiber_g = L_mm / 1e6 * bl.spec.tows * fb.tex
    resin_g = fiber_g / fb.density * (1 - comp.fiber_volume_fraction) / comp.fiber_volume_fraction * resin.density
    speed = b.project.machine.fiber_speed
    kn_min, bridge, bridge_gap = normal_curvature(bl)
    ten = b.tension.get(bl.index) if b.tension else None
    return S.LayerResult(
        id=bl.spec.id,
        index=bl.index,
        type=bl.spec.type,
        angle=math.degrees(bl.angle),
        thickness=bl.t_cyl,
        band_thickness=bl.t_band,
        turnaround_radius=bl.r0,
        winding=bl.spec.winding if bl.spec.type == "helical" else "geodesic",
        turnaround_a=bl.gp.r_a if bl.gp else None,
        turnaround_b=bl.gp.r_b if bl.gp else None,
        slippage_a=bl.gp.lam_a if bl.gp else 0.0,
        slippage_b=bl.gp.lam_b if bl.gp else 0.0,
        dwell_slippage=max(bl.gp.dwell_slip_a, bl.gp.dwell_slip_b) if bl.gp else 0.0,
        friction=bl.spec.friction,
        min_normal_curvature=kn_min,
        bridging_length=bridge,
        bridging_gap=bridge_gap,
        winding_stress=ten[0] if ten else 0.0,
        residual_prestress=ten[1] if ten else 0.0,
        tension_loss=ten[2] if ten else 0.0,
        z_start=bl.z_start,
        z_end=bl.z_end,
        thickness_profile=S.Curve(x=bl.base.z.tolist(), y=bl.thickness.tolist()),
        surface=S.Curve(x=bl.top.z.tolist(), y=bl.top.r.tolist()),
        pattern=_pattern_out(bl.pattern) if bl.pattern else None,
        pattern_candidates=[_pattern_out(p) for p in bl.candidates],
        circuits=bl.circuits,
        fiber_length=L_mm / 1000.0,
        fiber_mass=fiber_g,
        resin_mass=resin_g,
        wind_time=1.35 * L_mm / speed,  # includes turnaround slow-downs; /api/simulate is exact
        warnings=bl.warnings,
    )


# --------------------------------------------------------------------------- sizing
def suggest_layup(project: S.Project, max_iter: int = 60) -> tuple[list[S.Layer], list[str]]:
    """Netting-based initial layup refined until burst, mode and stress-ratio checks pass."""
    notes: list[str] = []
    tmpl_hel = next((L for L in project.layers if L.type == "helical"), None)
    tmpl_hoop = next((L for L in project.layers if L.type == "hoop"), None)
    hel_t = tmpl_hel or S.Layer(id="h", type="helical", tows=1, band_width=6.0, tension=25.0)
    hoop_t = tmpl_hoop or S.Layer(id="c", type="hoop", tows=1, band_width=6.0, tension=35.0)
    fiber = get_fiber(project.composite.fiber, project.materials)
    Vf = project.composite.fiber_volume_fraction
    t_b_hel = band_thickness(fiber, hel_t.tows, hel_t.band_width, Vf)
    t_b_hoop = band_thickness(fiber, hoop_t.tows, hoop_t.band_width, Vf)

    probe = project.model_copy(update={"layers": []})
    b0 = build(probe)
    req = project.requirements
    p_req = req.meop * req.burst_factor
    t_hoop, t_hel = netting_thickness(b0, p_req)
    # size stress rupture too: fibre stress at MEOP must stay below the limit
    sr = req.stress_ratio_limit
    scale = max(1.0, 1.0 / (sr * req.burst_factor))
    n_hel = max(1, math.ceil(1.15 * scale * t_hel / (2 * t_b_hel)))
    n_hoop = max(1, math.ceil(scale * t_hoop / (2 * t_b_hoop)))
    notes.append(f"Netting at {p_req:.1f} MPa: hoop {t_hoop:.2f} mm, helical {t_hel:.2f} mm")

    def make(nh: int, nc: int) -> list[S.Layer]:
        seq: list[S.Layer] = []
        # interleave: start and end with hoop, spread helicals evenly
        order = []
        for k in range(nh + nc):
            order.append("hel" if (k * nh) // (nh + nc) != ((k + 1) * nh) // (nh + nc) else "hoop")
        if order and order[0] == "hel" and "hoop" in order:
            j = order.index("hoop")
            order[0], order[j] = order[j], order[0]
        ih = ic = 0
        stagger = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5]
        for kind in order:
            if kind == "hel":
                seq.append(hel_t.model_copy(update={
                    "id": f"hel{ih + 1}", "pattern": None,
                    "turnaround_offset": stagger[ih % len(stagger)] * hel_t.band_width,
                    "start_angle": round((ih * 137.508) % 360.0, 1),  # golden angle: interleave crossovers
                }))
                ih += 1
            else:
                off = min(ic * hoop_t.band_width / 2, 0.15 * project.liner.cyl_length)
                seq.append(hoop_t.model_copy(update={
                    "id": f"hoop{ic + 1}", "passes": 2, "end_offset_a": off, "end_offset_b": off,
                }))
                ic += 1
        return seq

    layers = make(n_hel, n_hoop)
    best: list[S.Layer] | None = None
    for it in range(max_iter):
        proj = project.model_copy(update={"layers": layers})
        try:
            res = analyze(proj)
        except DesignError as e:
            notes.append(f"Stopped: {e}")
            if best is not None:
                notes.append("Returning the last feasible layup; review the failing checks")
                layers = best
            break
        best = layers
        st = res.structural
        assert st is not None
        fails = {c.id for c in res.checks if c.status == "fail"}
        warns = {c.id for c in res.checks if c.status == "warn"}
        fails = {f for f in fails if not f.startswith("tension.")}
        if st.burst_mode == "helical" or "sr.helical" in fails or "burst.balance" in warns:
            n_hel += 1
        elif "burst" in fails or "sr.hoop" in fails:
            n_hoop += 1
        elif "fe.burst" in fails and res.fe is not None:
            crit = next((L for L in layers if L.id == res.fe.critical_layer), None)
            if crit is not None and crit.type == "helical":
                n_hel += 1
            else:
                n_hoop += 1
        elif "fe.liner" in fails and res.fe is not None:
            # liner bending hot spot on the dome: reinforce the domes (helicals), cylinder: hoops
            if abs(res.fe.liner_hotspot_z) > project.liner.cyl_length / 2:
                n_hel += 1
            else:
                n_hoop += 1
        elif "sr.temp" in fails or "liner.lbb" in fails:
            n_hoop += 1
        elif fails & {"af.window", "af.reverse", "fatigue", "liner.meop", "liner.temp"}:
            # liner too dominant: stiffen the overwrap in proportion to the netting split
            n_hoop += 1
            if st.stress_ratio_helical > 0.8 * st.stress_ratio_hoop:
                n_hel += 1
        else:
            rest = sorted(f for f in fails if not f.startswith("tension."))
            if rest:
                notes.append(f"Sized after {it + 1} iteration(s), but these checks cannot be fixed by adding "
                             f"layers: {', '.join(rest)} (e.g. slippage/path: adjust angles, friction or offsets)")
            else:
                notes.append(f"Converged after {it + 1} iteration(s): burst {st.burst_pressure:.1f} MPa "
                             f"({st.burst_mode}-first), {n_hel} helical + {n_hoop} hoop layers")
            break
        layers = make(n_hel, n_hoop)
    else:
        notes.append("Did not converge; review the checks")
    layers = _best_stagger(project, layers, notes)
    layers = apply_tension_schedule(project, layers)
    notes.append("Winding tensions set for uniform residual prestress (outermost layer keeps the template tension)")
    return layers, notes


def _stagger_patterns(n: int, B: float, cap: float) -> dict[str, list[float]]:
    steps = max(int(cap // (0.5 * B)), 1)
    return {
        "cyclic": [((k % 6) * 0.5 * B) for k in range(n)],
        "ascending": [min(k, steps) * 0.5 * B if k <= steps else ((k - steps - 1) % (steps + 1)) * 0.5 * B
                      for k in range(n)],
        "zigzag": [(steps - abs(steps - (k % (2 * steps or 1)))) * 0.5 * B for k in range(n)],
    }


def _best_stagger(project: S.Project, layers: list[S.Layer], notes: list[str]) -> list[S.Layer]:
    """Pick the helical turnaround stagger with the smallest fibre bridging gap (all checks still passing)."""
    hel = [i for i, L in enumerate(layers) if L.type == "helical"]
    if len(hel) < 2:
        return layers
    lin = project.liner
    B = layers[hel[0]].band_width
    cap = 0.3 * (lin.radius - max(lin.boss_radius_a, lin.boss_radius_b))
    best, best_gap = None, math.inf
    for name, offs in _stagger_patterns(len(hel), B, cap).items():
        cand = list(layers)
        for k, i in enumerate(hel):
            cand[i] = cand[i].model_copy(update={"turnaround_offset": round(offs[k], 3)})
        try:
            res = analyze(project.model_copy(update={"layers": cand}))
        except DesignError:
            continue
        if any(c.status == "fail" and not c.id.startswith("tension.") for c in res.checks):
            continue
        gap = max((L.bridging_gap for L in res.layers), default=0.0)
        if gap < best_gap - 1e-9:
            best, best_gap, best_name = cand, gap, name
    if best is None:
        return layers
    notes.append(f"Helical turnaround stagger: {best_name} (largest bridging gap {best_gap:.2f} mm)")
    return best


def apply_tension_schedule(project: S.Project, layers: list[S.Layer]) -> list[S.Layer]:
    """Set layer tensions to the uniform-prestress schedule (outermost layer keeps its tension)."""
    from . import tension

    try:
        b = build(project.model_copy(update={"layers": layers}))
    except DesignError:
        return layers
    T = tension.schedule(b)
    return [L.model_copy(update={"tension": round(float(t) * 2) / 2}) for L, t in zip(layers, T)]
