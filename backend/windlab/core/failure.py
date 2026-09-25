"""Ply failure criteria shared by the cylinder model and the progressive shell analysis.

* Fibre failure: fibre-direction (mechanical) strain vs the delivered failure strain in tension and a
  compressive strain limit.
* Inter-fibre failure (matrix cracking): Puck's plane-stress action-plane criterion, modes A (transverse
  tension), B (moderate transverse compression) and C (high transverse compression), with the inclination
  parameters recommended for carbon/epoxy (VDI 2014 part 3).
"""
from __future__ import annotations

import numpy as np

P_PERP_PAR_T, P_PERP_PAR_C = 0.30, 0.25  # Puck inclination parameters, CFRP
IFF_RESIDUAL = 0.10  # remaining E2 / G12 after inter-fibre failure (Puck's recommended degradation floor)
FF_RESIDUAL = 1e-3
COMPRESSIVE_STRAIN_RATIO = 0.6  # compressive / tensile fibre failure strain (typical carbon/epoxy)


def puck_iff(sig2, tau21, Yt, Yc, S):
    """Puck inter-fibre failure effort (>= 1: failure). Arrays broadcast."""
    sig2 = np.asarray(sig2, dtype=float)
    t = np.abs(np.asarray(tau21, dtype=float))
    pt, pc = P_PERP_PAR_T, P_PERP_PAR_C
    RA = S / (2 * pc) * (np.sqrt(1 + 2 * pc * Yc / S) - 1)
    p_pp = pc * RA / S
    t21c = S * np.sqrt(1 + 2 * p_pp)
    fA = np.sqrt((t / S) ** 2 + ((1 - pt * Yt / S) * sig2 / Yt) ** 2) + pt * sig2 / S
    fB = (np.sqrt(t**2 + (pc * sig2) ** 2) + pc * sig2) / S
    with np.errstate(divide="ignore", invalid="ignore"):
        fC = ((t / (2 * (1 + p_pp) * S)) ** 2 + (sig2 / Yc) ** 2) * Yc / np.maximum(-sig2, 1e-12)
        modeB = np.abs(sig2) / np.maximum(t, 1e-12) <= RA / t21c
    return np.where(sig2 >= 0, fA, np.where(modeB, fB, fC))


def ply_material_state(eps_s, eps_t, angle, Q, alpha1, alpha2, dT):
    """Material-axis strains and (undamaged) stresses of a balanced +/-angle pair from laminate strains.

    Returns e1 (mechanical fibre strain), sigma2, |tau12|.
    """
    c2, s2 = np.cos(angle) ** 2, np.sin(angle) ** 2
    sc = np.sin(angle) * np.cos(angle)
    e1 = eps_s * c2 + eps_t * s2 - alpha1 * dT
    e2 = eps_s * s2 + eps_t * c2 - alpha2 * dT
    g12 = 2 * (eps_t - eps_s) * sc
    Q11, Q12, Q22, Q66 = Q
    return e1, Q12 * e1 + Q22 * e2, np.abs(Q66 * g12)
