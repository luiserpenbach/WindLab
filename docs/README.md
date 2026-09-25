# WindLab documentation

WindLab designs, analyses and manufactures filament-wound composite overwrapped pressure vessels (COPVs):
Type III (metal liner) and Type IV (polymer liner), wound on 2-, 3- and 4-axis machines driven by LinuxCNC or
GRBL / grblHAL.

| Document | For | Contents |
|---|---|---|
| [User guide](user-guide.md) | everyone | installation, a tour of the web UI, every step and field, workflows (Type III, Type IV, G-code, continuous winding, cure, test correlation), the design checks, CLI, troubleshooting, glossary |
| [Theory 1 – Geometry, fibre paths and thickness](theory/01-geometry-paths-thickness.md) | engineers | liner meridians, geodesic and non-geodesic paths, slippage, pattern closure and pattern style, band and build-up thickness |
| [Theory 2 – Structural analysis](theory/02-structural-analysis.md) | engineers | micromechanics and CLT, cylinder model with liner plasticity, autofrettage, burst, Puck matrix cracking, shell FE, progressive failure, fatigue, winding tension, Type IV liner checks, all design checks |
| [Theory 3 – Reliability, cure and design tools](theory/03-reliability-cure-design-tools.md) | engineers | stress-rupture reliability, oven cure simulation, burst sensitivity, test calibration, layup suggestion, mass optimiser |
| [Theory 4 – Manufacturing: kinematics, G-code, continuous winding](theory/04-manufacturing-kinematics-gcode.md) | engineers, machine builders | machine model, eye placement, refinement, time planning, post-processors, G-code verification, continuous-winding transitions, FE exports, traveller |
| [HTTP API](API.md) | integrators | endpoints and payloads |
| [Validation](VALIDATION.md) | everyone | what is checked against what, agreement, and known limitations |

Conventions used throughout: lengths in mm, pressures and stresses in MPa, angles in degrees (radians in
equations), temperatures in °C, time in s (min where stated), masses in g. The winding angle is measured from
the vessel axis (the meridian). End A is at negative z, end B at positive z, z = 0 is the cylinder mid-plane.

> WindLab's predictions use datasheet or generic material data. Burst, fatigue, stress-rupture and cure
> predictions must be correlated with tests on the actual materials and process before a design is released.
> Pressure testing is hazardous: use a barricaded test cell and remote operation.
