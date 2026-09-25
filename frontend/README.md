# WindLab web frontend

Single-page UI for WindLab: design, analyse, simulate and export G-code for
Type III COPVs wound on 3/4-axis filament-winding machines.

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
              selection, path/sim results), playback (simulation clock), defaults
  components/ fields (NumberInput etc.), ui (buttons, status, modal, KPI),
              LineChart (SVG chart), TopBar, Stepper, Icon
  steps/      one panel per workflow step (+ optional bottom chart area), stepStatus
  viewer/     VesselViewer (three.js scene), Viewport (React wrapper), colors
  util/       formatting and download helpers
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
  `liner`, `af`, `fatigue` → Vessel; `layer`, `layup`, `dome` → Layup; all
  checks → Analysis). The Machine and Simulate dots come from the last
  simulation's `limits_ok` and warnings.
- **3D view**: the vessel is revolved from `liner_outer`/`liner_inner` and each
  `LayerResult.surface`. The section toggle cuts the vessel in half and draws
  filled cross-sections of the liner wall and each layer. While simulating a
  layer, only the layers wound before it are shown. The mandrel group rotates
  about +x by `frames.mandrel`, and the eye sits at `(carriage, crossfeed, 0)`,
  rotated by `frames.eye` about world y.
- Keyboard: Alt+1…7 switches steps. In the layer table, Alt+↑/↓ on a layer
  moves it.
