"""Stress-rupture reliability of the overwrap (Weibull power-law breakdown with cumulative damage).

The model of Coleman / Phoenix used for NASA COPV stress-rupture assessments: a ply group loaded at
fibre stress ratio rho(t) (fibre stress / median delivered strength) accumulates

    Psi = (1 / t_c) * integral rho(t)^n dt

and fails with probability ``P = 1 - exp(-Psi^alpha)``. Loading a group to failure over a ramp of
``RAMP_MIN`` reproduces a Weibull strength distribution of shape ``beta = alpha (n + 1)`` with its median at
rho = 1, which fixes alpha and t_c from beta and n.

Proof testing screens weak vessels: the service failure probability is conditional on surviving the
autofrettage and proof holds, ``P = 1 - exp(-[(Psi_s + Psi_v)^alpha - Psi_s^alpha])``.

Default parameters per fibre family: beta from typical COPV burst scatter (CoV about 4 / 5 / 6 % for carbon /
aramid / glass); n calibrated so that the minimum burst ratios for stress rupture of the gas-cylinder
standards (ISO 11119-2/-3, ISO 11439: carbon 2.25, aramid 3.0, glass 3.5) give P = 1e-6 over 15 years
at constant pressure without proof credit. They are indicative: calibrate against stress-rupture data
for the actual fibre/resin system when available.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache

from scipy.optimize import brentq

RAMP_MIN = 1.0  # burst-test ramp duration [min]
REF_YEARS, REF_PF = 15.0, 1e-6
MIN_PER_YEAR = 365.25 * 24 * 60
FAMILIES = {  # strength Weibull shape, standard minimum burst ratio for stress rupture
    "carbon": (30.0, 2.25),
    "aramid": (25.0, 3.0),
    "glass": (20.0, 3.5),
}


def family_of(fiber_id: str, fiber_name: str = "") -> str:
    s = f"{fiber_id} {fiber_name}".lower()
    if "glass" in s or s.startswith(("e-", "s2", "s-2")):
        return "glass"
    if "aramid" in s or "kevlar" in s or "twaron" in s:
        return "aramid"
    return "carbon"


@dataclass(frozen=True)
class Params:
    family: str
    beta: float  # strength Weibull shape
    n: float  # power-law exponent
    calibrated: bool  # n from the standard stress ratio (not user-given)

    @property
    def alpha(self) -> float:
        return self.beta / (self.n + 1.0)

    @property
    def t_c(self) -> float:
        """Characteristic time [min] so that a RAMP_MIN burst ramp has its median at rho = 1."""
        return RAMP_MIN / (self.n + 1.0) / math.log(2.0) ** (1.0 / self.alpha)


def _log_pf(beta: float, n: float, rho: float, minutes: float) -> float:
    """ln P for a constant hold (log space: tiny probabilities do not underflow)."""
    a = beta / (n + 1.0)
    ln_tc = math.log(RAMP_MIN / (n + 1.0)) - math.log(math.log(2.0)) / a
    ln_x = a * (math.log(minutes) + n * math.log(rho) - ln_tc)  # ln Psi^alpha
    return ln_x if ln_x < -30 else math.log(-math.expm1(-math.exp(ln_x)))


@lru_cache(maxsize=64)
def _calibrated_n(beta: float, ratio: float) -> float:
    rho, t = 1.0 / ratio, REF_YEARS * MIN_PER_YEAR
    return brentq(lambda n: _log_pf(beta, n, rho, t) - math.log(REF_PF), 2.0, 1000.0)


def params(family: str, beta: float | None = None, n: float | None = None) -> Params:
    b0, ratio = FAMILIES[family]
    beta = beta or b0
    if n:
        return Params(family, beta, n, False)
    return Params(family, beta, _calibrated_n(beta, ratio), True)


def damage(p: Params, profile: list[tuple[float, float]]) -> float:
    """Psi for a load profile of (stress ratio, minutes) holds."""
    return sum(t * max(rho, 0.0) ** p.n for rho, t in profile) / p.t_c


def pf(p: Params, psi_service: float, psi_screen: float = 0.0) -> float:
    """Service failure probability, conditional on having survived the screening (proof) damage."""
    a = p.alpha
    if psi_service <= 0.0:
        return 0.0
    if psi_screen <= 0.0:
        return -math.expm1(-psi_service**a)
    # (s + v)^a - s^a without cancellation when v << s
    x = psi_service / psi_screen
    return -math.expm1(-psi_screen**a * math.expm1(a * math.log1p(x)))


def life_years(p: Params, rho: float, target: float, psi_screen: float = 0.0, fraction: float = 1.0) -> float:
    """Years at ``rho`` (for ``fraction`` of the time) until the service failure probability reaches target."""
    if rho <= 0.0:
        return math.inf
    per_year = fraction * MIN_PER_YEAR * rho**p.n / p.t_c
    a = p.alpha
    eps = -math.log1p(-target)
    # (s + v)^a = s^a + eps  ->  v = s [(1 + eps / s^a)^(1/a) - 1], stable when eps << s^a
    if psi_screen > 0.0:
        v = psi_screen * math.expm1(math.log1p(eps / psi_screen**a) / a)
    else:
        v = eps ** (1.0 / a)
    return v / per_year if per_year > 0 else math.inf


def allowed_ratio(p: Params, years: float, target: float, psi_screen: float = 0.0, fraction: float = 1.0) -> float:
    """Highest constant stress ratio meeting the target over ``years``."""
    if years <= 0:
        return 1.0
    f = lambda r: math.log(max(life_years(p, r, target, psi_screen, fraction), 1e-300)) - math.log(years)  # noqa: E731
    lo, hi = 1e-3, 1.5
    if f(hi) > 0:
        return hi
    return brentq(f, lo, hi)
