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
| POST | `/api/suggest-layup` | `Project` | `{layers: Layer[], notes: string[]}` |
| POST | `/api/path` | `LayerRequest` | `PathResult` (fibre path on the mandrel, 3D) |
| POST | `/api/simulate` | `LayerRequest` | `SimulationResult` (machine axes over time) |
| POST | `/api/gcode` | `GcodeRequest` | `{filename, gcode, lines, total_time, warnings}` |
| POST | `/api/traveller` | `Project` | `{markdown, html}` shop-floor work instructions |
| GET | `/api/projects` | – | `[{name, modified}]` saved on the server |
| GET | `/api/projects/{name}` | – | `Project` |
| PUT | `/api/projects/{name}` | `Project` | `{ok: true}` |
| DELETE | `/api/projects/{name}` | – | `{ok: true}` |

Errors: HTTP 422 with `{detail}` (validation or infeasible design, e.g. a
turnaround radius larger than the cylinder radius).

## Material records

```ts
Fiber  = {id, name, E: MPa, strength: MPa, elongation: frac, density: g/cm3, tex: g/km, filaments: string}
Resin  = {id, name, E: MPa, nu, density: g/cm3}
LinerMaterial = {id, name, E, nu, yield, ultimate, density, hardening: MPa, elongation}
```

## Frames

* Part frame: `x` along the vessel axis (0 = cylinder mid-plane, end A at
  negative x), `y`/`z` radial. `PathResult.points` and
  `MachineFrame.contact` use this frame **before** mandrel rotation.
* To animate: rotate the mandrel group by `mandrel[i]` degrees about +x; the
  payout eye sits at `(carriage[i], crossfeed[i], 0)` in world frame and is
  rotated by `eye[i]` degrees about the world y axis (4-axis). The free fibre
  runs from the eye to the rotated contact point.
