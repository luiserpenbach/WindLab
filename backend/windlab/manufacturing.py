"""Shop-floor traveller: bill of materials, layer-by-layer instructions, QA sign-off."""
from __future__ import annotations

import datetime as _dt
import html

from . import schemas as S
from .core.design import analyze
from .core.materials import get_fiber, get_liner, get_resin


def _table(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(out)


def traveller(project: S.Project) -> dict[str, str]:
    res = analyze(project)
    lin, req, comp, mach = project.liner, project.requirements, project.composite, project.machine
    fiber, resin, lmat = get_fiber(comp.fiber, project.materials), get_resin(comp.resin, project.materials), get_liner(lin.material, project.materials)
    st = res.structural
    today = _dt.date.today().isoformat()
    md: list[str] = [
        f"# Winding traveller: {project.name}",
        "",
        f"Date: {today} · Serial no.: ________ · Operator: ________ · Machine: {mach.name} ({mach.controller})",
        "",
        "## Design summary",
        "",
        _table(
            ["Item", "Value"],
            [
                ["Liner", f"{lmat.name}, R {lin.radius} mm, cylinder {lin.cyl_length} mm, wall {lin.wall_thickness} mm, {lin.dome_type} domes"],
                ["Bosses", f"A {lin.boss_radius_a} mm / B {lin.boss_radius_b} mm radius"],
                ["MEOP / proof", f"{req.meop:.1f} MPa / {req.meop * req.proof_factor:.1f} MPa"],
                ["Autofrettage", "none (Type IV)" if lmat.polymer else (f"{st.autofrettage_pressure:.1f} MPa" if st else "-")],
                ["Predicted burst", f"{st.burst_pressure:.1f} MPa ({st.burst_mode}-first), required {st.required_burst:.1f} MPa" if st else "-"],
                ["Fibre / resin", f"{fiber.name} / {resin.name}, Vf {comp.fiber_volume_fraction:.2f}"],
                ["Mass", f"liner {res.mass.liner:.0f} g, fibre {res.mass.fiber:.0f} g, resin {res.mass.resin:.0f} g, total {res.mass.total:.0f} g"],
            ],
        ),
        "",
        "## Bill of materials",
        "",
    ]
    fib_len = sum(L.fiber_length * project.layers[L.index].tows for L in res.layers)
    fib_g = sum(L.fiber_mass for L in res.layers)
    res_g = sum(L.resin_mass for L in res.layers)
    md.append(_table(
        ["Material", "Quantity", "Incl. 15% allowance", "Lot no."],
        [
            [fiber.name, f"{fib_len:.0f} m tow / {fib_g:.0f} g", f"{fib_len * 1.15:.0f} m / {fib_g * 1.15:.0f} g", "________"],
            [resin.name + " (mixed)", f"{res_g:.0f} g", f"{res_g * 1.15:.0f} g", "________"],
            [lmat.name + " liner", "1", "1", "________"],
        ],
    ))
    md += [
        "",
        "## Preparation",
        "",
        "- [ ] Liner serial recorded, visual inspection of the outer surface and boss threads",
        "- [ ] Liner degreased and surface prepared (abrade / primer per process spec)",
        "- [ ] Boss sealing surfaces and threads protected",
        "- [ ] Liner mounted on the winding shaft; runout measured: ______ mm (max 0.5 mm)",
        "- [ ] Machine homed; mandrel angle zero set; carriage mid-plane offset verified "
        f"({mach.carriage_offset} mm)",
        "- [ ] Resin mixed at ______ (time), bath temperature ______ °C, pot life until ______",
        "- [ ] Tension calibrated; band width measured at the eye: ______ mm",
    ]
    sup = next((c for c in res.checks if c.id == "liner.support"), None)
    if sup is not None:
        md.append(f"- [ ] Liner pressurised for winding: ≥ **{max(sup.value or 0.0, 0.0) * 10:.1f} bar** "
                  "(polymer liner; check it holds pressure). Actual: ______ bar")
    md += ["", "## Winding sequence", ""]
    if project.continuous.enabled:
        md += [f"Continuous winding: **do not cut the roving between layers**. The G-code contains the transition "
               f"passes (angle step ≤ {project.continuous.max_angle_step:g}°); pauses between layers are skipped.",
               ""]
    rows = []
    for L in res.layers:
        spec = project.layers[L.index]
        if L.type == "helical" and L.pattern:
            pat = f"{L.pattern.n_bands}/{L.pattern.shift} (p{L.pattern.pattern_number}), dwell {L.pattern.dwell:.1f}°"
            extent = (f"r0 {L.turnaround_a:.1f} / {L.turnaround_b:.1f} mm"
                      if L.turnaround_a is not None and abs(L.turnaround_a - L.turnaround_b) > 0.05
                      else f"r0 {L.turnaround_radius:.1f} mm")
        else:
            pat = f"{spec.passes} passes"
            extent = f"z {L.z_start:.0f} … {L.z_end:.0f} mm"
        rows.append([
            str(L.index + 1), L.type, f"{L.angle:.2f}°", f"{spec.tows} × {spec.band_width} mm", f"{spec.tension:.0f} N",
            pat, extent, f"{L.thickness:.3f}", f"{L.wind_time / 60:.0f} min", "☐ ____",
        ])
    md.append(_table(["#", "Type", "Angle", "Band", "Tension", "Pattern", "Extent", "t [mm]", "Time", "Done / initials"], rows))
    md += [
        "",
        "Record for every layer: start/end time, band gaps or overlaps, fibre breaks and splices, resin top-ups.",
        "",
        "## Cure",
        "",
    ]
    cr = res.cure
    if cr is not None:
        md.append(_table(["Step", "Ramp [K/min]", "Set point [°C]", "Hold [min]", "Actual (ramp / T / hold)"],
                         [[str(i + 1), f"{c.ramp:g}", f"{c.temperature:g}", f"{c.hold:g}", "______ / ______ / ______"]
                          for i, c in enumerate(cr.cycle)]))
        md += ["", f"Then cool at ≤ 2 K/min to ambient; total about {cr.duration / 60:.1f} h. Keep the part rotating.",
               "", _table(["Predicted", *[x.name for x in cr.sections]], [
                   ["Composite thickness", *[f"{x.thickness:.1f} mm" for x in cr.sections]],
                   ["Exotherm (rise from reaction heat)", *[f"{x.overshoot:.1f} K" for x in cr.sections]],
                   ["Peak liner temperature", *[f"{x.peak_liner:.0f} °C" for x in cr.sections]],
                   ["Final degree of cure (least cured)", *[f"{x.min_cure:.2f}" for x in cr.sections]],
                   ["Tg (least cured)", *[f"{x.tg_final:.0f} °C" for x in cr.sections]],
               ]), ""]
    else:
        md.append(f"- [ ] Rotating cure: {resin.cure or 'per resin datasheet'}")
    md += [
        "- [ ] Thermocouples on the laminate surface and, if possible, at the liner; cure log attached",
        "- [ ] Post-cure visual inspection (dry spots, wrinkles, bridging at the domes)",
        "- [ ] Mass after cure: ______ g (predicted " + f"{res.mass.total:.0f} g)",
        "",
        "## Autofrettage and proof",
        "",
    ]
    if st and lmat.polymer:
        md += [
            "- [ ] No autofrettage (Type IV).",
            f"- [ ] Proof: **{req.meop * req.proof_factor:.1f} MPa**, hold ≥ {req.hold_time:g} s; record volumetric "
            f"expansion (predicted {st.expansion_af_total:.0f} mL total)",
            "- [ ] Leak / permeation test at MEOP: ______",
        ]
    elif st:
        md += [
            f"- [ ] Autofrettage: pressurise to **{st.autofrettage_pressure:.1f} MPa**, hold 60 s, vent; record volumetric expansion",
            f"- [ ] Proof: **{req.meop * req.proof_factor:.1f} MPa**, hold ≥ 60 s; permanent volumetric expansion ≤ 5 % of total",
            "- [ ] Leak test at MEOP with helium or He/N2 mix: ______",
            f"- [ ] Expected liner residual hoop stress after autofrettage: {st.residual.liner_hoop:.0f} MPa",
            f"- [ ] Water jacket: expected expansion at autofrettage {st.expansion_af_total:.0f} mL total, "
            f"{st.expansion_af_permanent:.0f} mL permanent; at proof {st.expansion_proof_total:.0f} mL total, "
            f"~{max(st.expansion_proof_permanent, 0):.0f} mL permanent. Measured: ______ / ______ mL",
        ]
    md += [
        "",
        "## Release",
        "",
        "Inspected by ________ · Date ________ · Disposition: ☐ accept ☐ rework ☐ reject",
        "",
        "> Generated by WindLab. Pressure testing is hazardous: use a barricaded test cell and remote operation.",
    ]
    text = "\n".join(md)
    return {"markdown": text, "html": _md_to_html(text)}


def _md_to_html(md: str) -> str:
    """Tiny Markdown subset renderer (headings, tables, lists, paragraphs, bold)."""
    import re

    def inline(s: str) -> str:
        s = html.escape(s)
        return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)

    out: list[str] = []
    lines = md.split("\n")
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("# "):
            out.append(f"<h1>{inline(ln[2:])}</h1>")
        elif ln.startswith("## "):
            out.append(f"<h2>{inline(ln[3:])}</h2>")
        elif ln.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].strip("|").split("|")])
                i += 1
            head, body = rows[0], rows[2:]
            out.append("<table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr></thead><tbody>")
            out += ["<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body]
            out.append("</tbody></table>")
            continue
        elif ln.startswith("- "):
            out.append("<ul>")
            while i < len(lines) and lines[i].startswith("- "):
                item = lines[i][2:].replace("[ ] ", "☐ ")
                out.append(f"<li>{inline(item)}</li>")
                i += 1
            out.append("</ul>")
            continue
        elif ln.startswith("> "):
            out.append(f"<blockquote>{inline(ln[2:])}</blockquote>")
        elif ln.strip():
            out.append(f"<p>{inline(ln)}</p>")
        i += 1
    return "\n".join(out)
