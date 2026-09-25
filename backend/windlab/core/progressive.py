"""Progressive failure analysis of the whole vessel (nonlinear axisymmetric shell).

Same kinematics as ``shellfe`` (Kirchhoff shell of revolution on the liner outer surface, conical elements,
Hermite bending), but the material response is integrated through the thickness at every Gauss point:

* liner: 5 integration points through the wall, J2 plane-stress plasticity with isotropic hardening,
  history carried through the whole pressure sequence, thermal strain;
* every wound layer (balanced +/-alpha pair, or hoop) as a ply group with its own local angle and
  thickness, thermal strain, and damage state:
    - inter-fibre failure (matrix cracking): Puck's plane-stress criterion (modes A, B, C) with the
      inclination parameters recommended for CFRP; on failure E2 and G12 are degraded (Puck's
      recommended residual stiffness ~10 %);
    - fibre failure: delivered fibre-direction strain (tension) / compressive strain limit; the ply is
      discounted (1e-3 residual stiffness).

Load history: cure cool-down, autofrettage, unload, proof, unload, MEOP, unload, then a burst ramp. At
every load level the structure is re-equilibrated after each new failure until the damage state is stable.
Burst is the pressure at which equilibrium can no longer be found (fibre failure through the wall, runaway
deformation) - the model captures load redistribution from failed plies and from the yielding liner.

Assumptions: small strains (geometric nonlinearity neglected), balanced angle-ply pairs without shear
coupling, bosses as rigid rings, no delamination.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import splu

from .design import Build
from .materials import get_liner
from .shellfe import _G, _GW, _interp_idx, _mesh

from .failure import COMPRESSIVE_STRAIN_RATIO, FF_RESIDUAL, IFF_RESIDUAL, puck_iff

NL = 5  # liner integration points through the thickness


@dataclass
class Event:
    pressure: float
    phase: str
    kind: str  # liner_yield | iff | ff | liner_rupture | burst
    layer: int  # -1 = liner
    z: float


@dataclass
class ProgressiveResult:
    burst_pressure: float
    burst_z: float
    burst_layer: int
    events: list[Event]
    curve_p: list[float]  # burst ramp pressures
    curve_strain: list[float]  # mid-cylinder hoop strain (liner outer surface)
    z: np.ndarray  # element mid positions
    ff_at_burst: np.ndarray  # (n_layers, n_el) fraction of Gauss points with fibre failure
    iff_at_burst: np.ndarray
    liner_peeq_at_burst: np.ndarray  # (n_el,) max equivalent plastic strain
    first_iff_pressure: float | None = None
    first_ff_pressure: float | None = None
    liner_yield_pressure: float | None = None
    notes: list[str] = field(default_factory=list)


class _Model:
    def __init__(self, b: Build, max_len: float = 4.0):
        self.b = b
        prof = b.liner_outer
        fidx = _mesh(b, max_len)
        zn, rn = _interp_idx(prof.z, fidx), _interp_idx(prof.r, fidx)
        self.zn, self.rn = zn, rn
        n = len(zn)
        E = n - 1
        self.n, self.E = n, E
        L = np.hypot(np.diff(zn), np.diff(rn))
        c, s = np.diff(zn) / L, np.diff(rn) / L
        G = len(_G)
        # local -> global transformation per element
        T = np.zeros((E, 6, 6))
        for o in (0, 3):
            T[:, o, o], T[:, o, o + 1] = c, s
            T[:, o + 1, o], T[:, o + 1, o + 1] = -s, c
            T[:, o + 2, o + 2] = 1.0
        Bm = np.zeros((E, G, 4, 6))
        dA = np.zeros((E, G))
        fp = np.zeros((E, 6))
        zi, ri = _interp_idx(b.liner_inner.z, fidx), _interp_idx(b.liner_inner.r, fidx)
        L_in = np.hypot(np.diff(zi), np.diff(ri))
        n_in = np.stack([-np.diff(ri), np.diff(zi)], axis=1) / np.maximum(L_in, 1e-12)[:, None]
        for g, (xi, wg) in enumerate(zip(_G, _GW)):
            r = rn[:-1] + (rn[1:] - rn[:-1]) * xi
            H = np.stack([np.full(E, 1 - 3 * xi**2 + 2 * xi**3), L * (xi - 2 * xi**2 + xi**3),
                          np.full(E, 3 * xi**2 - 2 * xi**3), L * (-(xi**2) + xi**3)], axis=1)
            dH = np.stack([np.full(E, -6 * xi + 6 * xi**2), L * (1 - 4 * xi + 3 * xi**2),
                           np.full(E, 6 * xi - 6 * xi**2), L * (-2 * xi + 3 * xi**2)], axis=1) / L[:, None]
            d2H = np.stack([np.full(E, -6 + 12 * xi), L * (-4 + 6 * xi), np.full(E, 6 - 12 * xi),
                            L * (-2 + 6 * xi)], axis=1) / (L**2)[:, None]
            Nu = np.array([1 - xi, xi])
            Bm[:, g, 0, 0], Bm[:, g, 0, 3] = -1 / L, 1 / L
            Bm[:, g, 1, 0], Bm[:, g, 1, 3] = Nu[0] * s / r, Nu[1] * s / r
            Bm[:, g, 1, [1, 2, 4, 5]] = H * (c / r)[:, None]
            Bm[:, g, 2, [1, 2, 4, 5]] = -d2H
            Bm[:, g, 3, [1, 2, 4, 5]] = -(s / r)[:, None] * dH
            dA[:, g] = 2 * math.pi * r * L * wg
            r_in = ri[:-1] + (ri[1:] - ri[:-1]) * xi
            f = 2 * math.pi * r_in * L_in * wg
            fu = f * (n_in[:, 0] * c + n_in[:, 1] * s)
            fw = f * (-n_in[:, 0] * s + n_in[:, 1] * c)
            fp[:, 0] += Nu[0] * fu
            fp[:, 3] += Nu[1] * fu
            fp[:, [1, 2, 4, 5]] += H * fw[:, None]
        self.BT = np.einsum("egij,ejk->egik", Bm, T)  # global-dof B matrices
        self.dA = dA
        self.dof = np.stack([3 * np.arange(E) + k for k in range(6)], axis=1)
        Fp = np.zeros(3 * n)
        np.add.at(Fp, self.dof.ravel(), np.einsum("eij,ei->ej", T, fp).ravel())
        Fp[3 * (n - 1)] += math.pi * ri[-1] ** 2  # opening load on boss B
        self.Fp = Fp
        self.fixed = np.array([0, 1, 2, 3 * (n - 1) + 1, 3 * (n - 1) + 2])
        self.free = np.setdiff1d(np.arange(3 * n), self.fixed)
        self.z_el = 0.5 * (zn[1:] + zn[:-1])
        self.r_el = 0.5 * (rn[1:] + rn[:-1])

        # ---- section: liner through-thickness points, ply groups
        fmid = 0.5 * (fidx[1:] + fidx[:-1])
        wall = np.hypot(b.liner_outer.z - b.liner_inner.z, b.liner_outer.r - b.liner_inner.r)
        t_l = _interp_idx(wall, fmid)
        xi_l = (np.arange(NL) + 0.5) / NL
        self.z_l = -t_l[:, None] * (1 - xi_l[None, :])  # (E, NL) from inner (-t) to outer (0)
        self.w_l = np.repeat((t_l / NL)[:, None], NL, axis=1)
        lin = b.project.liner
        self.lmat = get_liner(lin.material, b.project.materials)
        m = self.lmat
        self.Cl = m.E / (1 - m.nu**2) * np.array([[1.0, m.nu], [m.nu, 1.0]])
        K = len(b.layers)
        self.K = K
        zb = np.zeros((E, K + 1))
        ang = np.zeros((E, K))
        for k, bl in enumerate(b.layers):
            t = np.maximum(_interp_idx(bl.thickness, fmid), 0.0)
            zb[:, k + 1] = zb[:, k] + t
            if bl.spec.type == "helical" and bl.gp is not None:
                ang[:, k] = bl.gp.alpha_at_s(_interp_idx(bl.base.s, fmid))
            else:
                ang[:, k] = bl.angle
        self.t_k = np.diff(zb, axis=1)  # (E, K)
        self.z_k = 0.5 * (zb[:, 1:] + zb[:, :-1])
        self.present = self.t_k > 1e-4
        self.c2, self.s2 = np.cos(ang) ** 2, np.sin(ang) ** 2
        self.sc = np.sin(ang) * np.cos(ang)
        plies = [bl.ply for bl in b.layers]
        self.Q = np.array([p.Q() for p in plies]).reshape(K, 4)  # Q11 Q12 Q22 Q66
        self.eps1u = np.array([p.eps1_ult for p in plies])
        self.eps1c = COMPRESSIVE_STRAIN_RATIO * self.eps1u
        self.alpha = np.array([[p.alpha1, p.alpha2] for p in plies]).reshape(K, 2)
        self.Yt = np.array([p.Yt for p in plies])
        self.Yc = np.array([p.Yc for p in plies])
        self.S12 = np.array([p.S12 for p in plies])

        # ---- state
        self.eps_p = np.zeros((E, G, NL, 2))
        self.alpha_l = np.zeros((E, G, NL))
        self.iff = np.zeros((E, G, K), dtype=bool)
        self.ff = np.zeros((E, G, K), dtype=bool)
        self.u = np.zeros(3 * n)
        self.dT = 0.0
        self.p = 0.0

    # --------------------------------------------------------------------- material
    def _ply_Q(self, damage_iff, damage_ff):
        """Damaged reduced stiffness per (E, G, K): returns q11, q12, q22 in laminate axes."""
        Q11, Q12, Q22, Q66 = (self.Q[:, i][None, None, :] for i in range(4))
        d2 = np.where(damage_iff, IFF_RESIDUAL, 1.0)
        dF = np.where(damage_ff, FF_RESIDUAL, 1.0)
        Q11d = Q11 * dF
        Q22d = Q22 * d2 * dF
        Q12d = Q12 * np.sqrt(d2) * dF
        Q66d = Q66 * d2 * dF
        c2, s2 = self.c2[:, None, :], self.s2[:, None, :]
        q11 = Q11d * c2**2 + 2 * (Q12d + 2 * Q66d) * s2 * c2 + Q22d * s2**2
        q12 = (Q11d + Q22d - 4 * Q66d) * s2 * c2 + Q12d * (s2**2 + c2**2)
        q22 = Q11d * s2**2 + 2 * (Q12d + 2 * Q66d) * s2 * c2 + Q22d * c2**2
        return q11, q12, q22

    def _liner(self, eps, eps_p_old, alpha_old):
        """Vectorised plane-stress J2 return mapping. eps (..., 2) mechanical strain."""
        m = self.lmat
        H = m.hardening
        e_el = eps - eps_p_old
        C = self.Cl
        sig = np.einsum("ij,...j->...i", C, e_el)
        vm = np.sqrt(np.maximum(sig[..., 0] ** 2 - sig[..., 0] * sig[..., 1] + sig[..., 1] ** 2, 0.0))
        k0 = m.yield_ + H * alpha_old
        plastic = vm > k0 * (1 + 1e-10)
        eps_p, alpha = eps_p_old.copy(), alpha_old.copy()
        if plastic.any():
            ee = e_el[plastic]
            kk = k0[plastic]
            nu, E_ = m.nu, m.E
            ci00, ci01 = 1 / E_, -nu / E_

            def sig_of(dg):
                a = ci00 + dg * 2 / 3
                bb = ci01 - dg / 3
                det = a * a - bb * bb
                return np.stack([(a * ee[:, 0] - bb * ee[:, 1]) / det, (a * ee[:, 1] - bb * ee[:, 0]) / det], axis=1)

            def g(dg):
                sg = sig_of(dg)
                v = np.sqrt(np.maximum(sg[:, 0] ** 2 - sg[:, 0] * sg[:, 1] + sg[:, 1] ** 2, 0.0))
                return v - (kk + H * dg * 2 / 3 * v)

            lo = np.zeros(len(kk))
            hi = np.full(len(kk), 1e-6)
            for _ in range(60):
                grow = g(hi) > 0
                if not grow.any():
                    break
                hi = np.where(grow, hi * 4, hi)
            for _ in range(60):
                mid = 0.5 * (lo + hi)
                pos = g(mid) > 0
                lo, hi = np.where(pos, mid, lo), np.where(pos, hi, mid)
            dg = 0.5 * (lo + hi)
            sg = sig_of(dg)
            v = np.sqrt(np.maximum(sg[:, 0] ** 2 - sg[:, 0] * sg[:, 1] + sg[:, 1] ** 2, 0.0))
            P = np.array([[2.0, -1.0], [-1.0, 2.0]]) / 3.0
            eps_p[plastic] = eps_p_old[plastic] + dg[:, None] * (sg @ P.T)
            alpha[plastic] = alpha_old[plastic] + dg * 2 / 3 * v
            sig[plastic] = sg
        return sig, eps_p, alpha, plastic

    def _gen_strain(self, u):
        ue = u[self.dof]  # (E, 6)
        return np.einsum("egij,ej->egi", self.BT, ue)  # (E, G, 4)

    def internal(self, u, dT):
        """Internal force vector, trial liner state, generalised strains and ply strains."""
        e = self._gen_strain(u)
        m = self.lmat
        # liner
        eps_l = e[:, :, None, :2] + self.z_l[:, None, :, None] * e[:, :, None, 2:] - m.cte * dT
        sig_l, eps_p, alpha, plastic = self._liner(eps_l, self.eps_p, self.alpha_l)
        w = self.w_l[:, None, :, None]
        N = np.sum(sig_l * w, axis=2)
        M = np.sum(sig_l * w * self.z_l[:, None, :, None], axis=2)
        # plies (laminate axes s, theta)
        eps_k = e[:, :, None, :2] + self.z_k[:, None, :, None] * e[:, :, None, 2:]  # (E,G,K,2)
        a1, a2 = self.alpha[:, 0][None, None, :], self.alpha[:, 1][None, None, :]
        c2, s2 = self.c2[:, None, :], self.s2[:, None, :]
        a_s, a_t = a1 * c2 + a2 * s2, a1 * s2 + a2 * c2
        mech = np.stack([eps_k[..., 0] - a_s * dT, eps_k[..., 1] - a_t * dT], axis=-1)
        q11, q12, q22 = self._ply_Q(self.iff, self.ff)
        sig_k = np.stack([q11 * mech[..., 0] + q12 * mech[..., 1], q12 * mech[..., 0] + q22 * mech[..., 1]], axis=-1)
        tk = (self.t_k * self.present)[:, None, :, None]
        N = N + np.sum(sig_k * tk, axis=2)
        M = M + np.sum(sig_k * tk * self.z_k[:, None, :, None], axis=2)
        S = np.concatenate([N, M], axis=-1)  # (E, G, 4)
        fe = np.einsum("egij,egi,eg->ej", self.BT, S, self.dA)
        F = np.zeros(3 * self.n)
        np.add.at(F, self.dof.ravel(), fe.ravel())
        return F, (eps_p, alpha, plastic, sig_l), e, mech

    def liner_tangent(self, sig, plastic):
        """Continuum elasto-plastic tangent D = C - (C a)(C a)^T / (a^T C a + H), a = d(sigma_vm)/d(sigma)."""
        G = len(_G)
        D = np.broadcast_to(self.Cl, (self.E, G, NL, 2, 2)).copy()
        if plastic is None or not plastic.any():
            return D
        s_ = sig[plastic]
        vm = np.sqrt(np.maximum(s_[:, 0] ** 2 - s_[:, 0] * s_[:, 1] + s_[:, 1] ** 2, 1e-12))
        a = np.stack([(2 * s_[:, 0] - s_[:, 1]) / (2 * vm), (2 * s_[:, 1] - s_[:, 0]) / (2 * vm)], axis=1)
        Ca = a @ self.Cl.T
        denom = np.einsum("ni,ni->n", a, Ca) + self.lmat.hardening
        D[plastic] = self.Cl[None] - np.einsum("ni,nj->nij", Ca, Ca) / denom[:, None, None]
        return D

    def stiffness(self, D_liner=None):
        """Tangent stiffness: liner (elastic or elasto-plastic tangent per point) + damaged plies."""
        C = np.zeros((self.E, len(_G), 4, 4))
        if D_liner is None:
            D_liner = np.broadcast_to(self.Cl, (self.E, len(_G), NL, 2, 2))
        for j in range(NL):
            zz = self.z_l[:, None, j]
            wj = self.w_l[:, None, j]
            Dj = D_liner[:, :, j]
            for (i, k) in ((0, 0), (0, 1), (1, 0), (1, 1)):
                d = Dj[:, :, i, k]
                C[:, :, i, k] += d * wj
                C[:, :, i, k + 2] += d * wj * zz
                C[:, :, i + 2, k] += d * wj * zz
                C[:, :, i + 2, k + 2] += d * wj * zz**2
        q11, q12, q22 = self._ply_Q(self.iff, self.ff)
        tk = (self.t_k * self.present)[:, None, :]
        zk = self.z_k[:, None, :]
        for (i, k), q in (((0, 0), q11), ((0, 1), q12), ((1, 0), q12), ((1, 1), q22)):
            C[:, :, i, k] += np.sum(q * tk, axis=2)
            C[:, :, i, k + 2] += np.sum(q * tk * zk, axis=2)
            C[:, :, i + 2, k] += np.sum(q * tk * zk, axis=2)
            C[:, :, i + 2, k + 2] += np.sum(q * tk * (zk**2 + self.t_k[:, None, :] ** 2 / 12), axis=2)
        Ke = np.einsum("egij,egjk,egkl,eg->eil", self.BT.transpose(0, 1, 3, 2), C, self.BT, self.dA)
        rows = np.repeat(self.dof, 6, axis=1).ravel()
        cols = np.tile(self.dof, (1, 6)).ravel()
        K = coo_matrix((Ke.ravel(), (rows, cols)), shape=(3 * self.n, 3 * self.n)).tocsc()
        f = self.free
        return splu(K[f][:, f])

    def equilibrate(self, p, dT, max_iter=120, tol=1e-6):
        """Newton iteration with the elasto-plastic continuum tangent and a backtracking line search."""
        u = self.u.copy()
        Fext = p * self.Fp
        ref = max(np.linalg.norm(Fext[self.free]), 1.0)
        F, st, e, mech = self.internal(u, dT)
        ref = max(ref, np.linalg.norm(F[self.free]))
        R = (Fext - F)[self.free]
        rn = np.linalg.norm(R)
        for it in range(max_iter):
            if rn < tol * ref:
                self.u, self.dT, self.p = u, dT, p
                self.eps_p, self.alpha_l = st[0], st[1]
                self._last = (e, mech, st[2])
                return True
            lu = self.stiffness(self.liner_tangent(st[3], st[2]))
            du = np.zeros_like(u)
            du[self.free] = lu.solve(R)
            step = 1.0
            for _ in range(8):  # backtracking: accept the first step that reduces the residual
                u_try = u + step * du
                F2, st2, e2, mech2 = self.internal(u_try, dT)
                R2 = (Fext - F2)[self.free]
                r2 = np.linalg.norm(R2)
                if np.isfinite(r2) and r2 < rn:
                    break
                step *= 0.5
            else:
                return False
            u, F, st, e, mech, R, rn = u_try, F2, st2, e2, mech2, R2, r2
            if np.abs(u).max() > 0.5 * self.rn.max():
                return False
        return False

    # --------------------------------------------------------------------- failure
    def check_failure(self):
        """Puck IFF and fibre failure at the current converged state. Returns (new_iff, new_ff) masks."""
        e, mech, _ = self._last
        c2, s2, sc = self.c2[:, None, :], self.s2[:, None, :], self.sc[:, None, :]
        es, et = mech[..., 0], mech[..., 1]
        e1 = es * c2 + et * s2
        e2 = es * s2 + et * c2
        g12 = 2 * (et - es) * sc
        Q11, Q12, Q22, Q66 = (self.Q[:, i][None, None, :] for i in range(4))
        s2_ = Q12 * e1 + Q22 * e2
        t12 = np.abs(Q66 * g12)
        Yt, Yc, S = (x[None, None, :] for x in (self.Yt, self.Yc, self.S12))
        f_iff = puck_iff(s2_, t12, Yt, Yc, S)
        present = self.present[:, None, :]
        new_iff = (f_iff >= 1.0) & ~self.iff & present
        eu = self.eps1u[None, None, :]
        ec = self.eps1c[None, None, :]
        new_ff = ((e1 >= eu) | (e1 <= -ec)) & ~self.ff & present
        return new_iff, new_ff, e1


def run(b: Build, max_len: float = 4.0, p_af: float | None = None) -> ProgressiveResult:
    from .design import structural

    st, _ = structural(b)
    req = b.project.requirements
    T_cure = b.project.composite.cure_temperature
    dT = req.temperature_ref - T_cure
    p_af = p_af or st.autofrettage_pressure
    proof = req.meop * req.proof_factor
    M = _Model(b, max_len)
    events: list[Event] = []
    firsts = {"iff": None, "ff": None, "liner_yield": None}

    def settle(p, phase):
        """Equilibrate at (p, dT) and propagate failures until the damage state is stable."""
        for _ in range(40):
            if not M.equilibrate(p, M.dT):
                return False
            plastic = M._last[2]
            if firsts["liner_yield"] is None and plastic.any():
                firsts["liner_yield"] = p
                j = int(np.argmax(plastic.any(axis=(1, 2))))
                events.append(Event(p, phase, "liner_yield", -1, float(M.z_el[j])))
            new_iff, new_ff, e1 = M.check_failure()
            if not (new_iff.any() or new_ff.any()):
                return True
            for kind, mask in (("iff", new_iff), ("ff", new_ff)):
                if mask.any():
                    if firsts[kind] is None:
                        firsts[kind] = p
                    el, _, lay = np.nonzero(mask)
                    for k in np.unique(lay):
                        j = el[lay == k][0]
                        events.append(Event(p, phase, kind, int(k), float(M.z_el[j])))
            M.iff |= new_iff
            M.ff |= new_ff | M.ff
        return True

    # cure cool-down
    for d in np.linspace(0, dT, 5)[1:]:
        M.dT = float(d)
        settle(0.0, "cure")
    for phase, target, n in (("autofrettage", p_af, 12), ("unload", 0.0, 4), ("proof", proof, 6),
                             ("unload", 0.0, 4), ("meop", req.meop, 6), ("unload", 0.0, 4)):
        for p in np.linspace(M.p, target, n + 1)[1:]:
            if not settle(float(p), phase):
                return _result(M, float(p), events, firsts, [], [], "failed during " + phase)
    # burst ramp
    jm = int(np.argmin(np.abs(M.z_el)))
    curve_p, curve_e = [], []
    p = 0.0
    step = max(st.burst_pressure / 40.0, 0.05)
    tol = 2e-3 * st.burst_pressure
    while p < 5 * st.burst_pressure:
        saved = (M.u.copy(), M.eps_p.copy(), M.alpha_l.copy(), M.iff.copy(), M.ff.copy(), M.p, len(events),
                 dict(firsts))
        ok = settle(p + step, "burst")
        # fibre failure through the whole wall anywhere: no load path left
        through = bool((M.ff | ~M.present[:, None, :]).all(axis=2).any()) if M.K else False
        if ok and not through:
            p += step
            e, mech, _ = M._last
            curve_p.append(p)
            curve_e.append(float(e[jm, 1, 1]))
            continue
        if step <= tol:  # failure located within the tolerance: this is the burst
            break
        # failure within this increment: roll back and refine
        M.u, M.eps_p, M.alpha_l, M.iff, M.ff, M.p, n_ev, fs = saved
        del events[n_ev:]
        firsts.clear()
        firsts.update(fs)
        step *= 0.5
    ff_frac = M.ff.mean(axis=1).T if M.K else np.zeros((0, M.E))
    return _result(M, p + step, events, firsts, curve_p, curve_e, None, ff_frac)


def _result(M: _Model, pb, events, firsts, cp, ce, note, ff_frac=None) -> ProgressiveResult:
    ff_frac = M.ff.mean(axis=1).T if ff_frac is None and M.K else (ff_frac if ff_frac is not None
                                                                   else np.zeros((0, M.E)))
    ff_events = [ev for ev in events if ev.kind == "ff"]
    last = ff_events[-1] if ff_events else None
    peeq = M.alpha_l.max(axis=(1, 2))
    res = ProgressiveResult(
        burst_pressure=float(pb), burst_z=float(last.z) if last else float("nan"),
        burst_layer=int(last.layer) if last else -1, events=events, curve_p=cp, curve_strain=ce, z=M.z_el,
        ff_at_burst=ff_frac, iff_at_burst=M.iff.mean(axis=1).T if M.K else np.zeros((0, M.E)),
        liner_peeq_at_burst=peeq, first_iff_pressure=firsts["iff"], first_ff_pressure=firsts["ff"],
        liner_yield_pressure=firsts["liner_yield"],
    )
    if note:
        res.notes.append(note)
    return res


def to_schema(b: Build, r: ProgressiveResult):
    from .. import schemas as S

    ids = [bl.spec.id for bl in b.layers]
    half = b.project.liner.cyl_length / 2
    req = b.project.requirements

    def zone(z: float) -> str:
        if not np.isfinite(z):
            return "unknown"
        side = "B" if z > 0 else "A"
        if abs(z) < half - 20:
            return "cylinder"
        if abs(z) <= half + 20:
            return f"junction {side}"
        return f"dome {side}"

    grouped: dict[tuple, S.FailureEvent] = {}
    for ev in r.events:
        key = (ev.phase, ev.kind, ev.layer)
        name = "liner" if ev.layer < 0 else ids[ev.layer]
        if key in grouped:
            grouped[key].count += 1
        else:
            grouped[key] = S.FailureEvent(pressure=ev.pressure, phase=ev.phase, kind=ev.kind, layer=name, z=ev.z)
    rnd = lambda a: np.round(np.asarray(a, dtype=float), 5).tolist()  # noqa: E731
    return S.ProgressiveResultOut(
        burst_pressure=r.burst_pressure, required_burst=req.meop * req.burst_factor,
        burst_z=r.burst_z if np.isfinite(r.burst_z) else None,
        burst_layer=ids[r.burst_layer] if r.burst_layer >= 0 else None, burst_zone=zone(r.burst_z),
        first_iff_pressure=r.first_iff_pressure, first_ff_pressure=r.first_ff_pressure,
        liner_yield_pressure=r.liner_yield_pressure, events=list(grouped.values()),
        curve_pressure=rnd(r.curve_p), curve_hoop_strain=rnd(r.curve_strain), z=rnd(r.z),
        ff_fraction=[rnd(x) for x in r.ff_at_burst], iff_fraction=[rnd(x) for x in r.iff_at_burst],
        liner_peeq=rnd(r.liner_peeq_at_burst), notes=r.notes,
    )
