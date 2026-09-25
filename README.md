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
- Liner meridians: geodesic-isotensoid, hemispherical, elliptical; separate boss radii; liner neck thickening
  into the bosses. Material database plus a per-project library of qualified materials (fibres, resins,
  liners incl. CTEs and S-N data).
- Layer-by-layer build-up: band thickness from tex / band width / Vf; each layer is wound on the surface left
  by the previous one (thick polar build-ups are cleaned of offset loops). Per-layer fibre override (e.g.
  glass outer layer), hoop overlap and drop-offs, helical turnaround offsets per end, pattern clocking.
- **Geodesic and non-geodesic helical paths**: slippage-controlled path ODE (kg/kn) integrated in fibre
  arclength, shooting for each end's turnaround radius (unequal polar openings), auto cylinder angle that
  balances slippage on both domes, per-layer friction checks, dwell-slippage info.
- **Pattern closure solver**: circuits/advance with gcd(n,k)=1, dwell per turnaround, coverage, pattern
  number, leading/lagging; auto or user-picked. **Pattern style** per layer: request a pattern number
  (1-2 = large diamonds, high = fine mosaic) and leading/lagging; the solver finds the closest closing pattern.
- **Band-level thickness simulation**: every band of every circuit laid with its real width and
  cross-section (rectangular / lenticular / elliptical) onto a surface grid: gaps, overlaps, crossover
  ridges, polar build-up peaks.

**Analysis**
- **Type III and Type IV**: metal liners (autofrettage, reverse yield, liner fatigue, leak-before-burst) and
  polymer liners (HDPE, PA6: no autofrettage; liner strain at proof, cure and service temperature limits,
  H2 permeation vs the GTR 13 / EC 79 limit with Arrhenius temperature dependence, internal support pressure
  needed while winding against liner buckling).
- Cylinder: J2 elastic-plastic liner + CLT overwrap with thermal strains; cure cool-down residual stresses;
  autofrettage window and auto-selection; proof; MEOP at ambient and at the temperature extremes; burst
  (hoop-first check, helical reserve); stress-rupture ratios; liner fatigue (SWT).
- **Whole-vessel axisymmetric laminated shell FE** (liner + every layer with local thickness and angle):
  fibre utilisation along the domes, liner bending hot spots, burst estimate incl. domes, hot-spot fatigue.
- **Progressive failure analysis** (nonlinear shell): J2 liner through the thickness, Puck inter-fibre
  failure (modes A/B/C) with stiffness degradation, fibre failure per ply, full load history (cure,
  autofrettage, proof, MEOP) then a burst ramp; reports first matrix crack, first fibre failure, liner
  yield, the burst location and damage maps. The cylinder model also includes Puck matrix cracking.
- **Stress-rupture reliability**: Weibull power-law breakdown (Coleman/Phoenix, as in NASA COPV
  assessments) with cumulative damage over autofrettage, proof and service, credit for surviving the proof
  test, failure probability over the service life per ply group, allowed stress ratio and life to target.
  Parameters per fibre family calibrated to the ISO 11119 / 11439 stress ratios (overridable).
- Netting sizing, dome netting check, **winding tension loss** and uniform-prestress tension schedule,
  **fibre bridging** detection, predicted **water-jacket volumetric expansion**.
- **Suggest layup** (sizes to every check), **mass optimiser**, **test-data calibration** (burst /
  expansion correlation, suggested and B-basis translation efficiency).

**Manufacturing**
- **Continuous winding** (roving never cut): automatic transitions between layers. Helical layers join
  directly when the angle changes by <= 7 deg (configurable); larger changes get transition passes at
  intermediate angles and turnaround radii, each dome leg checked against friction; hoop <-> helical uses
  friction-limited angle ramps on the cylinder; phase dwells keep every layer's planned pattern. Transition
  fibre length/mass reported; G-code winds the whole vessel in one program.
- Kinematics for 2-axis (fixed eye radius), 3-axis and 4-axis (eye roll) machines, clearance envelope from
  the wound part, bosses and shaft; free-fibre clearance check; time planning with velocity and
  acceleration limits; soft limits.
- Post-processors: **LinuxCNC** (G93, `M68` tension, `(MSG)`/`M0` pauses) and **GRBL / grblHAL** (G93,
  spindle-PWM tension, float-safe rotary resets, letter validation), any axis mapping / scale / direction.
- Traveller (BOM, prep, per-layer sign-off, cure, autofrettage/proof with expansion targets), printable
  **design report**, **Abaqus SAX1 composite export** + per-element layup CSV, **CalculiX axisymmetric
  solid export** (open source; `windlab ccx project.json --run DIR` runs it and compares with WindLab).
- **Validation**: see [docs/VALIDATION.md](docs/VALIDATION.md) (analytic references, independent FE,
  G-code interpretation).

## Engineering model: know the limits

WindLab is for preliminary design and process planning. Before pressurising
hardware:

- Material values are typical datasheet numbers. Use qualified, lot-specific
  allowables. The liner S-N data is indicative only.
- The structural model covers the cylinder membrane. It does not include dome
  bending, the boss/liner junction, winding-tension residual stress or
  cure/thermal residual stress. Validate the domes with FEA and verify the
  design by burst testing.
- Non-geodesic paths use a constant slippage coefficient per dome; friction values must be measured for
  your fibre/resin/surface combination.
- The shell FE is linear elastic at MEOP; burst including domes is estimated by scaling the cylinder's
  nonlinear burst. The Abaqus export has not been validated in Abaqus by the authors; check the normals
  and ply order on first use.
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

- Continuous layer transitions (currently a pause and reposition between layers).
- Stress-rupture reliability model (S-081B style) and hot/wet allowable knock-downs.
- Nonlinear (liner plasticity) shell FE and dome burst without scaling; CalculiX export.
- Type IV / Type V vessels.
