"""FEA export: Abaqus axisymmetric composite shell model + solver-neutral layup CSV.

The mesh, stack-up and boundary conditions match WindLab's own shell FE:
SAX1 elements on the liner outer surface, one composite section per element
(liner + every layer present there, bottom = inner side), each balanced
+/-alpha pair homogenised into an orthotropic lamina in meridional (1) / hoop
(2) axes, liner with isotropic hardening plasticity, rigid-ring bosses and the
pressure on the opening carried by the boss at end B.

Steps: autofrettage -> unload -> proof -> unload -> MEOP -> unload.
"""
from __future__ import annotations

import io
import math

import numpy as np

from . import __version__
from . import schemas as S
from .core import shellfe
from .core.design import build
from .core.materials import get_liner

ANGLE_BIN = 0.25  # deg: plies are grouped into materials by angle


def _lamina(Q, a_deg: float) -> tuple[float, float, float, float]:
    Q11, Q12, Q22, Q66 = Q
    q11, q12, q22 = shellfe._qbar(Q11, Q12, Q22, Q66, math.radians(a_deg))
    Sm = np.linalg.inv(np.array([[q11, q12], [q12, q22]]))
    E1, E2 = 1 / Sm[0, 0], 1 / Sm[1, 1]
    nu12 = -Sm[0, 1] / Sm[0, 0]
    c, s = math.cos(math.radians(a_deg)), math.sin(math.radians(a_deg))
    G = (Q11 + Q22 - 2 * Q12) * s**2 * c**2 + Q66 * (c**2 - s**2) ** 2
    return E1, E2, nu12, G


def export(project: S.Project, p_af: float | None = None) -> dict[str, str]:
    from .core.design import structural

    b = build(project)
    if not b.layers:
        raise ValueError("Nothing to export: the layup is empty")
    st, _ = structural(b)
    p_af = p_af or st.autofrettage_pressure
    req = project.requirements
    lin = project.liner
    mat = get_liner(lin.material, project.materials)
    prof = b.liner_outer
    fidx = shellfe._mesh(b)
    zn = shellfe._interp_idx(prof.z, fidx)
    rn = shellfe._interp_idx(prof.r, fidx)
    zi = shellfe._interp_idx(b.liner_inner.z, fidx)
    ri = shellfe._interp_idx(b.liner_inner.r, fidx)
    ri_end = float(ri[-1])
    # Abaqus applies shell pressure on the reference surface (liner outer): scale each element by the ratio
    # of inner to reference surface area so the resultant is the pressure on the liner inner surface
    area_ratio = (0.5 * (ri[1:] + ri[:-1]) * np.hypot(np.diff(zi), np.diff(ri))) / np.maximum(
        0.5 * (rn[1:] + rn[:-1]) * np.hypot(np.diff(zn), np.diff(rn)), 1e-12)
    fmid = 0.5 * (fidx[1:] + fidx[:-1])
    sec = shellfe.sections(b, fmid)
    n = len(zn)

    mats: dict[str, tuple] = {}
    out = io.StringIO()
    w = out.write
    w(f"** WindLab {__version__} - {project.name}\n")
    w("** Axisymmetric composite shell model of the full Type III COPV (units: mm, N, MPa)\n")
    w("** Check: element normals point outwards (nodes ordered pole B -> pole A); plies listed inner -> outer.\n")
    w("*HEADING\n")
    w(f"{project.name} - WindLab export\n")
    w("*NODE, NSET=ALLN\n")
    for i in range(n):
        w(f"{i + 1}, {rn[i]:.6f}, {zn[i]:.6f}\n")
    w("*ELEMENT, TYPE=SAX1, ELSET=VESSEL\n")
    for e in range(n - 1):
        # reversed order: positive normal points out of the vessel
        w(f"{e + 1}, {e + 2}, {e + 1}\n")
    csv = io.StringIO()
    csv.write("element,z_mid,r_mid,liner_t," + ",".join(f"{L.spec.id}_t,{L.spec.id}_angle"
                                                      for L in b.layers) + "\n")
    t_all = np.diff(sec.z_bot, axis=1)
    for e in range(n - 1):
        plies = [(float(t_all[e, 0]), "LINER", 0.0)]
        for k, L in enumerate(b.layers):
            t = float(t_all[e, k + 1])
            if t < 1e-4:
                continue
            a = round(math.degrees(sec.angles[e, k]) / ANGLE_BIN) * ANGLE_BIN
            fid = "F_" + "".join(ch if ch.isalnum() else "_" for ch in L.fiber.id).upper()
            name = f"{fid}_A{a:06.2f}".replace(".", "P")
            mats[name] = _lamina(L.ply.Q(), a) + (L.ply.G12,)
            plies.append((t, name, 0.0))
        total = sum(p[0] for p in plies)
        # reference surface = liner outer surface (z = 0); mid-surface at (t_comp - t_liner) / 2
        mid = (total - 2 * plies[0][0]) / 2
        offset = -mid / total
        w(f"*ELSET, ELSET=E{e + 1}\n{e + 1}\n")
        w(f"*SHELL SECTION, ELSET=E{e + 1}, COMPOSITE, OFFSET={offset:.6f}\n")
        for t, name, ang in plies:
            w(f"{t:.6f}, 3, {name}, {ang:g}\n")
        zm, rm = 0.5 * (zn[e] + zn[e + 1]), 0.5 * (rn[e] + rn[e + 1])
        csv.write(f"{e + 1},{zm:.3f},{rm:.3f},{t_all[e, 0]:.4f}," + ",".join(
            f"{t_all[e, k + 1]:.4f},{math.degrees(sec.angles[e, k]):.3f}" for k in range(len(b.layers))) + "\n")
    w("*MATERIAL, NAME=LINER\n*ELASTIC\n")
    w(f"{mat.E:g}, {mat.nu:g}\n*PLASTIC\n")
    eps_u = max(mat.elongation - mat.yield_ / mat.E, 1e-3)
    w(f"{mat.yield_:g}, 0.\n{mat.yield_ + mat.hardening * eps_u:g}, {eps_u:.5f}\n")
    for name, (E1, E2, nu12, G, G13) in sorted(mats.items()):
        w(f"*MATERIAL, NAME={name}\n*ELASTIC, TYPE=LAMINA\n")
        w(f"{E1:.1f}, {E2:.1f}, {nu12:.5f}, {G:.1f}, {G13:.1f}, {G13:.1f}\n")
    last = n
    w("*NSET, NSET=BOSS_A\n1\n")
    w(f"*NSET, NSET=BOSS_B\n{last}\n")
    w("*BOUNDARY\nBOSS_A, 1, 2\nBOSS_A, 5, 5\nBOSS_B, 1, 1\nBOSS_B, 5, 5\n")
    boss_force = math.pi * ri_end**2  # per MPa, carried by the end-B boss
    fibre_eps = b.ply.eps1_ult
    steps = [("AUTOFRETTAGE", p_af), ("UNLOAD_AF", 0.0), ("PROOF", req.meop * req.proof_factor),
             ("UNLOAD_PROOF", 0.0), ("MEOP", req.meop), ("UNLOAD_MEOP", 0.0)]
    for name, p in steps:
        w(f"*STEP, NAME={name}, INC=200\n*STATIC\n0.05, 1., 1e-6, 0.25\n")
        w("*DLOAD, OP=NEW\n")
        for e in range(n - 1):
            w(f"{e + 1}, P, {-p * area_ratio[e]:.5f}\n")
        w(f"*CLOAD, OP=NEW\nBOSS_B, 2, {boss_force * p:.3f}\n")
        w("*OUTPUT, FIELD\n*NODE OUTPUT\nU\n*ELEMENT OUTPUT, DIRECTIONS=YES\nS, E, PEEQ\n*END STEP\n")
    w(f"** Fibre failure strain (delivered, fibre direction): {fibre_eps:.5f}\n")
    slug = "".join(ch if ch.isalnum() else "_" for ch in project.name).strip("_") or "windlab"
    return {"filename": f"{slug}.inp", "inp": out.getvalue(), "csv": csv.getvalue(),
            "csv_filename": f"{slug}_layup.csv", "elements": n - 1, "materials": len(mats) + 1}
