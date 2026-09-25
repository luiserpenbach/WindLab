# WindLab

Filament winding design and CAM for **Type III COPVs** (metal liner, carbon
overwrap), from liner geometry to G-code for **3- and 4-axis** winding machines
running **LinuxCNC** or **GRBL / grblHAL**, driven from a web UI.

```
Vessel ─► Materials ─► Layup ─► Analysis ─► Machine ─► Simulate ─► Export
liner &    fibre/resin  hoop/     burst,      axes,      3D eye &   G-code +
domes      micromech.   helical,  autofrett., limits,    mandrel    traveller
                        patterns  fatigue     posts      playback
```

## Quick start

```bash
# backend (Python ≥ 3.10)
cd backend
pip install -e ".[dev]"
windlab serve            # http://127.0.0.1:8000  (serves frontend/dist if built)
pytest                   # engineering + API test suite

# frontend (Node ≥ 18)
cd frontend
npm install
npm run dev              # http://localhost:5173, proxies /api to :8000
npm run build            # production build into frontend/dist, served by `windlab serve`
```

CLI without the UI:

```bash
windlab analyze my_tank.json          # checks, burst, autofrettage window; exit 1 on failures
windlab gcode my_tank.json -o tank.ngc
```

Projects are plain JSON (`backend/windlab/schemas.py` is the single source of
truth for fields and units). Server-side saves go to `~/.windlab/projects`
(`WINDLAB_PROJECTS` to override).

## What it does

**Design**
- Liner meridians: geodesic-isotensoid, hemispherical and elliptical domes,
  separate boss radii per end, boss/shaft geometry for clearance.
- Material database (T700S, T800S, T1000G, IM7, AS4, E-glass; epoxies;
  AA6061-T6/T62, AA7075-T73, Ti-6Al-4V, 316L) with Halpin-Tsai micromechanics
  and a strength translation efficiency.
- Layer-by-layer build-up: band thickness from tow tex / band width / Vf,
  hoop drop-offs, helical dome thickness from fibre conservation, band-averaged
  so it stays finite at the turnaround. **Each layer is wound on the surface left
  by the previous one.**
- Geodesic helical paths (Clairaut), turnaround staggering to spread the polar
  build-up.
- **Pattern closure solver**: enumerates circuit counts / advances with
  gcd(n, k) = 1, dwell needed per turnaround, coverage, pattern number
  (crossover count), leading/lagging. Auto-pick or choose in the UI.

**Structural analysis (Type III)**
- Elastic-plastic liner (J2, plane stress, linear hardening, return mapping)
  coupled to the CLT overwrap; exact cylinder equilibrium.
- Full pressure history: autofrettage → proof → MEOP, residual stresses.
- **Autofrettage window**: lower bound max(proof, first yield), upper bound
  from reverse yielding on unload (0.9 σy for the Bauschinger effect) and fibre
  strain; auto-selection inside the window.
- Burst by fibre-strain failure; hoop-first check and helical reserve.
- Stress-rupture ratios at MEOP, liner fatigue (SWT with indicative S-N data)
  against design cycles × scatter factor.
- Netting sizing and a dome netting-stress check.
- **Suggest layup**: netting start point refined by full analysis until burst,
  failure mode, stress ratio, autofrettage and fatigue checks pass.

**Manufacturing**
- Kinematics for 3-axis (carriage, crossfeed, mandrel) and 4-axis (+ eye roll)
  machines: eye on an envelope at a set clearance from the wound part and the
  bosses/shaft, free fibre along the path tangent, mandrel angle solved per
  point, eye roll keeps the band flat.
- Time planning with fibre speed, per-axis velocity and acceleration limits;
  soft-limit checks; the machine's minimum crossfeed radius is respected.
- Post-processors: **LinuxCNC** (`.ngc`, G93 inverse time, `M68` tension
  analog out, `(MSG,…)` + `M0` layer pauses, `G64` blending) and **GRBL /
  grblHAL** (`.gcode`, G93, tension via spindle PWM, 32-bit-float safe rotary
  resets per layer or circuit, axis letter validation). Any axis letter,
  scale (e.g. mandrel mapped to a linear GRBL axis in degrees) and direction.
- Shop-floor traveller: BOM with allowance, preparation checklist, layer table
  with sign-off, cure, autofrettage/proof/leak steps, release.

## Engineering model: know the limits

WindLab is for preliminary design and process planning. Before pressurising
hardware:

- Material values are typical datasheet numbers. Use qualified, lot-specific
  allowables. The liner S-N data is indicative only.
- The structural model covers the cylinder membrane. It does not include dome
  bending, the boss/liner junction, winding-tension residual stress or
  cure/thermal residual stress. Validate the domes with FEA and verify the
  design by burst testing.
- Geodesic paths only. With unequal polar openings, both ends use the larger
  turnaround radius.
- Always dry-run new G-code (no fibre, no mandrel) with feed override and
  check the axis directions and offsets.

## Repository layout

```
backend/windlab/
  schemas.py            project + result data model (units: mm, MPa, N, deg, s, g)
  core/geometry.py      liner meridians, offsets, turnaround search
  core/materials.py     database, micromechanics, band thickness
  core/winding.py       geodesic & hoop paths
  core/patterns.py      pattern closure solver
  core/structural.py    liner plasticity + CLT vessel model, burst, fatigue
  core/design.py        layer build-up, analysis, checks, layup sizing
  core/kinematics.py    3/4-axis inverse kinematics, time planning, limits
  post/gcode.py         LinuxCNC and GRBL post-processors
  manufacturing.py      traveller
  api.py, cli.py        FastAPI app and CLI
frontend/               React + TypeScript + three.js web UI
docs/API.md             HTTP API
```

## Roadmap (not yet implemented)

- Non-geodesic winding (friction-limited slippage) for unequal openings and
  angle control, plus friction calibration.
- Dome FE export (Abaqus/CalculiX axisymmetric shell with per-element
  angle/thickness), and an integrated axisymmetric FE solver.
- Collision checks of the eye body against the part, and axis reversal
  smoothing at the turnarounds.
- Layer transitions without stopping (continuous winding between layers).
- Test-data loop: import burst, strain-gauge and autofrettage data and
  compare with the predictions to calibrate efficiency factors.
- Type IV (polymer liner) and Type V support, and a stress-rupture
  reliability model per ANSI/AIAA S-081B.
- A layup optimiser (mass vs. margins) and cost/time dashboards.
