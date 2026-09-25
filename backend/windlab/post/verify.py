"""Independent G-code verifier: interprets the program like a controller would.

Tracks modal feed mode (G93/G94), G92 offsets (and G92.1 resets) and
reconstructs the *physical* axis positions (programmed + offset). Reports
the total inverse-time duration, axis ranges, jumps between consecutive
feed moves, and whether every feed move carries an F word in G93.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_WORD = re.compile(r"([A-Z])\s*(-?\d+(?:\.\d*)?|-?\.\d+)")


@dataclass
class Verification:
    moves: int = 0
    rapids: int = 0
    total_time: float = 0.0  # seconds of G93 feed moves
    pauses: int = 0
    ranges: dict = field(default_factory=dict)  # letter -> (min, max) physical
    max_step: dict = field(default_factory=dict)  # letter -> largest change in one feed move (physical)
    errors: list[str] = field(default_factory=list)
    physical: dict = field(default_factory=dict)  # letter -> list of physical positions after each feed move


def verify(text: str, keep_positions: bool = False) -> Verification:
    v = Verification()
    pos: dict[str, float] = {}
    off: dict[str, float] = {}
    mode = "G94"
    for ln_no, raw in enumerate(text.splitlines(), 1):
        line = re.sub(r"\(.*?\)", "", raw).split(";")[0].strip().upper()
        if not line or line == "%":
            continue
        words = _WORD.findall(line.replace(" ", ""))
        gs = [float(val) for k, val in words if k == "G"]
        ms = [float(val) for k, val in words if k == "M"]
        axes = {k: float(val) for k, val in words if k in "XYZABCUVW"}
        f = next((float(val) for k, val in words if k == "F"), None)
        if 93 in gs:
            mode = "G93"
        if 94 in gs:
            mode = "G94"
        if any(abs(g - 92.1) < 1e-6 for g in gs):
            for k in list(off):
                pos[k] = pos.get(k, 0.0) + off[k]  # programmed coordinates become physical again
            off.clear()
            continue
        if 92 in gs:
            for k, val in axes.items():
                phys = pos.get(k, 0.0) + off.get(k, 0.0)
                off[k] = phys - val
                pos[k] = val
            continue
        if 0 in ms or 1 in ms:
            v.pauses += 1
        motion = 1 if 1 in gs else (0 if 0 in gs else None)
        if motion is None or not axes:
            continue
        prev = {k: pos.get(k, 0.0) + off.get(k, 0.0) for k in axes}
        pos.update(axes)
        now = {k: pos[k] + off.get(k, 0.0) for k in axes}
        for k, val in now.items():
            lo, hi = v.ranges.get(k, (val, val))
            v.ranges[k] = (min(lo, val), max(hi, val))
        if motion == 0:
            v.rapids += 1
            continue
        v.moves += 1
        if mode == "G93":
            if f is None or f <= 0:
                v.errors.append(f"line {ln_no}: G1 in G93 without a positive F word")
            else:
                v.total_time += 60.0 / f
        for k in axes:
            step = abs(now[k] - prev[k])
            v.max_step[k] = max(v.max_step.get(k, 0.0), step)
            if keep_positions:
                v.physical.setdefault(k, []).append(now[k])
    return v
