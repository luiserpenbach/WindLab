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
from ..core.kinematics import Motion, machine_coords, simulate_path

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
        out = [f"{m.carriage.letter}{self.fmt(pos['carriage'])}"]
        if m.axes_count >= 3:
            out.append(f"{m.crossfeed.letter}{self.fmt(pos['crossfeed'])}")
        out.append(f"{m.mandrel.letter}{self.fmt(pos['mandrel'])}")
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


def _feed(post: Post, f: float) -> str:
    """Inverse-time feed word value with about 4 significant digits (slow moves have F well below 1)."""
    return post.fmt(f, max(2, 3 - int(np.floor(np.log10(max(f, 1e-9))))))


def _safe_radius(motions: list[Motion]) -> float:
    return float(max(mo.y.max() for mo in motions))


def _segments(b: Build, layers):
    """(label, surface layer, path, transition-or-None) in winding order."""
    from ..core.kinematics import layer_path

    if b.project.continuous.enabled and len(layers) > 1:
        from ..core.continuous import plan

        p = plan(b, layers)
        return [(sg.label, sg.layer, sg.path, sg.transition) for sg in p.segments if len(sg.path.z) > 1], p
    return [(bl.spec.id, bl, layer_path(b, bl), None) for bl in layers], None


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
    segs, cplan = _segments(b, layers)
    continuous = cplan is not None
    if continuous:
        idx = [bl.index for bl in layers]
        if idx != list(range(idx[0], idx[0] + len(idx))):
            prog.warnings.append("Continuous winding over non-adjacent layers: transitions join the selected layers")
        for T in cplan.transitions:
            if not T.feasible:
                prog.warnings.append(f"Transition {T.src.spec.id} -> {T.dst.spec.id}: " + "; ".join(T.notes))
    motions = [simulate_path(b, bl, path) for _, bl, path, _ in segs]
    L = prog.lines
    L += post.header(project)
    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    L.append(post.comment(f"WindLab {__version__} - {project.name} - {now}"))
    L.append(post.comment(f"Machine: {m.name}, {m.axes_count}-axis, controller {m.controller}"))
    L.append(post.comment(f"Layers: {len(layers)}; units mm, deg; G93 inverse-time feed"))
    if continuous:
        L.append(post.comment(f"Continuous winding: {len(cplan.transitions)} transitions, "
                              f"{sum(len(T.angles) for T in cplan.transitions)} transition passes, roving not cut"))
    safe = _safe_radius(motions) + 10.0 if motions else 0.0
    period = 360.0 * abs(m.mandrel.scale)
    prev_end: float | None = None  # machine mandrel coordinate at the end of the previous segment
    prev_pos: dict | None = None
    tension_now: float | None = None
    for (label, bl, path, T), mo in zip(segs, motions):
        sp = bl.spec
        joined = continuous and prev_pos is not None  # fibre runs on from the previous segment
        if T is not None:
            desc = (f"Transition {T.src.spec.id} -> {T.dst.spec.id}: {T.kind}, {len(T.angles)} passes"
                    + (f" at {', '.join(f'{np.degrees(a):.1f}' for a in T.angles)} deg" if T.angles else "")
                    + f", max slippage {T.max_slip:.3f} (limit {T.limit:.3f})")
        else:
            desc = (f"Layer {bl.index + 1} {sp.id}: {sp.type}, {np.degrees(bl.angle):.2f} deg, "
                    f"band {sp.band_width} mm x {sp.tows} tow")
            if bl.pattern:
                desc += (f", pattern {bl.pattern.n_bands}/{bl.pattern.shift} p{bl.pattern.pattern_number}, "
                         f"dwell {np.degrees(bl.pattern.dwell):.1f} deg")
        L.append("")
        L.append(post.comment(desc))
        L.append(post.comment(f"Est. time {mo.total_time / 60:.1f} min, tension {sp.tension} N"))
        mc = machine_coords(m, mo.x, mo.y, mo.a, mo.b)
        wind_dir = 1.0 if mc["mandrel"][-1] >= mc["mandrel"][0] else -1.0
        if m.rotary_reset != "none":
            # express the segment in the first mandrel turn; the physical angle is unchanged
            mc["mandrel"] = mc["mandrel"] - period * np.floor(mc["mandrel"][0] / period)
        if prev_end is not None:
            cur = prev_end % period if m.rotary_reset != "none" else prev_end
            if joined:
                # the path continues: the nearest equivalent mandrel angle (it matches up to the eye lead)
                mc["mandrel"] = mc["mandrel"] + period * np.round((cur - mc["mandrel"][0]) / period)
            else:
                # never turn the mandrel backwards between layers (the fibre is still attached): shift the
                # layer by whole turns so its start lies ahead of the current position in the winding direction
                gap = (mc["mandrel"][0] - cur) * wind_dir
                if gap < -1e-6:
                    mc["mandrel"] = mc["mandrel"] + wind_dir * period * np.ceil(-gap / period)
        if joined and "eye" in mc and m.eye:
            # the band is symmetric: the eye roll has a period of 180 deg, take the equivalent nearest to where
            # the eye is (the roll accumulates over a layer)
            pe = 180.0 * abs(m.eye.scale)
            mc["eye"] = mc["eye"] + pe * np.round((prev_pos["eye"] - mc["eye"][0]) / pe)
        if m.rotary_reset != "none" and prev_end is not None:
            L += post.set_rotary(prev_end % period)
        first = {k: float(v[0]) for k, v in mc.items()}
        if joined:
            # no cut, no retract: move onto the next segment's first point at a gentle feed
            if tension_now != sp.tension:
                L += post.tension(sp.tension)
                tension_now = sp.tension
            here = dict(prev_pos, mandrel=prev_end % period if m.rotary_reset != "none" else prev_end)
            d = max(abs(first[k] - here[k]) for k in first)
            if d > 1e-3:
                t_join = max(0.5, d / 20.0)
                L.append("G93")
                L.append(post.words("G1", *post.axis_words(first), f"F{_feed(post, 60.0 / t_join)}"))
                prog.total_time += t_join
        else:
            safe_cf = float(machine_coords(m, [0], [safe], [0], [0])["crossfeed"][0])
            if m.pause_between_layers:
                L += post.pause(f"Layer {bl.index + 1} {sp.id}: {sp.tows} tow(s), band {sp.band_width} mm, "
                                f"tension {sp.tension} N")
            L.append("G94")
            if m.axes_count >= 3:
                L.append(post.words("G0", f"{m.crossfeed.letter}{post.fmt(safe_cf)}"))
            start_words = [w for w in post.axis_words(first)
                           if m.axes_count < 3 or not w.startswith(m.crossfeed.letter)]
            L.append(post.words("G0", *start_words))
            if m.axes_count >= 3:
                L.append(post.words("G0", f"{m.crossfeed.letter}{post.fmt(first['crossfeed'])}"))
            L += post.tension(sp.tension)
            tension_now = sp.tension
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
            L.append(post.words("G1", *post.axis_words(pos), f"F{_feed(post, f)}"))
        prev_end = float(mc["mandrel"][-1])
        prev_pos = {k: float(v[-1]) for k, v in mc.items()}
        prog.total_time += mo.total_time
        where = f"Transition {label}" if T is not None else f"Layer {bl.index + 1}"
        prog.warnings += [f"{where}: {w}" for w in mo.warnings]
    L.append("")
    L.append(post.comment(f"Total estimated winding time {prog.total_time / 60:.1f} min"))
    L += post.footer()
    return prog
