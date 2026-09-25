"""Helical winding pattern closure.

A helical layer needs ``n`` circuits so that ``n`` bands of circumferential
footprint ``B / cos(a)`` tile the cylinder. If the mandrel advances
``2*pi*k/n`` (mod 2*pi) per circuit and ``gcd(k, n) = 1``, every band slot is
visited exactly once before the pattern closes. The natural geodesic advance
is generally not such a value, so a dwell (extra mandrel rotation at each
turnaround) makes up the difference.

The *pattern number* ``p`` is the number of circuits after which a band lands
directly next to the first one (``p*k = +/-1 mod n``). It sets how many
crossover zones ("diamonds") the finished layer has around the circumference.
"""
from __future__ import annotations

from dataclasses import dataclass
from math import gcd

import numpy as np

TWO_PI = 2.0 * np.pi


@dataclass
class Pattern:
    n_bands: int
    shift: int
    pattern_number: int
    dwell: float  # per turnaround [rad]
    coverage: float
    leading: bool
    score: float

    @property
    def circuit_advance(self) -> float:
        return TWO_PI * self.shift / self.n_bands


def pattern_number(n: int, k: int) -> tuple[int, bool]:
    for i in range(1, n + 1):
        m = (i * k) % n
        if m == 1:
            return i, True
        if m == n - 1:
            return i, False
    return n, True


def dwell_for(natural_advance: float, n: int, k: int) -> float:
    """Dwell per turnaround so that the circuit advance equals 2*pi*k/n (mod 2*pi)."""
    target = TWO_PI * k / n
    delta = (target - 2.0 * natural_advance) % TWO_PI
    return delta / 2.0


def candidates(
    natural_advance: float,
    radius: float,
    angle: float,
    band_width: float,
    dwell_max: float,
    max_overlap: float = 0.15,
    limit: int = 12,
) -> list[Pattern]:
    """Enumerate closing patterns, best first.

    natural_advance: azimuth advance of one geodesic pass [rad]
    radius, angle:   cylinder radius [mm] and winding angle [rad]
    dwell_max:       max dwell per turnaround [rad]
    """
    n_min = int(np.ceil(TWO_PI * radius * np.cos(angle) / band_width))
    n_min = max(n_min, 1)
    n_max = max(int(np.floor(n_min * (1.0 + max_overlap))), n_min)
    out: list[Pattern] = []
    for n in range(n_min, n_max + 1):
        coverage = n * band_width / (TWO_PI * radius * np.cos(angle))
        for k in range(1, n):
            if gcd(k, n) != 1:
                continue
            d = dwell_for(natural_advance, n, k)
            # allow one full extra turn of dwell split over two turnarounds
            if d > dwell_max:
                continue
            p, leading = pattern_number(n, k)
            # prefer: small dwell, little overlap, moderate pattern numbers
            score = (
                d / max(dwell_max, 1e-9)
                + 4.0 * (coverage - 1.0)
                + 0.03 * abs(p - 5)
            )
            out.append(Pattern(n, k, p, d, coverage, leading, score))
    out.sort(key=lambda c: c.score)
    return out[:limit]


def evaluate(natural_advance: float, radius: float, angle: float, band_width: float, n: int, k: int) -> Pattern:
    if gcd(k % n or n, n) != 1 or not 0 < k < n:
        raise ValueError(f"Pattern {n}/{k} does not close (gcd(n, k) must be 1)")
    coverage = n * band_width / (TWO_PI * radius * np.cos(angle))
    p, leading = pattern_number(n, k)
    return Pattern(n, k, p, dwell_for(natural_advance, n, k), coverage, leading, 0.0)
