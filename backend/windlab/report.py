"""Design report: a self-contained, printable HTML document with inline SVG charts."""
from __future__ import annotations

import datetime as _dt
import html
import math
from typing import Optional, Sequence

import numpy as np

from . import __version__
from . import schemas as S
from .core.design import analyze, build
from .core.materials import get_fiber, get_liner, get_resin

PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#4b5563", "#ca8a04"]


def _nice(lo: float, hi: float, n: int = 5) -> list[float]:
    if not math.isfinite(lo) or not math.isfinite(hi) or hi <= lo:
        hi = lo + 1.0
    raw = (hi - lo) / n
    mag = 10 ** math.floor(math.log10(raw))
    step = min((m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw), default=raw)
    start = math.floor(lo / step) * step
    return [start + i * step for i in range(int(math.ceil((hi - start) / step)) + 1)]


def svg_chart(series: Sequence[tuple[str, Sequence[float], Sequence[float]]], xlabel: str, ylabel: str,
              width: int = 680, height: int = 260, hlines: Sequence[tuple[float, str]] = (),
              equal: bool = False) -> str:
    """Minimal line chart. series: (label, x, y)."""
    pad_l, pad_r, pad_t, pad_b = 58, 14, 14, 42
    xs = [v for _, x, _ in series for v in x if v is not None and math.isfinite(v)]
    ys = [v for _, _, y in series for v in y if v is not None and math.isfinite(v)]
    ys += [h for h, _ in hlines]
    if not xs or not ys:
        return "<p><em>No data</em></p>"
    xt = _nice(min(xs), max(xs))
    yt = _nice(min(ys), max(ys))
    x0, x1, y0, y1 = xt[0], xt[-1], yt[0], yt[-1]
    W, H = width - pad_l - pad_r, height - pad_t - pad_b
    if equal:
        scale = min(W / (x1 - x0), H / (y1 - y0))
        W2, H2 = scale * (x1 - x0), scale * (y1 - y0)
    else:
        W2, H2 = W, H

    def px(x):
        return pad_l + (x - x0) / (x1 - x0) * W2

    def py(y):
        return pad_t + H2 - (y - y0) / (y1 - y0) * H2

    if equal:
        height = int(pad_t + H2 + pad_b)
    out = [f'<svg viewBox="0 0 {width} {height}" width="100%" class="chart" role="img">']
    for t in xt:
        out.append(f'<line x1="{px(t):.1f}" y1="{pad_t}" x2="{px(t):.1f}" y2="{pad_t + H2:.1f}" class="grid"/>')
        out.append(f'<text x="{px(t):.1f}" y="{pad_t + H2 + 16:.1f}" text-anchor="middle">{t:g}</text>')
    for t in yt:
        out.append(f'<line x1="{pad_l}" y1="{py(t):.1f}" x2="{pad_l + W2:.1f}" y2="{py(t):.1f}" class="grid"/>')
        out.append(f'<text x="{pad_l - 6}" y="{py(t) + 4:.1f}" text-anchor="end">{t:g}</text>')
    for h, lab in hlines:
        out.append(f'<line x1="{pad_l}" y1="{py(h):.1f}" x2="{pad_l + W2:.1f}" y2="{py(h):.1f}" class="ref"/>')
        out.append(f'<text x="{pad_l + W2 - 4:.1f}" y="{py(h) - 4:.1f}" text-anchor="end" class="reflab">'
                   f'{html.escape(lab)}</text>')
    legend = []
    for k, (lab, x, y) in enumerate(series):
        col = PALETTE[k % len(PALETTE)]
        segs, cur = [], []
        for a, b in zip(x, y):
            if a is None or b is None or not (math.isfinite(a) and math.isfinite(b)):
                if cur:
                    segs.append(cur)
                cur = []
                continue
            cur.append(f"{px(a):.1f},{py(b):.1f}")
        if cur:
            segs.append(cur)
        for sg in segs:
            out.append(f'<polyline points="{" ".join(sg)}" fill="none" stroke="{col}" stroke-width="1.6"/>')
        legend.append(f'<span><i style="background:{col}"></i>{html.escape(lab)}</span>')
    out.append(f'<text x="{pad_l + W2 / 2:.1f}" y="{height - 6}" text-anchor="middle">{html.escape(xlabel)}</text>')
    out.append(f'<text x="14" y="{pad_t + H2 / 2:.1f}" text-anchor="middle" '
               f'transform="rotate(-90 14 {pad_t + H2 / 2:.1f})">{html.escape(ylabel)}</text>')
    out.append("</svg>")
    return "".join(out) + f'<div class="legend">{"".join(legend)}</div>'


def _table(headers: list[str], rows: list[list[str]], cls: str = "") -> str:
    h = "".join(f"<th>{html.escape(x)}</th>" for x in headers)
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<table class="{cls}"><thead><tr>{h}</tr></thead><tbody>{body}</tbody></table>'


def _f(v: Optional[float], d: int = 1, unit: str = "") -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "–"
    s = f"{v:,.{d}f}"
    return f"{s} {unit}".strip()


STATUS_ICON = {"ok": "✔", "warn": "▲", "fail": "✖", "info": "ℹ"}

CSS = """
:root{--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--ok:#15803d;--warn:#b45309;--fail:#b91c1c;--acc:#2563eb}
*{box-sizing:border-box}body{font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);
margin:0;background:#fff}main{max-width:900px;margin:0 auto;padding:28px 28px 60px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;padding-bottom:4px;border-bottom:2px solid var(--fg)}
h3{font-size:13px;margin:16px 0 6px}.sub{color:var(--muted)}table{border-collapse:collapse;width:100%;margin:6px 0 10px}
th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
th{font-weight:600;background:#f9fafb}td.n,th.n{text-align:right}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.kpi{border:1px solid var(--line);border-radius:6px;padding:8px}.kpi b{display:block;font-size:17px}
.kpi small{color:var(--muted)}.ok{color:var(--ok)}.warn{color:var(--warn)}.fail{color:var(--fail)}
.chart text{font-size:10px;fill:#374151}.chart .grid{stroke:#eef0f3}.chart .ref{stroke:#b91c1c;stroke-dasharray:4 3}
.chart .reflab{fill:#b91c1c}.legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:#374151;margin:-2px 0 8px 58px}
.legend i{display:inline-block;width:12px;height:3px;margin-right:4px;vertical-align:middle}
.banner{padding:10px 12px;border-radius:6px;margin:12px 0;font-weight:600}
.banner.ok{background:#f0fdf4}.banner.warn{background:#fffbeb}.banner.fail{background:#fef2f2}
.note{color:var(--muted);font-size:12px}ul{margin:4px 0 8px 18px;padding:0}
@media print{main{padding:0}h2{break-after:avoid}table,.chart{break-inside:avoid}}
"""


def report_html(project: S.Project) -> str:
    res = analyze(project)
    b = build(project)
    st, fe = res.structural, res.fe
    lin, req, comp, mach = project.liner, project.requirements, project.composite, project.machine
    fiber, resin, lmat = get_fiber(comp.fiber, project.materials), get_resin(comp.resin, project.materials), get_liner(lin.material, project.materials)
    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    n_fail = sum(c.status == "fail" for c in res.checks)
    n_warn = sum(c.status == "warn" for c in res.checks)
    status = "fail" if n_fail else ("warn" if n_warn else "ok")
    verdict = {"ok": "All design checks pass", "warn": f"{n_warn} warning(s), no failures",
               "fail": f"{n_fail} failing check(s), {n_warn} warning(s)"}[status]
    P: list[str] = [f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(project.name)} – "
                    f"design report</title><style>{CSS}</style></head><body><main>"]
    P.append(f"<h1>{html.escape(project.name)}</h1><div class='sub'>Type III COPV design report · WindLab "
             f"{__version__} · {now}</div>")
    P.append(f"<div class='banner {status}'>{STATUS_ICON[status]} {verdict}</div>")
    if project.notes:
        P.append(f"<p>{html.escape(project.notes)}</p>")

    # KPIs
    k = []
    if st:
        k.append(("Burst (cylinder)", _f(st.burst_pressure, 1, "MPa"), f"required {_f(st.required_burst, 1)} · "
                  f"{st.burst_mode}-first"))
    if fe:
        k.append(("Burst incl. domes (FE)", _f(fe.dome_burst, 1, "MPa"), f"critical {fe.critical_layer} at z = "
                  f"{fe.critical_z:.0f} mm"))
    if st:
        k.append(("Autofrettage", _f(st.autofrettage_pressure, 1, "MPa"), f"window {_f(st.autofrettage_window[0])}"
                  f" – {_f(st.autofrettage_window[1])}"))
        k.append(("Stress ratio @MEOP", f"{st.stress_ratio_hoop:.2f} / {st.stress_ratio_helical:.2f}",
                  f"hoop / helical, limit {req.stress_ratio_limit}"))
        k.append(("Liner fatigue", _f(min(st.liner_fatigue_cycles, fe.liner_hotspot_cycles if fe else 1e99), 0),
                  f"cycles (hot spot) · need {req.design_cycles * req.fatigue_scatter_factor:,.0f}"))
    m = res.mass
    k += [("Mass", _f(m.total / 1000, 2, "kg"), f"liner {m.liner / 1000:.2f} · composite "
           f"{(m.fiber + m.resin) / 1000:.2f} kg"), ("Volume", _f(m.volume, 2, "L"), ""),
          ("PV/W", _f(m.pv_w, 1, "km"), "at predicted burst")]
    P.append("<div class='kpis'>" + "".join(f"<div class='kpi'><small>{html.escape(a)}</small><b>{v}</b>"
                                              f"<small>{html.escape(c)}</small></div>" for a, v, c in k) + "</div>")

    # checks
    P.append("<h2>1. Design checks</h2>")
    rows = []
    for c in res.checks:
        val = "" if c.value is None else f"{c.value:,.3g}"
        lim = "" if c.limit is None else f"{c.limit:,.3g}"
        rows.append([f"<span class='{c.status}'>{STATUS_ICON[c.status]}</span>", html.escape(c.label),
                     f"{val} {html.escape(c.unit)}", lim, html.escape(c.detail)])
    P.append(_table(["", "Check", "Value", "Limit", "Detail"], rows))

    # inputs
    P.append("<h2>2. Requirements, liner and materials</h2>")
    P.append(_table(["Item", "Value"], [
        ["MEOP / proof / required burst", f"{req.meop:g} / {req.meop * req.proof_factor:g} / "
                                          f"{req.meop * req.burst_factor:g} MPa (factors {req.proof_factor:g}, "
                                          f"{req.burst_factor:g})"],
        ["Stress ratio limit / cycles", f"{req.stress_ratio_limit:g} / {req.design_cycles:,} × "
                                        f"{req.fatigue_scatter_factor:g}"],
        ["Liner", f"{lmat.name}; R {lin.radius:g} mm, cylinder {lin.cyl_length:g} mm, wall "
                  f"{lin.wall_thickness:g} mm, {lin.dome_type} domes"],
        ["Bosses", f"A {lin.boss_radius_a:g} mm, B {lin.boss_radius_b:g} mm radius; neck "
                   f"{lin.neck_thickness or 3 * lin.wall_thickness:g} mm"],
        ["Fibre / resin", f"{fiber.name} ({fiber.E / 1000:g} GPa, {fiber.strength:g} MPa) / {resin.name}"],
        ["Vf / translation efficiency", f"{comp.fiber_volume_fraction:g} / {comp.translation_efficiency:g}"],
        ["Ply E1 / E2 / G12", f"{b.ply.E1 / 1000:.1f} / {b.ply.E2 / 1000:.2f} / {b.ply.G12 / 1000:.2f} GPa; "
                              f"fibre failure strain {b.ply.eps1_ult * 100:.2f} %"],
    ]))
    P.append(svg_chart([("liner outer", res.liner_outer.x, res.liner_outer.y),
                        ("liner inner", res.liner_inner.x, res.liner_inner.y)]
                       + ([("outer surface", res.layers[-1].surface.x, res.layers[-1].surface.y)] if res.layers else []),
                       "z [mm]", "r [mm]", equal=True, height=240))

    # layup
    P.append("<h2>3. Layup</h2>")
    rows = []
    for L in res.layers:
        spec = project.layers[L.index]
        if L.type == "helical":
            pat = f"{L.pattern.n_bands}/{L.pattern.shift} p{L.pattern.pattern_number}, dwell {L.pattern.dwell:.1f}°" \
                if L.pattern else "–"
            path = ("NG" if L.winding == "non-geodesic" else "geo") + \
                   f", r<sub>t</sub> {L.turnaround_a:.1f}/{L.turnaround_b:.1f}"
            slip = f"{max(abs(L.slippage_a), abs(L.slippage_b)):.3f}" if L.winding == "non-geodesic" else "0"
        else:
            pat, path, slip = f"{spec.passes} passes", f"z {L.z_start:.0f}…{L.z_end:.0f}", "–"
        rows.append([str(L.index + 1), L.type, f"{L.angle:.2f}°", path, f"{spec.tows}×{spec.band_width:g}",
                     f"{spec.tension:g}", f"{L.thickness:.3f}", pat, slip, f"{L.fiber_length:.0f}",
                     f"{L.wind_time / 60:.0f}"])
    P.append(_table(["#", "Type", "Angle", "Path", "Band [mm]", "T [N]", "t [mm]", "Pattern", "|λ|",
                     "Fibre [m]", "Time [min]"], rows))
    if res.layers:
        tot = np.zeros(len(res.layers[0].thickness_profile.x))
        series = []
        for L in res.layers:
            tot = tot + np.asarray(L.thickness_profile.y)
        series.append(("total composite", res.layers[0].thickness_profile.x, tot.tolist()))
        P.append(svg_chart(series, "z [mm]", "thickness [mm]", height=220))

    # structural
    if st:
        P.append("<h2>4. Structural analysis</h2>")
        P.append("<h3>Cylinder: elastic-plastic liner + CLT overwrap, pressure history</h3>")
        hist = [h for h in st.history if h.phase in ("start", "autofrettage")]
        P.append(svg_chart([
            ("liner von Mises", [h.pressure for h in hist], [h.liner_vm for h in hist]),
            ("fibre stress hoop", [h.pressure for h in hist], [h.fiber_hoop for h in hist]),
            ("fibre stress helical", [h.pressure for h in hist], [h.fiber_helical for h in hist]),
        ], "pressure [MPa] (autofrettage loading)", "stress [MPa]", height=220,
            hlines=[(lmat.yield_, "liner yield")]))
        P.append(_table(["State", "p [MPa]", "Liner σx", "Liner σθ", "Liner σvm", "Fibre hoop", "Fibre helical"], [
            [n, _f(pt.pressure), _f(pt.liner_axial, 0), _f(pt.liner_hoop, 0), _f(pt.liner_vm, 0),
             _f(pt.fiber_hoop, 0), _f(pt.fiber_helical, 0)]
            for n, pt in (("After autofrettage", st.residual), ("Proof", st.at_proof), ("MEOP", st.at_meop))]))
        if fe:
            P.append("<h3>Whole vessel: axisymmetric laminated shell FE at MEOP</h3>")
            P.append(svg_chart([("max fibre utilisation", fe.z, fe.fiber_ratio_max)], "z [mm]",
                               "fibre strain / allowable", height=200,
                               hlines=[(req.stress_ratio_limit, "stress ratio limit")]))
            P.append(svg_chart([("liner σvm inner", fe.z, fe.liner_vm_inner),
                                ("liner σvm outer", fe.z, fe.liner_vm_outer)], "z [mm]",
                               "liner stress range at MEOP [MPa]", height=200))
            P.append(f"<p class='note'>Liner hot spot {fe.liner_hotspot_factor:.2f}× the cylinder stress range "
                     f"at z = {fe.liner_hotspot_z:.0f} mm; estimated life {fe.liner_hotspot_cycles:,.0f} cycles. "
                     f"Critical fibre location: layer {fe.critical_layer} at z = {fe.critical_z:.0f} mm.</p>")

    # manufacturing
    P.append("<h2>5. Manufacturing</h2>")
    total_time = sum(L.wind_time for L in res.layers)
    fib_m = sum(L.fiber_length * project.layers[L.index].tows for L in res.layers)
    P.append(_table(["Item", "Value"], [
        ["Machine", f"{html.escape(mach.name)} ({mach.axes_count}-axis, {mach.controller})"],
        ["Winding time (estimate)", f"{total_time / 60:.0f} min at {mach.fiber_speed:g} mm/s"],
        ["Fibre", f"{fib_m:,.0f} m tow, {sum(L.fiber_mass for L in res.layers):,.0f} g"],
        ["Resin", f"{sum(L.resin_mass for L in res.layers):,.0f} g"],
        ["Autofrettage / proof", f"{_f(st.autofrettage_pressure if st else None)} / "
                                 f"{req.meop * req.proof_factor:g} MPa"],
    ]))
    if res.layers:
        P.append(svg_chart([("winding prestress", list(range(1, len(res.layers) + 1)),
                             [L.winding_stress for L in res.layers]),
                            ("residual after winding", list(range(1, len(res.layers) + 1)),
                             [L.residual_prestress for L in res.layers])], "layer", "ply prestress [MPa]",
                           height=200))

    P.append("<h2>6. Assumptions and limitations</h2><ul>")
    for t in (
        "Material properties are typical datasheet values; use qualified, lot-specific allowables.",
        "Cylinder model: exact equilibrium, shared strains, J2 liner plasticity with linear hardening; no "
        "cure/thermal residual stresses; Bauschinger effect covered by a 0.9 reverse-yield knock-down.",
        "Shell FE is linear elastic at MEOP (the operating cycle of an autofrettaged liner); dome burst is the "
        "cylinder's nonlinear burst scaled by the FE strain distribution; bosses modelled as rigid rings.",
        "Liner fatigue uses indicative S-N data (SWT); confirm by cycle testing.",
        "Winding-tension loss uses a thin-ring model without viscoelastic relaxation or resin squeeze-out.",
        "Pressure testing is hazardous: use a barricaded test cell and remote operation.",
    ):
        P.append(f"<li>{html.escape(t)}</li>")
    P.append("</ul></main></body></html>")
    return "".join(P)
