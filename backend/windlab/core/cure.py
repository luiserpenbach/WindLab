"""Oven cure: transient heat conduction through liner + overwrap coupled with resin cure kinetics.

1D radial finite volumes through the wall at two sections (mid-cylinder and the thickest dome section):

* resin kinetics after Kamal-Sourour, ``da/dt = f_d (k1 + k2 a^m)(1 - a)^n``, ``k_i = A_i exp(-E_i / R T)``;
* diffusion control near vitrification: ``f_d = 1 / (1 + exp((Tg(a) - T) / DT_VITRIFY))``, with Tg(a) from the
  DiBenedetto equation;
* heat released ``rho_c w_resin H da/dt`` (w_resin: resin mass fraction), transverse conductivity of the
  composite from the Maxwell mixing rule;
* oven air following the cure cycle (ramps, holds, then cooling at ``COOL_RATE``) with a convective film on
  the outer surface; the inner liner surface is adiabatic (air trapped in the vessel: conservative for both
  the exotherm and the inner laminate lagging behind).

The kinetics defaults are generic for each resin family; replace them with DSC data for the actual system.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.linalg import solve_banded

from .. import schemas as S
from .design import Build
from .materials import get_liner, get_resin

R_GAS = 8.314
DT_VITRIFY = 6.0  # K
COOL_RATE = 2.0  # K/min after the last hold
DT = 10.0  # time step [s]
RESIN_CP, RESIN_K = 1200.0, 0.2  # J/(kg K), W/(m K)


def _fibre_thermal(fiber) -> tuple[float, float]:
    """(specific heat J/(kg K), transverse conductivity W/(m K)) of the fibre."""
    glass = "glass" in f"{fiber.id} {fiber.name}".lower()
    return (800.0, 1.0) if glass else (750.0, 5.0)


def cycle_of(b: Build) -> list[tuple[float, float, float]]:
    """Cure cycle (ramp K/min, set point degC, hold min): the project's, else the resin's recommended cycle
    with set points capped at the composite cure temperature."""
    comp = b.project.composite
    if comp.cure_cycle:
        return [(c.ramp, c.temperature, c.hold) for c in comp.cure_cycle]
    resin = get_resin(comp.resin, b.project.materials)
    return [(r, min(T, comp.cure_temperature), h) for r, T, h in resin.cycle]


def oven_profile(cycle, t_amb: float, dt: float = DT) -> tuple[np.ndarray, np.ndarray]:
    """Oven air temperature vs time [s] for a cycle, ending when the air is back at ambient."""
    pts_t, pts_T = [0.0], [t_amb]
    T, t = t_amb, 0.0
    for ramp, Tset, hold in cycle:
        t += abs(Tset - T) / ramp * 60.0
        pts_t.append(t), pts_T.append(Tset)
        t += hold * 60.0
        pts_t.append(t), pts_T.append(Tset)
        T = Tset
    t += abs(T - t_amb) / COOL_RATE * 60.0
    pts_t.append(t), pts_T.append(t_amb)
    times = np.arange(0.0, t + dt, dt)
    return times, np.interp(times, pts_t, pts_T)


@dataclass
class Section:
    name: str
    radius: float  # inner liner radius [mm]
    t_liner: float
    t_comp: float


def _sections(b: Build) -> list[Section]:
    lin = b.project.liner
    half = lin.cyl_length / 2
    outer = b.outer
    base = b.liner_outer
    zq = np.linspace(base.z.min(), base.z.max(), 800)

    def radius_along(prof, z):
        order = np.argsort(prof.z)
        return np.interp(z, prof.z[order], prof.r[order])

    t_cyl = sum(bl.t_cyl for bl in b.layers)
    out = [Section("cylinder", lin.radius - lin.wall_thickness, lin.wall_thickness, t_cyl)]
    # thickest overwrap on the domes (normal thickness ~ radial difference / cos of the local slope)
    dome = np.abs(zq) > half
    if dome.any() and b.layers:
        n = base.normals()
        order = np.argsort(base.z)
        nr = np.abs(np.interp(zq, base.z[order], n[order, 1]))
        tq = np.zeros_like(zq)
        for bl in b.layers:
            o = np.argsort(bl.base.z)
            tq += np.interp(zq, bl.base.z[o], bl.thickness[o])
        k = int(np.argmax(np.where(dome & (nr > 0.2), tq, -1.0)))
        if tq[k] > t_cyl:
            out.append(Section(f"dome (z = {zq[k]:.0f} mm)", float(radius_along(base, zq[k])) - lin.wall_thickness,
                               lin.wall_thickness, float(tq[k])))
    return out


def simulate_section(b: Build, sec: Section, times: np.ndarray, oven: np.ndarray) -> dict:
    comp = b.project.composite
    resin = get_resin(comp.resin, b.project.materials)
    lmat = get_liner(b.project.liner.material, b.project.materials)
    fiber = b.fiber
    Vf = comp.fiber_volume_fraction
    cp_f, k_f = _fibre_thermal(fiber)
    rho_f, rho_m = fiber.density * 1000.0, resin.density * 1000.0
    rho_c = Vf * rho_f + (1 - Vf) * rho_m
    w_res = (1 - Vf) * rho_m / rho_c
    cp_c = (1 - w_res) * cp_f + w_res * RESIN_CP
    km = RESIN_K
    k_c = km * ((k_f + km) + Vf * (k_f - km)) / ((k_f + km) - Vf * (k_f - km))  # Maxwell, transverse
    rho_l, cp_l, k_l = lmat.density * 1000.0, lmat.heat_capacity, lmat.conductivity

    n_l = 3
    n_c = max(int(math.ceil(sec.t_comp / 0.5)), 12)
    # cell faces [m]
    r0 = sec.radius * 1e-3
    faces = np.concatenate([r0 + np.linspace(0, sec.t_liner, n_l + 1) * 1e-3,
                            r0 + (sec.t_liner + np.linspace(0, sec.t_comp, n_c + 1)[1:]) * 1e-3])
    rc = 0.5 * (faces[1:] + faces[:-1])
    N = len(rc)
    is_c = np.arange(N) >= n_l
    rho = np.where(is_c, rho_c, rho_l)
    cp = np.where(is_c, cp_c, cp_l)
    kk = np.where(is_c, k_c, k_l)
    vol = 0.5 * (faces[1:] ** 2 - faces[:-1] ** 2)  # per radian per metre length
    # conductance between cells i and i+1 (series resistance of the two half cells)
    ri, ro = faces[:-1], faces[1:]
    res_out = np.log(ro / rc) / kk  # centre -> outer face
    res_in = np.log(rc / ri) / kk
    G = 1.0 / (res_out[:-1] + res_in[1:])
    h = comp.oven_htc
    G_oven = 1.0 / (res_out[-1] + 1.0 / (h * faces[-1]))
    C = rho * cp * vol

    T = np.full(N, oven[0])
    T0 = T.copy()  # the same wall without reaction heat: the exotherm is T - T0 (thermal lag excluded)
    a = np.zeros(N)
    heat = resin.heat * 1000.0  # J/kg resin
    q_scale = np.where(is_c, rho_c * w_res * heat, 0.0) * vol  # J per unit da

    def tg(alpha):
        lam = resin.tg_lambda
        return resin.tg0 + (resin.tg_inf - resin.tg0) * lam * alpha / (1 - (1 - lam) * alpha)

    def rate(Tc, alpha):
        TK = Tc + 273.15
        k1 = resin.A1 * np.exp(-resin.E1 / (R_GAS * TK))
        k2 = resin.A2 * np.exp(-resin.E2 / (R_GAS * TK))
        fd = 1.0 / (1.0 + np.exp(np.clip((tg(alpha) - Tc) / DT_VITRIFY, -50, 50)))
        return fd * (k1 + k2 * np.maximum(alpha, 1e-6) ** resin.m) * np.maximum(1 - alpha, 0.0) ** resin.n

    # banded implicit conduction matrix (constant)
    ab = np.zeros((3, N))
    diag = C / DT
    diag = diag + np.concatenate([G, [0.0]]) + np.concatenate([[0.0], G])
    diag[-1] += G_oven
    ab[1] = diag
    ab[0, 1:] = -G
    ab[2, :-1] = -G

    keep = np.unique(np.linspace(0, len(times) - 1, 240).astype(int))
    rec = {k: [] for k in ("T_liner", "T_inner", "T_mid", "T_outer", "a_inner", "a_mid", "a_outer")}
    keep_set = set(keep.tolist())
    j_in, j_mid, j_out = n_l, n_l + n_c // 2, N - 1
    over, peak_liner = -np.inf, -np.inf
    for i, t in enumerate(times):
        if i:
            # kinetics (explicit, sub-stepped for fast reactions)
            sub = 4
            dq = np.zeros(N)
            for _ in range(sub):
                da = np.where(is_c, rate(T, a), 0.0) * DT / sub
                da = np.minimum(da, 1.0 - a)
                a = a + da
                dq += da
            rhs = np.stack([C / DT * T + q_scale * dq / DT, C / DT * T0], axis=1)
            rhs[-1] += G_oven * oven[i]
            sol = solve_banded((1, 1), ab, rhs)
            T, T0 = sol[:, 0], sol[:, 1]
        over = max(over, float(np.max(T[is_c] - T0[is_c])))
        peak_liner = max(peak_liner, float(T[:n_l].max()))
        if i in keep_set:
            rec["T_liner"].append(float(T[: n_l].mean()))
            rec["T_inner"].append(float(T[j_in]))
            rec["T_mid"].append(float(T[j_mid]))
            rec["T_outer"].append(float(T[j_out]))
            rec["a_inner"].append(float(a[j_in]))
            rec["a_mid"].append(float(a[j_mid]))
            rec["a_outer"].append(float(a[j_out]))
    ac = a[is_c]
    return dict(times=(times[keep] / 60.0).tolist(), oven=oven[keep].tolist(), overshoot=over,
                min_cure=float(ac.min()), tg_final=float(tg(ac.min())), peak_liner=peak_liner, **rec)


def analyse(b: Build) -> S.CureResult:
    req = b.project.requirements
    cycle = cycle_of(b)
    times, oven = oven_profile(cycle, req.temperature_ref)
    secs = []
    for sec in _sections(b):
        r = simulate_section(b, sec, times, oven)
        secs.append(S.CureSection(
            name=sec.name, thickness=sec.t_comp, times=r["times"], oven=r["oven"], t_liner=r["T_liner"],
            t_inner=r["T_inner"], t_mid=r["T_mid"], t_outer=r["T_outer"], a_inner=r["a_inner"], a_mid=r["a_mid"],
            a_outer=r["a_outer"], overshoot=r["overshoot"], min_cure=r["min_cure"], tg_final=r["tg_final"],
            peak_liner=r["peak_liner"]))
    return S.CureResult(cycle=[S.CureStep(ramp=c[0], temperature=c[1], hold=c[2]) for c in cycle],
                        duration=float(times[-1] / 60.0), sections=secs)


def _meets(b: Build, secs: list[dict], T_liner_max: float) -> tuple[bool, float]:
    """(all cure criteria met, badness for ranking infeasible cycles)."""
    comp, req = b.project.composite, b.project.requirements
    over = max(s["overshoot"] for s in secs)
    a = min(s["min_cure"] for s in secs)
    tg = min(s["tg_final"] for s in secs)
    peak = max(s["peak_liner"] for s in secs)
    tg_need = req.temperature_max + comp.tg_margin
    bad = (max(over - comp.max_exotherm, 0) / 5 + max(comp.min_cure - a, 0) * 20 + max(tg_need - tg, 0) / 5
           + max(peak - T_liner_max, 0) / 2)
    return bad <= 0, bad


def suggest_cycle(b: Build, max_evals: int = 60) -> tuple[list[S.CureStep], S.CureResult, list[str]]:
    """Shortest cure cycle (ramp, optional intermediate dwell, final hold) meeting the exotherm, degree of cure,
    Tg and liner temperature limits. Candidates are tried in order of duration."""
    comp, req = b.project.composite, b.project.requirements
    resin = get_resin(comp.resin, b.project.materials)
    lmat = get_liner(b.project.liner.material, b.project.materials)
    t_amb = req.temperature_ref
    # the final hold: as close to the resin's recommended final temperature as the liner allows (its peak
    # includes the exotherm: keep a few kelvin margin on polymer liners)
    T_rec = max(T for _, T, _ in resin.cycle)
    T_top = min(T_rec, lmat.max_temp - (3.0 if lmat.polymer else 0.0))
    finals = sorted({round(T_top), round(T_top - 5), round(T_top - 10)}, reverse=True)
    cands = []
    for Tf in finals:
        for ramp in (2.0, 1.0, 0.5):
            for hf in (120, 240, 360, 480, 720):
                cands.append([(ramp, Tf, hf)])
                for Td in (Tf - 20, Tf - 35, Tf - 50):
                    if Td <= t_amb + 10:
                        continue
                    for hd in (60, 120, 240):
                        cands.append([(ramp, Td, hd), (ramp, Tf, hf)])

    def duration(c):
        T, t = t_amb, 0.0
        for r, Tn, h in c:
            t += abs(Tn - T) / r + h
            T = Tn
        return t + abs(T - t_amb) / COOL_RATE

    cands.sort(key=duration)
    sections = _sections(b)
    best = None
    notes: list[str] = []
    for c in cands[:max_evals] if len(cands) <= max_evals else _spread(cands, max_evals):
        times, oven = oven_profile(c, t_amb)
        secs = [simulate_section(b, s, times, oven) for s in sections]
        ok, bad = _meets(b, secs, lmat.max_temp)
        if best is None or (ok, -bad) > (best[0], -best[1]):
            best = (ok, bad, c)
        if ok:
            break
    ok, bad, c = best
    if not ok:
        notes.append("No candidate cycle meets every cure criterion; the closest is shown (consider a resin "
                     "with a lower cure temperature or a higher Tg, or relax the limits)")
    steps = [S.CureStep(ramp=r, temperature=T, hold=h) for r, T, h in c]
    tmp = b.project.model_copy(update={"composite": comp.model_copy(update={"cure_cycle": steps})})
    b2 = Build(tmp, b.liner_outer, b.liner_inner, b.fiber, b.ply, b.layers)
    res = analyse(b2)
    notes.insert(0, f"{len(steps)}-step cycle, {res.duration / 60:.1f} h incl. cooling")
    return steps, res, notes


def _spread(cands: list, n: int) -> list:
    """The n shortest candidates, then every k-th of the rest (so long cycles are still reachable)."""
    head = cands[: n // 2]
    rest = cands[n // 2:]
    k = max(len(rest) // (n - len(head)), 1)
    return head + rest[::k][: n - len(head)]
