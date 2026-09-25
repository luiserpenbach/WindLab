"""Material database and micromechanics.

Values are typical datasheet numbers intended for preliminary design. Replace
them with qualified, lot-specific allowables before building flight or
certified hardware.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

# Transverse / shear properties of carbon fibres are rarely on datasheets;
# these are typical literature values for PAN-based fibres.
_CARBON_E2 = 15_000.0
_CARBON_G12 = 27_000.0
_CARBON_NU12 = 0.20


@dataclass(frozen=True)
class Fiber:
    id: str
    name: str
    E: float  # axial tensile modulus [MPa]
    strength: float  # impregnated strand tensile strength [MPa]
    elongation: float  # [-]
    density: float  # [g/cm3]
    tex: float  # linear density [g/km]
    filaments: str
    E2: float = _CARBON_E2
    G12: float = _CARBON_G12
    nu12: float = _CARBON_NU12
    cte1: float = -0.4e-6  # axial CTE [1/K]
    cte2: float = 7.0e-6  # transverse CTE [1/K]

    @property
    def area(self) -> float:
        """Fibre cross-section area of one tow [mm2]."""
        return self.tex / (self.density * 1000.0)


@dataclass(frozen=True)
class Resin:
    id: str
    name: str
    E: float
    nu: float
    density: float
    cte: float = 60e-6
    cure: str = ""  # typical cure schedule (datasheet), for the traveller
    cure_temperature: float = 120.0  # typical stress-free (final cure) temperature [degC]
    Yt: float = 55.0  # UD ply transverse tensile strength [MPa] (matrix dominated)
    Yc: float = 200.0  # UD ply transverse compressive strength [MPa]
    S12: float = 75.0  # UD ply in-plane shear strength [MPa]

    @property
    def G(self) -> float:
        return self.E / (2.0 * (1.0 + self.nu))


@dataclass(frozen=True)
class LinerMaterial:
    id: str
    name: str
    E: float
    nu: float
    yield_: float
    ultimate: float
    density: float
    elongation: float
    fatigue_coeff: float  # Basquin sigma'_f [MPa]
    fatigue_exp: float  # Basquin b [-]
    cte: float = 23.6e-6  # [1/K]
    k_ic: float = 29.0  # plane-strain fracture toughness [MPa sqrt(m)]

    @property
    def hardening(self) -> float:
        """Linear plastic hardening modulus fitted between yield and ultimate [MPa]."""
        eps_p = max(self.elongation - self.yield_ / self.E, 1e-3)
        return max((self.ultimate - self.yield_) / eps_p, 1.0)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["yield"] = d.pop("yield_")
        d["hardening"] = self.hardening
        return d


FIBERS: dict[str, Fiber] = {
    f.id: f
    for f in [
        Fiber("T700S-12K", "Toray T700S 12K", 230_000, 4900, 0.021, 1.80, 800, "12K"),
        Fiber("T700S-24K", "Toray T700S 24K", 230_000, 4900, 0.021, 1.80, 1650, "24K"),
        Fiber("T800S-24K", "Toray T800S 24K", 294_000, 5880, 0.020, 1.80, 1030, "24K"),
        Fiber("T1000G-12K", "Toray T1000G 12K", 294_000, 6370, 0.022, 1.80, 485, "12K"),
        Fiber("IM7-12K", "Hexcel IM7 12K", 276_000, 5516, 0.019, 1.78, 446, "12K"),
        Fiber("AS4-12K", "Hexcel AS4 12K", 231_000, 4433, 0.018, 1.79, 858, "12K"),
        Fiber(
            "E-glass-2400", "E-glass direct roving 2400 tex", 72_000, 2400, 0.033, 2.58, 2400,
            "roving", E2=72_000, G12=30_000, nu12=0.22, cte1=5.0e-6, cte2=5.0e-6,
        ),
    ]
}

RESINS: dict[str, Resin] = {
    r.id: r
    for r in [
        Resin("Epoxy-DGEBA", "Epoxy DGEBA / anhydride (wet winding)", 3100, 0.35, 1.20, 60e-6,
              "2 h at 90 degC + 4 h at 130 degC, rotating; ramp <= 2 K/min", 130.0),
        Resin("Epoxy-toughened", "Toughened epoxy (towpreg)", 2900, 0.36, 1.18, 60e-6,
              "2 h at 120 degC, rotating; ramp <= 2 K/min", 120.0),
        Resin("Epoxy-HT", "High-Tg epoxy / amine", 3400, 0.34, 1.22, 55e-6,
              "2 h at 80 degC + 2 h at 150 degC + 2 h at 180 degC post-cure", 180.0),
    ]
}

LINERS: dict[str, LinerMaterial] = {
    m.id: m
    for m in [
        LinerMaterial("AA6061-T6", "Aluminium 6061-T6", 68_900, 0.33, 276, 310, 2.70, 0.12, 386, -0.071),
        LinerMaterial("AA6061-T62", "Aluminium 6061-T62", 68_900, 0.33, 262, 296, 2.70, 0.10, 380, -0.071),
        LinerMaterial("AA7075-T73", "Aluminium 7075-T73", 71_700, 0.33, 434, 503, 2.81, 0.10, 900, -0.10, 23.4e-6,
                      32.0),
        LinerMaterial("Ti-6Al-4V", "Titanium Ti-6Al-4V (annealed)", 113_800, 0.34, 880, 950, 4.43, 0.14, 1500, -0.085,
                      8.6e-6, 75.0),
        LinerMaterial("SS316L", "Stainless 316L (annealed)", 193_000, 0.30, 290, 580, 7.99, 0.40, 1000, -0.114,
                      16.0e-6, 200.0),
    ]
}


@dataclass(frozen=True)
class Ply:
    """Unidirectional composite ply properties (material axes)."""

    E1: float
    E2: float
    G12: float
    nu12: float
    density: float  # g/cm3
    Vf: float
    eps1_ult: float  # delivered fibre-direction failure strain in the vessel
    fiber_E: float
    fiber_strength: float  # delivered fibre stress at failure (with translation efficiency)
    alpha1: float = 0.0  # ply CTE, fibre direction [1/K]
    alpha2: float = 0.0  # ply CTE, transverse [1/K]
    Yt: float = 55.0
    Yc: float = 200.0
    S12: float = 75.0

    @property
    def nu21(self) -> float:
        return self.nu12 * self.E2 / self.E1

    def Q(self) -> tuple[float, float, float, float]:
        """Reduced stiffness terms Q11, Q12, Q22, Q66 [MPa]."""
        d = 1.0 - self.nu12 * self.nu21
        return self.E1 / d, self.nu12 * self.E2 / d, self.E2 / d, self.G12


def _halpin_tsai(Pf: float, Pm: float, Vf: float, xi: float) -> float:
    eta = (Pf / Pm - 1.0) / (Pf / Pm + xi)
    return Pm * (1.0 + xi * eta * Vf) / (1.0 - eta * Vf)


def ply_properties(fiber: Fiber, resin: Resin, Vf: float, efficiency: float) -> Ply:
    Vm = 1.0 - Vf
    E1 = Vf * fiber.E + Vm * resin.E
    E2 = _halpin_tsai(fiber.E2, resin.E, Vf, 2.0)
    G12 = _halpin_tsai(fiber.G12, resin.G, Vf, 1.0)
    nu12 = Vf * fiber.nu12 + Vm * resin.nu
    eps_ult = efficiency * fiber.strength / fiber.E
    # Schapery
    alpha1 = (fiber.E * fiber.cte1 * Vf + resin.E * resin.cte * Vm) / (fiber.E * Vf + resin.E * Vm)
    alpha2 = (1 + fiber.nu12) * fiber.cte2 * Vf + (1 + resin.nu) * resin.cte * Vm - alpha1 * nu12
    return Ply(
        E1=E1,
        E2=E2,
        G12=G12,
        nu12=nu12,
        density=Vf * fiber.density + Vm * resin.density,
        Vf=Vf,
        eps1_ult=eps_ult,
        fiber_E=fiber.E,
        fiber_strength=efficiency * fiber.strength,
        alpha1=alpha1,
        alpha2=alpha2,
        Yt=resin.Yt,
        Yc=resin.Yc,
        S12=resin.S12,
    )


def band_thickness(fiber: Fiber, tows: int, band_width: float, Vf: float) -> float:
    """Cured thickness of one band pass [mm] from fibre area conservation."""
    return tows * fiber.area / (band_width * Vf)


def catalog() -> dict:
    return {
        "fibers": [asdict(f) for f in FIBERS.values()],
        "resins": [asdict(r) for r in RESINS.values()],
        "liners": [m.to_dict() for m in LINERS.values()],
    }


def get_fiber(fid: str, lib=None) -> Fiber:
    for f in getattr(lib, "fibers", None) or []:
        if f.id == fid:
            return Fiber(f.id, f.name, f.E, f.strength, f.elongation, f.density, f.tex, f.filaments, f.E2, f.G12,
                         f.nu12, f.cte1, f.cte2)
    if fid not in FIBERS:
        raise KeyError(f"Unknown fibre '{fid}'")
    return FIBERS[fid]


def get_resin(rid: str, lib=None) -> Resin:
    for r in getattr(lib, "resins", None) or []:
        if r.id == rid:
            return Resin(r.id, r.name, r.E, r.nu, r.density, r.cte, r.cure, r.cure_temperature, r.Yt, r.Yc, r.S12)
    if rid not in RESINS:
        raise KeyError(f"Unknown resin '{rid}'")
    return RESINS[rid]


def get_liner(lid: str, lib=None) -> LinerMaterial:
    for m in getattr(lib, "liners", None) or []:
        if m.id == lid:
            return LinerMaterial(m.id, m.name, m.E, m.nu, m.yield_, m.ultimate, m.density, m.elongation,
                                 m.fatigue_coeff, m.fatigue_exp, m.cte, m.k_ic)
    if lid not in LINERS:
        raise KeyError(f"Unknown liner material '{lid}'")
    return LINERS[lid]
