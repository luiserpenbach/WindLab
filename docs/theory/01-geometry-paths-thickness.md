# 1. Geometry, fibre paths and thickness

This chapter covers WindLab's winding model, from the liner meridian to the laminate
thickness. It explains how the liner surface is generated, how helical and hoop fibre paths are
computed on that surface, how a helical layer is closed into a pattern, and how each layer's
thickness (and so the surface the next layer is wound on) is obtained. Every statement here is
checked against the Python backend in `backend/windlab/`. Where the code simplifies, the
simplification is stated.

Worked numbers are taken from the shipped example projects (`windlab/presets.py`,
`windlab/data/examples/*.json`), computed with the code as it stands:

| Example id | Liner | Domes | Bosses A / B | Fibre |
|---|---|---|---|---|
| `type3-30mpa-11l` | R = 100 mm, L = 300 mm, AA6061-T6 2.5 mm | isotensoid | 20 / 20 mm | T700S-12K |
| `type3-70mpa-2l` | R = 60, L = 160, 3.0 mm | hemispherical | 12 / 12 | T800S-24K |
| `type3-25mpa-unequal` | R = 80, L = 260, 3.0 mm | isotensoid | 14 / 24 | T700S-12K, non-geodesic helicals |
| `type4-35mpa-h2` | R = 110, L = 400, HDPE 5.0 mm | isotensoid | 22 / 22 | T700S-24K |
| `grbl-10mpa-1l` | R = 50, L = 120, 1.5 mm | elliptical, aspect 0.7 | 10 / 10 | T700S-12K |

## Contents

1. [Coordinate frames and conventions](#1-coordinate-frames-and-conventions)
2. [Liner geometry](#2-liner-geometry)
3. [Helical fibre paths](#3-helical-fibre-paths)
4. [Hoop layers](#4-hoop-layers)
5. [Pattern closure](#5-pattern-closure)
6. [Thickness](#6-thickness)
7. [Validation pointers](#7-validation-pointers)
8. [Summary of simplifications and assumptions](#8-summary-of-simplifications-and-assumptions)
9. [References](#9-references)

---

## 1. Coordinate frames and conventions

**Where in the code:** `core/geometry.py: Profile`, `core/winding.py: PathPoints.xyz`, `schemas.py: LinerSpec, Layer`

### 1.1 Part frame

Every wound surface is a **surface of revolution** about the vessel axis. The code stores it as its
**meridian**, a polyline $(z_i, r_i)$ held in a `Profile` object:

- $z$ is the axial coordinate in mm. $z = 0$ is the **mid-plane** of the cylindrical section.
- $r$ is the radius (distance from the axis) in mm.
- **End A** is the end at negative $z$ and **end B** is the end at positive $z$. Each end has its own
  polar boss radius (`boss_radius_a`, `boss_radius_b`).
- The **tangent lines** (the cylinder/dome junctions of the liner) are at $z = \pm L/2$, where
  $L$ is `cyl_length`.
- The meridian runs from the boss edge of end A to the boss edge of end B. It does **not** reach the
  axis: $r$ starts and ends at the boss radius.

**Azimuth** $\phi$ (rad) is measured around the axis. In the 3D frame used for kinematics and
display, `PathPoints.xyz()` maps a point to

$$
(x, y, z)_{3D} = \big(z,\; r\cos\phi,\; -r\sin\phi\big),
$$

so the 3D $x$ axis is the vessel axis. The negative sine makes the mandrel turn in the positive
sense as $\phi$ increases while winding.

### 1.2 Meridian arclength

The **meridian arclength** $s$ is the cumulative polyline length measured from the end-A boss
(`Profile.s`):

$$
s_i = \sum_{j<i} \sqrt{(z_{j+1}-z_j)^2 + (r_{j+1}-r_j)^2}.
$$

Derivatives along the meridian are written with primes: $r' = dr/ds$ and $z' = dz/ds$, with
$r'^2 + z'^2 = 1$.

- The unit tangent is $(z', r')$. `Profile.tangents` computes it by central differences.
- The unit **outward normal** is $(n_z, n_r) = (-r', z')$ (`Profile.normals`). On the cylinder
  $n_r = 1$. On a dome $n_r = z'$, the cosine of the angle between the meridian tangent and the
  axis.

### 1.3 Winding angle

The winding angle $\alpha$ is measured **from the meridian**, which on the cylinder is the vessel
axis:

- $\alpha = 0$: axial fibre.
- $\alpha = 90^\circ$: circumferential (hoop) fibre. On a dome, $\alpha = 90^\circ$ marks the
  **turnaround**, where the fibre is tangent to a parallel circle.

The fibre unit tangent in the local surface frame $(\mathbf e_s, \mathbf e_\phi)$ is

$$
\mathbf T = \cos\alpha\,\mathbf e_s + \sin\alpha\,\mathbf e_\phi .
$$

The angle reported for a layer (`BuiltLayer.angle`) is $\alpha$ at the mid-plane of that layer's
base surface (`alpha_mid`). For hoops it is the helix angle of the hoop band (Section 4).

### 1.4 Layer surfaces

A built layer (`design.py: BuiltLayer`) carries two profiles:

- `base`: the surface it is wound on, i.e. the liner or the previous layer's top;
- `top`: its own outer surface.

All profiles have **the same number of points in the same order as the liner outer profile**. Offsets
and loop removal keep this index correspondence (Section 2.4), and the thickness map uses it to map
every layer back onto liner arclength (Section 6.5).

---

## 2. Liner geometry

**Where in the code:** `core/geometry.py: liner_profiles, dome_curve, _isotensoid, liner_thickness, clean_offset, turnaround_s`

`liner_profiles(spec)` builds the **outer** liner meridian from three parts:

1. dome A, with `n_dome` = 240 points by default, built by `dome_curve` for `boss_radius_a` and
   mirrored;
2. the cylinder, with `n_cyl` = 60 points of which the two end points are dropped, at $r = R$;
3. dome B, built by `dome_curve` for `boss_radius_b`.

Here $R$ is the outer radius of the liner cylinder (`LinerSpec.radius`). The **inner** meridian is
the outer one offset inwards by the local wall thickness (Section 2.3). The outer liner surface is
the surface the first layer is wound on.

`dome_curve` returns $(r, h)$ from the equator ($r = R$, $h = 0$) to the boss, where $h$ is the
axial height beyond the tangent line. It refuses (raises `GeometryError`) in two cases:

- a boss radius $\ge 0.9R$;
- an isotensoid with $\rho_b = r_{boss}/R > 0.6$.

### 2.1 Geodesic-isotensoid (netting) dome

**Where in the code:** `geometry.py: _isotensoid`

**Assumptions.** The dome is sized with netting theory: the resin carries no load and the fibres
carry all the pressure. The fibres are geodesic ($\lambda = 0$) with Clairaut constant equal to the
boss radius. Every fibre then has the same stress along the whole dome, which is what
"isotensoid" means.

**Membrane equilibrium.** Let $N$ be the fibre force per unit length of the laminate, summed over
the $\pm\alpha$ plies. The membrane stress resultants are

$$
N_m = N\cos^2\alpha,\qquad N_\theta = N\sin^2\alpha ,
$$

where

- $N_m$ is the meridional stress resultant (N/mm);
- $N_\theta$ is the hoop stress resultant (N/mm).

Two equilibrium equations govern a shell of revolution under internal pressure $p$.

- **Axial equilibrium of the cap cut at radius $r$.** The cap is closed by the boss or a plug; the
  force on the boss is neglected, as is usual in netting theory. With $u = z' = n_r$:

  $$
  2\pi r\,N_m\,u = \pi r^2 p \quad\Rightarrow\quad N_m = \frac{p\,r}{2u}.
  $$

- **Normal equilibrium (Laplace).** With the principal curvatures $k_m$ of the meridian and
  $k_p = u/r$ of the parallel:

  $$
  N_m k_m + N_\theta k_p = p .
  $$

Now substitute $N_\theta = N_m\tan^2\alpha$ and $N_m = pr/(2u)$ into Laplace. On a meridian
parametrised by $r$ the meridional curvature is $k_m = du/dr$ (see Section 3.2). This gives

$$
\frac{du}{dr} = \frac{u}{r}\left(2 - \tan^2\alpha\right).
$$

For geodesic fibres, Clairaut's relation gives $\sin\alpha = \rho_0/\rho$, with
$\rho = r/R$ and $\rho_0 = r_{boss}/R$. Hence $\tan^2\alpha = \rho_0^2/(\rho^2-\rho_0^2)$, and

$$
\frac{d\ln u}{d\ln\rho} = \frac{2\rho^2 - 3\rho_0^2}{\rho^2 - \rho_0^2}.
$$

Integrate this with partial fractions in $\rho^2$ and apply $u(1) = 1$: the meridian is tangent
to the cylinder at the equator. The result is the expression implemented in the code:

$$
\boxed{\,u(\rho) = \rho^3\sqrt{\frac{1-\rho_0^2}{\rho^2-\rho_0^2}}\,}
$$

**Meridian height.** The height below the equator follows from $dh/d\rho = u/\sqrt{1-u^2}$
($u$ is the cosine of the tangent's angle to the axis):

$$
h(\rho) = \int_\rho^1 \frac{u(\tilde\rho)}{\sqrt{1-u(\tilde\rho)^2}}\,d\tilde\rho .
$$

**How it is computed.**

- **Upper integration limit.** $u$ has a minimum at $\rho^2 = 1.5\rho_0^2$ and grows back past 1 as
  $\rho \to \rho_0$. The code bisects (200 steps) on $[\rho_0(1+10^{-12}),\ \sqrt{1.5}\,\rho_0]$
  for $\rho_1$, the radius where $u$ returns to 1. There the dome is again tangent to a cylinder:
  it becomes a short **neck**.
- **Singularities.** Both ends of $[\rho_1, 1]$ have $u \to 1$, so the integrand has a
  $1/\sqrt{\cdot}$ singularity at each end. Cosine spacing removes them:

  $$
  \rho(\tau) = 1 - (1-\rho_1)\tfrac12(1-\cos\pi\tau),\qquad \tau \in [0,1],
  $$

  where $\tau$ is the integration parameter. The integral is then taken with the trapezoidal rule
  in $\tau$. The two end values of the integrand are replaced by their neighbours.
- **Scaling and closure.** The result is scaled by $R$. If the last radius is still above the boss
  radius, the neck is closed with one extra point at the boss radius, with a tiny axial step
  ($\Delta h = 0.05\,\Delta r$). This is an almost radial annular face.

In practice $\rho_1$ is extremely close to $\rho_0$, so the neck is negligible:

| $\rho_0$ | $\rho_1$ | dome height $h/R$ |
|---|---|---|
| 0.1 | 0.1000 | 0.604 |
| 0.2 | 0.2002 | 0.618 |
| 0.3 | 0.3011 | 0.640 |
| 0.4 | 0.4046 | 0.669 |

The `type3-30mpa-11l` example ($\rho_0 = 0.2$) has a dome height of 61.8 mm ($0.618R$). The
classical height of a geodesic isotensoid is about $0.55$ to $0.65\,R$, and
`test_isotensoid_height` checks this range.

> **Simplifications.**
> - The dome shape is designed for fibres turning exactly **at the boss radius**. Real helical
>   layers turn at $r_{boss} + B/2 + \text{offset}$ (Section 3.7) and on the built-up surface.
> - It assumes a single geodesic helical family, with no hoop fibres on the dome and no liner load
>   sharing.
> - Non-geodesic layers and outer layers therefore deviate from isotensoid loading. The netting
>   stress check (`design.py: dome_netting_stress`) quantifies this per build.

### 2.2 Hemispherical and elliptical domes

These domes are parametrised by an angle $\theta$ from $\pi/2$ (equator) down to
$\arcsin\rho_b$ (boss):

$$
r = R\sin\theta,\qquad h = b\cos\theta ,
$$

where

- $b = R$ for a hemisphere;
- $b = a_d R$ for an ellipse, where $a_d$ is the aspect ratio `dome_aspect` (height/radius,
  0.2 to 1.5).

For the ellipse, $\theta$ is the parametric angle, not the polar angle. The dome ends exactly at
$r = r_{boss}$; there is no flat face.

- The 70 MPa hemispherical example ($R$ = 60, boss 12) has a dome height of
  $R\cos(\arcsin 0.2) = 58.8$ mm.
- The desktop elliptical example ($R$ = 50, aspect 0.7, boss 10) has $0.7 \cdot 50 \cdot \cos(\arcsin 0.2) = 34.3$ mm.

> **Note.** A hemisphere on a cylinder has a jump in meridional curvature, from $0$ to $1/R$, at the
> tangent line. The fibre-path surface tables smooth the curvature (Section 3.5), so the jump is
> spread over about 4 mm of meridian.

### 2.3 Boss openings and neck thickening

**Where in the code:** `geometry.py: liner_thickness`

The liner wall has thickness $t_w$ (`wall_thickness`) on the cylinder and most of the dome. It
thickens smoothly towards each boss to $t_{neck}$ (`neck_thickness`, default $3t_w$). On each side
separately:

$$
x = \operatorname{clip}\!\left(\frac{r_{blend} - r}{r_{blend} - r_b}, 0, 1\right),\qquad
t(r) = t_w + (t_{neck}-t_w)\,(3x^2 - 2x^3),
$$

where

- $r_b$ is the boss radius of that end;
- $r_{blend}$ is `neck_blend_radius`, the radius where thickening starts. The default is
  $\min(\max(1.8r_b,\ r_b + 15),\ 0.6R)$.

The blend $3x^2 - 2x^3$ is a smoothstep: it has zero slope at both ends of the blend.

For the 30 MPa example: $r_b = 20$ gives $r_{blend} = 36$ mm, and the wall grows from 2.5 to
7.5 mm at the boss.

**The thickening goes inwards.** `inner = outer.offset(-t)`, so the winding surface (the outer
profile) is the dome shape of Sections 2.1 and 2.2. The inner profile is **not** cleaned of loops.
A `GeometryError` is raised if any inner radius becomes $\le 0$.

The boss hardware itself (`boss_length`, `shaft_radius`) is not part of the meridian. It is used
only by the machine-clearance envelope (`kinematics.py: solid_radius`).

### 2.4 Profile offsetting and `clean_offset`

**Where in the code:** `geometry.py: Profile.offset, clean_offset`

**Offset.** `Profile.offset(t)` moves every point along its outward normal by a (pointwise)
thickness $t_i$:

$$
(z_i, r_i) \mapsto (z_i + t_i n_{z,i},\ r_i + t_i n_{r,i}).
$$

A normal offset of a curve develops **swallow-tail loops** where

- the thickness exceeds the local radius of curvature (the concave side of the offset), or
- the thickness varies steeply.

Both happen at the polar build-up of helical layers. `clean_offset(prof, half)` removes the loops
**without changing the number or order of points**.

**Cleaning procedure.** For each dome (points with $|z| > L/2$), with $\Delta z = |z| - L/2$:

1. Take polar coordinates about the dome centre on the axis at $z = \pm L/2$:
   $\vartheta = \operatorname{atan2}(r, \Delta z)$ and $\varrho = \sqrt{r^2 + \Delta z^2}$.
   $\vartheta = \pi/2$ at the equator and decreases towards the pole.
2. Walk from the equator to the pole and force $\vartheta$ to be monotone (running minimum). The
   polyline can then never run backwards.
3. Build the **outer envelope**: the maximum $\varrho$ in each of 2000 bins of $\vartheta$.
4. Replace each point by the envelope radius at its (monotone) angle. Where the angle was not
   modified, the original $\varrho$ is kept if it is larger.

> **Assumption.** Each dome is star-shaped about $(z = \pm L/2,\ r = 0)$, i.e. every ray from that
> centre crosses the surface once. This holds for the domes generated here and their build-ups.
> Where cleaning collapses several points onto one, the local ratio of arclengths becomes small;
> the thickness map floors this ratio (Section 6.5).

### 2.5 Layer-on-layer surfaces

**Where in the code:** `design.py: build`

Layers are built in order.

1. The surface `surf` starts as the liner outer profile.
2. For each layer, its thickness distribution $t(s)$ is computed on `surf` (Sections 4 and 6).
3. Its top surface is set to

   $$
   \texttt{top} = \texttt{clean\_offset}(\texttt{surf.offset}(t),\ L/2),
   $$

   and `surf = top` for the next layer.

Everything a layer does is computed on its own base surface:

- its mid-plane radius `R_mid = surf.radius_at(0)`;
- its helical path and its pattern;
- its thickness.

Build-up from earlier layers therefore changes the mid-plane radius, the dome shape near the
turnarounds, and the geodesic advance of every subsequent layer. The helical angles in the
examples increase slightly from layer to layer partly for this reason: the Clairaut angle
$\arcsin(r_0/R_{mid})$ changes as $R_{mid}$ grows, and the turnaround offsets are staggered.

> **Simplification.** The build-up is axisymmetric and band-averaged (Sections 6.2 and 6.3). The
> band-level thickness map (Section 6.5) is a post-processing result; it does **not** feed back
> into the surfaces of later layers.

### 2.6 Locating a turnaround circle on a profile

`turnaround_s(profile, r0, end)` walks from the point nearest $z = 0$ towards the requested end and
returns, by linear interpolation, the arclength where $r$ first drops to $r_0$. It raises an error
in two cases:

- $r_0$ exceeds the mid-plane radius;
- $r_0$ is below the boss radius at that end.

---

## 3. Helical fibre paths

**Where in the code:** `core/winding.py: geodesic_pass`, `core/paths.py: geodesic, non_geodesic, balanced_angle, _Side, _shoot, _integrate, SurfaceTable, HelicalPass`

### 3.1 Geodesics and Clairaut's relation

A **geodesic** is a surface curve with zero geodesic curvature: a straight line for an observer
on the surface. A fibre pulled under tension over a frictionless surface follows a geodesic.

On a surface of revolution, geodesics satisfy **Clairaut's relation**:

$$
r\sin\alpha = r_0 = \text{const},
$$

where $r_0$ is the Clairaut constant. $r_0$ is also the smallest radius the fibre reaches: its
**turnaround radius**, where $\alpha = 90^\circ$. The cylinder angle of a geodesic that turns at
$r_0$ is therefore

$$
\alpha_{cyl} = \arcsin(r_0/R).
$$

**Example.** Layer `hel1` of `type3-30mpa-11l` turns at $r_0 = 23$ mm on a surface with
$R_{mid} = 100.49$ mm (the liner plus two hoop layers), so $\alpha_{cyl} = 13.23^\circ$.

**Azimuth advance.** From $r\,d\phi = \tan\alpha\,ds$ and Clairaut:

$$
\frac{d\phi}{ds} = \frac{r_0}{r\sqrt{r^2 - r_0^2}} .
$$

This is singular like $1/\sqrt{s - s_t}$ at the turnaround $s_t$, because $r - r_0 \approx
r'(s_t)(s - s_t)$ there. `geodesic_pass` removes the singularity with the substitution
$s = s_t \pm w^2$, where $w$ is a new integration variable:

$$
\frac{d\phi}{dw} = \frac{2w\,r_0}{r\sqrt{(r-r_0)(r+r_0)}}
\ \xrightarrow{w\to 0}\ \frac{2}{\sqrt{2r_0\,|r'(s_t)|}} .
$$

The code integrates $d\phi/dw$ with the trapezoidal rule. The first value is set to the limit
above, where $|r'(s_t)|$ is found from a one-sided finite difference. Each half pass runs from a
turnaround to the midpoint $s_m$ of the two turnaround arclengths, using $n/2$ points uniform in
$w$ (so points cluster near the turnaround in $s$). The two halves are joined into one
**pass A → B**. Its total azimuth change is the **advance** $\Delta\phi_{pass}$.

`paths.geodesic` wraps this into a `HelicalPass`:

- $\alpha = \arcsin(r_0/r)$ and $\lambda = 0$;
- the analytic thickness integral $G(r) = \operatorname{arccosh}(r/r_0)$ (Section 6.2);
- the dwell slippage of the turnaround circles (Section 3.9).

**Worked check.** On a hemisphere-capped cylinder, each dome half-leg of a geodesic is a
great-circle arc spanning $\pi/2$ in azimuth. The advance per pass is therefore

$$
\Delta\phi_{pass} = \pi + \frac{L\tan\alpha}{R}.
$$

For the 70 MPa liner ($R$ = 60, $L$ = 160) with $r_0$ = 16 mm, the code gives $222.277^\circ$
against $222.274^\circ$ for the formula.

### 3.2 Normal and geodesic curvature on a surface of revolution

A curve on a surface has a curvature vector that splits into two parts:

- **normal curvature** $k_n$, the component along the surface normal;
- **geodesic curvature** $k_g$, the component in the tangent plane, perpendicular to the curve.

On a surface of revolution the principal directions are the meridian and the parallel. Their
principal curvatures are

$$
k_m = r'z'' - z'r'' \;\big(= du/dr \text{ with } u = z'\big),\qquad k_p = \frac{z'}{r} = \frac{n_r}{r}.
$$

Euler's theorem gives the normal curvature of a fibre at angle $\alpha$:

$$
k_n = k_m\cos^2\alpha + k_p\sin^2\alpha .
$$

Liouville's formula for a curve crossing the meridians at angle $\alpha$ gives its geodesic
curvature:

$$
k_g = \frac{d\alpha}{dl} + \frac{\sin\alpha\, r'}{r},
$$

where $l$ is the arclength along the fibre. The sign convention used by the code is the one in
which a positive $k_g$ **increases** $\alpha$ and so turns the fibre around earlier.

On a convex dome $k_n > 0$: fibre tension presses the fibre onto the surface. On a concave region
(the flank beside a thick polar build-up) $k_n < 0$: the fibre tends to lift off and bridge
(Section 6.6).

### 3.3 Slippage coefficient and friction

A tensioned fibre with $k_g \ne 0$ pushes sideways on the surface. Per unit length of fibre under
tension $F$:

- the normal (contact) force is $F k_n$;
- the lateral force is $F k_g$.

The fibre stays in place on the wet surface as long as the **slippage coefficient**

$$
\lambda = \frac{k_g}{k_n}
$$

stays within the available fibre/surface friction coefficient $\mu$ (`Layer.friction`, default
0.2).

`design.py: checks` compares the dome slippage of each non-geodesic layer,
$\max(|\lambda_A|, |\lambda_B|)$, against $\mu$:

- **ok** if it is $\le \mu$;
- **warn** up to $1.25\mu$;
- **fail** above.

> **Simplification.** This is the classical Coulomb-type slippage criterion. It treats $\mu$ as a
> single scalar for the layer: it does not depend on resin viscosity, tension, speed or the angle
> between the fibre and the fibres underneath.

### 3.4 Non-geodesic path equations in fibre arclength

Combining Liouville's formula with $k_g = \lambda k_n$ and the kinematics of $\mathbf T$ gives, in
fibre arclength $l$:

$$
\begin{aligned}
\frac{d\alpha}{dl} &= \lambda\,k_n(s,\alpha) - \frac{\sin\alpha\,r'(s)}{r(s)},\\[2pt]
\frac{ds}{dl} &= \cos\alpha,\\[2pt]
\frac{d\phi}{dl} &= \frac{\sin\alpha}{r(s)},
\end{aligned}
$$

where

- $s$ is the meridian arclength of the fibre point;
- $r(s)$, $r'(s)$, $k_m(s)$ and $z'(s)$ come from the surface table (Section 3.5);
- $k_n(s, \alpha) = k_m\cos^2\alpha + (z'/r)\sin^2\alpha$.

**Special cases.**

- $\lambda = 0$ recovers Clairaut: $\tfrac{d}{dl}(r\sin\alpha) = r'\cos\alpha\sin\alpha + r\cos\alpha(-\sin\alpha\,r'/r) = 0$.
- On a cylinder ($r' = 0$, $k_m = 0$, $k_p = 1/R$), $d\alpha/dl = \lambda\sin^2\alpha/R$. Hence
  $\cot\alpha$ changes linearly with fibre length:

  $$
  \cot\alpha(l) = \cot\alpha_0 - \lambda l/R .
  $$

  `core/continuous.py` uses this closed form for the cylinder angle ramps between hoop and helical
  layers.

**Why fibre arclength and not meridian arclength?** Written in $s$, the angle equation becomes

$$
\frac{d\alpha}{ds} = \frac{\lambda k_n - \sin\alpha\,r'/r}{\cos\alpha},
$$

which is singular at the turnaround, where $\cos\alpha = 0$. In $l$ all right-hand sides are
bounded. The integration passes smoothly through $\alpha = 90^\circ$, where $ds/dl$ changes sign,
and the turnaround is found as the zero crossing of $\alpha - \pi/2$. The same reasoning motivates
the $w^2$ substitution for the geodesic (Section 3.1).

### 3.5 Surface tables

**Where in the code:** `paths.py: SurfaceTable`

The integrator needs $r$, $r'$, $z'$ and $k_m$ at arbitrary $s$, for many lanes at once.
`SurfaceTable(prof, h=0.25)` builds them as follows.

1. Resample the meridian uniformly in $s$ with step $h \approx 0.25$ mm.
2. Compute first and second derivatives of $r(s)$ and $z(s)$ with a **Savitzky-Golay** filter: a
   cubic polynomial over a window of about 4 mm (at least 7 points, odd).
3. Normalise the first derivatives to a unit tangent and compute
   $k_m = (r'z'' - z'r'')/|\cdot|^2$.
4. Store the rows $[r, r', z', k_m]$. `at(s)` interpolates them linearly, vectorised over lanes.

> **Simplification.** Smoothing over about 4 mm is needed because the meridian is a polyline,
> possibly with offset kinks. It also smears genuine curvature jumps, such as the hemisphere tangent
> line, and very short features of the build-up.

### 3.6 RK4 integration with vectorised lanes

**Where in the code:** `paths.py: _integrate, _rhs`

`_integrate(tab, s0, a0, phi0, lams, dl)` integrates **many lanes at once**. Each lane is the same
start state $(s_0, \alpha_0, \phi_0)$ with a different constant dome slippage $\lambda$.

- **Step.** Classical fourth-order Runge-Kutta with a fixed step $\Delta l$ (0.8 mm for layers,
  1.6 mm for continuous-winding transitions, 2.0 mm in the first two coarse shooting iterations).
  Only the lanes still active are advanced in each step, with NumPy vector arithmetic.
- **Turnaround.** When a lane's new angle reaches $\alpha \ge \pi/2$, the crossing is found by
  linear interpolation inside the step. From it the code records $s_{turn}$, $\phi_{turn}$ and
  $r_{turn} = r(s_{turn})$, and the lane stops.
- **Run-off.** A lane is invalid, with $r_{turn} = -1$, in two cases:
  - it reaches the end of the surface ($s \ge s_{end} - 2h$, i.e. it runs onto the boss) before
    turning;
  - its angle drops to $\alpha \le 0$ (the fibre reverses sense).

  Such a lane turns "too late".
- **Step limit.** At most $6(s_{end}-s_0)/\Delta l + 200$ steps.

The dome integration starts at the tangent line. The cylinder part is computed separately:

- **Cylinder section** (`_Side.cylinder`). From the mid-plane to the tangent line $z = L/2$ of the
  base surface, the path is a **geodesic**, integrated by quadrature:
  $\alpha = \arcsin(c/r)$ with $c = R_{mid}\sin\alpha_{mid}$, and $\phi = \int \tan\alpha / r\,ds$.
  This is exact on any surface of revolution, including a built-up one. If $r \le c$ somewhere,
  the fibre would turn on the cylinder, and a `GeometryError` asks for a lower angle.
- **Dome section.** From the tangent line on, the path uses a constant dome slippage $\lambda$
  (per side).

**Sides.** Each side is handled by a `_Side`, oriented so that the pole of interest is at the end
of the profile. Side B uses the profile as is. Side A uses the mirrored profile
$z \to -z$ (`_mirror`), so one code path serves both domes.

### 3.7 Turnaround radii and shooting on $\lambda$

The requested turnaround radius of a helical layer is the boss radius plus half the band width
plus an optional offset, so the band edge just clears the boss:

$$
r_A = r_{boss,A} + \tfrac{B}{2} + \delta_A,\qquad r_B = r_{boss,B} + \tfrac{B}{2} + \delta_B ,
$$

where

- $B$ is the band width;
- $\delta_A$ is `turnaround_offset`;
- $\delta_B$ is `turnaround_offset_b`, which defaults to $\delta_A$.

The build fails if $\max(r_A, r_B) \ge 0.95R_{mid}$.

For a given cylinder angle $\alpha_{mid}$, each dome needs the constant $\lambda$ at which the
integrated path turns exactly at $r_{target}$. This is a 1-D root-finding problem on

$$
f(\lambda) = r_{turn}(\lambda) - r_{target}.
$$

The function has gaps: lanes that run onto the boss have no $r_{turn}$. `_shoot` solves it with a
**scan-bracket-refine** strategy:

1. **Scan.** Iteration 0 integrates 37 lanes, $\lambda \in [-0.9, 0.9]$ (`LAMBDA_SEARCH` = 0.9),
   with a coarse step. Later iterations use 13 lanes over the current bracket $[lo, hi]$. From
   iteration 2 on, the fine step is used.
2. **Track the best lane.** Keep the valid lane closest to the target seen so far.
3. **Brackets.** Collect adjacent pairs of **valid** lanes whose $f$ changes sign. If there are
   several, choose the one **closest to $\lambda = 0$** (smallest $|\lambda_j + \lambda_{j+1}|$).
   This prefers the least-slippage solution when $r_{turn}(\lambda)$ is not monotone.
4. **Edge brackets.** If no sign change exists, the target may lie between a lane that runs onto
   the boss and the first valid lane that turns above the target. The code then refines into that
   valid/invalid interval (the one nearest $\lambda = 0$) and continues.
5. **Secant update.** Within a bracket, a regula-falsi estimate gives the new $\lambda$.
   Convergence is declared when the bracket's $|f|$ values differ by less than 0.02 mm, from
   iteration 2 on. Otherwise the bracket becomes the new scan interval. There are up to 12
   iterations, or 4 in "coarse" mode.
6. **No bracket.**
   - If the nearest valid lane is within $\max(0.3\ \text{mm},\ 1\%\ r_{target})$, it is accepted:
     the target is at the edge of the reachable range.
   - If this happens on the first scan, a `GeometryError` states the reachable range of
     $r_{turn}$ and whether to **raise** or **lower** the cylinder angle.

After shooting, `_Side.leg` re-integrates the chosen $\lambda$ with history recording. It
assembles the **leg** from the mid-plane to the turnaround: the cylinder quadrature points followed
by the RK4 dome points. The per-point $\lambda$ is 0 on the cylinder and $\lambda_{dome}$ on the
dome.

The accuracy of the turnaround radius is checked in `test_nongeodesic.py: test_turnaround_hits_target`
(0.1 mm).

### 3.8 The balanced cylinder angle and unequal polar openings

**Where in the code:** `paths.py: balanced_angle, non_geodesic`; `design.py: build`

**Geodesic layers** (`winding = "geodesic"`, the default) have a single Clairaut constant. The code
uses $r_0 = \max(r_A, r_B)$ at both ends. When the openings differ, it adds a warning that the path
turns at the larger radius at both ends, and `checks` adds an informational "Unequal polar
openings" entry.

**Non-geodesic layers** (`winding = "non-geodesic"`) turn at $r_A$ and $r_B$ separately, using
different constant slippages $\lambda_A$ and $\lambda_B$ on the two domes.

- **Given angle.** If the layer's `angle` is set, that cylinder angle is used.
- **Auto angle.** If `angle` is null, `balanced_angle` picks the angle that **minimises the larger
  slippage**, $\max(|\lambda_A|, |\lambda_B|)$:
  1. Bound the search between the two geodesic angles $\arcsin(\min(r_A,r_B)/R)$ and
     $\arcsin(\max(r_A,r_B)/R)$. The interval is widened by 15 % on each side and clamped to
     $[0.01, 1.4]$ rad.
  2. Evaluate 11 angles with coarse shooting on both domes. The cost is
     $\max(|\lambda_A|,|\lambda_B|)$, or infinite if a side is infeasible.
  3. Refine by bisection (10 steps) on $\lambda_A + \lambda_B = 0$, between feasible grid
     neighbours of the best point that bracket a sign change.

  At the balanced angle, $\lambda_A \approx -\lambda_B$: one dome is steered towards the axis, the
  other away from it.

**Worked example.** `type3-25mpa-unequal`, layer `hel1`:

| Quantity | Value |
|---|---|
| Bosses | 14 / 24 mm |
| Band width $B$ | 6 mm |
| Turnaround radii $r_A$ / $r_B$ | 17 / 27 mm |
| $R_{mid}$ | 80.49 mm |
| Geodesic angles for 17 and 27 mm | $12.19^\circ$ and $19.60^\circ$ |
| Balanced angle | $15.99^\circ$ |
| Dome slippages $\lambda_A$ / $\lambda_B$ | $-0.062$ / $+0.062$ |
| Friction | 0.2 (check passes) |

The pass advance is $216.3^\circ$.

**Infeasible path.** If a non-geodesic path cannot be found, `build` does not stop. It falls back
to the geodesic path at $\max(r_A,r_B)$, records the reason in `Build.path_errors`, and `checks`
reports a **fail** for that layer's path.

### 3.9 Dwell arcs and dwell slippage

At each turnaround the pattern may need extra mandrel rotation, the **dwell** (Section 5). In the
path model the dwell is an arc of the **turnaround parallel circle**:

- constant $z$ and $r$;
- $\alpha = 90^\circ$;
- discretised in steps of at most $10^\circ$ (`winding.py: _dwell_arc`).

A parallel circle has $d\alpha/dl = 0$. From Liouville's formula its geodesic curvature is
$k_g = r'/r$. Its normal curvature is $k_n = k_p = z'/r$. Holding the fibre on that circle
therefore needs

$$
\lambda_{dwell} = \left|\frac{k_g}{k_n}\right| = \frac{|r'|}{|z'|} = \frac{|n_z|}{|n_r|},
$$

which is the tangent of the meridian's inclination to the axis at the turnaround. The code
computes this at the turnaround:

- non-geodesic legs: `Leg.dwell_slip`, from the surface table;
- geodesic passes: from the profile normals.

Near a polar opening the dome is almost flat (radial), so $\lambda_{dwell}$ is large. For example
it is 10.1 for `hel1` of `type3-30mpa-11l` and 12.6 / 4.1 at ends A / B of the unequal example.
In other words, a real fibre cannot follow a pure parallel-circle dwell on a flat dome without
slipping. In practice it spirals and settles.

> **Reporting only.** Dwell slippage is stored per point on the dwell arcs (`PathPoints.lam`) and
> reported per layer (`LayerResult.dwell_slippage`, the larger of the two ends). It is **not**
> part of the pass/fail slippage check, which covers only $\lambda_A$ and $\lambda_B$ of the dome
> legs.

### 3.10 Assembling a pass and a circuit

**Where in the code:** `paths.py: _non_geodesic, HelicalPass`; `winding.py: helical_layer_path`; `kinematics.py: layer_path`

**Pass A → B** (`_non_geodesic`). The two legs are joined at the mid-plane:

- leg A is reversed and mirrored back ($s \to s_{total} - s$, $z \to -z$), with azimuth
  $\phi_A^{max} - \phi$;
- leg B is appended with its azimuth shifted by the advance of leg A.

The result is a `HelicalPass` holding:

- the arrays $s, z, r, \phi, \alpha, \lambda$ along the pass;
- the achieved turnaround radii $r_A$ and $r_B$, and the dome slippages;
- the dwell slippages and $\alpha_{mid}$;
- the per-side thickness tables `legs` (Section 6.2).

Its `advance` is the total azimuth change of the pass. Its `r0` property, used for the length of
the dwell arcs, is the mean $(r_A + r_B)/2$.

**Circuit** (`helical_layer_path`). The pass is resampled to `samples` points evenly spaced in 3D
length (`machine.samples_per_pass`). Then, for each of the $n$ circuits of the pattern:

1. **A → B.** The pass, with azimuth continuing from the previous point.
2. **Dwell at B.** An arc of angle $d$ on the end-B turnaround circle.
3. **B → A.** The same pass walked backwards. The azimuth keeps increasing, by
   $\phi_{end} - \phi(\text{reversed})$, so the return pass is the mirror image of the outgoing one.
4. **Dwell at A.**

The azimuth advance per circuit is therefore

$$
\Delta\phi_{circuit} = 2\Delta\phi_{pass} + 2d ,
$$

where $d$ is the dwell at each turnaround, chosen so that $\Delta\phi_{circuit}$ closes the pattern.
The code asserts that this matches the pattern's circuit advance.

**Layer path** (`kinematics.py: layer_path`). The layer's `start_angle` (pattern clocking) is added
to all azimuths. `suggest_layup` clocks successive helical layers by the golden angle
$137.508^\circ$ to interleave their crossover zones.

> **Symmetric turnaround.** The return pass is the mirror image of the outgoing pass; the model
> does not integrate the path beyond $\alpha = 90^\circ$. For a surface of revolution with the same
> $|\lambda|$ this is the symmetric solution. Real turnarounds, especially with a dwell, are not
> exactly symmetric.

**Fibre length.** The centre-line length of a helical layer is

$$
L_f = n\,(2 L_{pass} + 2 d\, r_0),
$$

where $L_{pass}$ is the 3D length of one pass and $n$ the number of circuits
(`BuiltLayer.fiber_path_length`).

**Caching.** Path computations are cached by a hash of the profile arrays and the scalar arguments
(`paths._cached`, at most 1024 entries). The surface tables of both sides are cached per profile.

---

## 4. Hoop layers

**Where in the code:** `winding.py: hoop_layer_path`; `design.py: build` (hoop branch), `BuiltLayer.pitch, fiber_path_length`

A hoop layer is a near-circumferential helix on the cylinder. It is defined by:

| Parameter | Meaning | Default |
|---|---|---|
| `band_width` $B$ | band width | 6 mm |
| `overlap` $o$ | fraction of each band overlapped by the next revolution | 0 |
| `passes` $n_p$ | number of traverses; each traverse is one band layer | 2 |
| `end_offset_a`, `end_offset_b` | **drop-off** distance of the layer end from the tangent line | 0 |

**Extent.** The hoop layer covers

$$
z_s = -L/2 + e_A,\qquad z_e = L/2 - e_B ,
$$

where $e_A$ and $e_B$ are the two end offsets. The layer must be at least two band widths long.
Staggering the drop-offs of successive hoop layers tapers the hoop stack. Note that
`docs/VALIDATION.md` records that staggered drop-offs lowered the progressive burst of the 30 MPa
example (53.8 vs 73.9 MPa). `suggest_layup` therefore uses full-length hoops.

**Pitch and angle.** The axial advance per revolution is

$$
p_h = B(1-o).
$$

The reported hoop angle, measured from the axis, is

$$
\alpha_{hoop} = \operatorname{atan2}(2\pi R_{mid},\ p_h),
$$

for example $\operatorname{atan}(2\pi\cdot 100/6) = 89.45^\circ$ for the first hoop of the 30 MPa
example.

**Path.** The band centre travels between $z_s + B/2$ and $z_e - B/2$, so the band edges sit at
$z_s$ and $z_e$. This takes $N_{rev} = (z_e - z_s - B)/p_h$ revolutions per traverse, sampled at
72 points per revolution by default. Passes alternate direction.

**Reversal dwell.** At each reversal the path adds **half a revolution at constant $z$**
($\pi$ of mandrel rotation) to lock the band before the carriage reverses. These dwells deposit
extra material at the layer ends. In the band-level map of the desktop example the local peak at
the hoop ends is $0.49$ mm against a nominal $0.30$ mm.

**Reversed hoops.** `hoop_layer_path(..., reverse=True)` starts the first traverse at end B
instead of end A. Continuous winding (`core/continuous.py`, through `kinematics.layer_path(...,
reverse=...)`) uses it: when the fibre arrives at end B from the previous layer, the next hoop layer
starts there, so no transition across the cylinder is needed.

**Fibre length:**

$$
L_f = n_p\left(N_{rev}\sqrt{(2\pi R_{mid})^2 + p_h^2} + \tfrac12\,2\pi R_{mid}\right).
$$

**Thickness.** The cured hoop thickness on the cylinder is

$$
t_h = \frac{n_p\,t_b}{1-o},
$$

where $t_b$ is the band thickness (Section 6.1), unless `thickness_override` is set. The
axisymmetric profile applied to the base surface is

$$
t(z) = t_h\;\operatorname{clip}\!\left(\tfrac12 + \frac{e(z)}{B},\ 0,\ 1\right)\cdot \mathbb 1\big[\,|n_r| > 0.9\,\big],\qquad e(z) = \min(z - z_s,\ z_e - z),
$$

where $e(z)$ is the distance inside the nearer layer end.

- **Edge ramp.** $t$ ramps linearly from 0 at $B/2$ outside the band edge to full thickness at
  $B/2$ inside it. This is a smoothed representation of a band edge; the physical edge is a step
  at $z_s$ or $z_e$.
- **Cylinder mask.** The factor $\mathbb 1[|n_r| > 0.9]$ restricts hoop material to where the
  surface normal is within about $25.8^\circ$ of radial, i.e. the cylinder and the build-up around
  it. Hoops never extend onto the domes.

**Example.** For `type3-30mpa-11l`, T700S-12K, $B = 6$ mm, $V_f = 0.6$: $t_b = 0.1235$ mm, and
two passes give $t_h = 0.247$ mm per hoop layer.

---

## 5. Pattern closure

**Where in the code:** `core/patterns.py: candidates, dwell_for, pattern_number, evaluate, Pattern`; `design.py: build`

### 5.1 Number of bands $n$ and shift $k$

On the cylinder a helical band of width $B$ at angle $\alpha$ covers a circumferential width of
$B/\cos\alpha$. Full coverage of the circumference $2\pi R$ needs at least

$$
n_{min} = \left\lceil \frac{2\pi R\cos\alpha}{B} \right\rceil
$$

circuits. Each circuit lays two bands: the A→B band at $+\alpha$ and the B→A band at $-\alpha$.
The **coverage** of $n$ circuits is

$$
c = \frac{n B}{2\pi R\cos\alpha} \ \ (\ge 1).
$$

A coverage above 1 is overlap between neighbouring bands. In the code, $R$ is the mid-plane radius
of the layer's base surface and $\alpha$ is $\alpha_{mid}$.

Divide the circumference into $n$ **band slots**. If every circuit advances the mandrel by

$$
\Delta\phi_{circuit} \equiv \frac{2\pi k}{n} \pmod{2\pi},\qquad 0 < k < n,
$$

where $k$ is the **shift**, then circuit $i$ starts in slot $ik \bmod n$. All $n$ slots are
visited exactly once before the pattern repeats if and only if

$$
\gcd(k, n) = 1 .
$$

**Dwell to close.** The natural advance of a circuit, $2\Delta\phi_{pass}$, is generally not such a
value. The difference is made up by a dwell $d$ at each of the two turnarounds (`dwell_for`):

$$
d = \tfrac12\Big[\big(2\pi k/n - 2\Delta\phi_{pass}\big) \bmod 2\pi\Big] \in [0, \pi).
$$

A candidate is accepted only if $d \le d_{max}$ (`dwell_max`, default $90^\circ$).

**Worked example.** `type3-30mpa-11l`, layer `hel1`: $R = 100.49$, $\alpha = 13.23^\circ$,
$B = 6$.

- $2\pi R\cos\alpha / B = 102.44$, so $n_{min} = 103$.
- The pass advance is $205.47^\circ$, so the natural circuit advance is
  $410.94^\circ \equiv 50.94^\circ$.
- The chosen pattern $n = 103$, $k = 17$ needs $360\cdot 17/103 = 59.42^\circ$. The dwell is
  therefore $(59.42 - 50.94)/2 = 4.24^\circ$ per turnaround, and the coverage is $1.0054$.

### 5.2 Pattern number, leading and lagging

The **pattern number** $p$ is the smallest number of circuits after which a band lands directly
next to the first one:

$$
p\,k \equiv \pm 1 \pmod n .
$$

- **Leading** ($+1$): the new band lands one slot ahead of the first band.
- **Lagging** ($-1$): it lands one slot behind.

`pattern_number` searches $i = 1, \dots, n$ for the first $i$ with $ik \bmod n \in \{1, n-1\}$.
Following the module's interpretation, $p$ sets the number of crossover zones ("diamonds") of the
finished layer around the circumference:

- $p = 1$ or $2$ gives large diamonds;
- $p \ge 8$ gives a fine pattern.

In the example above, $6 \cdot 17 = 102 \equiv -1 \pmod{103}$: $p = 6$, lagging.

### 5.3 Candidate enumeration and scoring

`candidates(...)` enumerates:

- every $n$ from $n_{min}$ to $\lfloor n_{min}(1 + o_{max})\rfloor$, where $o_{max}$ is the maximum
  overlap (default 0.15);
- every $k$ with $\gcd(k, n) = 1$ and $d \le d_{max}$;
- optionally only leading or only lagging patterns (`pattern_direction`).

Each candidate gets a score, **lower is better**:

$$
\text{score} = \frac{d}{d_{max}} + 4\,(c - 1) + \begin{cases}
3\,|p - p^\ast|/p^\ast & \text{if a target } p^\ast \text{ is set},\\
0.03\,|p - 5| & \text{otherwise (mild preference for moderate } p).
\end{cases}
$$

The score penalises three things:

- long dwells, which cost time and put fibre on the dwell circle, where it needs high slippage
  (Section 3.9);
- excess overlap;
- deviation from the requested pattern style.

The 12 best candidates are returned. For `hel1` above, the first three are:

| $n$ | $k$ | $p$ | Direction | Dwell | Coverage | Score |
|---|---|---|---|---|---|---|
| 103 | 17 | 6 | lagging | $4.24^\circ$ | 1.0054 | 0.099 |
| 104 | 15 | 7 | leading | $0.49^\circ$ | 1.0152 | 0.126 |
| 104 | 21 | 5 | leading | $10.88^\circ$ | 1.0152 | 0.182 |

### 5.4 Pattern style option and fallbacks

Two layer options control the pattern style:

- `Layer.pattern_number` sets the target $p^\ast$ (1 to 60, null = no preference);
- `Layer.pattern_direction` is `any`, `leading` or `lagging`.

**Widening to reach a style.** If no candidate within the default overlap limit has exactly
$p = p^\ast$, the search is repeated with overlap up to 0.35. More values of $n$ then become
available to reach the requested style. If the best candidate still does not match $p^\ast$,
`build` adds the warning "Pattern number … not reachable within the dwell/overlap limits".

**Explicit pattern.** `Layer.pattern = {n_bands, shift}` bypasses the search. `evaluate` rejects
patterns with $\gcd(k,n) \ne 1$ or $k \notin (0, n)$. `build` warns if the coverage is below
0.999 (gaps) or the dwell exceeds `dwell_max`.

**No candidate.** If the search finds nothing, a last search allows any dwell ($d_{max} = \pi$) and
overlap up to 0.3. The layer carries the warning "No pattern within the dwell limit". If even that
fails, the build fails.

**Continuous winding** keeps the planned pattern of each helical layer. Before starting a layer, it
adds a **phase dwell** smaller than one slot $2\pi/n$: any rotation by a multiple of $2\pi/n$ lays
the same set of bands (`continuous.py`, `finish`).

---

## 6. Thickness

### 6.1 Band thickness

**Where in the code:** `core/materials.py: band_thickness, Fiber.area`

Fibre area is conserved. A band of $N_t$ tows (`tows`) of linear density $\mathrm{tex}$ (g/km) and
fibre density $\rho_f$ (g/cm³), spread to width $B$ at fibre volume fraction $V_f$, has a cured
thickness of

$$
t_b = \frac{N_t\,A_{tow}}{B\,V_f},\qquad A_{tow} = \frac{\mathrm{tex}}{1000\,\rho_f}\ \ [\text{mm}^2].
$$

**Example.** T700S-12K: $\mathrm{tex} = 800$ and $\rho_f = 1.80$ give $A_{tow} = 0.444$ mm². With
$B = 6$ mm and $V_f = 0.60$, $t_b = 0.1235$ mm.

A layer can override the fibre (`Layer.fiber`); $t_b$ then uses that fibre's tex and density.

On the cylinder, a helical layer with coverage $c$ has thickness

$$
t_{cyl} = 2\,t_b\,c ,
$$

since each circuit lays a $+\alpha$ and a $-\alpha$ band. `thickness_override` replaces this
value. Example: `hel1` of the 30 MPa example has $t_{cyl} = 2 \cdot 0.1235 \cdot 1.0054 = 0.2483$ mm.

### 6.2 Band-averaged dome thickness from fibre conservation

**Where in the code:** `paths.py: HelicalPass.thickness, _G, _leg_integral`; `paths.py: _geodesic` (analytic table)

**Fibre conservation.** Every fibre of the layer crosses each parallel circle once per pass. The
fibre cross-section crossing a parallel circle is therefore the same at every radius. The
thickness $t$ measured normal to the surface, times the circumference, times $\cos\alpha$ (the
fibres cross the circle obliquely) is constant:

$$
2\pi r\,t(r)\cos\alpha(r) = \text{const}
\quad\Rightarrow\quad t(r) = \frac{C}{r\cos\alpha(r)},\qquad C = t_{cyl}\,R_{mid}\cos\alpha_{mid},
$$

where $C$ is set by the cylinder thickness.

This point thickness is **infinite at the turnaround** ($\cos\alpha \to 0$). The singularity is
integrable. A band of width $B$ centred on the turnaround spreads the fibres over a finite region,
and the code models this by averaging $t(r)$ over a **radial window of one band width**:

$$
\bar t(r) = \frac{1}{B}\int_{r-B/2}^{r+B/2} \frac{C}{\tilde r\cos\alpha(\tilde r)}\,d\tilde r
= \frac{C}{B}\Big[G\!\left(r + \tfrac B2\right) - G\!\left(r - \tfrac B2\right)\Big],
$$

$$
G(r) = \int_{r_t}^{r} \frac{d\tilde r}{\tilde r\cos\alpha(\tilde r)},\qquad G(r) = 0 \text{ for } r \le r_t ,
$$

where $r_t$ is the turnaround radius. **Build-up** here means the thickness growth near the
turnaround.

**Geodesic tables.** With $\cos\alpha = \sqrt{r^2 - r_0^2}/r$, $G$ has a closed form:

$$
G(r) = \operatorname{arccosh}(r/r_0).
$$

The code tabulates it from $r_0$ to $r_{max} + 80$ mm.

**Non-geodesic tables** (`_leg_integral`). The integral is taken along the computed leg. Using
$dr = r'\,ds = r'\cos\alpha\,dl$:

$$
dG = \frac{dr}{r\cos\alpha} = \frac{r'\,dl}{r},
$$

which is regular at the turnaround. This is the same reason the path ODE uses $l$. The steps are:

1. Accumulate $dG$ from the turnaround, where $G = 0$.
2. Sort the table by $r$, drop duplicate radii and make $G$ monotone (running maximum).
3. Beyond the leg's largest radius, continue with the geodesic formula, using the leg's Clairaut
   constant at the mid-plane, $c = r\sin\alpha$ there.

`_G` evaluates the table:

- 0 below $r_t$;
- linear interpolation inside the table;
- linear extrapolation above it.

**Where each table applies.** `HelicalPass.thickness(base, t_cyl, R_mid, B)` uses:

- the side-A table for all base-surface points with $z < 0$, including half the cylinder;
- the side-B table for points with $z \ge 0$.

On the cylinder, $\bar t = t_{cyl}$ to 0.1 % (`test_helical_thickness_on_cylinder_and_growth_on_dome`).

**Worked build-up** (geodesic `hel1` of the 30 MPa example): $C = 0.2483\cdot 100.49\cdot\cos 13.23^\circ = 24.29$ mm², $r_0 = 23$ mm, $B = 6$ mm.

| $r$ (mm) | Point value $C/(r\cos\alpha)$ | Band-averaged $\bar t$ |
|---|---|---|
| 23 (turnaround) | $\infty$ | 2.05 |
| 26 ($r_0 + B/2$) | 2.00 | **2.86** (peak) |
| 29 | 1.38 | 1.43 |
| 35 | 0.92 | 0.93 |
| 60 | 0.44 | 0.44 |
| 100.5 (cylinder) | 0.248 | 0.248 |

The layer's discrete maximum is 2.854 mm, about $11.5\times$ the cylinder thickness. The build-up
peak sits half a band width outside the turnaround radius, and the averaged thickness falls to the
point value about two band widths out.

> **Simplifications.**
> - The averaging window is taken in **radius**, not in meridian arclength. The two agree where the
>   dome is nearly flat (radial), which is the case near a polar opening on isotensoid and
>   elliptical domes. They differ on steep regions, but there $\bar t$ is close to the point value
>   anyway.
> - Each side of the vessel uses its own leg table. For non-geodesic layers the two domes
>   therefore get different build-ups.
> - The thickness is applied along the normal of the base surface. Resin flow, compaction and
>   thickness-dependent band spreading are not modelled.
> - The analytic model is axisymmetric: it gives the circumferential mean. Pattern-scale
>   variations come from the thickness map (Section 6.5).

### 6.3 Hoop thickness with edge ramps

This is the profile of Section 4:

$$
t(z) = t_h\,\operatorname{clip}(\tfrac12 + e/B, 0, 1)\cdot\mathbb 1[|n_r| > 0.9],\qquad t_h = n_p t_b/(1 - o).
$$

The ramp represents the band edge at a drop-off, smeared over one band width. The factor
$1/(1-o)$ accounts for overlapping revolutions. The extra fibre in the reversal dwells (half a
revolution per reversal) is **not** included in the axisymmetric hoop thickness. It appears only in
the band-level map.

### 6.4 Mass and volume of the laminate

For completeness: the laminate volume of a layer is the shell volume on its base surface,

$$
V = \int 2\pi\left(r + \tfrac t2\right) t\,ds
$$

(`Profile.shell_volume`). `design.py: mass` splits it into fibre and resin with $V_f$.
`layer_result` reports the fibre mass separately from the path length and tex.

### 6.5 Band-level thickness map (splat simulation)

**Where in the code:** `core/thickness_map.py: layer_map, band_shape, cumulative_map, map_result, ThicknessMap.stats`

The axisymmetric model cannot show pattern gaps, overlaps, crossover ridges, hoop pitch ridges, or
how the polar build-up is really distributed around the circumference. `layer_map` resolves these
by **laying every band of every circuit onto a grid**.

**Grid.** Cells in

- liner meridian arclength $s_L$ (step `ds` = 1 mm by default), shared by all layers so that maps
  can be summed;
- azimuth $\phi$ (`n_phi` = 720 cells by default).

**Centre-line.** The full layer path comes from `kinematics.layer_path`, including dwell arcs, the
pattern and `start_angle`. It is sampled at 0.45 of the cell size. The meridian arclength on the
base surface is mapped to liner arclength through the shared point index of the profiles
(Section 1.4).

**Lateral strips.** The band is split across its width into $m = \max(\lceil B/\ell\rceil, 4)$
strips, where the lateral resolution $\ell$ is at most 0.5 mm and at most 0.45 of a cell. The strip
centres are $x_j \in (-1, 1)$ and the lateral offset is $d_j = x_j B/2$. The offset direction is
perpendicular to the fibre in the surface:

$$
\Delta s = -\,d\,\sin\alpha \cdot \sigma\cdot \frac{ds_L}{ds_{base}},\qquad
\Delta\phi = \frac{d\cos\alpha}{r},
$$

where

- $\sigma = \pm1$ is the direction of travel along the meridian, so that A→B and B→A passes place
  their width on consistent sides;
- $ds_L/ds_{base}$ converts base-surface arclength to liner arclength, clipped to $[0.2, 5]$.

**Deposited volume.** Strip $j$ at a centre-line point with segment length $dl$ deposits

$$
\Delta V = t_b\,\frac{B}{m}\,dl\; w(x_j),
$$

where $w$ is the **band cross-section**, normalised to a mean of 1 over $[-1, 1]$:

| `band_shape` | $w(x)$ |
|---|---|
| `rectangular` (default) | $1$ |
| `lenticular` (parabolic) | $\tfrac32\,(1 - x^2)$ |
| `elliptical` | $\tfrac{4}{\pi}\sqrt{1 - x^2}$ |

All three shapes deposit the same volume. The lenticular and elliptical shapes concentrate it at
the band centre.

**Splatting.** The volumes are distributed to the four nearest cell centres with bilinear weights.
This anti-aliases band edges; the $\phi$ direction wraps around. Thickness is volume divided by
cell area on the base surface:

$$
t_{cell} = \frac{\sum \Delta V}{\max\!\big(\tfrac{ds_{base}}{ds_L}, 0.3\big)\,\Delta s_L\,\max(r_{base},\ 0.5\,r_L)\,\Delta\phi}.
$$

The two floors, on the arclength ratio and on the radius, prevent infinite thickness where
`clean_offset` collapsed the build-up surface (Section 2.4).

**Statistics** (`ThicknessMap.stats`), over the cylinder cells with $|z| < L/2 - 5$ mm:

- the mean;
- the coefficient of variation `cyl_cv`;
- the **gap fraction**, cells below $0.5\,t_{nominal}$;
- the **overlap fraction**, cells above $1.5\,t_{nominal}$.

The peak is taken over the whole map. `cumulative_map` sums the per-layer maps (each one cached) up
to a given layer.

`map_result` issues warnings when:

- the gap fraction exceeds 0.5 %;
- the overlap fraction exceeds 5 %;
- the map's peak exceeds $1.25\times$ the axisymmetric peak, which indicates crossover or
  turnaround ridges.

**Worked numbers** (`grbl-10mpa-1l`, first hoop and first helical layer):

| Layer, shape | Nominal | Cylinder mean | CV | Gap fraction | Peak (map) | Peak (axisymmetric) |
|---|---|---|---|---|---|---|
| hoop1, rectangular | 0.296 | 0.296 | 1.1 % | 0 | 0.49 | 0.30 |
| hoop1, lenticular | 0.296 | 0.297 | 27 % | 5.5 % | 0.48 | 0.30 |
| hel1, rectangular | 0.298 | 0.298 | 1.1 % | 0 | 3.01 | 2.53 |
| hel1, lenticular | 0.298 | 0.298 | 30 % | 6.2 % | 3.43 | 2.53 |

These numbers show three things:

- Rectangular bands tile the cylinder almost uniformly.
- Lenticular bands conserve the mean but create ridges and thin seams.
- The discrete turnaround build-up peaks about 20 to 35 % above the band-averaged estimate. The
  hoop peak comes from the reversal dwells.

> **Simplifications.**
> - Bands are laid on the axisymmetric base surface, and the map is not fed back into the geometry.
> - The band is not compacted or reshaped by the bands underneath.
> - Fibres in a band do not slide towards each other at the turnaround.
> - The lateral direction uses the local $\alpha$ of the centre-line.
> - The dwell arcs deposit material across the meridian, as a circumferential band would.

### 6.6 Bridging check

**Where in the code:** `design.py: normal_curvature, checks` (`layup.bridging`); used by `_best_stagger`

Where the base surface is **concave along the fibre** ($k_n < 0$), a tensioned fibre does not
follow the surface. It spans a chord and leaves a gap. The typical place is the flank just outside
an earlier layer's build-up ridge.

`normal_curvature(bl)` evaluates, along the layer's pass on its base surface (surface table of
Section 3.5):

$$
k_n = k_m\cos^2\alpha + \frac{z'}{r}\sin^2\alpha.
$$

It then finds each **run** of consecutive points with $k_n < -10^{-5}$ mm⁻¹. For a circular arc of
curvature $|k_n|$ spanned by a chord of length $L$, the sagitta (maximum gap between arc and chord)
is

$$
g \approx \frac{|k_n|\,L^2}{8}.
$$

The code evaluates $g$ with the run's **largest** $|k_n|$ (conservative) and its length along the
fibre. It returns three values:

- the minimum $k_n$;
- the total concave path length;
- the largest gap.

Layers with $g > 0.05$ mm (`BRIDGE_GAP`) get a **warning** "Fibre bridging". It suggests adjusting
the turnaround offsets so that turnarounds do not land just inside earlier build-up ridges, or
tapering the hoop drop-offs.

`suggest_layup` tries three turnaround-offset staggers of the helical layers, called cyclic,
ascending and zigzag (`_stagger_patterns`). It keeps the one with the smallest bridging gap among
those whose checks all pass (`_best_stagger`).

**Example.** In `type4-35mpa-h2`, layer `hel13` turns at $r_0 = 27$ mm on top of twelve earlier
helical layers. It has $\min k_n = -0.22$ mm⁻¹ and a predicted gap of 0.99 mm, so it gets a
warning. The first helical layer of the same vessel has none.

> **Limits of the check.**
> - It is evaluated only for helical layers, on one A→B pass. Hoop layers always return
>   $1/R$, 0, 0.
> - It is a check only: the fibre path, the thickness and the machine kinematics are computed as if
>   the fibre followed the surface. `docs/VALIDATION.md` lists bridging under "Not validated (yet)".

---

## 7. Validation pointers

The rows of `docs/VALIDATION.md` relevant to this chapter follow. Each is an automated test in
`backend/tests/`.

**Geometry and fibre paths** (`test_geometry_winding.py`, `test_nongeodesic.py`):

| Quantity | Reference | Agreement |
|---|---|---|
| Hemisphere + cylinder volume | closed form | 0.2 % |
| Isotensoid dome height | classical $0.55$–$0.65\,R$ | in range |
| Geodesic advance per pass (hemispherical domes) | $\pi + L\tan\alpha/R$ | $10^{-5}$ relative |
| Clairaut invariant $r\sin\alpha$ along the path | $r_0$ | 2 % (numerical derivative) |
| Non-geodesic path with $\lambda = 0$ | geodesic solution | $10^{-4}$ |
| Slippage $k_g/k_n$ measured on the 3D path by finite differences | prescribed $\lambda$ | 1 % |
| Turnaround radius hit by the shooting solver | requested radius | 0.1 mm |
| Pattern closure | every slot visited once, advance $= 2\pi k/n$ | exact |

**Thickness** (`test_geometry_winding.py`, `test_thickness_map.py`):

| Quantity | Reference | Agreement |
|---|---|---|
| Helical thickness on the cylinder | nominal $2t_b\times$ coverage | 0.1 % |
| Isotensoid netting fibre stress along the dome (single layer) | uniform | 15 % incl. turnaround zone |
| Band simulation: single band footprint | $B/\cos\alpha$ | 2 % |
| Band simulation: rectangular bands on the cylinder | uniform nominal | CV < 3 % |
| Band simulation: dome mean | axisymmetric band-averaged model | 1 % median |
| Band simulation: volume, rectangular vs lenticular | equal | 0.1 % |

**Continuous winding** (`test_continuous.py`), relevant to Sections 3.4 and 5.4:

| Quantity | Reference | Agreement |
|---|---|---|
| Cylinder angle ramp | $d\alpha/dl = \lambda\sin^2\alpha/R$ | 0.2 % |
| Helical layer pattern after a phase dwell | azimuth shift = multiple of $2\pi/n$ | $10^{-6}$ |

**Documented limitations:**

- **Bridging** is detected but not modelled (see Section 6.6). The machine eye is placed for a
  fibre that follows the surface.
- **Staggered hoop drop-offs** lowered the progressive burst of the 30 MPa example from 73.9 to
  53.8 MPa. The layup sizer therefore uses full-length hoops (Section 4).
- **Hemispherical domes** with a thin helical build-up fail in the dome first: first fibre failure
  at 61 MPa in dome A for the 70 MPa example. This is consistent with a hemisphere not being a
  netting-optimal dome for geodesic winding.

---

## 8. Summary of simplifications and assumptions

| Topic | What the code does | Consequence |
|---|---|---|
| Isotensoid shape | Geodesic netting dome for $r_0 = r_{boss}$, one helical family, no hoops or liner on the dome | Real layers turn at $r_{boss} + B/2 + \delta$, and non-geodesic layers deviate from isotensoid loading |
| Liner neck | Smoothstep thickening towards the boss, inward | Winding surface unchanged; boss hardware not in the meridian |
| Layer surfaces | Normal offset of the base surface plus star-shaped loop removal, index-preserving | Axisymmetric band-averaged build-up only |
| Surface curvature | Savitzky-Golay derivatives over about 4 mm | Curvature jumps smeared |
| Non-geodesic paths | Geodesic on the cylinder, constant $\lambda$ on each dome, found by shooting | No optimised $\lambda(s)$ profile |
| Turnaround | Symmetric: return pass mirrors the outgoing pass; dwell on the parallel circle | Dwell slippage reported, not checked |
| Unequal openings | Geodesic: $r_0 = \max(r_A, r_B)$; non-geodesic: balanced angle | Informational check for geodesic |
| Slippage | $\lvert\lambda\rvert \le \mu$ with one scalar $\mu$ per layer | No dependence on speed, viscosity or tension |
| Dome thickness | $t = C/(r\cos\alpha)$ averaged over a radial window $B$ | Window in $r$, not $s$; circumferential mean only |
| Hoop thickness | $n_p t_b/(1-o)$ with a linear edge ramp; cylinder only ($\lvert n_r\rvert > 0.9$) | Reversal-dwell material only in the band map |
| Band map | Volume splatting of $\pm B/2$ strips with a chosen cross-section | Not fed back into the geometry; no compaction or spreading |
| Bridging | Sagitta estimate $\lvert k_n\rvert L^2/8$ on concave runs | Warning only; path and kinematics assume contact |

---

## 9. References

These are standard sources for the classical results used in this chapter. They are cited for the
theory, not for WindLab's specific implementation.

1. **Clairaut's relation, geodesic and normal curvature, Liouville's formula, Euler's theorem.**
   M. P. do Carmo, *Differential Geometry of Curves and Surfaces*, Prentice-Hall, 1976 (Chapter 4,
   geodesics on surfaces of revolution). See also D. J. Struik, *Lectures on Classical Differential
   Geometry*, 2nd ed., Addison-Wesley, 1961 (Dover reprint).
2. **Membrane theory of shells of revolution** (the meridional and Laplace equilibrium equations of
   Section 2.1). S. Timoshenko and S. Woinowsky-Krieger, *Theory of Plates and Shells*, 2nd ed.,
   McGraw-Hill, 1959 (chapter on the membrane theory of shells in the form of a surface of
   revolution).
3. **Netting analysis and geodesic-isotensoid domes of filament-wound pressure vessels.**
   V. V. Vasiliev, *Composite Pressure Vessels: Analysis, Design, and Manufacturing*, Bull Ridge
   Publishing, 2009. The classical netting-dome derivations go back to the early US filament-winding
   programmes of the 1960s, which these texts summarise.
4. **Filament winding practice** (geodesic and non-geodesic paths, patterns, band thickness,
   polar build-up). S. T. Peters (ed.), *Composite Filament Winding*, ASM International, 2011.
5. **Non-geodesic winding, the slippage coefficient $\lambda = k_g/k_n$ and friction, winding
   pattern theory.** S. Koussios, *Filament Winding: a Unified Approach*, PhD thesis, Delft
   University of Technology, 2004 (DUP Science). Non-geodesic winding with a friction-limited
   slippage coefficient appears widely in the filament-winding literature of the 1980s and 1990s;
   the thesis gives a unified treatment of paths on surfaces of revolution, stability (slippage)
   conditions and pattern closure (the gcd condition, the pattern number, leading and lagging
   patterns).
6. **Runge-Kutta integration.** E. Hairer, S. P. Nørsett and G. Wanner, *Solving Ordinary
   Differential Equations I: Nonstiff Problems*, 2nd ed., Springer, 1993.
7. **Smoothing and differentiation of sampled data.** A. Savitzky and M. J. E. Golay, "Smoothing
   and differentiation of data by simplified least squares procedures", *Analytical Chemistry*
   36(8), 1964.
8. **Offset curves and their self-intersections** (swallow-tails). This is standard material in
   computational geometry and CAD texts on offset curves. WindLab's loop removal is its own
   star-shaped envelope method (Section 2.4), not a published algorithm.
