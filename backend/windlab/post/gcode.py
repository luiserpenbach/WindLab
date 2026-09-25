"""G-code post-processors for LinuxCNC and GRBL.

Both use inverse-time feed (G93) for the winding moves: every G1 carries
``F = 1 / segment duration [min]``, so mixed linear/rotary moves run at the
planned timing regardless of how the controller treats rotary feed.
"""
from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass, field

import numpy as np

from .. import __version__
from .. import schemas as S
from ..core.design import Build, build
from ..core.kinematics import Motion, machine_coords, simulate_layer

GRBL_LETTERS = {"X", "Y", "Z"}
GRBLHAL_LETTERS = {"X", "Y", "Z", "A", "B", "C"}


@dataclass
class Program:
    filename: str
    lines: list[str] = field(default_factory=list)
    total_time: float = 0.0
    warnings: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n".join(self.lines) + "\n"


class Post:
    controller = "generic"
    ext = ".nc"
    sep = " "

    def __init__(self, m: S.MachineSpec) -> None:
        self.m = m

    # -- formatting -------------------------------------------------------
    def comment(self, text: str) -> str:
        text = re.sub(r"[()]", "", text)
        return f"({text})"

    def fmt(self, v: float, digits: int = 3) -> str:
        s = f"{v:.{digits}f}".rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s

    def words(self, *parts: str) -> str:
        return self.sep.join(p for p in parts if p)

    def axis_words(self, pos: dict[str, float]) -> list[str]:
        m = self.m
        out = [f"{m.carriage.letter}{self.fmt(pos['carriage'])}", f"{m.crossfeed.letter}{self.fmt(pos['crossfeed'])}",
               f"{m.mandrel.letter}{self.fmt(pos['mandrel'])}"]
        if "eye" in pos and m.eye:
            out.append(f"{m.eye.letter}{self.fmt(pos['eye'])}")
        return out

    # -- hooks --------------------------------------------------------------
    def header(self, prj: S.Project) -> list[str]:
        return []

    def footer(self) -> list[str]:
        return ["G94", "G92.1", "M2"]

    def tension(self, newtons: float) -> list[str]:
        val = self.fmt(newtons * self.m.tension_scale, 2)
        if self.m.tension_output == "spindle":
            return [f"M3 S{val}"]
        return []

    def pause(self, msg: str) -> list[str]:
        return [self.comment(msg), "M0"]

    def set_rotary(self, value: float) -> list[str]:
        return [f"G92 {self.m.mandrel.letter}{self.fmt(value)}"]

    def validate(self) -> list[str]:
        return []


class LinuxCNCPost(Post):
    controller = "linuxcnc"
    ext = ".ngc"

    def header(self, prj):
        return ["%", "G21 G90 G40 G49 G17 G94", "G64 P0.05 Q0.02", "G92.1"]

    def footer(self):
        out = ["G94", "G92.1"]
        if self.m.tension_output == "m67":
            out.append("M68 E0 Q0")
        elif self.m.tension_output == "spindle":
            out.append("M5")
        return out + ["M2", "%"]

    def tension(self, newtons):
        if self.m.tension_output == "m67":
            return [f"M68 E0 Q{self.fmt(newtons * self.m.tension_scale, 2)}"]
        return super().tension(newtons)

    def pause(self, msg):
        return [f"(MSG, {re.sub(r'[()]', '', msg)})", "M0"]


class GrblPost(Post):
    controller = "grbl"
    ext = ".gcode"
    sep = ""

    def header(self, prj):
        return ["G21G90G94", "G92.1"]

    def footer(self):
        out = ["G94", "G92.1"]
        if self.m.tension_output == "spindle":
            out.append("M5")
        return out + ["M2"]

    def validate(self):
        letters = {self.m.carriage.letter, self.m.crossfeed.letter, self.m.mandrel.letter}
        if self.m.axes_count == 4 and self.m.eye:
            letters.add(self.m.eye.letter)
        w = []
        if not letters <= GRBL_LETTERS:
            extra = ", ".join(sorted(letters - GRBL_LETTERS))
            if letters <= GRBLHAL_LETTERS:
                w.append(f"Axis letters {extra} need grblHAL or a multi-axis GRBL fork")
            else:
                w.append(f"Axis letters {extra} are not supported by GRBL")
        if self.m.tension_output == "m67":
            w.append("GRBL has no M67 analog output; tension commands are omitted (use 'spindle')")
        if self.m.rotary_reset == "none":
            w.append("GRBL uses 32-bit floats: large cumulative mandrel angles lose precision; enable rotary reset")
        return w


POSTS = {"linuxcnc": LinuxCNCPost, "grbl": GrblPost}


def _safe_radius(motions: list[Motion]) -> float:
    return float(max(mo.y.max() for mo in motions))


def generate(project: S.Project, layer_ids: list[str] | None = None) -> Program:
    b: Build = build(project)
    m = project.machine
    post = POSTS[m.controller](m)
    layers = [bl for bl in b.layers if layer_ids is None or bl.spec.id in layer_ids]
    slug = re.sub(r"[^A-Za-z0-9_-]+", "_", project.name).strip("_") or "windlab"
    prog = Program(filename=f"{slug}{post.ext}")
    prog.warnings += post.validate()
    if not layers:
        prog.warnings.append("No layers selected")
    motions = [simulate_layer(b, bl) for bl in layers]
    L = prog.lines
    L += post.header(project)
    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    L.append(post.comment(f"WindLab {__version__} - {project.name} - {now}"))
    L.append(post.comment(f"Machine: {m.name}, {m.axes_count}-axis, controller {m.controller}"))
    L.append(post.comment(f"Layers: {len(layers)}; units mm, deg; G93 inverse-time feed"))
    safe = _safe_radius(motions) + 10.0 if motions else 0.0
    period = 360.0 * abs(m.mandrel.scale)
    prev_end: float | None = None  # machine mandrel coordinate at the end of the previous layer
    for mo in motions:
        bl = mo.layer
        sp = bl.spec
        desc = (f"Layer {bl.index + 1} {sp.id}: {sp.type}, {np.degrees(bl.angle):.2f} deg, "
                f"band {sp.band_width} mm x {sp.tows} tow")
        if bl.pattern:
            desc += (f", pattern {bl.pattern.n_bands}/{bl.pattern.shift} p{bl.pattern.pattern_number}, "
                     f"dwell {np.degrees(bl.pattern.dwell):.1f} deg")
        L.append("")
        L.append(post.comment(desc))
        L.append(post.comment(f"Est. time {mo.total_time / 60:.1f} min, tension {sp.tension} N"))
        mc = machine_coords(m, mo.x, mo.y, mo.a, mo.b)
        if m.rotary_reset != "none":
            # express the layer in the first mandrel turn; the physical angle is unchanged
            mc["mandrel"] = mc["mandrel"] - period * np.floor(mc["mandrel"][0] / period)
        safe_cf = float(machine_coords(m, [0], [safe], [0], [0])["crossfeed"][0])
        if m.pause_between_layers:
            L += post.pause(f"Layer {bl.index + 1} {sp.id}: {sp.tows} tow(s), band {sp.band_width} mm, "
                            f"tension {sp.tension} N")
        L.append("G94")
        L.append(post.words("G0", f"{m.crossfeed.letter}{post.fmt(safe_cf)}"))
        if m.rotary_reset != "none" and prev_end is not None:
            L += post.set_rotary(prev_end % period)
        first = {k: float(v[0]) for k, v in mc.items()}
        start_words = [w for w in post.axis_words(first) if not w.startswith(m.crossfeed.letter)]
        L.append(post.words("G0", *start_words))
        L.append(post.words("G0", f"{m.crossfeed.letter}{post.fmt(first['crossfeed'])}"))
        L += post.tension(sp.tension)
        L.append("G93")
        dt = np.diff(mo.t)
        circuit_set = set(mo.circuit_starts[1:]) if m.rotary_reset == "circuit" else set()
        for i in range(1, len(mo.t)):
            if i in circuit_set:
                cur = float(mc["mandrel"][i - 1])
                L.append("G94")
                L += post.set_rotary(cur % period)
                L.append("G93")
                mc["mandrel"][i:] -= cur - cur % period
            pos = {k: float(v[i]) for k, v in mc.items()}
            f = 60.0 / max(float(dt[i - 1]), 1e-4)
            L.append(post.words("G1", *post.axis_words(pos), f"F{post.fmt(f, 2)}"))
        prev_end = float(mc["mandrel"][-1])
        prog.total_time += mo.total_time
        prog.warnings += [f"Layer {bl.index + 1}: {w}" for w in mo.warnings]
    L.append("")
    L.append(post.comment(f"Total estimated winding time {prog.total_time / 60:.1f} min"))
    L += post.footer()
    return prog

