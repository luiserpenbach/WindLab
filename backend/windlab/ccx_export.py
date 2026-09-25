"""CalculiX export: axisymmetric solid model of the whole vessel (open-source solver).

Mesh: the liner and every wound layer are element rows between consecutive
surfaces (liner inner, liner outer, each layer's top), columns along the
meridian. CAX8 quadratic quads, CAX6 triangles where a layer ends (its top
collapses onto the surface below); rows of zero thickness are skipped.

Materials: liner isotropic with isotropic hardening plasticity and CTE;
each balanced +/-alpha pair as an orthotropic material (local 1 = meridian,
2 = through-thickness, 3 = hoop) with orthotropic CTEs, oriented per column.

Loads: cure cool-down from the stress-free temperature, then autofrettage,
proof and MEOP cycles; pressure on the liner inner face; the pressure on the
polar opening acts on the end face of the liner at boss B; rigid-ring ends
(radial displacement fixed at both poles, axial at pole A).
"""
from __future__ import annotations

import io
import math

import numpy as np

from . import __version__
from . import schemas as S
from .core import shellfe
from .core.design import build, structural
from .core.materials import get_liner

TOL = 0.01  # mm: layer thickness below which its top surface collapses onto the one below
ANGLE_BIN = 0.25


def _engineering(ply, a_deg: float) -> tuple:
    """Orthotropic constants of a balanced +/-a pair in (meridian 1, normal 2, hoop 3) axes."""
    Q11, Q12, Q22, Q66 = ply.Q()
    q11, q12, q22 = shellfe._qbar(Q11, Q12, Q22, Q66, math.radians(a_deg))
    Sm = np.linalg.inv(np.array([[q11, q12], [q12, q22]]))
    Es, Et = 1 / Sm[0, 0], 1 / Sm[1, 1]
    nu_st = -Sm[0, 1] / Sm[0, 0]
    c, s = math.cos(math.radians(a_deg)), math.sin(math.radians(a_deg))
    G_st = (Q11 + Q22 - 2 * Q12) * s**2 * c**2 + Q66 * (c**2 - s**2) ** 2
    En = ply.E2
    nu_sn = 0.3  # in-plane load -> through-thickness strain (major ratio of the stiff direction)
    nu_nt = 0.3 * En / Et  # through-thickness load -> hoop strain (minor ratio, symmetric compliance)
    Gn = ply.G12
    a_s = ply.alpha1 * c**2 + ply.alpha2 * s**2
    a_t = ply.alpha1 * s**2 + ply.alpha2 * c**2
    # CalculiX order: E1 E2 E3 nu12 nu13 nu23 G12 G13 G23 with 1 = meridian, 2 = normal, 3 = hoop
    return (Es, En, Et, nu_sn, nu_st, nu_nt, Gn, G_st, Gn), (a_s, ply.alpha2, a_t)


def export(project: S.Project, max_len: float = 4.0) -> dict:
    b = build(project)
    if not b.layers:
        raise ValueError("Nothing to export: the layup is empty")
    st, _ = structural(b)
    req, lin, comp = project.requirements, project.liner, project.composite
    mat = get_liner(lin.material, project.materials)
    fidx = shellfe._mesh(b, max_len=max_len)
    surfaces = [b.liner_inner, b.liner_outer] + [bl.top for bl in b.layers]
    Z = np.array([shellfe._interp_idx(sf.z, fidx) for sf in surfaces])  # (n_surf, n_col)
    R = np.array([shellfe._interp_idx(sf.r, fidx) for sf in surfaces])
    n_surf, n_col = Z.shape

    node_xy: list[tuple[float, float]] = []
    node_id = np.zeros((n_surf, n_col), dtype=int)
    for m in range(n_surf):
        for j in range(n_col):
            if m >= 2 and math.hypot(Z[m, j] - Z[m - 1, j], R[m, j] - R[m - 1, j]) < TOL:
                node_id[m, j] = node_id[m - 1, j]
                continue
            node_xy.append((R[m, j], Z[m, j]))
            node_id[m, j] = len(node_xy)
    mids: dict[tuple[int, int], int] = {}

    def mid(a: int, c: int) -> int:
        key = (min(a, c), max(a, c))
        if key not in mids:
            pa, pc = node_xy[a - 1], node_xy[c - 1]
            node_xy.append((0.5 * (pa[0] + pc[0]), 0.5 * (pa[1] + pc[1])))
            mids[key] = len(node_xy)
        return mids[key]

    quads, tris = [], []  # (eid, nodes, row, col, inner_face or None, end_face or None)
    elsets: dict[tuple[str, int], list[int]] = {}  # (material, column) -> element ids
    pressure_faces: list[tuple[int, str]] = []
    boss_faces: list[tuple[int, str]] = []
    materials: dict[str, tuple] = {}
    eid = 0
    for m in range(n_surf - 1):
        if m == 0:
            mat_of = lambda j: "LINER"  # noqa: E731
        else:
            bl = b.layers[m - 1]
            fid = "F_" + "".join(ch if ch.isalnum() else "_" for ch in bl.fiber.id).upper()

            def mat_of(j, bl=bl, fid=fid):
                s_mid = shellfe._interp_idx(bl.base.s, 0.5 * (fidx[j] + fidx[j + 1]))
                a = float(np.degrees(bl.gp.alpha_at_s(np.array([s_mid]))[0])) if bl.gp is not None \
                    else math.degrees(bl.angle)
                a = round(a / ANGLE_BIN) * ANGLE_BIN
                name = f"{fid}_A{a:06.2f}".replace(".", "P")
                if name not in materials:
                    materials[name] = _engineering(bl.ply, a)
                return name
        for j in range(n_col - 1):
            c = [node_id[m, j], node_id[m + 1, j], node_id[m + 1, j + 1], node_id[m, j + 1]]
            corners = [c[0], c[1], c[2], c[3]]
            pts = np.array([node_xy[k - 1] for k in corners])
            area = 0.5 * np.sum(pts[:, 0] * np.roll(pts[:, 1], -1) - np.roll(pts[:, 0], -1) * pts[:, 1])
            flip = area < 0
            if flip:
                corners = [c[3], c[2], c[1], c[0]]
            uniq = list(dict.fromkeys(corners))
            if len(uniq) < 3:
                continue
            eid += 1
            name = mat_of(j)
            elsets.setdefault((name, j), []).append(eid)
            if len(uniq) == 4:
                nodes = corners + [mid(corners[0], corners[1]), mid(corners[1], corners[2]),
                                   mid(corners[2], corners[3]), mid(corners[3], corners[0])]
                quads.append((eid, nodes))
                if m == 0:
                    # inner edge: c[3]-c[0] (face 4) unflipped, c[0]-c[3] -> corners[2]-corners[3] (face 3) flipped
                    pressure_faces.append((eid, "P4"))  # inner edge: node 4 -> node 1 either way
                    if j == n_col - 2:
                        boss_faces.append((eid, "P1" if flip else "P3"))
            else:
                # triangle: drop the collapsed corner, keep counter-clockwise order
                t = [k for k in corners]
                for i in range(4):
                    if t[i] == t[(i + 1) % 4]:
                        del t[(i + 1) % 4]
                        break
                nodes = t + [mid(t[0], t[1]), mid(t[1], t[2]), mid(t[2], t[0])]
                tris.append((eid, nodes))

    out = io.StringIO()
    w = out.write
    w(f"** WindLab {__version__} - {project.name}: CalculiX axisymmetric solid model (mm, N, MPa, degC)\n")
    w("** x = radius, y = axis; CAX8/CAX6; liner + one element row per wound layer\n")
    w("*HEADING\n" + project.name + "\n*NODE, NSET=NALL\n")
    for i, (x, y) in enumerate(node_xy, 1):
        w(f"{i}, {x:.6f}, {y:.6f}\n")
    if quads:
        w("*ELEMENT, TYPE=CAX8, ELSET=EQUAD\n")
        for e, nodes in quads:
            w(f"{e}, " + ", ".join(map(str, nodes)) + "\n")
    if tris:
        w("*ELEMENT, TYPE=CAX6, ELSET=ETRI\n")
        for e, nodes in tris:
            w(f"{e}, " + ", ".join(map(str, nodes)) + "\n")
    # orientation per column: local 1 = meridian tangent, 2 = outward normal (in the r-z plane)
    zc, rc = shellfe._interp_idx(b.liner_outer.z, fidx), shellfe._interp_idx(b.liner_outer.r, fidx)
    for j in range(n_col - 1):
        tz, tr = zc[j + 1] - zc[j], rc[j + 1] - rc[j]
        L = math.hypot(tz, tr) or 1.0
        tz, tr = tz / L, tr / L
        w(f"*ORIENTATION, NAME=OR{j + 1}, SYSTEM=RECTANGULAR\n{tr:.6f}, {tz:.6f}, 0., {tz:.6f}, {-tr:.6f}, 0.\n")
    for (name, j), els in elsets.items():
        w(f"*ELSET, ELSET=S_{name}_{j + 1}\n")
        for k in range(0, len(els), 12):
            w(", ".join(map(str, els[k:k + 12])) + "\n")
        if name == "LINER":
            w(f"*SOLID SECTION, ELSET=S_{name}_{j + 1}, MATERIAL=LINER\n")
        else:
            w(f"*SOLID SECTION, ELSET=S_{name}_{j + 1}, MATERIAL={name}, ORIENTATION=OR{j + 1}\n")
    eps_u = max(mat.elongation - mat.yield_ / mat.E, 1e-3)
    w(f"*MATERIAL, NAME=LINER\n*ELASTIC\n{mat.E:g}, {mat.nu:g}\n*PLASTIC\n{mat.yield_:g}, 0.\n"
      f"{mat.yield_ + mat.hardening * eps_u:g}, {eps_u:.5f}\n*EXPANSION, ZERO={comp.cure_temperature:g}\n"
      f"{mat.cte:.4e}\n")
    for name, (ec, ac) in sorted(materials.items()):
        w(f"*MATERIAL, NAME={name}\n*ELASTIC, TYPE=ENGINEERING CONSTANTS\n")
        w(", ".join(f"{v:.6g}" for v in ec[:8]) + "\n" + f"{ec[8]:.6g}\n")
        w(f"*EXPANSION, TYPE=ORTHO, ZERO={comp.cure_temperature:g}\n{ac[0]:.4e}, {ac[1]:.4e}, {ac[2]:.4e}\n")
    # boundary node sets
    end_a = sorted({int(node_id[m, 0]) for m in range(n_surf)})
    end_b = sorted({int(node_id[m, -1]) for m in range(n_surf)})
    for nm, ids in (("POLE_A", end_a), ("POLE_B", end_b)):
        w(f"*NSET, NSET={nm}\n" + ", ".join(map(str, ids)) + "\n")
    # monitoring: through-thickness column at the cylinder mid-plane
    jm = int(np.argmin(np.abs(zc)))
    mid_nodes = sorted({int(node_id[m, jm]) for m in range(n_surf)})
    w("*NSET, NSET=MIDPLANE\n" + ", ".join(map(str, mid_nodes)) + "\n")
    w("*BOUNDARY\nPOLE_A, 1, 2\nPOLE_B, 1, 1\n")
    w(f"*INITIAL CONDITIONS, TYPE=TEMPERATURE\nNALL, {comp.cure_temperature:g}\n")
    ri_b = float(shellfe._interp_idx(b.liner_inner.r, fidx)[-1])
    ro_b = float(shellfe._interp_idx(b.liner_outer.r, fidx)[-1])
    boss_p = ri_b**2 / max(ro_b**2 - ri_b**2, 1e-9)  # opening load spread over the liner end face, per MPa
    steps = [("CURE", 0.0), ("AUTOFRETTAGE", st.autofrettage_pressure), ("UNLOAD_AF", 0.0),
             ("PROOF", req.meop * req.proof_factor), ("UNLOAD_PROOF", 0.0), ("MEOP", req.meop), ("UNLOAD_MEOP", 0.0)]
    for name, p in steps:
        w(f"*STEP, INC=500\n*STATIC\n0.1, 1., 1e-5, 0.25\n")
        w(f"*TEMPERATURE\nNALL, {req.temperature_ref:g}\n")
        w("*DLOAD, OP=NEW\n")
        for e, face in pressure_faces:
            w(f"{e}, {face}, {p:.5f}\n")
        for e, face in boss_faces:
            w(f"{e}, {face}, {-p * boss_p:.5f}\n")
        w("*NODE PRINT, NSET=MIDPLANE\nU\n*NODE FILE\nU\n*EL FILE\nS, E, PEEQ\n*END STEP\n")
    slug = "".join(ch if ch.isalnum() else "_" for ch in project.name).strip("_") or "windlab"
    return {"filename": f"{slug}_ccx.inp", "inp": out.getvalue(), "elements": eid, "nodes": len(node_xy),
            "materials": len(materials) + 1, "steps": [s_[0] for s_ in steps],
            "midplane_nodes": mid_nodes, "midplane_radius": [float(R[m, jm]) for m in range(n_surf)]}


def parse_midplane(dat_text: str) -> dict[float, dict[int, tuple[float, float]]]:
    """Mid-plane nodal displacements from a CalculiX .dat file: {total time: {node: (u_r, u_z)}}."""
    import re

    out: dict[float, dict[int, tuple[float, float]]] = {}
    parts = re.split(r"displacements \(vx,vy,vz\) for set MIDPLANE and time\s+([0-9.Ee+-]+)", dat_text)
    for k in range(1, len(parts), 2):
        t = float(parts[k])
        rows = {}
        for line in parts[k + 1].splitlines():
            f = line.split()
            if len(f) >= 3 and f[0].isdigit():
                rows[int(f[0])] = (float(f[1]), float(f[2]))
        out[t] = rows
    return out


def run_and_compare(project: S.Project, workdir: str, max_len: float = 8.0, ccx: str = "ccx") -> list[dict]:
    """Export, run CalculiX and compare the mid-cylinder hoop strains with WindLab's cylinder model."""
    import os
    import subprocess

    meta = export(project, max_len=max_len)
    os.makedirs(workdir, exist_ok=True)
    with open(os.path.join(workdir, "vessel.inp"), "w") as f:
        f.write(meta["inp"])
    subprocess.run([ccx, "-i", "vessel"], cwd=workdir, check=True, capture_output=True, timeout=3600)
    with open(os.path.join(workdir, "vessel.dat")) as f:
        res = parse_midplane(f.read())
    b = build(project)
    st, _ = structural(b)
    af_peak = max((h for h in st.history if h.phase == "autofrettage"), key=lambda h: h.pressure)
    ours = {"CURE": st.cure_residual, "AUTOFRETTAGE": af_peak, "UNLOAD_AF": st.residual, "PROOF": st.at_proof,
            "MEOP": st.at_meop}
    inner, outer = meta["midplane_nodes"][0], meta["midplane_nodes"][-1]
    r_in, r_out = meta["midplane_radius"][0], meta["midplane_radius"][-1]
    rows = []
    for i, name in enumerate(meta["steps"]):
        u = res.get(float(i + 1))
        if u is None or name not in ours:
            continue
        rows.append({"step": name, "ccx_inner": u[inner][0] / r_in, "ccx_outer": u[outer][0] / r_out,
                     "windlab": ours[name].strain_hoop})
    return rows
