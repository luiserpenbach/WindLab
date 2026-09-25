"""Command line entry points: serve the app, analyse a project, post G-code."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import schemas as S


def _load(path: str) -> S.Project:
    return S.Project.model_validate(json.loads(Path(path).read_text()))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="windlab", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="run the web app")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    a = sub.add_parser("analyze", help="analyse a project JSON and print the checks")
    a.add_argument("project")
    g = sub.add_parser("gcode", help="post-process a project JSON to G-code")
    g.add_argument("project")
    g.add_argument("-o", "--output")
    g.add_argument("--layers", nargs="*", help="layer ids (default: all)")
    c = sub.add_parser("ccx", help="export a CalculiX axisymmetric solid model (optionally run and compare)")
    c.add_argument("project")
    c.add_argument("-o", "--output")
    c.add_argument("--run", metavar="DIR", help="run ccx in DIR and compare with the cylinder model")
    c.add_argument("--mesh", type=float, default=4.0, help="max element length along the meridian [mm]")
    args = ap.parse_args(argv)

    if args.cmd == "serve":
        import uvicorn

        uvicorn.run("windlab.api:app", host=args.host, port=args.port)
        return 0
    if args.cmd == "analyze":
        from .core.design import analyze

        res = analyze(_load(args.project))
        st = res.structural
        if st:
            print(f"Burst {st.burst_pressure:.1f} MPa ({st.burst_mode}-first), required {st.required_burst:.1f} MPa")
            print(f"Autofrettage {st.autofrettage_pressure:.1f} MPa, window {st.autofrettage_window[0]:.1f}-"
                  f"{st.autofrettage_window[1]:.1f} MPa")
        print(f"Mass {res.mass.total:.0f} g, volume {res.mass.volume:.2f} L, PV/W {res.mass.pv_w:.1f} km")
        worst = 0
        for c in res.checks:
            print(f"[{c.status.upper():4}] {c.label}" + (f": {c.value:.3g}" if c.value is not None else "")
                  + (f" (limit {c.limit:.3g})" if c.limit is not None else ""))
            worst = max(worst, {"fail": 2, "warn": 1}.get(c.status, 0))
        return 1 if worst == 2 else 0
    if args.cmd == "gcode":
        from .post.gcode import generate

        prog = generate(_load(args.project), args.layers)
        out = args.output or prog.filename
        Path(out).write_text(prog.text)
        for w in prog.warnings:
            print("warning:", w, file=sys.stderr)
        print(f"{out}: {len(prog.lines)} lines, est. {prog.total_time / 60:.1f} min")
        return 0
    if args.cmd == "ccx":
        from .ccx_export import export, run_and_compare

        prj = _load(args.project)
        if args.run:
            for r in run_and_compare(prj, args.run, max_len=args.mesh):
                print(f"{r['step']:13s} hoop strain  ccx inner {r['ccx_inner']:.5f}  outer {r['ccx_outer']:.5f}  "
                      f"windlab {r['windlab']:.5f}")
            return 0
        meta = export(prj, max_len=args.mesh)
        out = args.output or meta["filename"]
        Path(out).write_text(meta["inp"])
        print(f"{out}: {meta['elements']} elements, {meta['nodes']} nodes, {meta['materials']} materials")
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
