# 4. Manufacturing: machine kinematics, G-code and continuous winding

This chapter covers how WindLab turns a designed layup into machine motion: the inverse kinematics of
2-, 3- and 4-axis filament-winding machines, time planning, the LinuxCNC and GRBL/grblHAL
post-processors, the independent G-code verifier, continuous winding (the roving is not cut between
layers), and the exports that leave WindLab (CalculiX and Abaqus decks, and the shop traveller).

It describes what the code in `backend/windlab/` actually does, including its simplifications. Numbers
marked *worked example* were produced by running the shipped example projects
(`windlab.presets.examples()`) with the code as it is in the repository. They will drift slightly if the
examples are re-sized.

Conventions used throughout:

- Lengths in mm, angles in degrees at the machine interface (radians inside the path code), times in s.
- $z$ is the vessel axis; the vessel mid-plane is at $z = 0$; end A is $z<0$ and end B is $z>0$.
- The winding angle $\alpha$ is measured from the meridian (the vessel axis): $\alpha = 0$ is axial,
  $\alpha \to 90^\circ$ is a hoop.
- "Layer" means one `BuiltLayer` (a helical ±α layer or a hoop layer) from `core/design.py`.

---

## Table of contents

1. [Machine model](#1-machine-model)
   1. [Axes and frames](#11-axes-and-frames)
   2. [Axis mapping, scale, direction and offsets](#12-axis-mapping-scale-direction-and-offsets)
   3. [Soft limits and the minimum eye radius](#13-soft-limits-and-the-minimum-eye-radius)
   4. [2-, 3- and 4-axis machines](#14-2--3--and-4-axis-machines)
2. [Free-fibre geometry (inverse kinematics)](#2-free-fibre-geometry-inverse-kinematics)
   1. [Fibre path in the mandrel frame](#21-fibre-path-in-the-mandrel-frame)
   2. [The tangent ray and tangent smoothing](#22-the-tangent-ray-and-tangent-smoothing)
   3. [The eye envelope](#23-the-eye-envelope)
   4. [Ray–envelope intersection](#24-rayenvelope-intersection)
   5. [The no-slack condition](#25-the-no-slack-condition)
   6. [Mandrel angle](#26-mandrel-angle)
   7. [Eye roll angle (4-axis)](#27-eye-roll-angle-4-axis)
   8. [Free-fibre clearance and `solid_depth`](#28-free-fibre-clearance-and-solid_depth)
   9. [Warnings and a worked example](#29-warnings-and-a-worked-example)
   10. [Limitations of the kinematic model](#210-limitations-of-the-kinematic-model)
3. [Adaptive refinement](#3-adaptive-refinement)
4. [Time planning](#4-time-planning)
5. [G-code post-processors](#5-g-code-post-processors)
   1. [Program structure](#51-program-structure)
   2. [LinuxCNC vs GRBL / grblHAL](#52-linuxcnc-vs-grbl--grblhal)
   3. [Inverse-time feed (G93)](#53-inverse-time-feed-g93)
   4. [Rotary G92 resets](#54-rotary-g92-resets)
   5. [Never turning the mandrel backwards between layers](#55-never-turning-the-mandrel-backwards-between-layers)
   6. [Layer start: the safe crossfeed retract](#56-layer-start-the-safe-crossfeed-retract)
   7. [Worked excerpts](#57-worked-excerpts)
6. [G-code verifier](#6-g-code-verifier)
7. [Continuous winding](#7-continuous-winding)
   1. [Motivation and overview](#71-motivation-and-overview)
   2. [Where layers start and end (pass parity)](#72-where-layers-start-and-end-pass-parity)
   3. [Direct joins](#73-direct-joins)
   4. [Transition passes: the angle schedule](#74-transition-passes-the-angle-schedule)
   5. [Near-geodesic turnaround radii](#75-near-geodesic-turnaround-radii)
   6. [Solving a pass and checking its slippage](#76-solving-a-pass-and-checking-its-slippage)
   7. [Nudging turnarounds off build-up ridges](#77-nudging-turnarounds-off-build-up-ridges)
   8. [Pass-count search](#78-pass-count-search)
   9. [Hoop ↔ helical cylinder ramps](#79-hoop--helical-cylinder-ramps)
   10. [The `HOOP_CAP` turnaround](#710-the-hoop_cap-turnaround)
   11. [Hoop → hoop connectors](#711-hoop--hoop-connectors)
   12. [Phase dwell](#712-phase-dwell)
   13. [Assembling the path: upper surface and merged points](#713-assembling-the-path-upper-surface-and-merged-points)
   14. [Parallel prefetch of pass solves](#714-parallel-prefetch-of-pass-solves)
   15. [G-code joins](#715-g-code-joins)
   16. [Worked example](#716-worked-example)
   17. [Limitations](#717-limitations)
8. [Exports](#8-exports)
   1. [CalculiX axisymmetric solid deck](#81-calculix-axisymmetric-solid-deck)
   2. [Abaqus SAX1 shell deck](#82-abaqus-sax1-shell-deck)
   3. [Shop traveller](#83-shop-traveller)
9. [Summary of assumptions and limitations](#9-summary-of-assumptions-and-limitations)
10. [References](#10-references)

---

## 1. Machine model

**Where in the code:** `core/kinematics.py` (module docstring, `machine_coords`, `to_machine`,
`check_limits`, `min_eye_radius`, `_axis_rate`); `schemas.py` (`MachineAxis`, `MachineSpec`);
`presets.py` (`machine_presets`).

### 1.1 Axes and frames

WindLab models the classical lathe-type winder (Peters 2011, ch. on winding machines; Koussios 2004):

| Role | Symbol | Motion | Default letter | Present on |
|---|---|---|---|---|
| Carriage | $X$ | eye translation parallel to the mandrel axis | `X` | 2, 3, 4 axes |
| Crossfeed | $Y$ | eye translation radially towards / away from the mandrel axis | `Y` | 3, 4 axes |
| Mandrel | $A$ | rotation of the mandrel (part) about its axis | `A` | 2, 3, 4 axes |
| Eye roll | $B$ | rotation of the payout eye about the crossfeed direction | `B` | 4 axes |

Two frames are used:

- **Mandrel (part) frame.** Fixed to the part. The fibre path, surfaces and contact points live here.
  Its $x$ axis is the vessel axis ($x \equiv z$ of the meridian profile).
- **World (machine) frame.** Fixed to the machine. The mandrel axis is world $x$. The eye moves in the
  horizontal half-plane through the axis, **world $z = 0$, $y > 0$**. The eye's world position is
  therefore fully described by two numbers: its axial position $x_e$ (carriage) and its distance from the
  axis $y_e$ (crossfeed).

The mandrel angle $\theta$ (axis $A$) is the rotation about $+x$ that maps the mandrel frame onto the
world frame:

$$
\begin{pmatrix} y_w \\ z_w \end{pmatrix} =
\begin{pmatrix} \cos\theta & -\sin\theta \\ \sin\theta & \cos\theta \end{pmatrix}
\begin{pmatrix} y_m \\ z_m \end{pmatrix}, \qquad x_w = x_m ,
$$

where $(x_m, y_m, z_m)$ are mandrel-frame and $(x_w, y_w, z_w)$ world-frame coordinates. The test
`tests/test_machine.py::test_eye_lies_on_free_fibre_ray` uses exactly this rotation to check that the
eye lies on the free-fibre ray to $10^{-3}$ mm.

The inverse-kinematics problem solved for every sample of the fibre path is: *given the contact point and
fibre direction in the mandrel frame, find $(x_e, y_e, \theta, \beta)$ such that the eye lies on the free
fibre and outside the part.*

### 1.2 Axis mapping, scale, direction and offsets

Kinematics produces "part units": $x_e$ and $y_e$ in mm, $\theta$ and $\beta$ in degrees. Each
`MachineAxis` then converts to controller units with `to_machine`:

$$
q_{\text{machine}} = q_0 + s_{\text{dir}}\; k \; q_{\text{part}}, \qquad
s_{\text{dir}} = \begin{cases} -1 & \text{if the axis is inverted} \\ +1 & \text{otherwise} \end{cases}
$$

with $k$ = `scale` (machine units per mm for linear axes, per degree for rotary axes) and $q_0$ the
offset. `machine_coords` applies:

| Axis | Part value | Offset / shift |
|---|---|---|
| carriage | $x_e$ | $q_0$ = `carriage_offset`: machine carriage coordinate of the mid-plane $z = 0$ |
| crossfeed | $y_e - r_0$ | $r_0$ = `crossfeed_zero_radius`: eye distance from the axis when the crossfeed reads 0 |
| mandrel | $\theta$ (cumulative, unwrapped) | none |
| eye | $\beta$ | none (4-axis only) |

Example (GRBL 3-axis desktop preset): `carriage_offset = 400`, `crossfeed_zero_radius = 30`; an eye at
$y_e = 62.296$ mm is commanded as `Z32.296` (the preset maps the crossfeed to `Z` and the mandrel to `Y`,
in degrees).

### 1.3 Soft limits and the minimum eye radius

`check_limits` converts the whole motion to machine coordinates and compares the carriage, crossfeed
(3/4-axis only) and eye axes with their optional `min`/`max`. Violations become warnings
(`"crossfeed axis Y below soft limit: ..."`); the motion is not clipped. The mandrel has no limits
(unbounded rotation).

The crossfeed's inner soft limit is also used *geometrically*: `min_eye_radius` returns the smallest
eye radius the crossfeed can reach,

$$
y_{e,\min} = r_0 + s_{\text{dir}}\,\frac{L}{k}, \qquad
L = \begin{cases} L_{\max} & \text{if inverted} \\ L_{\min} & \text{otherwise}\end{cases}
$$

where $L_{\min}, L_{\max}$ are the crossfeed's `min`/`max` soft limits (machine units), and the eye envelope (§2.3) is floored at this value, so the solution never asks the crossfeed to go
closer to the axis than it can. In the desktop example $r_0 = 30$ mm and $L_{\min} = 0$, so
$y_{e,\min} = 30$ mm; the eye of the first helical layer actually reaches this floor near the poles
(eye radius range 30.0–62.9 mm).

The **outer** crossfeed limit is only checked, not enforced: the no-slack correction (§2.5) can push the
eye outwards and a warning is raised if that exceeds the limit.

### 1.4 2-, 3- and 4-axis machines

`MachineSpec.axes_count` selects the mode:

- **4-axis**: all four axes; the eye roll $\beta$ keeps the band flat (§2.7).
- **3-axis**: $\beta \equiv 0$ (no eye axis is output).
- **2-axis (fixed eye)**: no crossfeed. In `_simulate` the envelope is replaced by a constant equal to its
  maximum over the axial range of the path ±50 mm, so "the eye runs at one fixed radius clearing
  everything it passes". The crossfeed word is not written to the G-code and its limits are not checked.
  The fixed radius is computed per segment (per layer) and shown in the simulation; the operator sets it
  mechanically.

  *Observed behaviour of the current implementation:* the no-slack correction (§2.5) is applied after
  the fixed-radius intersection, so near helical turnarounds the planned eye point can move further out
  along the ray than the fixed radius (desktop example on the 2-axis preset: fixed radius 62.9 mm, planned
  eye radius up to 191 mm around the turnarounds). Because a 2-axis program has no crossfeed word, the
  commanded carriage/mandrel positions there correspond to a point further out on the ray than the
  physical eye. Review turnarounds of 2-axis programs in the simulation.

Presets (`presets.machine_presets()`):

| Preset | Controller | Axes (letters) | Fibre speed | Eye clearance | Rotary reset | Tension output |
|---|---|---|---|---|---|---|
| `linuxcnc-4axis` | LinuxCNC | X carriage, Y crossfeed, A mandrel, B eye | 100 mm/s | 15 mm | layer | `M68 E0` |
| `linuxcnc-3axis` | LinuxCNC | X, Y, A | 100 mm/s | 15 mm | layer | `M68 E0` |
| `grbl-3axis` | GRBL | X carriage, Y mandrel (deg), Z crossfeed | 60 mm/s | 12 mm | circuit | spindle `M3 S` |
| `grbl-2axis` | GRBL | X carriage, Y mandrel (deg) | 60 mm/s | 12 mm | circuit | spindle `M3 S` |
| `grblhal-4axis` | GRBL (grblHAL) | X, Y crossfeed, A mandrel, B eye | 80 mm/s | 12 mm | circuit | spindle `M3 S` |

---

## 2. Free-fibre geometry (inverse kinematics)

**Where in the code:** `core/kinematics.py`: `layer_path`, `_dedupe`, `_tangents`, `profile_envelope`,
`solid_radius`, `_upper_concave_hull`, `eye_envelope`, `min_eye_radius`, `no_slack`, `_surface_normals`,
`_simulate`, `solid_depth`, `free_fibre_clearance`; `core/winding.py` (`PathPoints`).

### 2.1 Fibre path in the mandrel frame

The fibre centre-line is a `PathPoints` object: samples of axial position $z_i$, radius $r_i$,
cumulative azimuth $\varphi_i$ and optionally the winding angle $\alpha_i$, slippage coefficient
$\lambda_i$, a dwell flag and the meridian arclength $s_i$. `layer_path` builds it for a helical layer
(`helical_layer_path`: circuits A→B, dwell, B→A, dwell, with the pattern's dwell) or a hoop layer
(`hoop_layer_path`: a helix of pitch = band width by default, half a revolution of dwell at every
reversal), adds the layer's `start_angle` clocking, and `_dedupe` removes zero-length segments.

The Cartesian contact point in the mandrel frame is (`PathPoints.xyz`)

$$
\mathbf P_i = \big(z_i,\; r_i\cos\varphi_i,\; -r_i\sin\varphi_i\big),
$$

the negative sine making the mandrel turn in the positive sense while the azimuth increases.

### 2.2 The tangent ray and tangent smoothing

At a contact point the free fibre leaves the surface **tangentially**, along the fibre direction
$\mathbf T_i$ (unit vector). Every admissible eye position lies on the ray

$$
\mathbf E_i(\lambda) = \mathbf P_i + \lambda\,\mathbf T_i, \qquad \lambda > 0 ,
$$

where $\lambda$ [mm] is the free-fibre length (since $\lVert\mathbf T_i\rVert = 1$). This is the standard
free-fibre model of winding-machine kinematics (Koussios 2004; Peters 2011): the fibre between contact
point and eye is a straight line under tension.

`_tangents` computes $\mathbf T_i$ by central differences of the sampled path (`np.gradient` over the
sample index), normalised. Before differencing, the path radius is partly replaced by a smoothed
surface radius:

- the base profile is resampled every 0.5 mm of meridian and its radius smoothed with a Gaussian of
  standard deviation `TANGENT_SMOOTHING` = 6 mm; the smoothed radius is a function of $z$ only, so it is
  independent of the direction of travel;
- the smoothed radius is used with weight

  $$
  w = \operatorname{clip}\!\left(\frac{h + e - |z|}{0.4\,e}, 0, 1\right)\cdot
      \operatorname{clip}\!\left(\frac{\cos\alpha}{0.2}, 0, 1\right),
  \qquad r_{\text{use}} = w\,\tilde r(z) + (1-w)\,r ,
  $$

  where $h$ is half the cylinder length, $e = 0.3\,r_{\max}$ with $r_{\max}$ the largest profile radius,
  $\tilde r$ the smoothed radius and $r$ the exact path radius.

Rationale (docstring): *the band bridges sub-band-width surface steps (hoop drop-offs)*. A helical band
crossing the step where a hoop layer ends does not follow the step; without smoothing, the finite
difference tangent would kink there and throw the eye around. The smoothing is therefore applied only on
the cylinder (plus a blend of $0.4e$ into the domes, where the profile can fold) and faded out for
near-circumferential fibre ($\alpha > 78.5^\circ$, $\cos\alpha < 0.2$), i.e. at turnarounds and in hoop
layers, where the exact geometry is kept.

### 2.3 The eye envelope

The eye must stay a clearance $c$ (`eye_clearance`) away from everything it can hit: the wound part
(including the current layer), the bosses and the winding shaft. `eye_envelope` builds a surface of
revolution $y = g_{\text{env}}(x)$ on which the eye travels:

1. **Solid radius** (`solid_radius`, `profile_envelope`): on a 1 mm grid in $x$, the maximum radius of the
   top surface of the current layer (a possibly folded meridian polyline is binned, empty bins inside the
   profile are interpolated), then the boss radius over `boss_length` beyond each pole, then the shaft
   radius further out (the grid extends 800 mm beyond the bosses).
2. **Eye body width**: a sliding maximum over $\pm w$ grid points, $w = \lfloor\max(c, 1)\rfloor$ mm, so a
   solid feature affects the envelope over the width of the eye.
3. **Clearance and concave hull**: within the window from `boss_length + 60` mm beyond pole A to the same
   beyond pole B, the envelope is the **upper concave hull** of (solid + width) $+ c$
   (`_upper_concave_hull`, a monotone-chain upper hull; it returns the smallest concave function $\ge$ the
   data). Outside the window the end values are held constant.
4. **Floor**: $g_{\text{env}} \leftarrow \max(g_{\text{env}}, y_{e,\min})$ (§1.3).

**Why concave.** The docstring states the key property: *along any free-fibre ray the distance from the
axis is convex in the ray parameter while a concave envelope stays concave, so every ray crosses the
envelope exactly once: the eye position is unique and varies continuously.* In detail, define

$$
h_i(\lambda) = \rho_i(\lambda) - g_{\text{env}}\big(x_i(\lambda)\big), \qquad
\rho_i(\lambda) = \big\lVert (\mathbf P_i + \lambda\mathbf T_i)_{yz} \big\rVert, \quad
x_i(\lambda) = P_{i,x} + \lambda T_{i,x},
$$

where the subscript $yz$ takes the two components perpendicular to the axis.

- $\rho_i$ is the norm of an affine function of $\lambda$, hence **convex**.
- $x_i$ is affine in $\lambda$, so $g_{\text{env}}(x_i(\lambda))$ is **concave** when $g_{\text{env}}$ is
  concave.
- Hence $h_i$ is convex. At the contact point $h_i(0) < 0$ (the envelope is at least the surface radius
  plus $c$). A convex function that is negative at 0 has at most one zero for $\lambda > 0$, and it
  crosses with positive slope; by the implicit function theorem the root depends continuously on
  $\mathbf P_i$ and $\mathbf T_i$.

With a non-concave envelope (for example following the true solid, with a step at a hoop drop-off or at
the boss shoulder) a ray could cross it three times; choosing "the first crossing" would then jump
discontinuously from one branch to another as the path moves, which shows up as sudden eye repositioning
in the program. The concave hull is the tightest envelope that avoids this, at the cost of keeping the eye
further out than strictly necessary over concave regions of the part (e.g. the dome/boss neck).

Strictly, the constant extension outside the hull window and the floor $y_{e,\min}$ are not concave, so
the uniqueness argument holds where the ray meets the hull itself; rays reaching the end regions are
near-axial ones, and `simulate_path` warns about any remaining jumps (§3).

*Worked example (desktop, first hoop layer):* top radius on the cylinder 50.296 mm, clearance 12 mm, so
$g_{\text{env}} = 62.3$ mm over the cylinder; 60.8 mm at $x = 80$ mm, 51.9 mm at 100 mm, 42.7 mm at
120 mm, and the 30 mm floor from about 150 mm outwards (boss radius 10 mm + 12 mm is below the floor).
For the 30 MPa example (clearance 15 mm): 115.7 mm on the cylinder, 65.8 mm at $x = 250$ mm, and
27.0 mm (shaft radius 12 + 15) far out.

### 2.4 Ray–envelope intersection

`_simulate` solves $h_i(\lambda) = 0$ for all samples at once (vectorised):

1. **Coarse scan** over $\lambda \in \{5, 10, \dots, 400\}$ mm (80 values) and then 230 values from 420 to
   5000 mm (≈ 20 mm apart). For each sample the first grid value with $h_i \ge 0$ and its predecessor
   bracket the root.
2. **Bisection**, 40 iterations, on each bracket; the upper end (outside the envelope) is taken.
3. Samples with no crossing up to 5000 mm (near-axial fibre) keep $\lambda = 5000$ mm and raise the
   warning *"N points have near-axial fibre; eye position clipped"*.

The first-crossing search is correct because of the uniqueness argument above; the coarse scan only
guarantees a bracket, and the bisection brings the error far below $10^{-3}$ mm.

### 2.5 The no-slack condition

The fibre fed through the eye between samples $i$ and $i+1$ is the length laid on the part plus the
change of free length:

$$
f_i = \ell_i + (\lambda_{i+1} - \lambda_i), \qquad \ell_i = \lVert \mathbf P_{i+1} - \mathbf P_i\rVert .
$$

If $f_i < 0$ the eye moves towards the part faster than fibre is laid: fibre would have to be pulled
back through the eye, i.e. slack that the tensioner must take up. `no_slack` enforces $f_i \ge 0$ with a
forward sweep

$$
\lambda_{i+1} \leftarrow \max\big(\lambda_{i+1},\; \lambda_i - \ell_i\big).
$$

Lengthening $\lambda$ keeps the eye on the same ray and, since $h_i$ is convex and already non-negative at
the root, every point further out is also outside the envelope. The price is that the eye can end up
further from the part than the envelope (and, in rare cases, beyond the outer crossfeed limit, which is
then reported). `tests/test_machine.py::test_no_fibre_slack` checks $\ell_i + \Delta\lambda_i \ge -10^{-6}$
for the first four layers of the default project.

Note that $f_i \ge 0$ is a kinematic condition only; the tension level itself is a separate output
(§5.2).

### 2.6 Mandrel angle

With $\mathbf Q_i = (\mathbf P_i + \lambda_i\mathbf T_i)_{yz} = (Q_{i,y}, Q_{i,z})$ the eye position
perpendicular to the axis in the mandrel frame, the mandrel angle is the rotation that brings it into the
eye plane (world $z = 0$, $y > 0$):

$$
\theta_i = -\operatorname{atan2}(Q_{i,z}, Q_{i,y}) \quad (\text{then unwrapped}), \qquad
y_{e,i} = \lVert \mathbf Q_i \rVert, \qquad x_{e,i} = P_{i,x} + \lambda_i T_{i,x}.
$$

From the rotation in §1.1, $z_w = Q_y\sin\theta + Q_z\cos\theta = 0$ and $y_w = \lVert\mathbf Q\rVert$.
Because $\mathbf P$ uses $-r\sin\varphi$, $\theta \approx \varphi$ plus the "eye lead" of the free fibre.
`np.unwrap` makes $\theta$ cumulative (a helical layer turns the mandrel thousands of degrees: 25 559°
for the first helical layer of the desktop example).

### 2.7 Eye roll angle (4-axis)

On a 4-axis machine the payout eye rotates about the crossfeed direction (world $y$) so that the band
leaves flat. The code aligns the eye with the **band width direction at the contact point**:

$$
\mathbf W_i = \mathbf N_i \times \mathbf T_i ,
$$

where $\mathbf N_i$ is the outward surface normal at the contact, interpolated from the base profile's
meridian normals $(n_z, n_r)$ by meridian arclength $s$ when available (robust on folded build-ups), and
rotated to azimuth $\varphi_i$ (`_surface_normals`). $\mathbf W_i$ lies in the tangent plane,
perpendicular to the fibre.

Rotated into the world frame, its component along world $z$ is
$W^{w}_{z} = W_y\sin\theta + W_z\cos\theta$, and the roll angle is the angle of the projection of
$\mathbf W$ onto the plane perpendicular to the roll axis (world $x$–$z$):

$$
\beta_i = \operatorname{atan2}\big(W^{w}_{z,i},\; W_{x,i}\big).
$$

Two properties are handled explicitly:

- **180° symmetry.** A flat band looks the same after a half turn, so $\beta$ has period $\pi$. The code
  unwraps $2\beta$ and halves it (`np.unwrap(2*beta)/2`), which removes spurious ±180° flips, and finally
  shifts the whole layer by a multiple of $\pi$ so that $\beta_0 \in [-90^\circ, 90^\circ]$.
- **Near-degenerate projections.** When $\mathbf W$ points almost along the roll axis, its projection
  $\sqrt{W_x^2 + (W^{w}_z)^2}$ is short and $\beta$ is ill-defined (and the band orientation hardly matters
  there). Points with projection length $\le 0.35$ are discarded and $\beta$ is linearly interpolated
  (after the $2\beta$ unwrap on the good points) between the well-defined neighbours.

For hoops $\mathbf W$ is axial and $\beta \approx 0$ (default project: $|\beta| < 2^\circ$, test
`test_hoop_eye_roll_is_small_and_helical_turns`); on helical layers $\beta$ swings by tens of degrees
(30 MPa example, first helical at 13.2°: $\beta$ = 58.9° … 121.1°).

Simplification: the band twist along the free span is not modelled; the eye is oriented for the band as
it lies at the contact point.

### 2.8 Free-fibre clearance and `solid_depth`

The envelope keeps the *eye* clear of the part; the *free fibre* between contact and eye can still pass
through material, e.g. a low-angle fibre leaving the dome close to the boss shoulder, or a fibre
spanning a polar build-up. `free_fibre_clearance` samples every ray at 16 points between 5 mm from the
contact (`skip`, to ignore the contact itself) and the eye, and evaluates `solid_depth` there.

`solid_depth(x, ρ)` returns how far a point at axial position $x$ and radius $\rho$ lies inside the part
**below** the current layer (base surface), the bosses or the shaft (positive inside):

- cylinder ($|x| \le h$): $d = r_{\text{base}}(x) - \rho$;
- domes: tested **radially from the dome centre** on the axis at $x = \pm h$: with polar angle
  $\vartheta = \operatorname{atan2}(\rho, |x| - h)$, $d = R_{\text{dome}}(\vartheta) - \sqrt{\rho^2 + (|x|-h)^2}$,
  where $R_{\text{dome}}(\vartheta)$ is the profile's distance from that centre. This works because the
  dome with its build-up is star-shaped about the centre, even when a thick polar build-up makes the end
  face nearly flat (a radial-by-$x$ test would fail there);
- bosses and shaft as cylinders of radius `boss_radius_*` and `shaft_radius`.

The minimum clearance $-\max d$ over all rays and its axial position are returned; below $-2$ mm the
simulation warns *"Free fibre cuts … mm into earlier build-up/boss near z = …: it will rub or bridge
there"*.

### 2.9 Warnings and a worked example

`_simulate` collects: near-axial rays (§2.4); **free fibre longer than 600 mm** (*"low winding angle;
expect band narrowing"*: a long free span lets the band neck down and wander); soft-limit violations
(§1.3); free-fibre intrusion (§2.8); and, from `simulate_path`, eye jumps (§3).

*Worked example: the shipped desktop project (`grbl-10mpa-1l`, GRBL 3-axis, 60 mm/s):*

| Layer | Angle | Samples | Time | Eye $x$ [mm] | Eye radius [mm] | Free fibre max [mm] | Mandrel total |
|---|---|---|---|---|---|---|---|
| hoop1 | 89.09° | 6 701 | 4.1 min | −58 … 58 | 62.3 | 39 | 16 915° |
| hel1 | 14.30° (pattern 62 bands, dwell 3.9°, $r_0$ = 12.5 mm) | 20 337 | 24.2 min | −169 … 169 | 30.0 … 62.9 | 132 | 25 559° |

The hoop angle follows from the pitch $p$ = band width = 5 mm: $\tan\alpha = 2\pi R/p$, with
$R = 50.3$ mm giving $\alpha = 89.09^\circ$.

*30 MPa example (LinuxCNC 4-axis, 100 mm/s):* the first helical layer (13.2°) needs 44 909 samples and
38.4 min; eye $x$ −290 … 290 mm, radius 36.3 … 115.7 mm, free fibre 45 … 251 mm. It reports *"Eye
solution jumps 13 deg / 1 mm in one segment near z = 181 mm (206 segments)"*: at the dome/boss neck the
eye swings round faster than the refinement can resolve (§3); this is an honest warning to inspect that
region in the simulation, not a failure.

### 2.10 Limitations of the kinematic model

- **Fibre bridging is not modelled** (see `docs/VALIDATION.md`, "Not validated"). Over concave meridional
  regions (the flank beside a thick polar build-up) a tensioned fibre bridges instead of following the
  surface. WindLab detects this (layer bridging check, free-fibre clearance warnings) but the eye is
  placed for the fibre following the surface. Continuous-winding transitions that leave a helical
  turnaround on top of its own build-up ridge report such warnings; review them in the simulation.
- The fibre is a line with no bending stiffness or sag; band width and twist on the free span are
  ignored (§2.7).
- Tangents are finite differences over the sample index, not over arclength; the refinement (§3)
  keeps samples dense where it matters.
- The eye is a point with a width allowance (the sliding maximum); the actual eye/roller geometry and
  machine collisions other than eye-vs-part are not checked.

---

## 3. Adaptive refinement

**Where in the code:** `core/kinematics.py`: `simulate_layer`, `simulate_path`, `_refine`, constants
`MAX_STEP_DEG`, `MAX_STEP_MM`, `MAX_EYE_STEP_DEG`.

Every consecutive pair of samples becomes one G-code `G1` segment, and the controller interpolates each
segment **linearly in joint space** (all axes in proportion). The true motion is a curve in joint space:
the eye must stay on the moving tangent ray while the mandrel turns. Between two samples the linear
interpolation leaves that curve by a chord error that scales roughly with (curvature of the joint-space
path) × (step length)² / 8, so the eye leaves the ray, the fibre direction at the contact changes, and
the fibre is pulled off its planned path (on a dome, a sideways pull on a geodesic or low-slippage path
is exactly what makes it slip). Halving the step quarters the error.

`simulate_path` therefore limits the joint steps per segment:

| Axis | Limit per segment |
|---|---|
| mandrel $\theta$ | `MAX_STEP_DEG` = 5° |
| carriage $x_e$ | `MAX_STEP_MM` = 10 mm |
| eye roll $\beta$ | `MAX_EYE_STEP_DEG` = 10° |

Algorithm:

1. Simulate the path (`_simulate`).
2. For every segment $i$ compute
   $k_i = \max\big(\lceil|\Delta\theta_i|/5^\circ\rceil, \lceil|\Delta x_i|/10\,\text{mm}\rceil,
   \lceil|\Delta\beta_i|/10^\circ\rceil\big)$. If all $k_i \le 1$, stop.
3. `_refine` subdivides segment $i$ into $\min(k_i, 16)$ pieces by **linear interpolation of the path
   parameters** $z, r, \varphi, \alpha, \lambda, s$ (the dwell flag is interpolated and thresholded at
   0.5; circuit start indices are remapped). The new samples are on the surface path, not on the chord in
   machine space; the kinematics is then solved again for all samples.
4. Repeat at most 3 times.

Crossfeed steps are not limited explicitly (they are small when the carriage and mandrel steps are).
Where the geometry still forces steps above **twice** a limit after refinement (the eye swinging round at
a neck, §2.9), the warning *"Eye solution jumps …"* names the location and the number of offending
segments.

The desktop helical layer ends with a largest mandrel step of 9.3° (below the 10° warning threshold);
hoop layers are exactly at 5°.

---

## 4. Time planning

**Where in the code:** `core/kinematics.py`: `plan_times`, `_axis_rate`, used at the end of `_simulate`.

The joint positions $\mathbf q_i \in \mathbb R^k$ ($k$ = 3 or 4: $x_e$ [mm], $y_e$ [mm], $\theta$ [deg],
$\beta$ [deg], in part units) are timed segment by segment. Limits per axis in part units
(`_axis_rate`):

$$
v_{\max,j} = \frac{V_j}{60\,|k_j|}, \qquad a_{\max,j} = \frac{A_j}{|k_j|},
$$

with $V_j$ = `max_velocity` [machine units/min], $A_j$ = `max_accel` [machine units/s²], $k_j$ = scale.

**Velocity pass.** Each segment's duration is the largest of the fibre-speed and axis-velocity times:

$$
\Delta t_i = \max\left( \frac{\ell_i}{v_f},\; \max_j \frac{|\Delta q_{ij}|}{v_{\max,j}},\; 10^{-4}\,\text{s}\right),
$$

where $\ell_i$ is the laid fibre length of segment $i$ (on the part, §2.5) and $v_f$ = `fiber_speed`.

**Acceleration pass (approximate).** Segment velocities $v_{ij} = \Delta q_{ij}/\Delta t_i$ change at
each interior sample by $\Delta v_{ij} = |v_{i+1,j} - v_{ij}|$. The allowed change is
$a_{\max,j}\,(\Delta t_i + \Delta t_{i+1})/2$. With

$$
\rho_i = \max_j \frac{\Delta v_{ij}}{a_{\max,j}\,(\Delta t_i + \Delta t_{i+1})/2},
$$

if $\max_i \rho_i \le 1.02$ the plan is accepted. Otherwise both segments adjacent to each violating
sample are stretched by $\sqrt{\rho_i}$ (each at most ×1.5 per iteration), up to 200 iterations. The
square root is the right scaling: stretching the durations by $f$ divides velocity changes by $f$ and
multiplies the allowed change by $f$, so $\rho$ falls as $1/f^2$.

This is a per-axis, jerk-free approximation. The controller still runs its own trajectory planner
(LinuxCNC's TP with `G64` blending, GRBL's look-ahead planner) with its own acceleration limits; with
inverse-time feed (§5.3) the planned durations are targets that the controller meets or, if its limits
are tighter, stretches. Program time estimates are therefore lower bounds when the controller's limits
are stricter than the ones in `MachineSpec`.

The design module's layer summary uses a much cruder estimate, $1.35\,L/v_f$ (`core/design.py`,
`wind_time`), which the traveller prints (§8.3). For the desktop helical layer it gives 12 min, whereas
the kinematic plan gives 24.2 min: the GRBL preset's slow crossfeed (1500 mm/min, 100 mm/s²) dominates
around the turnarounds. Use the simulation or the G-code total for scheduling.

---

## 5. G-code post-processors

**Where in the code:** `post/gcode.py`: `Program`, `Post`, `LinuxCNCPost`, `GrblPost`, `POSTS`, `_feed`,
`_safe_radius`, `_segments`, `generate`; API `POST /api/gcode` (`api.py::post_gcode`), CLI
`windlab gcode`.

### 5.1 Program structure

`generate(project, layer_ids)` builds the design, selects layers, and produces the segments to wind:
one per layer, or, with continuous winding enabled and more than one layer, the layers and the transitions
between them (`_segments` → `core.continuous.plan`, §7). Each segment is simulated with `simulate_path`.
The program is:

1. controller header (§5.2);
2. comments: WindLab version, project, date, machine, layer count, `G93 inverse-time feed`, and for
   continuous winding the number of transitions and transition passes;
3. per segment: a description comment (layer: type, angle, band, tows, pattern $n$/shift, pattern
   number, dwell; transition: kind, pass angles, max slippage vs limit), estimated time and tension; then
   either the **layer start** sequence (§5.6) or a **join** (§7.15); then `G93` and one `G1` per segment
   of the motion;
4. total time comment and the footer.

All numbers are written by `Post.fmt` with 3 decimals, trailing zeros removed and `-0` written as `0`.
Comments have parentheses stripped from their text.

### 5.2 LinuxCNC vs GRBL / grblHAL

| Feature | LinuxCNC (`LinuxCNCPost`, `.ngc`) | GRBL / grblHAL (`GrblPost`, `.gcode`) |
|---|---|---|
| Header | `%`, `G21 G90 G40 G49 G17 G94`, `G64 P0.05 Q0.02`, `G92.1` | `G21G90G94`, `G92.1` |
| Word separator | space | none (shorter lines) |
| Tension, `tension_output = "m67"` | `M68 E0 Q<N·scale>` (analog output 0, immediate) | not supported: omitted with a warning |
| Tension, `"spindle"` | `M3 S<N·scale>`, `M5` in the footer | `M3 S<N·scale>`, `M5` in the footer |
| Pause between layers | `(MSG, <text>)` then `M0` | `(<text>)` then `M0` |
| Footer | `G94`, `G92.1`, `M68 E0 Q0` or `M5`, `M2`, `%` | `G94`, `G92.1`, `M5` if spindle, `M2` |
| Axis letters | any | checked by `validate` (below) |

Notes:

- `G64 P0.05 Q0.02` enables LinuxCNC path blending with a 0.05 mm path tolerance and 0.02 mm naive-CAM
  tolerance, so the many short segments run without stopping at each corner (LinuxCNC documentation,
  G64).
- The tension value is `tension` [N] × `tension_scale` (output units per newton), formatted with 2
  decimals. It is output at each layer start and whenever it changes at a continuous join. The option is
  named `m67` but the post uses `M68` (unsynchronised analog output), set before motion starts.
- `(MSG, …)` displays the operator message in LinuxCNC's GUI before `M0` pauses (tow count, band width,
  tension of the next layer).
- **GRBL checks** (`GrblPost.validate`): stock Grbl has the axes `X Y Z` only; letters in `A B C` produce
  *"Axis letters … need grblHAL or a multi-axis GRBL fork"*, others *"not supported by GRBL"*. The 3-axis
  GRBL preset therefore drives the mandrel as the `Y` axis whose "millimetres" are degrees (steps per unit
  set accordingly in the controller). `m67` tension produces a warning, and `rotary_reset = "none"` warns
  that *GRBL uses 32-bit floats: large cumulative mandrel angles lose precision; enable rotary reset*
  (a single-precision float has about 7 significant digits, so a cumulative angle of $10^5$ degrees
  resolves only about 0.01°).
- **Line length.** Grbl reads commands into a small line buffer (80 characters in stock Grbl 1.1); the
  GRBL post omits spaces and keeps 3 decimals. The post does not enforce a limit itself, but
  `tests/test_machine.py::test_gcode_is_well_formed` asserts that no GRBL line (comments removed) exceeds 70 characters for
  all five presets (the longest motion line of the desktop example is 34 characters).

### 5.3 Inverse-time feed (G93)

Winding moves combine linear axes (mm) and rotary axes (degrees). In units-per-minute mode (`G94`) the
RS274/NGC interpreter defines the feed along the linear axes when any of them moves, with rotary axes
coordinated to start and stop together (Kramer et al. 2000); Grbl, which treats the mandrel as a linear
axis in degrees, would instead apply the feed to the Euclidean norm of mm and degrees. Neither gives the
planned timing. **Inverse-time mode** removes the ambiguity: in `G93` an `F` word means the move must be
completed in $1/F$ minutes, and an `F` word is required on every `G1` line (LinuxCNC documentation,
"G93, G94, G95: Feed Rate Mode"; Kramer et al. 2000, §3.5.19; Grbl 1.1 supports `G93`/`G94`).

For segment $i$ with planned duration $\Delta t_i$ [s]:

$$
F_i = \frac{60}{\max(\Delta t_i,\; 10^{-4})}\quad [\text{min}^{-1}] .
$$

`_feed` writes $F$ with

$$
n_{\text{dec}} = \max\big(2,\; 3 - \lfloor \log_{10} F \rfloor\big)
$$

decimals, i.e. at least four significant digits when $F < 10$ (slow moves have $F$ well below 1: a 2-minute
move has $F = 0.5$, written with 4 decimals) and two decimals otherwise (e.g. `F1666.89`). The relative
rounding error of the duration is therefore at most $5\times10^{-4}$ for slow moves and far less for
fast ones; the verifier reproduces the planned total to 0.1 % or better (§6).

All `G0` positioning moves are run in `G94`; every winding block is preceded by `G93`, and the footer
returns to `G94`.

### 5.4 Rotary G92 resets

The mandrel angle is cumulative: a single 30 MPa helical layer turns the mandrel over 43 000°. To keep
numbers small (and GRBL's floats precise), `rotary_reset` rewrites the mandrel coordinate with `G92`,
which changes the coordinate system offset without moving the axis. With period
$\Pi = 360^\circ\cdot|k_A|$ ($k_A$ = mandrel scale):

- **`layer`** (LinuxCNC presets): each segment is first expressed in the first mandrel turn,
  $A \leftarrow A - \Pi\lfloor A_0/\Pi\rfloor$ ($A_0$ = first value of the segment). Before the next
  segment, `G92 A<prev_end mod Π>` declares the current physical position to be the equivalent angle in
  the first turn.
- **`circuit`** (GRBL presets): additionally, at every circuit start inside a segment (except the first),
  the post writes `G94`, `G92 A<current mod Π>`, `G93` and subtracts the whole turns from the remaining
  values. The mandrel values then stay within a few turns (test `test_rotary_reset_bounds_mandrel_values`
  asserts < 3·360 for the GRBL 3-axis preset).
- **`none`**: cumulative values throughout.

`G92.1` in header and footer clears any offsets at program start and end. The verifier (§6) interprets
`G92`/`G92.1` like a controller and checks that the **physical** mandrel motion per layer equals the
simulated cumulative rotation to 0.01° (`tests/test_gcode_verify.py`).

### 5.5 Never turning the mandrel backwards between layers

Between layers the fibre is still attached to the part (it is cut only after the last layer, or tied off
by the operator). Rotating the mandrel backwards would unwind or slacken the last band. When a segment
does not join continuously, `generate`:

1. determines the segment's winding direction $d = \operatorname{sign}(A_{\text{end}} - A_0)$;
2. takes the current position $c$ (previous end, modulo $\Pi$ when resets are on);
3. computes the gap $g = (A_0 - c)\,d$; if $g < 0$ it shifts the whole segment by
   $d\,\Pi\lceil -g/\Pi\rceil$, i.e. by whole turns, so the new start lies **ahead** of the current
   position in the winding direction.

A whole-turn shift does not change the physical placement of the layer on the part.

### 5.6 Layer start: the safe crossfeed retract

For a non-joined segment (every layer in separate winding; the first layer in continuous winding):

1. optional pause `M0` with the layer message (`pause_between_layers`, default on);
2. `G94`;
3. (3/4-axis) `G0` crossfeed to the **safe radius** $y_{\text{safe}} = \max_{\text{all segments}} y_e + 10$ mm,
   converted to machine units. The maximum is taken over the eye radii of **all** simulated segments of
   the program, so the retract clears the finished part whatever layer is next;
4. `G0` of carriage, mandrel (and eye) to the segment's first point, crossfeed excluded;
5. (3/4-axis) `G0` crossfeed in to the first point;
6. tension output;
7. `G93` and the `G1` blocks from the second sample on.

The rapid of step 4 moves the mandrel forwards only (§5.5), with the eye retracted.

### 5.7 Worked excerpts

*30 MPa example, LinuxCNC 4-axis, first two layers (hoop1 and hel1):*

```
%
G21 G90 G40 G49 G17 G94
G64 P0.05 Q0.02
G92.1
(WindLab 0.1.0 - Type III 30 MPa 11L - ...)
(Machine: Generic 4-axis LinuxCNC, 4-axis, controller linuxcnc)
(Layers: 2; units mm, deg; G93 inverse-time feed)

(Layer 1 hoop1: hoop, 89.45 deg, band 6.0 mm x 1 tow)
(Est. time 10.4 min, tension 84.0 N)
(MSG, Layer 1 hoop1: 1 tows, band 6.0 mm, tension 84.0 N)
M0
G94
G0 Y125.742
G0 X453.591 A32.402 B0.47
G0 Y115.247
M68 E0 Q84
G93
G1 X453.61 Y115.247 A33.582 B0.488 F556.68
G1 X453.672 Y115.247 A37.309 B0.482 F1113.1
...
(Layer 3 hel1: helical, 13.23 deg, band 6.0 mm x 1 tow, pattern 103/17 p6, dwell 4.2 deg)
(Est. time 38.4 min, tension 27.5 N)
G92 A27.402
(MSG, Layer 3 hel1: 1 tows, band 6.0 mm, tension 27.5 N)
M0
G94
G0 Y125.742
G0 X389.276 A75.935 B84.166
G0 Y94.589
M68 E0 Q27.5
G93
G1 X390.112 Y95.201 A76.097 B84.986 F1666.89
...
(Total estimated winding time 48.8 min)
G94
G92.1
M68 E0 Q0
M2
%
```

Reading it: the hoop eye radius is 115.247 mm (top of the first hoop layer ≈ 100.25 mm + 15 mm
clearance); the safe radius 125.742 mm is the largest eye radius of the program (115.742 mm) + 10 mm;
`G92 A27.402` puts the end of hoop1 (cumulative 35 667.402°) back into the first turn; the helical layer
then starts at 75.935°, ahead of 27.402° in the winding direction. The verifier interprets 48.78 min
against the planned 48.78 min.

*Desktop example, GRBL 3-axis (mandrel on `Y` in degrees, crossfeed on `Z`):*

```
G21G90G94
G92.1
...
M0
G94
G0Z43.491
G0X343.127Y39.19
G0Z32.296
M3 S235
G93
G1X343.144Z32.296Y40.386F415.05
```

Crossfeed `Z32.296` = eye radius 62.296 mm − `crossfeed_zero_radius` 30 mm; tension 23.5 N ×
`tension_scale` 10 = `S235`; the 5-layer program has 60 913 lines, 5 pauses and an estimated 60.9 min.

---

## 6. G-code verifier

**Where in the code:** `post/verify.py`: `verify`, `Verification`; used by `api.py::post_gcode`
(returned as `verification`) and the tests.

`verify(text)` is an independent, deliberately simple interpreter of the generated program. It does
**not** import the kinematics; it reads the text the way a controller would:

- strips `( … )` and `;` comments, skips empty lines and `%`, upper-cases, parses letter/number words;
- tracks the **modal feed mode** `G93`/`G94`;
- tracks **`G92` offsets** per axis letter: on `G92 A v` the offset becomes
  $o_A = (\text{programmed} + o_A)_{\text{before}} - v$, so the physical position is unchanged; `G92.1`
  folds the offsets back into the programmed positions and clears them;
- counts `M0`/`M1` as pauses;
- on `G0` lines: updates positions, counts rapids, updates ranges;
- on `G1` lines: counts feed moves; in `G93` requires a positive `F` (else an error
  *"line N: G1 in G93 without a positive F word"*) and accumulates the duration $60/F$ seconds;
  records the largest per-move change of each **physical** axis position (`max_step`) and optionally
  every physical position (`keep_positions`).

Outputs: move, rapid and pause counts; total inverse-time duration; physical ranges per letter;
largest step per letter; errors. The API adds `time_matches` (interpreted vs planned time within 0.1 %).

What the tests assert with it: no errors; interpreted time equal to the planned time to 0.1 %; the
largest mandrel step below 30° despite `G92` resets; the physical mandrel rotation per layer equal to the
simulated cumulative rotation to 0.01°; in continuous programs at most one `M0` and, on the 4-axis
machine, no eye step above 45° across joins.

What it does not check: motion lines without an explicit `G0`/`G1` word (the posts always write one),
arcs, units/absolute-mode changes, `G0` durations, soft limits (ranges are reported, not compared),
acceleration, and line length.

---

## 7. Continuous winding

**Where in the code:** `core/continuous.py` (`plan`, `_transition`, `_Ctx`, `_Builder`, `_pass`,
`_ramp`, `_cut`, `_phi_at`, `_onto`, `_ends`, `_hoop_start`, `prefetch`, `_solve`, `_spawn_safe`,
`to_schema`; constants `HOOP_CAP`, `MAX_PASSES`, `MERGE_TOL`, `TRANSITION_DL`, `PARALLEL_MIN_SOLVES`);
`core/paths.py` (`non_geodesic`); `post/gcode.py` (`_segments` and the join branch of `generate`);
`schemas.py` (`ContinuousSpec`); API `POST /api/continuous`.

### 7.1 Motivation and overview

In separate winding each layer is started, wound and the roving cut or tied off: the operator stops
the machine, re-anchors the tow, and every cut end is a local defect and a place where the band can
loosen. Continuous winding keeps the roving attached and moves from one layer to the next with
**transition paths** wound on the part. The difficulty is that consecutive layers can differ by 70° in
winding angle (hoop ↔ helical) and in turnaround radius, and the fibre must neither slip on the surface
nor be laid in a pattern that disturbs the designed layers.

`plan(b, layers)` returns a sequence of segments: layer 1, transition 1→2, layer 2, … Each transition is
one of

| Kind | When | Content |
|---|---|---|
| `direct` | helical → helical, small change | only a phase dwell (spiralling between radii if needed) |
| `passes` | helical/hoop → helical | full transition passes at intermediate angles (+ a ramp out of a hoop) |
| `hoop` | → hoop | transition passes and a ramp into the hoop, or a hoop connector for hoop → hoop |

Transition fibre is reported (length, dry fibre mass = length × tex × tows / 10⁶ g) but **not counted
in the laminate thickness** or the structural model.

Settings (`ContinuousSpec`): `enabled` (G-code winds the plan), `max_angle_step` (default 7°, a common
shop rule for the largest change of cylinder angle across one turnaround) and `slippage_margin` (default
0.8, the fraction of the layer friction that transition paths may use).

### 7.2 Where layers start and end (pass parity)

The planner relies on fixed conventions:

- **Helical layers start and end at their turnaround on end A.** `helical_layer_path` winds whole
  circuits (A→B, dwell, B→A, dwell).
- **Hoop layers** start at end A, or at end B when laid **reversed** (`layer_path(..., reverse=True)` →
  `hoop_layer_path(reverse=True)`); with an even pass count they end where they started.

Transition passes alternate direction: pass $j$ runs in direction $d_j = d_0(-1)^j$ ($+1$: A→B, $-1$:
B→A). The first direction is $d_0 = +1$ after a helical layer or a hoop that ended at A, and $-1$ after
a hoop that ended at B. If the destination is helical the **last pass must arrive at A**
($d_{m-1} = -1$), which constrains the parity of the pass count $m$. If the destination is a hoop, the
end where the last pass arrives decides whether the hoop is laid reversed.

### 7.3 Direct joins

Helical → helical transitions need no extra passes when

$$
|\alpha_1 - \alpha_0| \le \Delta\alpha_{\max} \quad\text{and}\quad |r_{A,1} - r_{A,0}| \le B ,
$$

where $\alpha_0, \alpha_1$ are the cylinder angles of the source and destination layers,
$\Delta\alpha_{\max}$ = `max_angle_step`, $r_{A,0}, r_{A,1}$ their end-A turnaround radii and $B$ the
destination band width. The next layer then leaves from the turnaround where the previous one arrived,
after a phase dwell (§7.12) that also spirals between the two turnaround radii. The test
`test_direct_join_and_angle_step` checks that two identical helicals (one re-clocked) join directly.

### 7.4 Transition passes: the angle schedule

Otherwise $m$ transition passes at intermediate cylinder angles are inserted. `_Ctx.candidates` builds
the schedule for increasing $m$ (from 1 when a hoop is involved, else 2, up to `MAX_PASSES` = 40):

End angles (`_ends`): a helical layer contributes its cylinder angle $\alpha_{\text{mid}}$ and its
turnaround radii; a hoop contributes $\alpha_H = \arcsin(c_H)$ = 66.93°, with $c_H$ = `HOOP_CAP` = 0.92, and radii
$c_H R$ (§7.10); the real hoop angle is reached by a cylinder ramp (§7.9).

The schedule includes the helical end layers' angles as fixed points: the number of angle points is
$n_p = m + [\text{src helical}] + [\text{dst helical}]$, joined by $n_p - 1$ intervals with weights
$w_k = 1$, except that an interval **next to a helical layer has weight 1/2**. The points are equally
spaced in cumulative weight:

$$
\alpha^{(k)} = \alpha_0 + (\alpha_1 - \alpha_0)\,\frac{\sum_{l<k} w_l}{\sum_l w_l},
$$

and the candidate is accepted only if the interior step
$|\alpha_1 - \alpha_0| / \sum_l w_l \le \Delta\alpha_{\max}$. The helical end angles themselves are not
passes; the $m$ interior points are.

**Why half-size end steps next to helical layers.** Each dome leg of a transition pass is a
non-geodesic path, and its slippage grows with how far its turnaround radius is from the geodesic
(Clairaut) turnaround radius for its cylinder angle, $r_{\text{geo}} = R\sin\alpha$. Interior turnarounds
are placed at the geodesic radius of the **mean** of the two adjacent pass angles (§7.5), so each leg
deviates by about **half** an angle step. The pass next to a helical layer, however, must turn at that
layer's own turnaround radius (the layer starts or ends there), so it absorbs the **whole** angle step
between itself and the layer as deviation from its geodesic. Halving that end step makes the end legs'
deviation equal to the interior ones' and evens out the slippage along the transition. Next to a hoop the
end is a ramp (§7.9), so no half step is used.

### 7.5 Near-geodesic turnaround radii

For interior turn $j$ (after pass $j$, at the end it arrives at) `_Ctx.turn_radius` uses the mean angle
$\bar\alpha = (\alpha^{(j)} + \alpha^{(j+1)})/2$ and blends the end layers' deviation from the geodesic:

$$
t = \operatorname{clip}\!\left(\frac{\bar\alpha - \alpha_0}{\alpha_1 - \alpha_0}, 0, 1\right),\qquad
\delta = (1-t)\,\big(r_0 - R\sin\alpha_0\big) + t\,\big(r_1 - R\sin\alpha_1\big),
$$

$$
r_j = \operatorname{clip}\big(R\sin\bar\alpha + \delta,\; r_{\min},\; c_H R\big),
$$

where $R$ is the cylinder radius of the surface the transition is wound on (the destination layer's
base), $r_0, r_1$ the source/destination turnaround radii **at that end** (A or B), and
$r_{\min} = \max(r_{\text{boss},A}, r_{\text{boss},B}) + B/2$ keeps the band off the bosses. (If
$\alpha_0 = \alpha_1$, $t = (j + 1/2)/m$.) For geodesic helical layers $\delta \approx 0$; for
non-geodesic layers with unequal openings (25 MPa example) $\delta$ carries their intentional deviation
smoothly across the transition. The last turn before a helical destination is its $r_{A,1}$; the first
pass after a helical source starts at $r_{A,0}$; next to a hoop the geodesic radius
$r_{\text{geo}}(\alpha) = \operatorname{clip}(R\sin\alpha, r_{\min}, c_H R)$ is used.

### 7.6 Solving a pass and checking its slippage

A transition pass (`_pass`) is solved by `paths.non_geodesic(surf, half, α, r_A, r_B, dl=1.6)`: a
geodesic helix at angle $\alpha$ on the cylinder and, on each dome, a **constant-slippage** leg found by
shooting so that it turns around exactly at the requested radius. On a surface of revolution, with $l$
the fibre arclength, $s$ the meridian arclength, $r(s)$ the radius and $r' = dr/ds$
(module docstring of `core/paths.py`; Koussios 2004; Lossie & Van Brussel 1994):

$$
\frac{d\alpha}{dl} = \lambda\,k_n - \frac{\sin\alpha\; r'}{r},\qquad
\frac{ds}{dl} = \cos\alpha,\qquad
\frac{d\varphi}{dl} = \frac{\sin\alpha}{r},\qquad
k_n = k_m\cos^2\alpha + \frac{z'}{r}\sin^2\alpha ,
$$

where $\lambda = k_g/k_n$ is the slippage coefficient (ratio of geodesic to normal curvature), $k_m$ the
meridian curvature and $z' = dz/ds$. $\lambda = 0$ is the geodesic ($r\sin\alpha$ = const, Clairaut).
A fibre stays put on the wet surface while $|\lambda| \le \mu$, the fibre/surface friction coefficient.
Passes in direction −1 are the A→B solution walked backwards (azimuth still increasing). Transition
passes are integrated with a 1.6 mm step (`TRANSITION_DL`; layers use 0.8 mm).

**Per-leg check.** The allowed slippage is

$$
\mu_{\text{T}} = m_s \times \mu_{\text{dst}},
$$

with $m_s$ = `slippage_margin` and $\mu_{\text{dst}}$ the destination layer's `friction`. For each pass the relevant slippage is the
larger of its start-leg and end-leg $|\lambda|$, **counting only legs that are actually wound**: the first
pass's start leg is replaced by a ramp when the source is a hoop, and the last pass's end leg when the
destination is a hoop. The transition is feasible if every pass satisfies $\le \mu_{\text{T}}$.

### 7.7 Nudging turnarounds off build-up ridges

A transition turnaround may land on the slope of an earlier layer's polar build-up ridge, where holding
the fibre needs far more friction than the nominal geometry suggests. For every pass except the last pass
into a helical layer (whose turnaround is fixed by that layer), the planner tries the nominal end radius
and then nudged radii

$$
r_{\text{end}} = \operatorname{clip}\big(r_j + f\,B,\; r_{\min},\; c_H R\big),\qquad
f \in (0,\,-0.25,\,+0.25,\,-0.5,\,+0.5),
$$

keeping the first that satisfies the limit or else the one with the least slippage. The chosen end
radius becomes the next pass's start radius. Passes the shooting solver cannot produce
(`GeometryError`) are skipped.

### 7.8 Pass-count search

The candidates are tried in order of increasing $m$. For each, every pass is solved (with nudging); the
best candidate so far (lowest maximum slippage) is kept; the search stops at the first $m$ whose maximum
slippage is within $\mu_{\text{T}}$. Because the slippage scales roughly with the angle step, i.e. with
$1/m$, the next pass count tried after a failure is

$$
m_{\text{next}} = \max\!\left(m + 1,\; \left\lceil m\,\frac{\lambda_{\max}}{\mu_{\text{T}}}\right\rceil\right),
$$

which jumps close to the count that should suffice instead of stepping one by one (each pass costs a
shooting solve). If no candidate can be built at all, the transition is marked infeasible with *"No
transition path found; wind these layers separately (cut and restart)"*; if the best candidate exceeds
the limit, it is used but marked infeasible with *"Transition slippage … exceeds …; raise the
friction/margin or wind these layers separately"*. The G-code generator copies these notes into its
warnings.

### 7.9 Hoop ↔ helical cylinder ramps

Between a hoop (≈ 89°) and the highest transition-pass angle $\alpha_H$ = 66.93° the angle changes
**along the cylinder** at constant slippage $\lambda$ ($|\lambda| = \mu_{\text{T}}$, sign by
direction). On a cylinder of radius $R$: $r' = 0$, $z' = 1$, $k_m = 0$, so $k_n = \sin^2\alpha/R$ and the
path equations reduce to

$$
\frac{d\alpha}{dl} = \frac{\lambda\sin^2\alpha}{R},\qquad \frac{dz}{dl} = \cos\alpha,\qquad
\frac{d\varphi}{dl} = \frac{\sin\alpha}{R},
$$

where $z$ is the axial distance travelled (in the direction of travel). Dividing by $d\alpha/dl$:

$$
\frac{dz}{d\alpha} = \frac{R\cos\alpha}{\lambda\sin^2\alpha}
\;\;\Rightarrow\;\;
\Delta z(\alpha) = \frac{R}{\lambda}\left(\frac{1}{\sin\alpha_0} - \frac{1}{\sin\alpha}\right),
$$

$$
\frac{d\varphi}{d\alpha} = \frac{1}{\lambda\sin\alpha}
\;\;\Rightarrow\;\;
\Delta\varphi(\alpha) = \frac{1}{\lambda}\Big(\operatorname{arsinh}(\cot\alpha_0) - \operatorname{arsinh}(\cot\alpha)\Big),
$$

using $\frac{d}{d\alpha}\operatorname{arsinh}(\cot\alpha) = -\frac{\csc^2\alpha}{\sqrt{1+\cot^2\alpha}} = -\frac{1}{\sin\alpha}$.
Here $\alpha_0$ is the start angle, $\lambda > 0$ when the angle increases and $< 0$ when it decreases,
which makes both $\Delta z$ and $\Delta\varphi$ positive in either case. `_ramp` evaluates these closed
forms at 24 angles; `test_cylinder_ramp_closed_form` checks them against the differential equation to
0.2 %. The fibre length of the ramp follows as
$\Delta l = \frac{R}{\lambda}(\cot\alpha_0 - \cot\alpha)$.

*Worked example (desktop, hoop2 → hel1):* $R$ = 50.593 mm, $\mu_{\text{T}} = 0.8 \times 0.2 = 0.16$,
from 89.09° to 66.93°:
$\Delta z = \frac{50.593}{0.16}(1/\sin 66.93^\circ - 1/\sin 89.09^\circ) = 316.2 \times 0.0869 = 27.5$ mm
and $\Delta\varphi = (0.4140 - 0.0159)/0.16 = 2.49$ rad = 142.6°.

Use in the assembly (`_transition`):

- **Out of a hoop** (first pass): the ramp starts where the hoop ended, runs in the first pass's
  direction to $z_r = z_{\text{end}} + d\,\Delta z$; the first pass is cut there (`_cut`, keep the part
  after $z_r$) and its azimuth re-referenced to its value at $z_r$ (`_phi_at`).
- **Into a hoop** (last pass): the hoop's start is at $z_S$ (half a band inside the hoop's end, at the end
  where the last pass arrives); the pass is kept up to $z_c = z_S - d\,\Delta z$, any azimuth mismatch at
  the cut is added to the ramp, the ramp runs to $z_S$, then a **half-turn dwell** locks the band (as at
  hoop reversals) and the hoop is laid, reversed if it starts at B.
- If $|z_r|$ or $|z_c| > h - 1$ mm (the ramp does not fit on the cylinder) the transition is marked
  infeasible: *"Cylinder too short for the … ramp …"*.

### 7.10 The `HOOP_CAP` turnaround

`HOOP_CAP` = 0.92 is the turnaround radius of the highest-angle transition pass as a fraction of the
cylinder radius. For a geodesic pass the turnaround radius is $R\sin\alpha$, so the highest pass angle is
$\arcsin 0.92 = 66.93^\circ$; above that the turnaround would move towards the dome/cylinder junction,
where the dome is nearly cylindrical and a turnaround is not held reliably. All turnaround radii are also
capped at $0.92R$ (§7.5). Angles between 66.93° and the hoop angle are covered by the cylinder ramps
instead of passes; the ramp is not subject to `max_angle_step` because its angle changes continuously at a
controlled slippage, not abruptly across a turnaround.

### 7.11 Hoop → hoop connectors

The next hoop starts at the end where the previous one finished (`_hoop_start(dst, src_end)`). If the
start positions differ axially by $\Delta z$, a hoop-pitch helix of $|\Delta z|/p$ revolutions ($p$ =
destination pitch) connects them, followed by a half-turn dwell. In the examples consecutive hoops have
the same extent, so the connector is empty (kind `hoop`, length 0).

### 7.12 Phase dwell

A helical layer is a pattern of $n$ band slots (`pattern.n_bands`) laid in a fixed circuit order. The
transition ends at some azimuth $\varphi_T$ at the end-A turnaround; the layer as designed starts at
$\varphi_L$. `finish` inserts a dwell arc at the turnaround of

$$
\Delta\varphi_{\text{dw}} = (\varphi_L - \varphi_T) \bmod \frac{2\pi}{n}, \qquad 0 \le \Delta\varphi_{\text{dw}} < \frac{2\pi}{n},
$$

and then shifts the whole layer path by $\sigma = \varphi_T + \Delta\varphi_{\text{dw}} - \varphi_L$, which is
a **whole multiple of the slot angle** $2\pi/n$.

Why this preserves the laid pattern: the pattern is invariant under a rotation by one slot. Rotating
the layer by $k\cdot 2\pi/n$ maps the set of $n$ band positions onto itself and keeps the order and
spacing of the circuits (pattern number, shift, crossover structure); only the physical slot where the
first band lands changes. The layer is therefore laid exactly as designed, with less than one slot of
extra dwell instead of up to a full turn. `test_plan_continuity_and_limits` checks that the azimuth shift
of every helical layer is a multiple of $2\pi/n$ to $10^{-6}$.

The dwell also moves the fibre from the transition's end point to the layer's start point (a spiral in
$z$, $r$, $s$) with the slippage that a dwell at that turnaround circle needs (`dwell_slip_a` of the
layer). If the radius changes by more than 0.3 mm and the dwell is below 20°, whole slots are added until
it is at least 20°, so the spiral between radii is not too abrupt. Hoop destinations need no phase
matching; the hoop path is simply shifted to continue the azimuth.

*Worked example:* desktop hel1 has $n = 62$ (slot 5.81°); the dwell after the hoop2 → hel1 transition is
2.4°. For hel2 ($n = 63$, slot 5.71°) it is 1.6°.

### 7.13 Assembling the path: upper surface and merged points

**Starting on the upper surface.** The previous layer's path lies on *its* base surface, but its last
circuit is physically on top of its own build-up. The transition is wound on the destination layer's base
(= top of the previous layer). `_onto` therefore starts the transition at the corresponding point of that
surface: the same $z$ on the cylinder, or the same radius on the dome of that side. The fibre does not
"tunnel" through the build-up; the G-code joins the two points with a slow move (§7.15). After a helical
source the start is set exactly to where the first transition pass leaves its turnaround.

**Merging shared turnaround points.** Consecutive passes meet at a turnaround only up to the shooting
tolerance. `_Builder.add` drops a new piece's first point if it lies within `MERGE_TOL` = 0.5 mm (3-D
distance including $r\,\Delta\varphi$) of the current end point. A sub-millimetre segment with no azimuth
advance would be a meridional kink with an arbitrary fibre direction; since path samples are several mm
apart, its tangent would throw the eye around. Every piece is added as increments of azimuth from the
current point, so the azimuth is continuous and never decreases (tested).

### 7.14 Parallel prefetch of pass solves

Each pass needs a shooting solve of the non-geodesic path equations, and a plan may need hundreds.
The planner itself is sequential (each transition starts at the azimuth where the previous one ended),
but pass *geometry* depends only on the surface, cylinder half-length, angle and radii, not on azimuth,
and `paths.non_geodesic` caches solutions by these arguments. `prefetch`:

1. collects, for every non-hoop→hoop pair, the pass arguments of the **first** candidate the planner will
   most likely try (`_Ctx.solves`; for a hoop source both first directions, since the hoop may end at
   either end), skipping those already cached;
2. if there are at least `PARALLEL_MIN_SOLVES` = 24 jobs, at least 2 workers (default
   $\min(\text{CPU count}, 8)$) and spawning is safe, solves them in a `ProcessPoolExecutor` with the
   **spawn** start method (chunk size 4) and seeds the cache (`paths._cache_put`);
3. otherwise, or on any exception (no subprocesses in a sandbox, an unguarded `__main__` script), returns
   0 and the planner solves sequentially.

`_spawn_safe` checks that `__main__` is a module or an existing file, because spawned workers re-import
it (scripts must use an `if __name__ == '__main__':` guard). Nudged radii and later candidates are not
prefetched; they are solved on demand. Results are identical with or without prefetch.

### 7.15 G-code joins

With continuous winding, `generate` treats every segment after the first as **joined** (`joined =
True`): no pause, no retract, no cut.

- **Mandrel.** Instead of the "never backwards" whole-turn shift (§5.5), the segment is shifted by whole
  turns to the **nearest** equivalent of the current position,
  $A \leftarrow A + \Pi\,\operatorname{round}((c - A_0)/\Pi)$. The path continues, so the two differ only by
  the change in eye lead; the planned azimuth is monotonic across segments.
- **Eye roll.** Each segment's $\beta$ is normalised independently (§2.7) and accumulates over a layer.
  Because the band is symmetric, the roll has period 180°·$|k_B|$; the segment is shifted by the multiple
  of that period nearest to where the eye is. Without this, a join could spin the eye by 180° or more
  (test: no eye step above 45° across joins on the 4-axis machine).
- **Tension** is output only if it changes.
- **Join move.** From the previous end to the new first point, if any axis differs by more than
  $10^{-3}$ units:

  $$
  t_{\text{join}} = \max\!\left(0.5\ \text{s},\; \frac{d}{20}\right),\qquad
  d = \max_{\text{axes}} |q_{\text{new}} - q_{\text{here}}| \ \text{(machine units)},\qquad
  F = \frac{60}{t_{\text{join}}},
  $$

  written as a `G93` `G1` move and added to the program time. This covers the step between the end of a
  layer (on its own base) and the start of the transition (on the upper surface), and the eye-lead
  difference. The "20 units/s" treats mm and degrees alike; it is a deliberately gentle rate, not a
  planned move.
- With rotary resets, `G92 A<prev_end mod Π>` still precedes the segment; the join move then starts
  from that value.

### 7.16 Worked example

Desktop project (`grbl-10mpa-1l`, 5 layers: hoop1, hoop2, hel1 14.30°, hoop3, hel2 17.04°; band 5 mm,
friction 0.2, so $\mu_{\text{T}} = 0.16$; default `max_angle_step` 7°):

| Transition | Kind | Passes | Pass angles [deg] | Max slippage | Dwell | Fibre |
|---|---|---|---|---|---|---|
| hoop1 → hoop2 | hoop | 0 | – | 0 | 0 | 0 |
| hoop2 → hel1 | passes | 10 | 66.93, 61.39, 55.85, 50.31, 44.77, 39.23, 33.69, 28.15, 22.61, 17.07 | 0.074 | 2.4° | 3.05 m, 2.4 g |
| hel1 → hoop3 | hoop | 9 | 17.40, 23.59, 29.78, …, 60.74, 66.93 | 0.081 | – | 2.93 m, 2.3 g |
| hoop3 → hel2 | passes | 9 | 66.93, 61.06, 55.19, …, 25.84, 19.97 | 0.084 | 1.6° | 2.79 m, 2.2 g |

How the pass counts arise:

- **hoop2 → hel1.** Hoop2 (2 passes from A) ends at A, so $d_0 = +1$; the helical destination needs the
  last pass at A, so $m$ is even. Points: $n_p = m + 1$, weights $(1, \dots, 1, \tfrac12)$, sum $m - \tfrac12$.
  From 66.93° to 14.30° (52.63°): $m = 8$ gives $52.63/7.5 = 7.02^\circ > 7^\circ$, rejected; $m = 10$
  gives $5.54^\circ$, and the last step to the layer is $2.77^\circ$ (17.07° → 14.30°).
- **hel1 → hoop3.** No parity constraint; $m = 9$: weights $(\tfrac12, 1, \dots, 1)$, sum 8.5, step
  $52.63/8.5 = 6.19^\circ$ (first step 3.10°: 14.30° → 17.40°). The ninth pass runs A→B, so hoop3 is laid
  **reversed** from end B.
- **hoop3 → hel2.** Hoop3 ended at B, so $d_0 = -1$ and $m$ must be odd; $m = 9$: $49.89/8.5 = 5.87^\circ$.
- The ramp out of hoop2 is the one computed in §7.9 (27.5 mm, 142.6°).

The continuous program has 65 125 lines and an estimated 64.9 min (verifier: 64.9 min), with a single
`M0` (before the first layer), against 60 913 lines, 60.9 min and 5 pauses for separate winding: the
transitions cost about 4 min and 8.8 m of fibre (7 g, not in the laminate), and save four cut/restart
operations. The first join in the program reads

```
(Transition hoop2 -> hel1: passes, 10 passes at 66.9, 61.4, ..., 17.1 deg, max slippage 0.074 limit 0.160)
(Est. time 1.3 min, tension 15.0 N)
G92 Y34.136
M3 S150
G93
G1X344.291Z32.891Y45.863F102.33
```

The join move turns the mandrel by $d = 45.863 - 34.136 = 11.73^\circ$ in
$t_{\text{join}} = 11.73/20 = 0.59$ s, hence $F = 60/0.586 = 102.3$.

### 7.17 Limitations

- Transition fibre is not included in thickness, mass-based sizing or stress analysis (it is reported
  separately, and the traveller notes the continuous mode).
- Slippage is checked per dome leg against a friction coefficient per layer; friction on a wet, partly
  wound surface is uncertain, hence the `slippage_margin`.
- Turnarounds of transition passes can sit on earlier build-up; the nudging reduces but does not
  eliminate this, and the kinematics does not model bridging over the ridge (§2.10). Such cases show up
  as free-fibre clearance or bridging warnings.
- The join move rate (20 units/s, minimum 0.5 s) is a fixed heuristic.
- Only adjacent layers are joined sensibly; selecting non-adjacent layers for G-code triggers the
  warning *"Continuous winding over non-adjacent layers: transitions join the selected layers"*.

---

## 8. Exports

### 8.1 CalculiX axisymmetric solid deck

**Where in the code:** `ccx_export.py`: `export`, `_engineering`, `parse_midplane`, `run_and_compare`;
CLI `windlab ccx project.json [--run DIR]`; API `POST /api/ccx-export`; `core/shellfe.py` (`_mesh`,
`_interp_idx`, `_qbar`).

Purpose: an independent, open-source finite-element check of WindLab's structural model, with
through-thickness resolution that the thin-wall models lack.

**Mesh.** Columns along the meridian come from the shell mesh (`shellfe._mesh`: liner outer profile,
near-duplicates dropped, spans split to at most `max_len` = 4 mm by default, 8 mm in `run_and_compare`).
Rows are the regions between consecutive surfaces: liner inner, liner outer, then the top of each wound
layer. Nodes are at (x = radius, y = axis). Where a layer's top lies within `TOL` = 0.01 mm of the surface
below (the layer has ended), its nodes are merged with those below:

- four distinct corners → **CAX8** (8-node quadratic axisymmetric quad; mid-side nodes shared between
  neighbours);
- three distinct corners (a layer ending) → **CAX6** (6-node triangle), collapsed corner removed,
  counter-clockwise order kept;
- fewer → skipped (zero-thickness row).

Element orientation is corrected by the signed area.

**Materials.**

- Liner (`LINER`): isotropic elastic ($E$, $\nu$) with a two-point isotropic hardening curve
  (yield stress at zero plastic strain; $\sigma_y + H\,\varepsilon_u$ at
  $\varepsilon_u = \max(\varepsilon_{\text{elong}} - \sigma_y/E, 10^{-3})$) and a CTE referenced to the
  cure temperature.
- Composite: for every layer and column, a balanced ±α pair homogenised into an **orthotropic** material
  in local axes 1 = meridian, 2 = through-thickness (normal), 3 = hoop. The angle is the layer's local
  angle at the column mid-point (`gp.alpha_at_s`) for helicals or the layer angle for hoops, binned to
  0.25°, one material per (fibre, binned angle). From the transformed in-plane stiffness
  $\bar Q_{11}, \bar Q_{12}, \bar Q_{22}$ of the pair (the ±α shear-coupling terms cancel), with
  $\mathbf S = [\bar Q]^{-1}$:

  $$
  E_s = 1/S_{11},\quad E_t = 1/S_{22},\quad \nu_{st} = -S_{12}/S_{11},\quad
  G_{st} = (Q_{11}+Q_{22}-2Q_{12})\,s^2c^2 + Q_{66}(c^2-s^2)^2 ,
  $$

  with $c = \cos\alpha$, $s = \sin\alpha$, $Q_{ij}$ the ply stiffnesses; through-thickness
  $E_n = E_2$, $\nu_{sn} = 0.3$, $\nu_{nt} = 0.3\,E_n/E_t$, $G_{sn} = G_{nt} = G_{12}$; CTEs
  $\alpha_s = \alpha_1c^2 + \alpha_2s^2$, $\alpha_t = \alpha_1s^2 + \alpha_2c^2$, $\alpha_n = \alpha_2$.
  The through-thickness Poisson ratios are assumed values.
- Per column an `*ORIENTATION` with local 1 along the meridian tangent and 2 along the outward normal.
- The composite is linear-elastic (no matrix cracking or progressive damage).

**Boundary conditions and loads.** Pole A nodes (the first column, all surfaces) fixed radially and
axially; pole B nodes fixed radially (rigid-ring ends). Initial temperature = cure (stress-free)
temperature; every step sets the reference temperature, so the cure cool-down is applied in the first
step and kept. Internal pressure acts on the liner inner faces; the pressure on the polar opening at boss
B is applied to the liner end face as a traction $-p\,r_i^2/(r_o^2 - r_i^2)$ ($r_i, r_o$ liner inner/outer
radius at that end), i.e. the plug force $\pi r_i^2 p$ spread over the annulus.

**Steps** (each `*STATIC`, initial increment 0.1): `CURE` (p = 0), `AUTOFRETTAGE` (WindLab's autofrettage
pressure), `UNLOAD_AF`, `PROOF` (MEOP × proof factor), `UNLOAD_PROOF`, `MEOP`, `UNLOAD_MEOP`. Output:
mid-plane node displacements (`*NODE PRINT`, set `MIDPLANE`: the through-thickness column nearest
$z = 0$), plus displacements, stresses, strains and equivalent plastic strain to the result file.

*Worked example (desktop):* 1 100 elements, 3 889 nodes, 154 materials, including CAX6 triangles where
hoop layers end.

**Comparison with the cylinder model** (`run_and_compare`): export, run `ccx -i vessel`, parse the
`MIDPLANE` displacements for each step from the `.dat` file, and compare the hoop strain
$\varepsilon_\theta = u_r/r$ at the liner inner node and the outermost composite node with WindLab's
cylinder model run **without matrix cracking** (`structural(b, damage=False)`), since the deck is
linear-elastic in the composite: cure residual, autofrettage peak, residual after autofrettage, proof
and MEOP. `docs/VALIDATION.md` reports agreement of 2–6 % for the desktop example; the solid model also
shows that the liner inner surface strains about 15 % more than the composite at autofrettage
(through-thickness compression and the $1/r$ variation), which the thin-wall model cannot resolve.

### 8.2 Abaqus SAX1 shell deck

**Where in the code:** `fea_export.py`: `export`, `_lamina`; API `POST /api/fea-export`.

The deck reproduces WindLab's own axisymmetric shell FE (`core/shellfe.py`) for Abaqus:

- **SAX1** 2-node axisymmetric shell elements on the liner **outer** surface, node $(r, z)$; element
  connectivity is reversed (pole B → pole A order) so that the positive normal points out of the vessel.
- One `*SHELL SECTION, COMPOSITE` per element: liner first (inner side), then each layer present there
  (thickness ≥ $10^{-4}$ mm), 3 integration points per ply, orientation angle 0 because each ply material
  is already the homogenised ±α pair in meridional (1) / hoop (2) axes (`*ELASTIC, TYPE=LAMINA` with
  $E_1, E_2, \nu_{12}, G_{12}$ from `_lamina` as in §8.1, and $G_{13} = G_{23}$ = ply $G_{12}$), grouped
  by 0.25° angle bins.
- `OFFSET` puts the reference surface at the liner outer surface: with total thickness $t$ and liner
  thickness $t_l$, the mid-surface lies $(t - 2t_l)/2$ above it, so $\mathrm{OFFSET} = -(t - 2t_l)/(2t)$.
- Liner material as in §8.1 (no thermal expansion; this deck has no cure step).
- Pressure as `*DLOAD … P` on the reference surface, scaled per element by the ratio of liner inner to
  reference surface area so the resultant equals the pressure on the liner inner surface; the polar-opening
  force $\pi r_{i,B}^2 p$ as a `*CLOAD` on the boss-B node; bosses as rigid rings (`BOSS_A`: $u_r$, $u_z$,
  rotation fixed; `BOSS_B`: $u_r$, rotation fixed).
- Steps: `AUTOFRETTAGE`, `UNLOAD_AF`, `PROOF`, `UNLOAD_PROOF`, `MEOP`, `UNLOAD_MEOP`; field output U, S,
  E, PEEQ; the delivered fibre failure strain is written as a comment.
- A solver-neutral **layup CSV** (element, $z$, $r$, liner thickness, thickness and angle per layer) is
  exported alongside.

*Worked example (desktop):* 298 elements, 154 materials. **Not validated:** the Abaqus deck has not been
run in Abaqus (no licence available to the authors); its conventions (SAX1 DOFs, normals, ply order,
`OFFSET`, per-element pressure scaling) were reviewed, and the independent FE check is the CalculiX
comparison (`docs/VALIDATION.md`).

### 8.3 Shop traveller

**Where in the code:** `manufacturing.py`: `traveller`, `_table`, `_md_to_html`; API
`POST /api/traveller`.

`traveller(project)` runs the full analysis and returns Markdown and a self-contained HTML rendering (a
small built-in Markdown subset renderer: headings, tables, lists, block quotes, bold). Sections:

1. **Header**: date, blanks for serial number and operator, machine name and controller.
2. **Design summary**: liner, bosses, MEOP/proof, autofrettage pressure (or "none (Type IV)"), predicted
   burst and required burst, fibre/resin and $V_f$, mass breakdown.
3. **Bill of materials**: fibre tow length ($\sum$ layer fibre length × tows) and mass, mixed resin mass,
   liner; each also with a 15 % allowance, and blanks for lot numbers. (Continuous-winding transition
   fibre is not included; it is a few metres, see §7.16.)
4. **Preparation checklist**: liner inspection and surface preparation, mounting with runout ≤ 0.5 mm,
   homing, mandrel zero and carriage mid-plane offset (`carriage_offset`), resin mixing and pot life,
   tension calibration and band width at the eye; for polymer liners the minimum winding support pressure
   (from the `liner.support` check).
5. **Winding sequence**: for continuous winding a note not to cut the roving (angle step ≤
   `max_angle_step`; pauses skipped); a table per layer with type, angle, tows × band width, tension,
   pattern ($n$/shift, pattern number, dwell) or hoop passes, extent (turnaround radii or $z$ range),
   thickness, estimated time and a sign-off box. The time is the design module's $1.35\,L/v_f$ estimate,
   not the kinematic plan (§4); use the G-code total for scheduling.
6. **Cure**: the cure cycle table with blanks for actual values, predicted thickness, exotherm, peak liner
   temperature, degree of cure and $T_g$ per section (from the cure analysis), or the resin's cure text;
   thermocouple, inspection and mass checks.
7. **Autofrettage and proof**: autofrettage pressure, proof pressure and hold, leak test, expected residual
   liner hoop stress and water-jacket volumetric expansions (Type III); proof, expansion and
   leak/permeation for Type IV.
8. **Release**: inspection and disposition, with a pressure-testing safety note.

*Worked example (desktop):* BOM 110 m of T700S 12K tow / 88 g (127 m / 101 g with allowance), 39 g mixed
resin; winding sequence rows for 5 layers, e.g. `3 | helical | 14.30° | 1 × 5.0 mm | 15 N | 62/9 (p7),
dwell 3.9° | r0 12.5 mm | 0.298 | 12 min`.

---

## 9. Summary of assumptions and limitations

| Topic | Assumption / limitation | Consequence |
|---|---|---|
| Free fibre | straight line from the tangent contact; no sag, twist or band narrowing model | warning above 600 mm free length |
| Bridging | fibre assumed to follow the surface; bridging over concave regions only detected | eye placement is off where the fibre actually bridges (VALIDATION.md) |
| Envelope | concave hull of part + bosses + shaft + clearance; eye as a point with a width allowance | eye kept further out than necessary over concave regions; no machine collision model |
| 2-axis mode | fixed eye radius per segment; no-slack may move planned points outwards | review 2-axis turnarounds |
| Eye roll | aligned to the band at the contact, period 180°, interpolated where ill-defined | twist along the free span ignored |
| Refinement | max 5°/10 mm/10° per segment, ≤ 3 × 16 subdivisions | remaining jumps reported, not removed |
| Timing | per-axis velocity and approximate acceleration limits, no jerk | controller may run slower than planned |
| G-code | G93 on every winding move; GRBL line length ensured by format, not enforced | tests keep lines ≤ 70 chars |
| Verifier | interprets G0/G1, G92/G92.1, G93/G94, M0/M1 only | no limit or acceleration check |
| Continuous | transitions not in the laminate; friction per layer × margin | check slippage notes; infeasible transitions are flagged |
| CalculiX | composite linear-elastic; assumed through-thickness Poisson ratios | validated vs cylinder model to 2–6 % (desktop) |
| Abaqus | not run in Abaqus | conventions reviewed only |

---

## 10. References

1. LinuxCNC Project, *G-Code Reference*: "G93, G94, G95: Feed Rate Mode", "G92 Coordinate System
   Offset", "G64 Path Blending", "M68 Analog Output", "(MSG, …) comments". linuxcnc.org/docs.
2. T. R. Kramer, F. M. Proctor, E. Messina, *The NIST RS274NGC Interpreter – Version 3*, NISTIR 6556,
   National Institute of Standards and Technology, 2000 (feed rate modes and rotary-axis feed semantics).
3. Grbl v1.1 documentation (github.com/gnea/grbl, wiki "Grbl v1.1 Commands"): supported G-codes
   including `G93`/`G94`, `G92`/`G92.1`, `M0`, `M3`/`M5`.
4. grblHAL (github.com/grblHAL): multi-axis (A/B/C) Grbl-compatible controller firmware.
5. S. T. Peters (ed.), *Composite Filament Winding*, ASM International, 2011.
6. S. Koussios, *Filament Winding: a Unified Approach*, PhD thesis, Delft University of Technology,
   2004 (geodesic and non-geodesic trajectories, slippage coefficient, winding-machine kinematics).
7. M. Lossie, H. Van Brussel, "Design principles in filament winding", *Composites Manufacturing*
   5(1), 1994, 5–13.
8. G. Dhondt, *CalculiX CrunchiX User's Manual* (CAX6/CAX8 elements, `*ORIENTATION`,
   `*ELASTIC, TYPE=ENGINEERING CONSTANTS`, `*EXPANSION, TYPE=ORTHO`).
9. Dassault Systèmes SIMULIA, *Abaqus Analysis User's Guide* (SAX1 elements,
   `*SHELL SECTION, COMPOSITE`, `OFFSET`, `*ELASTIC, TYPE=LAMINA`).
10. WindLab `docs/VALIDATION.md` (automated checks and the stated limitations referenced above).
