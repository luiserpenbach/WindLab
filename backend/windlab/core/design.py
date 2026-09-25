"""Design orchestration: layer build-up, structural analysis, checks, sizing."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .. import schemas as S
from . import patterns as pat
from .geometry import GeometryError, Profile, liner_profiles
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
from .winding import GeodesicPass, geodesic_pass

REVERSE_YIELD_LIMIT = 0.9  # Bauschinger knock-down on the compressive reverse-yield check
AF_FIBER_RATIO_LIMIT = 0.75  # max fibre strain ratio allowed during autofrettage


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
    gp: Optional[GeodesicPass] = None
    pattern: Optional[pat.Pattern] = None
    candidates: list[pat.Pattern] = field(default_factory=list)
    z_start: float = 0.0
    z_end: float = 0.0
    warnings: list[str] = field(default_factory=list)

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
        revs = max(length, 0.0) / self.spec.band_width
        rev_len = 2 * math.pi * self.R_mid
        return self.spec.passes * (revs * math.hypot(rev_len, self.spec.band_width) + 0.5 * rev_len)


@dataclass
class Build:
    project: S.Project
    liner_outer: Profile
    liner_inner: Profile
    fiber: Fiber
    ply: Ply
    layers: list[BuiltLayer]

    @property
    def outer(self) -> Profile:
        return self.layers[-1].top if self.layers else self.liner_outer


def _helical_thickness(base: Profile, t_cyl: float, R_ref: float, r0: float, B: float) -> np.ndarray:
    """Band-averaged geodesic thickness: fibre conservation t*r*cos(a) = const,
    averaged over the band width so it stays finite at the turnaround."""
    C = t_cyl * math.sqrt(R_ref**2 - r0**2)
    hi = np.arccosh(np.maximum((base.r + B / 2) / r0, 1.0))
    lo = np.arccosh(np.maximum((base.r - B / 2) / r0, 1.0))
    return C * (hi - lo) / B


def build(project: S.Project) -> Build:
    lin = project.liner
    try:
        outer, inner = liner_profiles(lin)
    except GeometryError as e:
        raise DesignError(str(e)) from e
    comp = project.composite
    fiber = get_fiber(comp.fiber)
    ply = ply_properties(fiber, get_resin(comp.resin), comp.fiber_volume_fraction, comp.translation_efficiency)
    boss = max(lin.boss_radius_a, lin.boss_radius_b)
    half = lin.cyl_length / 2.0

    layers: list[BuiltLayer] = []
    surf = outer
    for i, L in enumerate(project.layers):
        t_b = band_thickness(fiber, L.tows, L.band_width, comp.fiber_volume_fraction)
        R_mid = float(surf.radius_at(0.0))
        warnings: list[str] = []
        if L.type == "helical":
            r0 = boss + L.band_width / 2 + L.turnaround_offset
            if r0 >= 0.95 * R_mid:
                raise DesignError(f"Layer {i + 1}: turnaround radius {r0:.1f} mm too close to the cylinder radius")
            angle = math.asin(r0 / R_mid)
            try:
                gp = geodesic_pass(surf, r0)
            except GeometryError as e:
                raise DesignError(f"Layer {i + 1}: {e}") from e
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
            t = _helical_thickness(surf, t_cyl, R_mid, r0, L.band_width)
            bl = BuiltLayer(L, i, surf, surf.offset(t), t, t_cyl, t_b, angle, R_mid, r0, gp, chosen, cands,
                            float(surf.z[0]), float(surf.z[-1]), warnings)
        else:
            z_s, z_e = -half + L.end_offset_a, half - L.end_offset_b
            if z_e - z_s < 2 * L.band_width:
                raise DesignError(f"Layer {i + 1}: hoop length is shorter than two band widths")
            t_h = L.thickness_override or L.passes * t_b
            n = surf.normals()
            edge = np.minimum(surf.z - z_s, z_e - surf.z)
            t = t_h * np.clip(0.5 + edge / L.band_width, 0.0, 1.0) * (np.abs(n[:, 1]) > 0.9)
            angle = math.atan2(2 * math.pi * R_mid, L.band_width)
            bl = BuiltLayer(L, i, surf, surf.offset(t), t, t_h, t_b, angle, R_mid, z_start=z_s, z_end=z_e,
                            warnings=warnings)
        layers.append(bl)
        surf = bl.top
    return Build(project, outer, inner, fiber, ply, layers)


# --------------------------------------------------------------------------- structural
def _vessel(b: Build) -> Vessel:
    lin = b.project.liner
    mat = get_liner(lin.material)
    liner = Liner(mat, lin.wall_thickness, lin.radius - lin.wall_thickness / 2)
    groups = [
        PlyGroup(bl.spec.type, bl.angle, bl.t_cyl, bl.R_mid + bl.t_cyl / 2, b.ply)
        for bl in b.layers
    ]
    return Vessel(liner, groups, lin.radius - lin.wall_thickness)


def autofrettage_window(v: Vessel, proof: float, p_burst_est: float) -> tuple[float, float]:
    p_lo = max(proof, 1.05 * first_yield_pressure(v))
    # highest pressure that unloads without compressive reverse yielding
    lo, hi = 0.0, max(p_burst_est, p_lo) * 1.2
    for _ in range(40):
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
    mat = get_liner(lin.material)
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
        rk = bl.base.r
        cos2 = np.clip(1.0 - (bl.r0 / rk) ** 2, 0.0, 1.0)
        denom += bl.thickness * cos2
        # netting is meaningless inside the turnaround bands (boss and liner carry load there)
        r_excl = max(r_excl, bl.r0 + 2 * bl.spec.band_width)
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
    pb_est, _, _ = burst(v, v.virgin(), p_req)
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
    pb, mode, _ = burst(v, hist[-1].state, pb_est)
    ratios = v.fiber_ratio(meop_state.eps)
    mat = get_liner(b.project.liner.material)
    cycles = liner_fatigue_cycles(mat, hist[-1].state.liner_sigma, meop_state.liner_sigma)
    t_hoop, t_hel = netting_thickness(b, p_req)
    dz, ds = dome_netting_stress(b, req.meop)
    res = S.StructuralResult(
        autofrettage_pressure=p_af,
        autofrettage_auto=auto,
        autofrettage_window=(p_lo, p_hi),
        history=pts,
        residual=pts[i_af_end],
        at_meop=pts[i_meop],
        at_proof=pts[i_proof],
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
    mat = get_liner(lin.material)
    liner_g = (b.liner_outer.volume() - b.liner_inner.volume()) * mat.density / 1000.0
    comp_vol = sum(bl.base.shell_volume(bl.thickness) for bl in b.layers)  # mm3
    Vf = b.project.composite.fiber_volume_fraction
    resin = get_resin(b.project.composite.resin)
    fiber_g = comp_vol * Vf * b.fiber.density / 1000.0
    resin_g = comp_vol * (1 - Vf) * resin.density / 1000.0
    total = liner_g + fiber_g + resin_g
    vol_l = b.liner_inner.volume() / 1e6
    pvw = p_burst * 1e6 * vol_l * 1e-3 / (total / 1000.0 * 9.80665) / 1000.0 if total > 0 else 0.0
    return S.MassResult(liner=liner_g, fiber=fiber_g, resin=resin_g, total=total, volume=vol_l, pv_w=pvw)


def _chk(id_, label, ok, warn=False, value=None, limit=None, unit="", detail="") -> S.Check:
    status = "ok" if ok else ("warn" if warn else "fail")
    return S.Check(id=id_, label=label, status=status, value=value, limit=limit, unit=unit, detail=detail)


def checks(b: Build, st: Optional[S.StructuralResult], extra: dict) -> list[S.Check]:
    req = b.project.requirements
    out: list[S.Check] = []
    lin = b.project.liner
    if lin.boss_radius_a != lin.boss_radius_b:
        out.append(S.Check(id="geo.boss", label="Unequal polar openings", status="info",
                           detail="Geodesic paths use one turnaround radius, set by the larger boss."))
    for bl in b.layers:
        for w in bl.warnings:
            out.append(S.Check(id=f"layer.{bl.spec.id}", label=f"Layer {bl.index + 1}", status="warn", detail=w))
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
    p_lo, p_hi = st.autofrettage_window
    out.append(_chk("af.window", "Autofrettage window", p_hi >= p_lo, value=st.autofrettage_pressure,
                    unit="MPa", detail=f"Feasible range {p_lo:.1f} - {p_hi:.1f} MPa"))
    out.append(_chk("af.reverse", "No reverse yield after autofrettage",
                    extra["reverse_yield_ratio"] <= REVERSE_YIELD_LIMIT + 1e-6,
                    value=extra["reverse_yield_ratio"], limit=REVERSE_YIELD_LIMIT,
                    detail="Residual liner von Mises / yield (0.9 allows for the Bauschinger effect)"))
    out.append(_chk("af.fiber", "Fibre strain during autofrettage", extra["af_fiber_ratio"] <= AF_FIBER_RATIO_LIMIT,
                    warn=True, value=extra["af_fiber_ratio"], limit=AF_FIBER_RATIO_LIMIT))
    out.append(_chk("liner.meop", "Liner elastic at MEOP", extra["meop_yield_ratio"] <= 1.0 + 1e-6,
                    value=extra["meop_yield_ratio"], limit=1.0))
    out.append(_chk("liner.proof", "Liner elastic at proof", extra["proof_plastic"] <= 1e-6, warn=True,
                    detail="Proof below the autofrettage pressure keeps the liner elastic."))
    need = req.design_cycles * req.fatigue_scatter_factor
    out.append(_chk("fatigue", "Liner fatigue life", st.liner_fatigue_cycles >= need,
                    value=st.liner_fatigue_cycles, limit=need, unit="cycles",
                    detail="SWT estimate with indicative S-N data; confirm by test."))
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
        st, extra = structural(b)
    layer_results = [layer_result(b, bl) for bl in b.layers]
    m = mass(b, st.burst_pressure if st else 0.0)
    return S.AnalysisResult(
        liner_outer=S.Curve(x=b.liner_outer.z.tolist(), y=b.liner_outer.r.tolist()),
        liner_inner=S.Curve(x=b.liner_inner.z.tolist(), y=b.liner_inner.r.tolist()),
        layers=layer_results,
        structural=st,
        mass=m,
        checks=checks(b, st, extra),
    )


def _pattern_out(p: pat.Pattern) -> S.PatternCandidate:
    return S.PatternCandidate(
        n_bands=p.n_bands, shift=p.shift, pattern_number=p.pattern_number,
        dwell=math.degrees(p.dwell), coverage=float(p.coverage), leading=p.leading, score=float(p.score),
    )


def layer_result(b: Build, bl: BuiltLayer) -> S.LayerResult:
    comp = b.project.composite
    resin = get_resin(comp.resin)
    L_mm = bl.fiber_path_length()
    fiber_g = L_mm / 1e6 * bl.spec.tows * b.fiber.tex
    resin_g = fiber_g / b.fiber.density * (1 - comp.fiber_volume_fraction) / comp.fiber_volume_fraction * resin.density
    speed = b.project.machine.fiber_speed
    return S.LayerResult(
        id=bl.spec.id,
        index=bl.index,
        type=bl.spec.type,
        angle=math.degrees(bl.angle),
        thickness=bl.t_cyl,
        band_thickness=bl.t_band,
        turnaround_radius=bl.r0,
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
def suggest_layup(project: S.Project, max_iter: int = 40) -> tuple[list[S.Layer], list[str]]:
    """Netting-based initial layup refined until burst, mode and stress-ratio checks pass."""
    notes: list[str] = []
    tmpl_hel = next((L for L in project.layers if L.type == "helical"), None)
    tmpl_hoop = next((L for L in project.layers if L.type == "hoop"), None)
    hel_t = tmpl_hel or S.Layer(id="h", type="helical", tows=1, band_width=6.0, tension=25.0)
    hoop_t = tmpl_hoop or S.Layer(id="c", type="hoop", tows=1, band_width=6.0, tension=35.0)
    fiber = get_fiber(project.composite.fiber)
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
        stagger = [0.0, 0.5, 1.0, 1.5]
        for kind in order:
            if kind == "hel":
                seq.append(hel_t.model_copy(update={
                    "id": f"hel{ih + 1}", "pattern": None,
                    "turnaround_offset": stagger[ih % len(stagger)] * hel_t.band_width,
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
    for it in range(max_iter):
        proj = project.model_copy(update={"layers": layers})
        try:
            res = analyze(proj)
        except DesignError as e:
            notes.append(f"Stopped: {e}")
            break
        st = res.structural
        assert st is not None
        fails = {c.id for c in res.checks if c.status == "fail"}
        warns = {c.id for c in res.checks if c.status == "warn"}
        if st.burst_mode == "helical" or "sr.helical" in fails or "burst.balance" in warns:
            n_hel += 1
        elif "burst" in fails or "sr.hoop" in fails:
            n_hoop += 1
        elif fails & {"af.window", "af.reverse", "fatigue", "liner.meop"}:
            # liner too dominant: stiffen the overwrap in proportion to the netting split
            n_hoop += 1
            if st.stress_ratio_helical > 0.8 * st.stress_ratio_hoop:
                n_hel += 1
        else:
            notes.append(f"Converged after {it + 1} iteration(s): burst {st.burst_pressure:.1f} MPa "
                         f"({st.burst_mode}-first), {n_hel} helical + {n_hoop} hoop layers")
            break
        layers = make(n_hel, n_hoop)
    else:
        notes.append("Did not converge; review the checks")
    return layers, notes
