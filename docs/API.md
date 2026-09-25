# WindLab HTTP API

The backend is stateless: every compute request carries the full `Project`
(see `backend/windlab/schemas.py` for all field names, defaults and units).
All lengths in mm, pressures/stresses in MPa, angles in degrees, time in s,
mass in g.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | – | `{status, version}` |
| GET | `/api/materials` | – | `{fibers: Fiber[], resins: Resin[], liners: LinerMaterial[]}` |
| GET | `/api/machines` | – | `[{id, label, machine: MachineSpec}]` presets |
| GET | `/api/examples` | – | `[{id, label, project: Project}]` example projects |
| POST | `/api/analyze` | `Project` | `AnalysisResult` |
| POST | `/api/suggest-layup` | `Project` (query `progressive=true`: verify with progressive failure, add layers until it passes) | `{layers: Layer[], notes: string[]}` |
| POST | `/api/path` | `LayerRequest` | `PathResult` (fibre path on the mandrel, 3D) |
| POST | `/api/simulate` | `LayerRequest` | `SimulationResult` (machine axes over time) |
| POST | `/api/gcode` | `GcodeRequest` | `{filename, gcode, lines, total_time, warnings}` |
| POST | `/api/thickness-map` | `ThicknessMapRequest` | `ThicknessMapResult`: band-level thickness grid (z x phi) + stats |
| POST | `/api/tension-schedule` | `TensionScheduleRequest` | current vs recommended tensions for uniform prestress |
| POST | `/api/optimise` | `OptimiseRequest` | `OptimiseResult`: minimum-mass layup with all blocking checks passing |
| POST | `/api/calibrate` | `Project` (with `tests`) | `CalibrationResult`: measured vs predicted, suggested efficiency |
| POST | `/api/suggest-cure` | `Project` | `{cure_cycle, result: CureResult, notes}`: shortest cure cycle meeting exotherm / degree of cure / Tg / liner temperature |
| POST | `/api/continuous` | `Project` | `ContinuousResult`: transition between every pair of layers (kind, passes and their angles, slippage vs limit, fibre length/mass, phase dwell, 3D points); G-code winds these when `project.continuous.enabled` |
| POST | `/api/progressive` | `{project, mesh}` | `ProgressiveResultOut`: progressive-failure burst, first IFF / FF / liner-yield pressures, events, pressure-strain curve, damage along z (10 s to minutes) |
| POST | `/api/report` | `Project` (query `progressive=true` adds the progressive-failure analysis) | `{html}`: self-contained printable design report (Type III/IV, stress rupture, transitions when continuous) |
| POST | `/api/ccx-export` | `Project` | `{filename, inp, elements, nodes, materials, steps}` CalculiX axisymmetric solid deck (CLI `windlab ccx --run` also compares with WindLab) |
| POST | `/api/fea-export` | `Project` | `{filename, inp, csv_filename, csv, elements, materials}` Abaqus SAX1 deck + layup CSV |
| POST | `/api/traveller` | `Project` | `{markdown, html}` shop-floor work instructions (`html` is an unstyled fragment) |
| GET | `/api/projects` | – | `[{name, modified}]` saved on the server |
| GET | `/api/projects/{name}` | – | `Project` |
| PUT | `/api/projects/{name}` | `Project` | `{ok: true}` |
| DELETE | `/api/projects/{name}` | – | `{ok: true}` |

Errors: HTTP 422 with `{detail}` (validation or infeasible design, e.g. a
turnaround radius larger than the cylinder radius).

## Material records

```ts
Fiber  = {id, name, E: MPa, strength: MPa, elongation: frac, density: g/cm3, tex: g/km, filaments: string,
          E2, G12: MPa (transverse/shear, for micromechanics), nu12}
Resin  = {id, name, E: MPa, nu, density: g/cm3}
LinerMaterial = {id, name, E, nu, yield, ultimate, density, hardening: MPa, elongation,
                 fatigue_coeff: MPa, fatigue_exp (Basquin sigma'_f, b; indicative)}
```

## Frames

* Part frame: `x` along the vessel axis (0 = cylinder mid-plane, end A at
  negative x), `y`/`z` radial. `PathResult.points` and
  `MachineFrame.contact` use this frame **before** mandrel rotation.
* To animate: rotate the mandrel group by `mandrel[i]` degrees about +x; the
  payout eye sits at `(carriage[i], crossfeed[i], 0)` in world frame and is
  rotated by `eye[i]` degrees about the world y axis (4-axis). The free fibre
  runs from the eye to the rotated contact point.
