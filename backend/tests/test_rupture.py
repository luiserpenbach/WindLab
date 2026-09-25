import math

import pytest

from windlab import presets
from windlab.core import rupture as R
from windlab.core.design import analyze


@pytest.mark.parametrize("family", ["carbon", "aramid", "glass"])
def test_calibration_and_strength_consistency(family):
    p = R.params(family)
    beta, ratio = R.FAMILIES[family]
    years = R.REF_YEARS * R.MIN_PER_YEAR
    # the standard's stress ratio gives the reference probability over the reference life
    assert R.pf(p, R.damage(p, [(1.0 / ratio, years)])) == pytest.approx(R.REF_PF, rel=1e-6)
    # a burst-test ramp to rho = 1 fails half the vessels (damage of a linear ramp: t rho^n / (n + 1))
    ramp = R.RAMP_MIN / (p.n + 1.0) / p.t_c
    assert R.pf(p, ramp) == pytest.approx(0.5, rel=1e-9)
    # and the implied strength distribution has the Weibull shape beta
    q = lambda rho: math.log(-math.log1p(-R.pf(p, ramp * rho ** (p.n + 1))))  # noqa: E731
    assert (q(0.9) - q(0.8)) / (math.log(0.9) - math.log(0.8)) == pytest.approx(beta, rel=1e-6)


def test_proof_credit_life_and_allowed_ratio():
    p = R.params("carbon")
    year = R.MIN_PER_YEAR
    svc = R.damage(p, [(0.5, 15 * year)])
    screen = R.damage(p, [(0.75, 1.0), (0.65, 1.0)])
    assert R.pf(p, svc, screen) < R.pf(p, svc)  # surviving proof removes the weak vessels
    assert R.pf(p, R.damage(p, [(0.55, 15 * year)])) > R.pf(p, svc)
    life = R.life_years(p, 0.5, 1e-6, screen)
    assert R.pf(p, R.damage(p, [(0.5, life * year)]), screen) == pytest.approx(1e-6, rel=1e-6)
    rho = R.allowed_ratio(p, 15.0, 1e-6, screen)
    assert R.life_years(p, rho, 1e-6, screen) == pytest.approx(15.0, rel=1e-4)
    assert rho > 1 / 2.25  # the proof credit allows a slightly higher stress ratio


def test_family_detection_and_analysis():
    assert R.family_of("E-glass-2400") == "glass" and R.family_of("Kevlar49") == "aramid"
    assert R.family_of("T700S-12K") == "carbon"
    p = next(e["project"] for e in presets.examples() if e["id"] == "grbl-10mpa-1l")
    res = analyze(p)
    ru = res.structural.rupture
    assert ru.family == "carbon" and {g.group for g in ru.groups} == {"hoop", "helical"}
    assert 0.0 <= ru.pf < 1.0 and ru.reliability == pytest.approx(1 - ru.pf)
    assert any(c.id == "sr.reliability" for c in res.checks)
    assert all(b >= a - 1e-300 for a, b in zip(ru.curve_pf, ru.curve_pf[1:]))
