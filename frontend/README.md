# WindLab web frontend

Single-page UI for WindLab: design, analyse, correlate with tests, simulate and
export G-code for Type III COPVs wound on 2/3/4-axis filament-winding machines.

Stack: Vite + React 18 + TypeScript (strict) + plain `three`. No UI kit or
charting library: form controls, the SVG line chart and the 3D viewer are in
`src/`.

## Development

```bash
# 1. backend (from the repo root)
cd backend && python3 -m uvicorn windlab.api:app --port 8000

# 2. frontend
cd frontend
npm install
npm run dev          # http://localhost:5173, /api is proxied to 127.0.0.1:8000
```

Other scripts:

| Script | What it does |
|---|---|
| `npm run build` | type-check (`tsc`) and build to `dist/` |
| `npm run typecheck` | type-check only |
| `npm run preview` | serve `dist/` (also proxies `/api`) |
| `npm run format` | Prettier over `src/` |

The build uses `base: './'`, so the backend can serve `dist/` from any path.
API calls go to `<page path>/api`.

## Layout of the source

```
src/
  api/        types.ts (mirrors backend/windlab/schemas.py), client.ts (typed fetch client)
  state/      projectStore (useReducer + undo/redo + localStorage autosave),
              analysis (debounced /api/analyze, catalog data), uiStore (step, theme,
              selection, layer reveal, path/sim/thickness-map results, 3D overlay options),
              materials (built-in + project materials), fe (FE valid mask),
              thickness (thickness-map colour scale), playback (simulation clock), defaults
  components/ fields (NumberInput etc.), ui (buttons, status, modal, KPI, progress),
              LineChart (SVG chart), BarChart (grouped bars), Heatmap (canvas map
              with SVG axes), TopBar, Stepper, Icon
  steps/      one panel per workflow step (+ optional bottom chart area), stepStatus,
              TensionPanel (Layup: winding tension schedule), OptimiseDialog (Layup),
              PressureTargets (water-jacket targets: Analysis, Testing, Export)
  viewer/     VesselViewer (three.js scene), Viewport (React wrapper), colors, colormaps
  util/       formatting and download helpers, gcodeBackplot (G-code interpreter)
  workers/    backplot.worker (parses the G-code for the backplot off the main thread)
```

## Behaviour notes

- **Recompute**: every project change is POSTed to `/api/analyze` after 400 ms
  of quiet. In-flight requests are aborted. On an error (HTTP 422 `detail`) the
  last valid result stays on screen and a banner shows the message.
- **Undo/redo**: Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y). Consecutive edits to the
  same field, such as slider drags, merge into one undo step. Plain text fields
  keep their native undo while focused.
- **Autosave**: the project is written to `localStorage` (`windlab.project.v1`)
  and restored when the page reloads. **Save** stores it on the server
  (`PUT /api/projects/{name}`, also Ctrl+S). **Export** downloads JSON.
  **Open** lists server projects or imports a JSON file.
- **Number inputs** commit on Enter or blur. Escape reverts the edit. ↑/↓ step
  the value (Shift ×10, Alt ×0.1). Both `.` and `,` work as the decimal
  separator, and simple arithmetic (`300/2`) is accepted. Out-of-range values
  are flagged and not committed.
- **Step status dots**: checks are routed to steps by id prefix (`geo`,
  `liner` (incl. `liner.temp`, `liner.lbb`), `af`, `fatigue` → Vessel; `layer` (incl. `layer.<id>.slip` /
  `.path`), `layup` (e.g. `layup.bridging`), `tension`, `dome` → Layup; all
  checks → Analysis; `sr.*` incl. `sr.temp` sit there too). Checks with `refs`
  (layer ids) show chips; clicking the row or a chip opens the Layup step with
  that layer selected and scrolled into view. The Machine and Simulate dots come from the last
  simulation's `limits_ok` and warnings; the Thickness dot from the last
  thickness map (warn on backend warnings, gaps > 0.5 %, overlaps > 5 % or
  cells without a value).
- **Thickness step** (`/api/thickness-map`): band-level build-up of one layer
  or of all layers up to it. Runs take ~0.5–30 s, show elapsed time and can be
  cancelled (the fetch is aborted). Results are cached per project and request;
  changing layer, mode or grid re-runs, project edits only mark the map stale.
  The map is drawn unrolled (x = z or meridian s, y = φ; several rows in one
  pixel column show their maximum) and, optionally, as a texture on the
  layer's surface in the 3D view (u = φ, v = liner meridian arclength via the
  shared profile index). Colour scale: viridis over 0 – 2 × nominal (default),
  0 – 99.5th percentile, or 0 – max.
- **Analysis step, shell FE** (`AnalysisResult.fe`): burst incl. domes and
  liner hot-spot tiles, fibre-utilisation and liner von Mises charts along z
  (the rigid-ring boss clamp zone, r < boss + 3 × wall, is shaded and left out
  of the y range), a 3D surface colouring by either quantity (vertex colours
  by z) and a magnified deformed shape (auto scale: 10 % of the radius).
- **Winding tension** (Layup step, `/api/tension-schedule`): residual ply
  prestress current vs. recommended, recommended tensions per layer, and
  "Apply recommended tensions" as one undo step (rounded to 0.1 N).
- **3D view**: the vessel is revolved from `liner_outer`/`liner_inner` and each
  `LayerResult.surface`. The section toggle cuts the vessel in half and draws
  filled cross-sections of the liner wall and each layer. While simulating a
  layer, only the layers wound before it are shown. The mandrel group rotates
  about +x by `frames.mandrel`, and the eye sits at `(carriage, crossfeed, 0)`,
  rotated by `frames.eye` about world y.
- **Materials library** (Materials step, below the 3D view): built-in records
  (`/api/materials`) and the project's custom ones (`Project.materials`, saved
  with the project) per kind. "Duplicate as custom" opens an editor prefilled
  from a built-in record; custom records can be edited (renaming the id
  updates the references), duplicated and deleted (not while in use unless a
  built-in with the same id takes over). A custom record with a built-in id
  overrides it, as in the backend. All fibre/resin/liner selects list custom
  materials first, marked "(custom)".
- **Layer fields**: per-layer fibre override (badge in the layer table), hoop
  band overlap (0–90 %), start angle (pattern clocking).
- **Thermal**: operating temperature range + test ambient (Vessel), cure /
  stress-free temperature (Materials; one click takes the resin's final cure
  temperature). Analysis shows "After cure", "MEOP cold/hot" rows and the
  worst stress ratio over the range.
- **Testing step** (`/api/calibrate`, re-run 600 ms after edits while the step
  is open): editable test records, CSV / spreadsheet paste import (header
  aliases, `pressure [bar]` converted), measured-vs-predicted burst chart or
  ratio bars, and "Apply suggested / B-basis efficiency" (one undo step;
  disabled outside 0.3 < η ≤ 1).
- **Optimise mass** (Layup, `/api/optimise`): time budget 5–600 s, progress
  with elapsed time and cancel (aborts the request; the server finishes its
  run), then a per-layer diff (new / changed / moved / removed) and Apply as
  one undo step.
- **Export**: G-code verification card (green when the backend verifier found
  no errors and its interpreted time matches), axis ranges and largest steps;
  a **backplot** tab that interprets the program in a Web Worker (G0/G1,
  G92/G92.1, G93/G94; ~0.5 s for 500k lines) and plots every axis vs line or
  time with min/max decimation and layer markers; design report (opens in a
  new tab from a Blob URL, also as .html); Abaqus export (.inp + layup .csv);
  pressure test targets next to the traveller.
- **2-axis machines**: no crossfeed column / zero radius; the Simulate readout
  shows the fixed eye radius and the 3D eye does not move radially.
- Keyboard: Alt+1…9 switches steps. In the layer table, Alt+↑/↓ on a layer
  moves it.
