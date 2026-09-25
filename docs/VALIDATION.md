# WindLab validation

What is checked, against what, and how well it agrees. Everything below is an automated test in
`backend/tests/` unless marked otherwise, so it is re-verified on every change.

## Geometry and fibre paths

| Quantity | Reference | Agreement |
|---|---|---|
| Hemisphere + cylinder volume | closed form | 0.2 % |
| Isotensoid dome height | classical 0.55-0.65 R | in range |
| Geodesic advance per pass (hemispherical domes) | pi + L tan(a)/R | 1e-5 relative |
| Clairaut invariant r sin(a) along the path | r0 | 2 % (numerical derivative) |
| Non-geodesic path with lambda = 0 | geodesic solution | 1e-4 |
| Non-geodesic slippage kg/kn measured on the 3D path (finite differences) | prescribed lambda | 1 % |
| Turnaround radius hit by the shooting solver | requested radius | 0.1 mm |
| Pattern closure | every band slot visited once, advance = 2 pi k / n | exact |

## Thickness

| Quantity | Reference | Agreement |
|---|---|---|
| Helical thickness on the cylinder | nominal 2 t_band x coverage | 0.1 % |
| Isotensoid netting fibre stress along the dome (single layer) | uniform (definition of isotensoid) | 15 % incl. turnaround zone |
| Band simulation: single band footprint | B / cos(a) | 2 % |
| Band simulation: rectangular bands on the cylinder | uniform nominal | CV < 3 % |
| Band simulation: dome mean | axisymmetric band-averaged model | 1 % median |
| Band simulation: volume, rectangular vs lenticular bands | equal | 0.1 % |

## Structural

| Quantity | Reference | Agreement |
|---|---|---|
| Liner return mapping | stays on the yield surface; EH/(E+H) tangent | exact |
| Cylinder hoop equilibrium | p Ri | 1e-6 |
| Free body after autofrettage / cure cool-down | forces cancel | 1e-6 |
| Shell FE, liner-only cylinder | hoop p Ri / t, axial resultant p Ri^2 / (2 R) | 0.2 % |
| Shell FE, sphere membrane | equal biaxial | 0.5 % |
| Shell FE vs cylinder model (thick composite) | independent formulation | 1-6 % |
| **CalculiX axisymmetric solid FE vs cylinder model** (desktop example, composite hoop strain at mid-plane) | independent open-source solver | **2-6 %** (cure, autofrettage, proof, MEOP) |
| Burst calibration: suggested efficiency re-run | 0.92 x prediction | 3 % |

The CalculiX comparison also shows what the thin-wall cylinder model cannot: the **liner inner surface**
strains about 15 % more than the composite at autofrettage (through-thickness compression and 1/r). Use the
CalculiX export (`windlab ccx project.json --run DIR`) when the liner's plastic strain at autofrettage is
critical.

Example (1 L desktop vessel, `grbl-10mpa-1l`), hoop strain at the cylinder mid-plane:

| State | CalculiX liner inner | CalculiX composite outer | WindLab cylinder model |
|---|---|---|---|
| after cure | -0.00119 | -0.00131 | -0.00124 |
| autofrettage peak | 0.00902 | 0.00771 | 0.00774 |
| after autofrettage | 0.00298 | 0.00225 | 0.00206 |
| proof | 0.00589 | 0.00488 | 0.00480 |
| MEOP | 0.00492 | 0.00401 | 0.00388 |

## Machine motion and G-code

| Quantity | Reference | Agreement |
|---|---|---|
| Eye on the free-fibre ray, outside the clearance envelope | geometry | 1e-3 mm |
| Fibre feed (laid + change of free length) | >= 0 (no slack) | exact |
| G-code interpreted like a controller (G93/G94, G92, G92.1) | simulation | mandrel within 0.01 deg per layer; inverse-time total within 0.1 % |
| Max axis step per G-code segment | adaptive refinement limits | 5 deg mandrel / 10 mm carriage / 10 deg eye (warnings where the geometry forces more) |
| Posts: LinuxCNC, GRBL 2/3-axis, grblHAL 4-axis | letters, feeds, line length | every G1 in G93 carries F; GRBL lines <= 70 chars |

## Not validated (yet)

- The Abaqus deck has not been run in Abaqus by the authors (conventions reviewed: SAX1 DOFs, normals, ply
  order, OFFSET, per-element pressure scaling).
- Material data are datasheet values; burst and fatigue predictions need test calibration (`/api/calibrate`).
