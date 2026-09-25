# 2. Structural analysis

This chapter describes the structural theory implemented in the WindLab backend
(`backend/windlab/`) for composite overwrapped pressure vessels: Type III (metal liner, load-sharing,
autofrettaged) and Type IV (polymer liner, non-load-sharing). It covers what the code actually computes,
the assumptions behind it and the limits of each model. It does not cover geometry, fibre paths, patterns,
cure kinetics or stress-rupture reliability except where the structural checks use their results.

Conventions used throughout:

* Units: lengths in mm, forces in N, stresses, moduli and pressures in MPa (N/mm²), temperatures in °C
  (temperature differences in K), volumes in mL or L as stated.
* Cylinder axes: $x$ axial (meridional), $\theta$ hoop. In the shell models, $s$ is the meridional arc
  length, $\theta$ the hoop direction and $z$ the through-thickness coordinate measured outward from the
  reference surface (the liner outer surface).
* Ply material axes: 1 along the fibre, 2 transverse in-plane. Winding angle $\alpha$ is measured from
  the vessel axis, so a hoop layer has $\alpha \approx 90°$ and a low-angle helical $\alpha \approx 10$-$30°$.
* A "layer" is one entry of `project.layers`. A helical layer is a balanced $\pm\alpha$ pair; a hoop layer
  is treated the same way with $\alpha$ close to $90°$.
* Worked numbers come from the shipped example projects (`windlab.presets.examples()`), computed with the
  current code. They show orders of magnitude. They are not design allowables.

## Table of contents

1. [Materials and micromechanics](#1-materials-and-micromechanics)
2. [Netting analysis](#2-netting-analysis)
3. [Cylinder model (Type III / Type IV)](#3-cylinder-model-type-iii--type-iv)
4. [Axisymmetric laminated shell FE](#4-axisymmetric-laminated-shell-fe)
5. [Progressive failure analysis](#5-progressive-failure-analysis)
6. [Winding tension](#6-winding-tension)
7. [Type IV liner checks](#7-type-iv-liner-checks)
8. [Design checks](#8-design-checks)
9. [Validation and known limitations](#9-validation-and-known-limitations)
10. [References](#10-references)

---

## 1. Materials and micromechanics

**Where in the code:** `core/materials.py`: dataclasses `Fiber`, `Resin`, `LinerMaterial`, `Ply`;
functions `ply_properties`, `_halpin_tsai`, `band_thickness`, `LinerMaterial.hardening`, `Ply.Q`;
lookups `get_fiber`, `get_resin`, `get_liner` (these also resolve the custom materials in
`project.materials`). Ply construction per layer: `core/design.py build`.

### 1.1 Material database

The built-in values are typical datasheet or literature numbers for preliminary design. The module
docstring says to replace them with qualified, lot-specific allowables before building flight or
certified hardware.

**Fibres** (`FIBERS`). Each fibre has an axial modulus $E_f$, an impregnated-strand tensile strength
$X_f$, an elongation, a density $\rho_f$ [g/cm³] and a linear density (tex, g/km). Carbon fibre
transverse and shear properties are rarely published, so every carbon fibre uses the same literature
values: $E_{f2} = 15\,000$ MPa, $G_{f12} = 27\,000$ MPa, $\nu_{f12} = 0.20$. The fibre CTEs are
$\alpha_{f1} = -0.4\times10^{-6}$ /K and $\alpha_{f2} = 7.0\times10^{-6}$ /K. E-glass is isotropic:
$E_{f2}=E_f=72$ GPa, $G_{f12}=30$ GPa, $\nu=0.22$ and $\alpha=5\times10^{-6}$ /K.

| id | $E_f$ [MPa] | $X_f$ [MPa] | $\rho_f$ | tex |
|---|---|---|---|---|
| T700S-12K / -24K | 230 000 | 4 900 | 1.80 | 800 / 1650 |
| T800S-24K | 294 000 | 5 880 | 1.80 | 1030 |
| T1000G-12K | 294 000 | 6 370 | 1.80 | 485 |
| IM7-12K | 276 000 | 5 516 | 1.78 | 446 |
| AS4-12K | 231 000 | 4 433 | 1.79 | 858 |
| E-glass-2400 | 72 000 | 2 400 | 2.58 | 2400 |

**Resins** (`RESINS`). Each resin has a modulus $E_m$, a Poisson ratio $\nu_m$, a density, a CTE
$\alpha_m$ (55-65 × 10⁻⁶ /K) and a nominal cure temperature. It also carries three **UD ply strengths**
that depend mainly on the matrix and are used by the Puck criterion: $Y_t = 55$ MPa (transverse
tension), $Y_c = 200$ MPa (transverse compression) and $S_{12} = 75$ MPa (in-plane shear). These are the
same generic carbon/epoxy values for all four resins. The cure-kinetics parameters stored on `Resin`
belong to the cure chapter.

**Liners** (`LINERS`), with $E$, $\nu$, yield stress $\sigma_y$, ultimate $\sigma_u$, elongation $A$,
Basquin coefficient $\sigma_f'$ and exponent $b$, CTE $\alpha_l$ and fracture toughness $K_{Ic}$:

| id | kind | $E$ [MPa] | $\sigma_y$ | $\sigma_u$ | $A$ | $\sigma_f'$ | $b$ | $\alpha_l$ [1/K] | $K_{Ic}$ [MPa√m] |
|---|---|---|---|---|---|---|---|---|---|
| AA6061-T6 | metal | 68 900 | 276 | 310 | 0.12 | 386 | −0.071 | 23.6e-6 | 29 |
| AA6061-T62 | metal | 68 900 | 262 | 296 | 0.10 | 380 | −0.071 | 23.6e-6 | 29 |
| AA7075-T73 | metal | 71 700 | 434 | 503 | 0.10 | 900 | −0.10 | 23.4e-6 | 32 |
| Ti-6Al-4V | metal | 113 800 | 880 | 950 | 0.14 | 1500 | −0.085 | 8.6e-6 | 75 |
| SS316L | metal | 193 000 | 290 | 580 | 0.40 | 1000 | −0.114 | 16.0e-6 | 200 |
| HDPE | polymer | 1 000 | 24 | 30 | 0.5 | 60 | −0.1 | 150e-6 | 2 |
| PA6 | polymer | 2 000 | 55 | 70 | 0.3 | 120 | −0.1 | 90e-6 | 3 |

The polymer-only fields are listed in [§1.7](#17-type-iv-polymer-liner-data).

### 1.2 Band and layer thickness

The cured thickness of one band pass follows from conservation of fibre cross-section:

$$
t_\text{band} = \frac{n_\text{tow}\,A_\text{tow}}{B\,V_f},\qquad A_\text{tow} = \frac{\text{tex}}{1000\,\rho_f}\ [\text{mm}^2]
$$

Here $n_\text{tow}$ is the number of tows in the band, $B$ the band width [mm], $V_f$ the fibre volume
fraction and $\rho_f$ in g/cm³. In the cylinder, a helical layer has thickness
$t = 2\,t_\text{band}\,c$, where $c$ is the pattern coverage (two plies per $\pm\alpha$ pair). A hoop
layer has $t = n_\text{pass}\,t_\text{band}/(1-o)$, where $o$ is the overlap fraction. Either value can
be replaced with `thickness_override`. The thickness along the domes comes from the path module and is
used by the shell models of §4 and §5.

### 1.3 Ply stiffness from micromechanics

`ply_properties(fiber, resin, Vf, efficiency)` builds a unidirectional ply from the constituents, with
$V_m = 1 - V_f$. It uses the following formulas:

* Longitudinal modulus, rule of mixtures (Voigt):

$$
E_1 = V_f E_f + V_m E_m
$$

* Transverse modulus, Halpin-Tsai with the fibre *transverse* modulus and $\xi = 2$:

$$
E_2 = E_m\,\frac{1 + \xi\,\eta\,V_f}{1 - \eta\,V_f},\qquad \eta = \frac{E_{f2}/E_m - 1}{E_{f2}/E_m + \xi},\qquad \xi = 2
$$

* In-plane shear modulus, Halpin-Tsai with $\xi = 1$ and $G_m = E_m / (2(1+\nu_m))$:

$$
G_{12} = G_m\,\frac{1 + \eta\,V_f}{1 - \eta\,V_f},\qquad \eta = \frac{G_{f12}/G_m - 1}{G_{f12}/G_m + 1}
$$

* Major Poisson ratio, rule of mixtures: $\nu_{12} = V_f\,\nu_{f12} + V_m\,\nu_m$, with
  $\nu_{21} = \nu_{12} E_2 / E_1$.
* Density, rule of mixtures: $\rho = V_f \rho_f + V_m \rho_m$.

Halpin-Tsai with $\xi = 2$ for $E_2$ is the usual choice for circular fibres in a square-ish array.
$\xi = 1$ for $G_{12}$ is the standard Halpin-Tsai value.

The plane-stress reduced stiffnesses (`Ply.Q`) are

$$
Q_{11} = \frac{E_1}{1-\nu_{12}\nu_{21}},\quad Q_{12} = \frac{\nu_{12}E_2}{1-\nu_{12}\nu_{21}},\quad
Q_{22} = \frac{E_2}{1-\nu_{12}\nu_{21}},\quad Q_{66} = G_{12}
$$

Every layer gets its own `Ply`, because a layer may override the project fibre (`Layer.fiber`). All
layers share the project resin, $V_f$ and translation efficiency.

### 1.4 Translation efficiency and delivered failure strain

The strand strength never fully translates into the vessel. It is lowered by fibre damage during
winding, misalignment, uneven tow tension, and more. WindLab applies a single translation efficiency
$\eta_t$ (`composite.translation_efficiency`, default 0.82) and defines fibre failure **as a strain**:

$$
\varepsilon_{1u} = \frac{\eta_t\,X_f}{E_f},\qquad X_{f,\text{del}} = \eta_t\,X_f
$$

Here $\varepsilon_{1u}$ is the delivered fibre-direction failure strain (`Ply.eps1_ult`) and
$X_{f,\text{del}}$ the delivered fibre stress at failure (`Ply.fiber_strength`). The datasheet elongation
field is not used. All fibre-failure checks compare the **mechanical** fibre-direction strain (total
strain minus thermal strain) with $\varepsilon_{1u}$. For a linear-elastic fibre, the "stress ratio"
reported by WindLab is the same as fibre stress / delivered fibre strength. Section 9 describes how
$\eta_t$ is calibrated from burst tests (`core/calibration.py`, `/api/calibrate`).

### 1.5 Thermal expansion coefficients (Schapery)

The ply CTEs use Schapery's energy-bound expressions:

$$
\alpha_1 = \frac{E_f\,\alpha_{f1}\,V_f + E_m\,\alpha_m\,V_m}{E_f V_f + E_m V_m}
$$

$$
\alpha_2 = (1+\nu_{f12})\,\alpha_{f2}\,V_f + (1+\nu_m)\,\alpha_m\,V_m - \alpha_1\,\nu_{12}
$$

$\nu_{12}$ is the rule-of-mixtures ply Poisson ratio from §1.3. Schapery's original $\alpha_2$ formula is
written for isotropic fibres. The code uses the *transverse* fibre CTE $\alpha_{f2}$, which is the common
extension to transversely isotropic carbon fibres. $\alpha_1$ uses the axial fibre CTE $\alpha_{f1}$ and
the axial fibre modulus.

### 1.6 Worked example: T700S / DGEBA epoxy, $V_f = 0.60$, $\eta_t = 0.82$

This is the default composite of three of the example projects:

| Quantity | Value |
|---|---|
| $E_1$ | $0.6 \cdot 230\,000 + 0.4\cdot 3100 = 139\,240$ MPa |
| $E_2$ (Halpin-Tsai, $\eta = 0.561$) | 7 823 MPa |
| $G_{12}$ ($G_m = 1148$ MPa, $\eta = 0.918$) | 3 967 MPa |
| $\nu_{12}$ | 0.26 |
| $Q_{11}, Q_{12}, Q_{22}, Q_{66}$ | 139 771, 2 042, 7 853, 3 967 MPa |
| $\alpha_1$, $\alpha_2$ | 0.14 × 10⁻⁶ /K, 37.4 × 10⁻⁶ /K |
| $\varepsilon_{1u}$ | $0.82 \cdot 4900 / 230\,000 = 0.01747$ |
| $X_{f,\text{del}}$ | 4 018 MPa |
| ply density | 1.56 g/cm³ |

### 1.7 Type IV polymer liner data

A `LinerMaterial` with `kind = "polymer"` switches the design to the Type IV branch (no autofrettage,
§3.14; polymer checks, §7). Polymer liners carry extra data:

| Field | HDPE | PA6 | Meaning |
|---|---|---|---|
| `max_temp` | 85 °C | 120 °C | highest service and processing temperature |
| `strain_limit` | 0.030 | 0.025 | allowable liner strain at proof |
| `h2_permeability` | 1.3 Barrer | 0.15 Barrer | H₂ permeability at 20 °C |
| `perm_activation` | 35 kJ/mol | 40 kJ/mol | Arrhenius activation energy of the permeability |
| `cte` | 150e-6 /K | 90e-6 /K | CTE |

These are indicative literature values (see `docs/VALIDATION.md`). Use measured data for the actual liner
grade. The Basquin and $K_{Ic}$ numbers of the polymers exist only to fill the fields. No fatigue or
leak-before-burst check is run for polymer liners.

### 1.8 Liner hardening modulus

The liner is modelled with linear isotropic hardening (§3.3). The hardening modulus is fitted as a secant
between the yield point and the ultimate point at the elongation limit:

$$
H = \max\!\left(\frac{\sigma_u - \sigma_y}{\max(A - \sigma_y/E,\ 10^{-3})},\ 1\right)
$$

Example: AA6061-T6 gives $H = 34 / 0.116 = 293$ MPa and HDPE gives $H = 12.6$ MPa. This is a crude fit.
It is adequate for the small plastic strains of autofrettage (a few 0.1 %). It does not capture the
initial knee of the real curve.

---

## 2. Netting analysis

Netting analysis assumes that only the fibres carry load: the matrix has no stiffness, and the fibres
carry uniaxial stress along their own direction. WindLab uses it in three places: for the initial layup in
`suggest_layup`, for reporting (`netting_hoop_thickness`, `netting_helical_thickness`), and for the dome
versus cylinder helical stress comparison.

### 2.1 Cylinder netting thickness

**Where in the code:** `core/design.py netting_thickness`.

For a closed cylinder with inner liner radius $R_i$ at pressure $p$, the liner is credited with its
yield stress in both directions. The helical plies must then carry the remaining axial resultant, and the
hoop plies the remaining hoop resultant:

$$
t_\text{hel} = \max\!\left(0,\ \frac{p R_i/2 - t_l\,\sigma_y/2}{X\,\cos^2\alpha}\right)
$$

$$
t_\text{hoop} = \max\!\left(0,\ \frac{p R_i - t_l\,\sigma_y}{X} - t_\text{hel}\,\sin^2\alpha\right)
$$

Symbols:

* $p$: sizing pressure. Here it is the required burst, $p_\text{req} = \text{MEOP}\times$ `burst_factor`.
* $R_i = R - t_l$: liner inner radius, where $R$ is the liner outer radius and $t_l$ the wall thickness.
* $\sigma_y$: liner yield stress. The $t_l\sigma_y/2$ credit in the axial direction is a simplification;
  it is not a von Mises-consistent split.
* $X = E_1\,\varepsilon_{1u}$: ply stress at fibre failure. It is slightly higher than
  $V_f X_{f,\text{del}}$ because $E_1$ includes the resin.
* $\alpha$: mean cylinder angle of the existing helical layers. If there are none, it is estimated from
  the Clairaut relation at the boss, $\sin\alpha = \min((r_\text{boss}+3)/R,\ 0.9)$.

The axial resultant uses $R_i$ throughout. The radius of each ply is ignored here, unlike in the cylinder
model of §3.

*Example* (`type3-30mpa-11l`: $R = 100$, $t_l = 2.5$, AA6061-T6, $p_\text{req} = 45$ MPa,
$X = 2432$ MPa): $t_\text{hel} = 0.86$ mm, $t_\text{hoop} = 1.42$ mm.

`suggest_layup` turns these thicknesses into layer counts with extra factors. Helicals get 1.15 ×.
Both groups get $\max(1, 1/(SR_\text{lim}\cdot k_b))$ so that the MEOP stress-ratio limit is also met.
The counts are then refined with the full analysis (§8).

### 2.2 Dome netting stress

**Where in the code:** `core/design.py dome_netting_stress`, `_cyl_value`, `_dome_max`.

On a shell of revolution with radius $r(s)$, meridional equilibrium of the cap cut at $r$ gives the
meridional stress resultant

$$
N_s = \frac{p\,r}{2\,\left|\mathrm{d}z/\mathrm{d}s\right|}
$$

In netting theory this resultant is carried by the helical fibres, $N_s = \sum_k \sigma_{f,k}\,t_k\cos^2\alpha_k$.
WindLab assumes the same fibre stress $\sigma_f$ in all helical layers at a station:

$$
\sigma_f(s) = \frac{p\,r}{2\,\left|\mathrm{d}z/\mathrm{d}s\right|\ \sum_{k\in\text{hel}} t_k(s)\cos^2\alpha_k(s)}
$$

Symbols: $r$ and $\mathrm{d}z/\mathrm{d}s$ are taken on the liner outer profile, $p$ is MEOP,
$t_k(s)$ is the local layer thickness and $\alpha_k(s)$ the local path angle (`gp.alpha_at_s`). The
expression is evaluated only where it makes sense:

* the helical build-up exists: $\sum t_k\cos^2\alpha_k > 10^{-6}$;
* $r$ is outside the turnaround zones, $r > \max_k(r_{a,k}, r_{b,k}) + 2B_k$, because there the boss and
  the liner carry the load;
* $\left|\mathrm{d}z/\mathrm{d}s\right| > 0.05$, which excludes the equator region, where the membrane
  expression is singular for a flat end.

The check `dome.netting` compares the peak dome value ($|z| > L_\text{cyl}/2 + 1$ mm) with the value at
$z=0$. A ratio above 1 means the dome is the critical helical zone.

---

## 3. Cylinder model (Type III / Type IV)

**Where in the code:** `core/structural.py` (`Liner`, `PlyGroup`, `Vessel`, `run_history`,
`first_yield_pressure`, `reverse_yield_ratio`, `burst`, `liner_fatigue_cycles`) and `core/design.py`
(`_vessel`, `structural`, `autofrettage_window`, `_load_point`).

The cylinder model is the workhorse. It runs on every `/api/analyze` call and inside all sizing loops. It
is a nonlinear membrane model of the mid-cylinder section: an elastic-plastic liner, a linear-elastic
overwrap with Puck matrix-cracking degradation, thermal strains, and the full pressure history.

### 3.1 Kinematics and equilibrium

`_vessel` sets up the section as follows:

* Liner of thickness $t_l$ at its mid radius $R_l = R - t_l/2$. The inner radius $R_i = R - t_l$ is
  where the pressure acts.
* One `PlyGroup` per layer, with angle $\alpha_k$ (cylinder angle), thickness $t_k$ and mid radius
  $R_k$ (base surface radius plus $t_k/2$). The group name ("hoop" or "helical") is the layer type.

**Strain compatibility.** All layers share one axial strain $\varepsilon_x$ and one hoop strain
$\varepsilon_\theta$ (thin-wall assumption; no through-thickness strain gradient, no $1/r$ variation).
Balanced $\pm\alpha$ pairs carry no net in-plane shear, so the state is $\boldsymbol\varepsilon =
(\varepsilon_x, \varepsilon_\theta)^T$.

**Equilibrium** of a closed-end cylinder with internal pressure $p$ acting on $R_i$ is exact:

$$
\sum_j t_j\,\sigma_{\theta,j} = p\,R_i \qquad\text{(hoop)}
$$

$$
\sum_j t_j\,\frac{R_j}{R_i}\,\sigma_{x,j} = \frac{p\,R_i}{2} \qquad\text{(axial: } \textstyle\sum 2\pi R_j t_j\sigma_{x,j} = \pi R_i^2 p\text{)}
$$

The sums run over the liner and all ply groups. The radius weight $w_j = R_j/R_i$ appears only in the
axial equation.

### 3.2 Composite stiffness per ply group (CLT) and thermal forces

For a group at angle $\alpha$ ($c = \cos\alpha$, $s = \sin\alpha$), `PlyGroup.qbar` gives the transformed
reduced stiffness in $(x, \theta)$. It keeps only the terms that survive for a balanced pair
($\bar Q_{16} = \bar Q_{26} = 0$):

$$
\bar Q_{11} = Q_{11}c^4 + 2(Q_{12}+2Q_{66})s^2c^2 + Q_{22}s^4
$$

$$
\bar Q_{12} = (Q_{11}+Q_{22}-4Q_{66})s^2c^2 + Q_{12}(s^4+c^4)
$$

$$
\bar Q_{22} = Q_{11}s^4 + 2(Q_{12}+2Q_{66})s^2c^2 + Q_{22}c^4
$$

If the group has matrix cracking (§3.5), $Q_{22}$ and $Q_{66}$ are first multiplied by
$d = 0.10$ and $Q_{12}$ by $\sqrt d$. $Q_{11}$ is unchanged.

The laminate-direction CTEs of the pair are
$\alpha_x = \alpha_1c^2 + \alpha_2 s^2$ and $\alpha_\theta = \alpha_1 s^2 + \alpha_2 c^2$. The group
stress is $\boldsymbol\sigma_k = \bar{\mathbf Q}_k(\boldsymbol\varepsilon - \boldsymbol\alpha_k\Delta T)$.
Here $\Delta T = T - T_\text{sf}$ is the temperature relative to the stress-free (cure) temperature
$T_\text{sf}$ = `composite.cure_temperature`.

`Vessel._assemble` builds the composite stiffness $\mathbf K$ and the thermal force per kelvin
$\mathbf K_\alpha$, applying the axial radius weights to the first row:

$$
\mathbf K = \sum_k t_k \begin{bmatrix} w_k \bar Q_{11} & w_k \bar Q_{12} \\ \bar Q_{12} & \bar Q_{22}\end{bmatrix}_k,
\qquad
\mathbf K_\alpha = \sum_k t_k \begin{bmatrix} w_k\,(\bar{\mathbf Q}\boldsymbol\alpha)_x \\ (\bar{\mathbf Q}\boldsymbol\alpha)_\theta\end{bmatrix}_k,
\qquad w_k = R_k/R_i
$$

The equilibrium residual solved in §3.4 is then

$$
\mathbf F(\boldsymbol\varepsilon) = \mathbf K\boldsymbol\varepsilon
+ t_l\begin{bmatrix} w_l\,\sigma_{x,l} \\ \sigma_{\theta,l}\end{bmatrix}
- \begin{bmatrix} pR_i/2 \\ pR_i\end{bmatrix} - \mathbf K_\alpha\,\Delta T = \mathbf 0
$$

with $w_l = R_l/R_i$ and the liner stress $\boldsymbol\sigma_l$ from §3.3.

*Example* (`grbl-10mpa-1l`: $R_i = 48.5$ mm, 3 hoop and 2 helical layers of about 0.3 mm, uncracked):
$\mathbf K \approx [[84\,132,\ 8\,717],[8\,296,\ 129\,524]]$ N/mm and
$\mathbf K_\alpha \approx (0.73,\ 0.29)$ N/(mm K).

### 3.3 Liner: J2 plane-stress plasticity with linear hardening

**Where in the code:** `structural.Liner.stress`, `Liner.yield_stress`, `LinerState`.

The liner is in plane stress $\boldsymbol\sigma = (\sigma_x, \sigma_\theta)$, with no shear. It has
isotropic elasticity

$$
\mathbf C = \frac{E}{1-\nu^2}\begin{bmatrix}1 & \nu\\ \nu & 1\end{bmatrix}
$$

and a von Mises yield function with linear isotropic hardening:

$$
f = \sigma_\text{vm} - (\sigma_y + H\,\bar\varepsilon_p) \le 0,\qquad
\sigma_\text{vm} = \sqrt{\sigma_x^2 - \sigma_x\sigma_\theta + \sigma_\theta^2}
$$

The liner is loaded by its mechanical strain $\boldsymbol\varepsilon_\text{mech} = \boldsymbol\varepsilon
- \alpha_l\Delta T\,(1,1)^T$. The state variables are the plastic strain $\boldsymbol\varepsilon_p$ and
the equivalent plastic strain $\bar\varepsilon_p$ (`LinerState.eps_p`, `alpha`).

**Return mapping** (Simo and Taylor, plane stress). The elastic trial stress is
$\boldsymbol\sigma^\text{tr} = \mathbf C(\boldsymbol\varepsilon_\text{mech} - \boldsymbol\varepsilon_p^n)$.
If $f(\boldsymbol\sigma^\text{tr}) \le 0$ the step is elastic. Otherwise the closest-point projection with
the plane-stress projection matrix

$$
\mathbf P = \frac13\begin{bmatrix}2 & -1\\ -1 & 2\end{bmatrix},\qquad \boldsymbol\sigma^T\mathbf P\boldsymbol\sigma = \tfrac23\sigma_\text{vm}^2
$$

gives the updated stress for a given plastic multiplier $\Delta\gamma$, by solving a 2 × 2 system in
closed form:

$$
\left(\mathbf C^{-1} + \Delta\gamma\,\mathbf P\right)\boldsymbol\sigma(\Delta\gamma) = \boldsymbol\varepsilon_\text{mech} - \boldsymbol\varepsilon_p^n
$$

$\Delta\gamma$ is the root of the scalar consistency condition

$$
g(\Delta\gamma) = \sigma_\text{vm}(\Delta\gamma) - \left[\sigma_y + H\,\bar\varepsilon_p^n + H\,\Delta\gamma\,\tfrac23\sigma_\text{vm}(\Delta\gamma)\right] = 0
$$

The root is found by bracketing (the upper bound grows ×4 from $10^{-6}$) followed by Brent's method.
The state is then updated:

$$
\boldsymbol\varepsilon_p^{n+1} = \boldsymbol\varepsilon_p^n + \Delta\gamma\,\mathbf P\boldsymbol\sigma,\qquad
\bar\varepsilon_p^{n+1} = \bar\varepsilon_p^n + \Delta\gamma\,\tfrac23\sigma_\text{vm}
$$

The hardening is **isotropic**, so a Bauschinger effect is not represented. Reverse yielding on unloading
from autofrettage therefore starts at the (hardened) yield stress in compression, which is
unconservative. The reverse-yield check compensates with a 0.9 knock-down (§3.8).

### 3.4 Newton solution

**Where in the code:** `Vessel.solve`.

For a given $p$, $\Delta T$ and the liner state at the start of the increment, $\mathbf F(\boldsymbol
\varepsilon) = \mathbf 0$ from §3.2 is solved with Newton's method. The Jacobian is the analytic
composite stiffness $\mathbf K$ plus a forward finite-difference derivative of the liner force (step
$10^{-9}$), and each iteration re-runs the return mapping from the increment's start state. The iteration
converges when $\max|F_i| < 10^{-9}\max(1, |pR_i|)$ or after 60 iterations. Path dependence is handled
by always solving from the last converged liner state; the pressure ramps use 8-16 increments per phase.

### 3.5 Inter-fibre failure (Puck) with stiffness degradation

**Where in the code:** `core/failure.py` (`puck_iff`, `ply_material_state`, constants
`P_PERP_PAR_T`, `P_PERP_PAR_C`, `IFF_RESIDUAL`, `FF_RESIDUAL`, `COMPRESSIVE_STRAIN_RATIO`);
`structural.Vessel.update_cracking`, `solve_damaged`, `reset_damage`.

**Ply stresses.** `ply_material_state` transforms the laminate strains to the material axes of the
$+\alpha$ ply. The $-\alpha$ ply gives the same $\sigma_2$ and $|\tau_{12}|$. Using mechanical strains:

$$
\varepsilon_1 = \varepsilon_x c^2 + \varepsilon_\theta s^2 - \alpha_1\Delta T,\quad
\varepsilon_2 = \varepsilon_x s^2 + \varepsilon_\theta c^2 - \alpha_2\Delta T,\quad
\gamma_{12} = 2(\varepsilon_\theta - \varepsilon_x)\,sc
$$

$$
\sigma_2 = Q_{12}\varepsilon_1 + Q_{22}\varepsilon_2,\qquad |\tau_{21}| = |Q_{66}\gamma_{12}|
$$

The undamaged $Q_{ij}$ are used here. A ply is checked only until it cracks.

**Puck's plane-stress action-plane criterion** (VDI 2014 part 3). The strength symbols are
$R_\perp^{(+)} = Y_t$, $R_\perp^{(-)} = Y_c$ and $R_{\perp\parallel} = S_{12}$. The inclination
parameters are the values recommended for CFRP: $p_{\perp\parallel}^{(+)} = 0.30$ and
$p_{\perp\parallel}^{(-)} = 0.25$. The derived quantities are

$$
R_{\perp\perp}^A = \frac{S_{12}}{2p_{\perp\parallel}^{(-)}}\left(\sqrt{1 + 2p_{\perp\parallel}^{(-)}\frac{Y_c}{S_{12}}} - 1\right),\qquad
p_{\perp\perp}^{(-)} = p_{\perp\parallel}^{(-)}\frac{R_{\perp\perp}^A}{S_{12}},\qquad
\tau_{21c} = S_{12}\sqrt{1 + 2p_{\perp\perp}^{(-)}}
$$

With the default strengths (55 / 200 / 75 MPa) these are $R_{\perp\perp}^A = 79.1$ MPa,
$p_{\perp\perp}^{(-)} = 0.264$ and $\tau_{21c} = 92.7$ MPa. The stress exposure $f_E$ (failure at
$f_E \ge 1$) is:

* **Mode A**, $\sigma_2 \ge 0$ (transverse tension cracks):

$$
f_E = \sqrt{\left(\frac{\tau_{21}}{S_{12}}\right)^2 + \left(1 - p_{\perp\parallel}^{(+)}\frac{Y_t}{S_{12}}\right)^2\left(\frac{\sigma_2}{Y_t}\right)^2} + p_{\perp\parallel}^{(+)}\frac{\sigma_2}{S_{12}}
$$

* **Mode B**, $\sigma_2 < 0$ and $|\sigma_2|/|\tau_{21}| \le R_{\perp\perp}^A/\tau_{21c}$ (shear cracks
  under moderate compression, fracture plane at 0°):

$$
f_E = \frac{1}{S_{12}}\left(\sqrt{\tau_{21}^2 + (p_{\perp\parallel}^{(-)}\sigma_2)^2} + p_{\perp\parallel}^{(-)}\sigma_2\right)
$$

* **Mode C**, otherwise (high transverse compression, inclined fracture plane, the wedge effect that can
  cause delamination):

$$
f_E = \left[\left(\frac{\tau_{21}}{2(1+p_{\perp\perp}^{(-)})S_{12}}\right)^2 + \left(\frac{\sigma_2}{Y_c}\right)^2\right]\frac{Y_c}{-\sigma_2}
$$

The criterion reproduces $Y_t$, $S_{12}$ and $Y_c$ exactly under the respective pure loads, and this is
covered by a unit test.

**Degradation.** When a group reaches $f_E \ge 1$ it is flagged `cracked` and its transverse and shear
stiffness drop to Puck's recommended residual level:

$$
Q_{22} \to 0.1\,Q_{22},\qquad Q_{66} \to 0.1\,Q_{66},\qquad Q_{12} \to \sqrt{0.1}\,Q_{12},\qquad Q_{11}\ \text{unchanged}
$$

Scaling $Q_{12}$ by $\sqrt d$ keeps $Q_{12}^2 \le Q_{11}Q_{22}$, so the degraded stiffness stays positive
definite. The degradation is a single step (no gradual softening). It applies to the whole ply group in
the cylinder section and is irreversible within a load history.

**`solve_damaged`.** At each load level the model:

1. solves equilibrium (§3.4) from the liner state of the previous converged increment;
2. evaluates Puck for every uncracked group; if any group reaches $f_E \ge 1$, degrades it and
   reassembles $\mathbf K$, $\mathbf K_\alpha$;
3. re-solves at the **same** $p$ from the **same** previous liner state, so plasticity is not counted
   twice, until no new cracks appear (at most $n_\text{groups}+1$ passes).

`Vessel.damage = False` switches cracking off (a linear-elastic composite). The CalculiX comparison uses
this, because the CalculiX deck is linear-elastic (§9). Fibre failure is **not** a degradation event in
the cylinder model: it ends the analysis (§3.10).

*Example* (desktop vessel): no cracking after cure. The helical groups crack between 15 and 20 MPa during
the first pressurisation, and the hoop groups (transverse direction almost axial) crack later. By burst,
every group is cracked.

### 3.6 Cure cool-down residual stresses

**Where in the code:** `Vessel.cool`, `Vessel.initial`; called from `design.structural`.

The liner/composite bond is assumed stress-free at $T_\text{sf}$ = `composite.cure_temperature`
(default 120 °C; 80 °C for the Type IV example). This is a project input: the resin's nominal cure
temperature is not used here. The vessel is cooled at zero pressure from $\Delta T = 0$ to
$\Delta T_\text{ref} = T_\text{ref} - T_\text{sf}$ ($T_\text{ref}$ = `requirements.temperature_ref`,
default 20 °C) in 6 increments of `solve_damaged`. Liner plasticity and matrix cracking are possible
during cool-down. The final state becomes the initial state of the pressure history, with its crack
flags, and the vessel temperature is set to $\Delta T_\text{ref}$.

With an aluminium liner ($\alpha_l \approx 23.6\times10^{-6}$ /K) and a carbon overwrap
($\alpha_x, \alpha_\theta$ a few $10^{-6}$ /K), the liner ends up in **biaxial tension** and the
fibres in compression. Examples:

| Example | $\Delta T$ | liner $\sigma_x / \sigma_\theta$ [MPa] | fibre stress hoop / helical [MPa] |
|---|---|---|---|
| `grbl-10mpa-1l` | −100 K | +64 / +98 | −282 / −421 |
| `type3-30mpa-11l` | −100 K | +84 / +141 | −160 / −364 |
| `type4-35mpa-h2` (HDPE) | −60 K | +14 / +15 | −63 / −144 |

Winding-tension prestress is **not** added to this state; the tension model of §6 is separate.

### 3.7 Pressure history

**Where in the code:** `structural.run_history`, `Vessel.ramp`.

Starting from the post-cure state (crack flags reset to the post-cure pattern), the history is:

| Phase | Target | Increments (default `steps = 16`) |
|---|---|---|
| autofrettage | $p_\text{af}$ | 16 |
| unload | 0 | 8 |
| proof | $p_\text{proof} = \text{MEOP}\times$ `proof_factor` | 8 |
| unload | 0 | 8 |
| meop | MEOP | 8 |
| unload | 0 | 8 |

Each increment calls `solve_damaged`, so cracks that form during autofrettage stay in later phases.
`_load_point` reports for every point: liner $\sigma_x$, $\sigma_\theta$, $\sigma_\text{vm}$, the
largest hoop and helical **fibre** stress $E_f\,\varepsilon_{1,\text{mech}}$, and $\varepsilon_x$,
$\varepsilon_\theta$. The reported states are:

* `residual`: end of the autofrettage unload;
* `at_proof`: last proof point;
* `at_meop`: last MEOP point;
* `cure_residual`: last cool-down point.

### 3.8 Autofrettage window and the reverse-yield limit

**Where in the code:** `design.autofrettage_window`, `structural.first_yield_pressure`,
`structural.reverse_yield_ratio`; constants `REVERSE_YIELD_LIMIT = 0.9` and `AF_FIBER_RATIO_LIMIT = 0.75`.

Autofrettage deliberately yields the metal liner once. On unloading, the elastic overwrap pushes the
liner into compression. Every later cycle up to MEOP then starts from a compressive mean stress and stays
elastic, which improves liner fatigue life.

**Lower bound.** The liner must yield, and autofrettage must not be below proof:

$$
p_\text{lo} = \max\left(p_\text{proof},\ 1.05\,p_\text{y}\right)
$$

$p_\text{y}$ is the first-yield pressure from the post-cure state. Up to first yield the response is
affine in $p$, so `first_yield_pressure` solves once at $p = 1$ to get the stress increment
$\Delta\boldsymbol\sigma$ per MPa. It then bisects on $\lambda$ for
$\sigma_\text{vm}(\boldsymbol\sigma_0 + \lambda\Delta\boldsymbol\sigma) = \sigma_y$. The result is 0 if
the liner has already yielded during cool-down. Matrix cracking is not updated in this step.

**Upper bound from reverse yielding.** `reverse_yield_ratio(p_af)` ramps from the post-cure state to
$p_\text{af}$ in 12 increments (with damage), unloads to $p = 0$ in a single solve, and returns

$$
r_\text{rev} = \frac{\sigma_\text{vm}(\text{residual at } p=0)}{\sigma_y}
$$

The denominator is the *initial* yield stress, not the hardened one. The limit is
$r_\text{rev} \le 0.9$: the 0.9 knock-down stands in for the Bauschinger effect, which lowers the
compressive yield stress after tensile pre-strain and is not in the isotropic-hardening model. $p_\text{hi}$
is the largest pressure that meets this limit, found by 22 bisection steps on
$[0,\ 1.2\max(p_{b,\text{est}}, p_\text{lo})]$, assuming $r_\text{rev}$ increases monotonically with
$p_\text{af}$.

**Upper bound from the fibres.** $p_\text{hi} \leftarrow \min(p_\text{hi},\ 0.75\,p_{b,\text{est}})$.
$p_{b,\text{est}}$ comes from `burst` ramped directly from the post-cure state, without autofrettage.
Despite the "elastic-only" comment in the code, this estimate includes liner plasticity and matrix
cracking.

**Selection.** When `requirements.autofrettage_pressure` is null, the pressure is set automatically:

$$
p_\text{af} = \begin{cases} p_\text{lo} + 0.75\,(p_\text{hi} - p_\text{lo}) & p_\text{hi} > p_\text{lo}\\ p_\text{lo} & \text{otherwise (window closed, check } \texttt{af.window}\text{ fails)}\end{cases}
$$

The choice sits high in the window: it maximises the compressive pre-stress while keeping margin to
reverse yield. A user-given $p_\text{af}$ is used as is, and the checks `af.reverse` and `af.fiber` then
report on it.

*Example* (`grbl-10mpa-1l`, MEOP 10 MPa, proof 15 MPa): $p_\text{y} = 13.4$ MPa, so
$p_\text{lo} = \max(15,\ 14.0) = 15$ MPa. $p_{b,\text{est}} = 55.8$ MPa gives a fibre cap of 41.9 MPa,
but reverse yield binds first: $p_\text{hi} = 35.5$ MPa. The selected
$p_\text{af} = 15 + 0.75\cdot 20.5 = 30.4$ MPa leaves a residual liner stress of
$(\sigma_x, \sigma_\theta) = (-78, -202)$ MPa, $\sigma_\text{vm} = 176$ MPa, so $r_\text{rev} = 0.64$.

### 3.9 Proof, MEOP and stress ratios

The **stress ratio** of a ply group at a state is the mechanical fibre strain over the delivered
failure strain (`Vessel.fiber_ratio`). For each group type ("hoop", "helical") the maximum over its
layers is taken:

$$
SR_g = \max_{k \in g}\frac{\varepsilon_{x}c_k^2 + \varepsilon_\theta s_k^2 - \alpha_{1}\Delta T}{\varepsilon_{1u,k}}
$$

`stress_ratio_hoop` and `stress_ratio_helical` are evaluated at the MEOP point of the history, at
$T_\text{ref}$, and are compared with `stress_ratio_limit` (default 0.6). Because of the thermal term,
the cure residual strain is included. A stress-rupture reliability model based on these ratios is
documented separately (`core/rupture.py`) and feeds the `sr.reliability` check.

Two further checks come from the history: the liner at MEOP must be elastic
($\sigma_\text{vm}/(\sigma_y + H\bar\varepsilon_p) \le 1$), and proof must add no plastic strain, which is
the case when $p_\text{proof} < p_\text{af}$.

### 3.10 Operating temperature extremes

For $T \in \{T_\text{min}, T_\text{max}\}$ (defaults −40 °C and +65 °C), `design.structural` starts
from the final state of the history, with its plastic state and cracks, and solves:

* at MEOP with $\Delta T = T - T_\text{sf}$: gives `meop_cold` and `meop_hot`, and the stress ratios at
  temperature;
* at $p=0$ with the same $\Delta T$: the unpressurised cold vessel is where the aluminium liner is most
  compressed, so reverse yielding would appear here.

These are single `solve` calls with no new matrix cracking. The results are:

* `stress_ratio_worst`: the maximum stress ratio over $T_\text{ref}$, $T_\text{min}$ and $T_\text{max}$;
* `liner_temp_ratio`: the maximum $\sigma_\text{vm}/\sigma_{y,\text{hardened}}$ over the four states;
* `liner_temp_plastic`: any increase of $\bar\varepsilon_p$. It must stay at 0 for the check `liner.temp`.

A hot vessel raises the fibre strains, because the liner expands more than the overwrap. In the 30 MPa
example the helical fibre stress at MEOP rises from 738 MPa (20 °C) to 893 MPa (65 °C).

### 3.11 Burst, burst mode and helical reserve

**Where in the code:** `structural.burst`, `design.structural`, `design._burst_state`.

Burst is defined as **first fibre failure in the cylinder**: the first ply group whose mechanical fibre
strain reaches $\varepsilon_{1u}$. It is found in two steps:

1. Scan the history. If the fibre ratio crosses 1 during a loading segment (for example, an
   autofrettage pressure above capacity), burst is interpolated linearly in $p$ between the two points.
2. Otherwise, ramp from the final unloaded state in steps of $p_{b,\text{est}}/60$ (at least 0.05 MPa)
   with `solve_damaged`, and interpolate linearly on the fibre ratio inside the step where it crosses 1.

The **burst mode** is the group type ("hoop" or "helical") with the highest ratio at failure. A
hoop-first burst in the cylinder is preferred because it is predictable and less sensitive to dome
details. The check `burst.mode` warns when a layup that contains hoops bursts helical-first.

The **helical reserve** `helical_ratio_at_burst` is the helical fibre ratio when the hoops fail (one
`solve` at $p_b$ from the final state). The check `burst.balance` warns above 0.95, because a helical
failure could then follow in the domes.

Compressive fibre failure is not checked in the cylinder model. The liner has no rupture criterion; at
burst its contribution is small.

*Examples:* desktop 55.8 MPa (required 20), hoop-first, helical reserve 0.62. `type3-30mpa-11l`
113.5 MPa (required 45), reserve 0.88. `type4-35mpa-h2` 100.8 MPa (required 78.75), reserve 0.47.

### 3.12 Volumetric expansion (water jacket)

The cylinder strains are applied to the whole internal volume $V$ (liner inner profile, mL). The change
is measured from the post-cure state:

$$
\frac{\Delta V}{V} = 2\,\Delta\varepsilon_\theta + \Delta\varepsilon_x
$$

The reported values are:

| Field | Definition |
|---|---|
| `expansion_af_total` | at peak autofrettage, relative to post-cure |
| `expansion_af_permanent` | after autofrettage unload, relative to post-cure |
| `expansion_proof_total` | at proof relative to the post-autofrettage state (the water-jacket reading of a proof test on the finished vessel) |
| `expansion_proof_permanent` | after proof unload relative to post-autofrettage |

Values below $10^{-6}$ mL are set to 0. The domes are stiffer than the cylinder, so applying the
cylinder strain field everywhere slightly overestimates the total. The code says to confirm water-jacket
targets on first articles. *Example* (desktop, $V = 1211$ mL): autofrettage 28.4 mL total, 11.8 mL
permanent; proof 8.2 mL total, 0 permanent.

### 3.13 Leak-before-burst (metal liner)

**Where in the code:** `design.checks`, check `liner.lbb`.

A through-wall axial crack of total length $2a = 2t_l$ is the standard leak-before-burst assumption: a
surface crack grows through the wall and then leaks. That crack must be stable at MEOP. The stress
intensity is that of a centre crack in an infinite plate:

$$
K_I = \sigma_\theta\,\sqrt{\pi a},\qquad a = t_l\ [\text{m}],\qquad \frac{K_I}{K_{Ic}} \le 1
$$

$\sigma_\theta$ is the largest liner hoop stress at MEOP over $T_\text{ref}$, $T_\text{min}$ and
$T_\text{max}$, taken as at least 0. There is no Folias bulging factor and no finite-width correction.
The restraint that the overwrap gives the crack flanks is ignored, which is conservative. *Example*
(30 MPa, $t_l = 2.5$ mm, cold MEOP hoop stress 180 MPa): $K = 180\sqrt{\pi\cdot0.0025} = 16.0$ MPa√m,
ratio 0.55.

### 3.14 Liner fatigue (Smith-Watson-Topper)

**Where in the code:** `structural.liner_fatigue_cycles`, check `fatigue`.

The service cycle runs between the final unloaded state (after the MEOP cycle) and the MEOP state.
WindLab uses the stress-based SWT parameter with Basquin's law:

$$
\sigma_\text{max}\,\sigma_a = (\sigma_f')^2\,(2N_f)^{2b}
\quad\Rightarrow\quad
N_f = \frac12\left(\frac{\sigma_\text{max}\sigma_a}{(\sigma_f')^2}\right)^{1/(2b)}
$$

Symbols:

* $\sigma_\text{max} = \max(\sigma_{\theta}, \sigma_x)$ at MEOP;
* $\sigma_a = \tfrac12\max(|\Delta\sigma_\theta|, |\Delta\sigma_x|)$ between the two states;
* $\sigma_f'$ and $b$: the Basquin coefficient and exponent of the liner.

$\sigma_\text{max}$ and $\sigma_a$ may come from different components, which is a conservative envelope.
This is the elastic (high-cycle) branch of SWT. The Coffin-Manson plastic-strain term is omitted, which
is consistent with an elastic service cycle after autofrettage. If $\sigma_\text{max} \le 0$ or
$\sigma_a = 0$, the life is set to $10^9$, and every result is capped at $10^9$.

The requirement is $N_f \ge N_\text{design}\times$ `fatigue_scatter_factor` (default 4).

*Example* (`type3-30mpa-11l`): at MEOP $\sigma_x = 117$ MPa and $\sigma_\theta = 91$ MPa; after unload
$\sigma_x = -159$ MPa and $\sigma_\theta = -246$ MPa. This gives $\sigma_\text{max} = 117$ MPa and
$\sigma_a = \tfrac12(91+246) = 168.5$ MPa, so $N_f = \tfrac12(19\,716/386^2)^{-7.04} = 7.6\times10^5$
cycles, against $1000\times4 = 4000$ required.

The Basquin constants in the database are indicative. The check text says "confirm by test". Stress
concentrations at the dome/boss transitions are handled by the FE hot-spot scaling in §4.5.

### 3.15 Type IV: no autofrettage

With a polymer liner (`LinerMaterial.polymer`), `design.structural` skips the window search. It sets
$p_\text{lo} = p_\text{hi} = p_\text{proof}$ and $p_\text{af} = p_\text{proof}$, unless a value is given.
The first load of the history is therefore simply the proof test. The rest of the model is unchanged,
including J2 plasticity of the polymer with its low yield stress. The liner carries very little load
($E = 1$-2 GPa): in the Type IV example the liner hoop stress at MEOP is 24 MPa, against 1716 MPa fibre
stress. The metal-liner checks `af.*`, `liner.meop`, `liner.proof`, `liner.temp`, `liner.lbb`,
`fatigue` and `fe.liner` are replaced by the checks of §7.

### 3.16 Summary of the cylinder-model assumptions

* Membrane state of the mid-cylinder only. No dome, boss or junction bending; §4 and §5 cover these.
* Common strain through the wall. The CalculiX comparison shows the liner inner surface straining about
  15 % more than the composite at autofrettage (§9).
* Linear-elastic fibres; fibre failure = first ply group reaching $\varepsilon_{1u}$; no load
  redistribution after fibre failure.
* Isotropic hardening; Bauschinger effect covered only by the 0.9 knock-down.
* No winding-tension residual stresses; no cure shrinkage beyond the thermal mismatch; no viscoelasticity.
* Matrix cracking is a one-step, per-group stiffness knock-down.

---

## 4. Axisymmetric laminated shell FE

**Where in the code:** `core/shellfe.py`: `_mesh`, `sections`, `_qbar`, `solve`, `FESolution`
(`layer_fiber_strain`, `liner_stress`), `evaluate`, `FEEvaluation`; wrapped by `design.fe_result`.

The shell FE covers the whole meridian: cylinder, domes and boss regions. It is **linear elastic**. Its
job is to find where the vessel is weakest relative to the mid-cylinder and to scale the nonlinear
cylinder results accordingly.

### 4.1 Kinematics (Kirchhoff shell of revolution)

The reference surface is the liner outer surface. The meridian is discretised into two-node conical
frustum elements. Each node has three degrees of freedom: axial displacement $U_z$, radial displacement
$U_r$, and meridional rotation $\beta = \mathrm{d}w/\mathrm{d}s$. Per element, the global DOFs are
rotated into the meridional displacement $u$ and the outward normal displacement $w$ using the element
direction cosines $\cos\phi = \mathrm{d}z/\mathrm{d}s$ and $\sin\phi = \mathrm{d}r/\mathrm{d}s$. The
strains are:

$$
\varepsilon_s = \frac{\mathrm{d}u}{\mathrm{d}s},\qquad
\varepsilon_\theta = \frac{u\sin\phi + w\cos\phi}{r},\qquad
\kappa_s = -\frac{\mathrm{d}^2 w}{\mathrm{d}s^2},\qquad
\kappa_\theta = -\frac{\sin\phi}{r}\frac{\mathrm{d}w}{\mathrm{d}s}
$$

The strain at distance $z$ from the reference surface is $\boldsymbol\varepsilon(z) =
\boldsymbol\varepsilon^0 + z\boldsymbol\kappa$. Transverse shear deformation is neglected (Kirchhoff).
These are the classical conical-frustum shell element kinematics (Grafton and Strome).

### 4.2 Element interpolation and integration

With $\xi \in [0,1]$ along an element of length $L_e$:

* $u$ is **linear**: $N_1 = 1-\xi$, $N_2 = \xi$.
* $w$ is **cubic Hermite** in $(w_1, \beta_1, w_2, \beta_2)$:
  $H_1 = 1-3\xi^2+2\xi^3$, $H_2 = L_e(\xi-2\xi^2+\xi^3)$, $H_3 = 3\xi^2-2\xi^3$, $H_4 = L_e(\xi^3-\xi^2)$.
  This gives $C^1$ continuity of the normal displacement, which the Kirchhoff curvature needs.
* The element stiffness is $\mathbf K_e = \int \mathbf B^T\,\mathbf{ABD}\,\mathbf B\;2\pi r\,\mathrm{d}s$.
  It is integrated with 3-point Gauss-Legendre quadrature, with $r$ interpolated linearly along the
  element.
* **Mesh** (`_mesh`): the nodes follow the liner outer profile. Profile points closer than 0.4 mm are
  dropped, and spans are split so that no element exceeds 4 mm.

Strains are recovered at element mid-points ($\xi = 1/2$).

### 4.3 Laminate section per element

`sections` builds a laminate for every element from its **local** build-up:

* the liner from $z = -t_\text{wall}(s)$ to $0$. The wall thickness is the local distance between the
  inner and outer liner profiles, so the neck thickening at the boss is included;
* every wound layer stacked outward, with thickness $t_k(s)$ interpolated from the layer's thickness
  profile. Its angle is the local path angle $\alpha_k(s)$ for helicals (`gp.alpha_at_s`) and the
  constant hoop angle for hoops. A hoop layer has zero thickness outside its axial extent.

The stiffness about the reference surface comes from classical lamination theory, in
$(\varepsilon_s, \varepsilon_\theta, \kappa_s, \kappa_\theta)$ order:

$$
\begin{bmatrix}\mathbf N\\ \mathbf M\end{bmatrix} = \begin{bmatrix}\mathbf A & \mathbf B\\ \mathbf B & \mathbf D\end{bmatrix}\begin{bmatrix}\boldsymbol\varepsilon^0\\ \boldsymbol\kappa\end{bmatrix},\qquad
(A, B, D)_{ij} = \sum_\text{plies}\bar Q_{ij}\left(z_1 - z_0,\ \tfrac12(z_1^2 - z_0^2),\ \tfrac13(z_1^3 - z_0^3)\right)
$$

The liner is isotropic, with $\bar Q_{11} = \bar Q_{22} = E/(1-\nu^2)$ and $\bar Q_{12} = \nu E/(1-\nu^2)$.
The layers use §3.2 without damage. $\mathbf B \neq 0$, because the laminate is unsymmetric about the
liner outer surface, so membrane-bending coupling is included. Balanced pairs are again assumed
($\bar Q_{16} = \bar Q_{26} = 0$; no torsion).

### 4.4 Loads and boundary conditions

* **Pressure** acts on the liner **inner** surface. For each element, the force on the matching
  inner-profile segment ($p\cdot 2\pi r_\text{in}\,\mathrm{d}s_\text{in}$, along that segment's own
  outward normal) is projected onto the element's $u$ and $w$ directions. It is distributed with the
  consistent shape functions: linear for $u$, Hermite for $w$, which includes the rotation terms.
* **Bosses** are rigid rings. Both end nodes have $U_r = 0$ and $\beta = 0$. End A is also fixed axially
  ($U_z = 0$). End B is free axially and carries the pressure on the polar opening,
  $F_z = p\,\pi r_{i,B}^2$, where $r_{i,B}$ is the liner inner radius at boss B.

The global system is sparse and solved directly (`scipy.sparse.linalg.spsolve`). The FE carries **no
thermal load, no residual stress and no liner plasticity**. It is solved at MEOP from zero.

### 4.5 Evaluation: dome burst and liner hot spot

**Where in the code:** `shellfe.evaluate`; checks `fe.burst` and `fe.liner`.

**Fibre ratio.** For each layer $k$ and element, the fibre strain is evaluated at the layer's mid-depth,
$\varepsilon_1 = \varepsilon_s(z_m)\cos^2\alpha_k + \varepsilon_\theta(z_m)\sin^2\alpha_k$, and divided
by $\varepsilon_{1u,k}$. Elements where the layer is thinner than 0.001 mm are ignored. The peak over
layers gives $\rho(s)$.

* Elements close to the rigid-ring boundary, with $r \le r_\text{boss} + 3t_l$, are excluded because the
  clamp distorts them.
* The **reference** $\rho_\text{ref}$ is the peak ratio in the mid-cylinder,
  $|z| < \max(0.2\,L_\text{cyl}/2,\ 5\text{ mm})$, where the cylinder model applies.

**Dome burst scaling.** The linear FE gives the *distribution* of fibre strain, and the nonlinear
cylinder model gives the *level* at burst:

$$
p_{b,\text{FE}} = p_{b,\text{cyl}}\ \frac{\rho_\text{ref}}{\max_s \rho(s)}
$$

The location and layer of $\max\rho$ are reported as the critical position (`critical_z`,
`critical_layer`). The check `fe.burst` requires $p_{b,\text{FE}} \ge p_\text{req}$. This assumes the
fibre strain scales proportionally from MEOP to burst everywhere. Liner yielding, matrix cracking and
redistribution break that assumption, and the progressive analysis (§5) resolves them.

**Liner hot spot.** The liner von Mises stress is computed at its inner and outer surfaces
($z = -t_\text{wall}$ and $z = 0$) from the elastic strain field. It gives a hot-spot factor

$$
k = \frac{\max_s \sigma_\text{vm}}{\operatorname{median}_\text{mid-cyl}\ \sigma_\text{vm}}
$$

The linear FE at MEOP is taken as the stress *range* of the elastic service cycle. Assume the local
residual stress scales like the elastic range, so that both $\sigma_\text{max}$ and $\sigma_a$ in the
SWT law scale by $k$. Then $(2N)^{2b} \propto k^2$, and

$$
N_\text{hot} = \min\!\left(N_\text{cyl}\ k^{1/b},\ 10^9\right)
$$

$b < 0$ is the Basquin exponent. The check `fe.liner` (metal liners only) requires
$N_\text{hot} \ge N_\text{design}\times$ scatter factor.

*Examples:*

| Example | $p_{b,\text{cyl}}$ | $p_{b,\text{FE}}$ | critical | $k$ | $N_\text{cyl}$ → $N_\text{hot}$ |
|---|---|---|---|---|---|
| `grbl-10mpa-1l` | 55.8 | 53.5 | hoop3, z = 39 mm (cylinder end) | 1.03 | ≥1e9 → 6.4e8 |
| `type3-30mpa-11l` | 113.5 | 85.1 | hel7, z = 210 mm (dome B) | 1.26 at z = −182 mm | 7.6e5 → 2.9e4 |
| `type4-35mpa-h2` | 100.8 | 100.1 | hoop13, z = 124 mm | – | – |

The 30 MPa case shows why the FE check exists: the domes limit the burst to 75 % of the cylinder
prediction, and the liner life at the dome/boss transition is 26 times shorter than in the cylinder.

---

## 5. Progressive failure analysis

**Where in the code:** `core/progressive.py`: `_Model` (`_liner`, `liner_tangent`, `stiffness`,
`internal`, `equilibrate`, `check_failure`, `_ply_Q`), `run`, `_result`, `to_schema`. Exposed as
`/api/progressive`. Also used by `suggest_layup(progressive=True)` through `design._progressive_verify`
and by the report.

The progressive analysis uses the kinematics, mesh, quadrature, pressure loading and boundary conditions
of §4. It replaces the linear laminate with a nonlinear material response integrated through the
thickness at every Gauss point, and it follows the complete load history to burst. It runs in about
10 s to a few minutes; the desktop example takes about 20 s.

### 5.1 Section integration

At each of the 3 Gauss points per element:

* **Liner**: $N_L = 5$ midpoint-rule integration points through the local wall thickness, at
  $z_j = -t_\text{wall}(1 - (j+\tfrac12)/5)$, each with weight $t_\text{wall}/5$. Each point carries its
  own J2 state ($\boldsymbol\varepsilon_p$, $\bar\varepsilon_p$) through the whole history. The
  mechanical strain is $\boldsymbol\varepsilon^0 + z_j\boldsymbol\kappa - \alpha_l\Delta T$. The return
  mapping is the plane-stress closest-point projection of §3.3, vectorised and solved for $\Delta\gamma$
  by bracketing and 60 bisection steps.
* **Plies**: one integration point per layer at its mid-depth $z_k$, with the layer's local thickness
  and angle. The mechanical strain in laminate axes is $\boldsymbol\varepsilon^0 + z_k\boldsymbol\kappa -
  (\alpha_s, \alpha_\theta)\Delta T$. The stress is $\bar{\mathbf Q}_k^{d}\,\boldsymbol\varepsilon_\text{mech}$,
  where $\bar{\mathbf Q}^{d}$ is the damaged stiffness of §5.3.

The stress resultants are $\mathbf N = \sum \boldsymbol\sigma\,w$ and $\mathbf M = \sum \boldsymbol\sigma\,w\,z$,
and the internal force is $\mathbf f_\text{int} = \int \mathbf B^T (\mathbf N, \mathbf M)\,2\pi r\,\mathrm{d}s$.
Ply stresses are sampled only at mid-ply, so the ply's own bending term $\bar Q\,t_k^3/12$ enters the
tangent stiffness but not the internal force. For the thin plies used here the difference is negligible.

### 5.2 Elasto-plastic tangent and Newton iteration

**Continuum tangent** of the liner, per integration point that is plastic in the current iterate:

$$
\mathbf D^{ep} = \mathbf C - \frac{(\mathbf C\mathbf a)(\mathbf C\mathbf a)^T}{\mathbf a^T\mathbf C\mathbf a + H},\qquad
\mathbf a = \frac{\partial\sigma_\text{vm}}{\partial\boldsymbol\sigma} = \frac{1}{2\sigma_\text{vm}}\begin{bmatrix}2\sigma_x - \sigma_\theta\\ 2\sigma_\theta - \sigma_x\end{bmatrix}
$$

This is the continuum tangent, not the algorithmically consistent one, so Newton converges linearly
rather than quadratically near yield. The line search makes up for this. The tangent section stiffness
integrates $\mathbf D^{ep}$ over the liner points and $\bar{\mathbf Q}^{d}_k$ over the plies (including
$t_k^3/12$). It is assembled sparse and factorised with `splu`.

**`equilibrate(p, ΔT)`** solves $\mathbf r = p\,\mathbf F_p - \mathbf f_\text{int}(\mathbf u) = \mathbf 0$.
Here $\mathbf F_p$ is the unit-pressure load vector, including the opening load at boss B.

* Newton update: $\Delta\mathbf u = \mathbf K_T^{-1}\mathbf r$.
* **Backtracking line search**: the step $\lambda \in \{1, \tfrac12, \dots, 2^{-7}\}$ is the first
  that reduces $\lVert\mathbf r\rVert$. If none does, equilibrium fails.
* Convergence: $\lVert\mathbf r\rVert < 10^{-6}\max(\lVert p\mathbf F_p\rVert, \lVert\mathbf f_\text{int}(\mathbf u_0)\rVert, 1)$, within at most 120 iterations.
* Divergence guard: any displacement larger than half the largest radius is treated as runaway
  deformation, and equilibrium fails.

History variables (plastic strains) are committed only after convergence.

### 5.3 Ply failure and residual stiffness

`check_failure` runs at every converged state, for every element, Gauss point and present layer. It
computes the material-axis strains from the mechanical laminate strains, as in §3.5, and the stresses
$\sigma_2$ and $\tau_{12}$ with the undamaged $Q_{ij}$.

* **Inter-fibre failure (IFF):** Puck $f_E \ge 1$ (§3.5, the same function `puck_iff`). The degraded
  stiffness is $Q_{22} \times 0.1$, $Q_{66} \times 0.1$, $Q_{12} \times \sqrt{0.1}$.
* **Fibre failure (FF):** $\varepsilon_1 \ge \varepsilon_{1u}$ in tension or
  $\varepsilon_1 \le -0.6\,\varepsilon_{1u}$ in compression. The ratio 0.6 is
  `COMPRESSIVE_STRAIN_RATIO`, a typical carbon/epoxy value. The ply is then discounted: every $Q_{ij}$
  is multiplied by $10^{-3}$ (`FF_RESIDUAL`).

Damage is stored per (element, Gauss point, layer), is irreversible, and switches on in a single step.

**`settle(p, phase)`** repeats *equilibrate, then check failure* until no new IFF or FF appears, for up
to 40 rounds, so each load level converges to a stable damage state. The first liner yield, first IFF and
first FF are recorded as events, with pressure, phase, layer and position.

### 5.4 Load history

`run` first calls the cylinder model (`design.structural`) for the autofrettage pressure and the
burst-ramp scale. It then applies:

| Stage | Loading | Increments |
|---|---|---|
| cure cool-down | $\Delta T$: $0 \to T_\text{ref} - T_\text{sf}$ at $p=0$ | 4 |
| autofrettage | $0 \to p_\text{af}$ (cylinder model's value, or the argument `p_af`) | 12 |
| unload | $\to 0$ | 4 |
| proof | $\to p_\text{proof}$ | 6 |
| unload | $\to 0$ | 4 |
| MEOP | $\to$ MEOP | 6 |
| unload | $\to 0$ | 4 |
| burst ramp | $0 \to$ failure | adaptive |

For Type IV, $p_\text{af}$ equals proof (§3.15). If equilibrium fails before the burst ramp, the run
stops. The burst pressure is then the failing pressure, with the note "failed during *phase*".

### 5.5 Step refinement and burst definition

The burst ramp starts at $p = 0$ with step $\Delta p = p_{b,\text{cyl}}/40$ (at least 0.05 MPa). Before
each step the complete state is saved: displacements, plastic state, damage, events. A step **fails**
when either:

* `settle` cannot find equilibrium (loss of equilibrium: runaway deformation, or a residual that no line
  search step can reduce); or
* **fibre failure goes through the wall** at any Gauss point, meaning every present layer there has
  failed in fibre mode, so no load path is left.

On failure the state is rolled back and $\Delta p$ is halved, until $\Delta p \le 2\times10^{-3}\,p_{b,\text{cyl}}$.
The burst pressure is then the last converged pressure plus the final step, and the failed state is kept
for output. The ramp is capped at $5\,p_{b,\text{cyl}}$.

### 5.6 Outputs

`ProgressiveResult` / `ProgressiveResultOut` contain:

* `burst_pressure`, `burst_z` and `burst_layer`: the location of the **last** fibre-failure event. The
  schema also classifies it as a zone: cylinder ($|z| < L_\text{cyl}/2 - 20$ mm), junction A/B (within
  ±20 mm of the tangent line) or dome A/B.
* `first_iff_pressure`, `first_ff_pressure` and `liner_yield_pressure`.
* `events`, grouped by (phase, kind, layer) with counts. The kinds are `liner_yield`, `iff` and `ff`.
  The docstring also lists `liner_rupture` and `burst`, but they are not emitted: the liner has no
  rupture criterion in this model.
* `curve_pressure` / `curve_hoop_strain`: pressure against hoop membrane strain of the reference surface
  (liner outer surface) at the element closest to $z = 0$, over the burst ramp.
* `ff_fraction` and `iff_fraction`: for each layer and element, the fraction of Gauss points that have
  failed.
* `liner_peeq`: per element, the maximum equivalent plastic strain.

*Example* (desktop): liner first yields at 15.2 MPa during autofrettage (the cylinder model predicts
13.4 MPa). First IFF at 20.2 MPa (helicals, as in the cylinder model). Burst at **55.0 MPa** in layer
index 3 (hoop3) at $z = 22$ mm, compared with 55.8 MPa from the cylinder model.

Assumptions: small strains (no geometric nonlinearity, so no pressure follower effect and no dome
flattening), balanced angle-ply pairs, rigid-ring bosses, no delamination, no through-thickness stresses,
and single-step (sudden) degradation. The Puck parameters and transverse strengths are generic.

### 5.7 Findings (design rules derived from the progressive model)

`docs/VALIDATION.md` records two findings that the cylinder model cannot resolve:

* **Staggered hoop drop-offs** concentrate bending at the ends of the hoop stack. The 30 MPa example
  bursts at 53.8 MPa with staggered hoops but at 73.9 MPa with full-length hoops, which is close to
  netting (about 72 MPa). `suggest_layup` therefore generates full-length hoops
  (`end_offset_a = end_offset_b = 0`; see the comment in `design.suggest_layup.make`).
* **Hemispherical domes with a thin helical build-up** fail in the dome first. In the 70 MPa example the
  first fibre failure is at 61 MPa in dome A.

`docs/VALIDATION.md` also lists the progressive burst of the desktop example as within −25 % / +5 % of
the cylinder model (55.0 against 55.8 MPa for the current layup). The shell sees the junction bending that the membrane model does not.

---

## 6. Winding tension

**Where in the code:** `core/tension.py`: `_stack`, `analyse`, `schedule`, `TensionResult`;
`design.apply_tension_schedule`; check `tension.loss`; endpoint `/api/tension-schedule`.

### 6.1 Thin-ring prestress model

The model treats the cylinder section as a stack of thin rings built up in winding order. Layer $k$ is
wound with tension $T_k$ [N] on a band of cross-section $B_k\,t_{\text{band},k}$, so its initial
ply-level stress is

$$
\sigma_{w,k} = \frac{T_k}{B_k\,t_{\text{band},k}}
$$

Through the ring (Laplace) relation, its hoop component presses on everything underneath with a pressure

$$
q_k = \frac{\sigma_{w,k}\,t_k\sin^2\alpha_k}{R_k}
$$

Here $t_k$ is the layer thickness and $R_k$ its mid radius.

### 6.2 Loss by later layers

The stack under layer $k$ has hoop membrane stiffness

$$
S_k = \frac{E_l}{1-\nu_l^2}\,t_l + \sum_{j<k} E_{\theta,j}\,t_j,\qquad E_{\theta} = \bar Q_{22}
$$

$E_\theta = \bar Q_{22}$ is the transformed reduced hoop stiffness from §3.2, with no damage. The stack
contracts by

$$
\Delta\varepsilon_{\theta,k} = -\frac{q_k R_k}{S_k}
$$

Each earlier layer $j<k$ loses $E_1\sin^2\alpha_j\,\Delta\varepsilon_{\theta,k}$ of fibre-direction
stress, and the liner gains a hoop stress of $E_l/(1-\nu_l^2)\,\Delta\varepsilon_{\theta,k}$. After all
layers are wound, the residual stress is $\sigma_{r,j} = \sigma_{w,j} + \sum_{k>j}E_1\sin^2\alpha_j\,
\Delta\varepsilon_{\theta,k}$ and the loss fraction is $1 - \sigma_{r,j}/\sigma_{w,j}$. A loss above 1
means the layer has gone slack in the model: it would carry compression, which in reality means
wrinkles and voids.

Low-angle helicals ($\sin^2\alpha$ small) hardly lose tension. Inner hoops on a soft stack lose the most.

The module docstring lists what is neglected: axial coupling, cure shrinkage and thermal effects, resin
squeeze-out and viscoelastic relaxation. The results are a **relative guide**, and the prestress is not
added to the cylinder model's initial state.

### 6.3 Uniform-prestress schedule

`schedule(b, target_tension, max_factor=5)` solves the inverse problem: find tensions for which every
layer keeps the same residual stress $\sigma^*$ after winding. The outermost layer loses nothing, so
$\sigma^* = T_\text{out}/(B t_\text{band})_\text{out}$. The default $T_\text{out}$ is the outermost
layer's current tension. The system is triangular and is solved from the outside in:

$$
\sigma_{w,j} = \min\left(\sigma^* + E_1\sin^2\alpha_j\sum_{k>j}\frac{\sigma_{w,k}\,t_k\sin^2\alpha_k}{S_k},\ 5\,\sigma^*\right),\qquad T_j = \sigma_{w,j}\,B_j t_{\text{band},j}
$$

`apply_tension_schedule` rounds the tensions to 0.5 N. `suggest_layup` always applies it as its last
step.

*Example* (desktop, already scheduled): tensions 23.5 / 18.5 / 15 / 15 / 15 N give winding stresses
31.7 / 25.0 / 20.2 / 20.2 / 20.2 MPa, residual stresses of about 20 MPa in every layer, and a liner hoop
stress of −12.5 MPa.

---

## 7. Type IV liner checks

**Where in the code:** `core/design.py`: `_polymer_checks`, `permeation_rate`, `support_pressure`;
constants `R_GAS`, `BARRER`, `MOLAR_VOLUME` and `SUPPORT_SAFETY = 2.0`.

A polymer liner does not share load in any useful way, so its checks concern compatibility, not
strength.

### 7.1 Liner strain at proof (`liner.strain`)

The liner follows the overwrap. The largest cylinder strain at proof,
$\max(|\varepsilon_\theta|, |\varepsilon_x|)$, must not exceed `strain_limit` (HDPE 3 %, PA6 2.5 %). If
it fails, `suggest_layup` adds a layer in the direction that strains most. *Example:* 0.90 % against 3 %.

### 7.2 Cure and service temperature (`liner.cure`, `liner.service_temp`)

* `liner.cure`: the peak liner temperature during cure must be at or below `max_temp`. The peak comes
  from the cure simulation, including the exotherm, when it has been run. Otherwise
  `composite.cure_temperature` is used. This is why the Type IV example uses the low-temperature resin
  and an 80 °C cure (HDPE limit 85 °C).
* `liner.service_temp`: $T_\text{max} \le$ `max_temp`.

### 7.3 Hydrogen permeation (`liner.permeation`)

Steady-state Fickian permeation through the liner wall, with the solution-diffusion permeability $P$
(permeability = diffusivity × solubility), is

$$
\dot n = \frac{P(T)\,A\,\Delta p}{t_l}
$$

Symbols and units:

* $\dot n$: molar flow [mol/s].
* $P(T)$: permeability [mol·m/(m²·s·Pa)]. The database value in Barrer is converted with
  $1\ \text{Barrer} = 10^{-10}\ \text{cm}^3_\text{STP}\,\text{cm}/(\text{cm}^2\,\text{s}\,\text{cmHg})
  = 3.348\times10^{-16}$ mol·m/(m²·s·Pa).
* Temperature dependence, Arrhenius about 20 °C:

$$
P(T) = P_{20}\,\exp\!\left[-\frac{E_P}{R}\left(\frac1T - \frac1{293.15\ \text{K}}\right)\right]
$$

  where $E_P$ is `perm_activation` [J/mol], $R = 8.314$ J/(mol K) and $T$ the test temperature
  `permeation_temperature` + 273.15 [K] (default 55 °C).
* $A$: internal surface area of the liner inner profile, $\sum 2\pi\bar r\,\Delta\ell$ [m²].
* $\Delta p$: MEOP in Pa. The outside is at zero H₂ partial pressure.
* $t_l$: the nominal cylinder wall thickness in m, applied over the whole area.

The result is converted to normal millilitres per hour per litre of water capacity:

$$
q = \frac{\dot n \cdot 22\,414\ \text{NmL/mol} \cdot 3600\ \text{s/h}}{V_\text{water}\ [\text{L}]}\quad [\text{NmL/(h·L)}]
$$

This is compared with `permeation_limit` (default 46 NmL/h/L, the order of the SAE J2579 / GTR 13
allowance). Only the liner resists permeation: the overwrap's resistance and the boss seals are ignored,
and so is the transient before steady state.

*Example* (`type4-35mpa-h2`, HDPE 5 mm, MEOP 43.75 MPa, 55 °C): the Arrhenius factor from 20 °C to
55 °C is $e^{(35\,000/8.314)(1/293.15 - 1/328.15)} = 4.6$, and $q = 31.5$ NmL/h/L against 46. `VALIDATION.md`
confirms the scaling with $1/t$ and with Arrhenius exactly.

### 7.4 Support pressure while winding (`liner.support`)

The winding tension puts an external pressure on the thin polymer liner. From the tension model (§6),
this pressure is $p_\text{ext} = \max(-\sigma_{\theta,l}\,t_l/R, 0)$, where $\sigma_{\theta,l}$ is the
liner hoop stress after winding and $R = R_\text{out} - t_l/2$. A long thin tube under external pressure
buckles at the **Bresse** long-tube pressure:

$$
p_\text{cr} = \frac{E}{4(1-\nu^2)}\left(\frac{t_l}{R}\right)^3
$$

With a safety factor of 2 (`SUPPORT_SAFETY`), the internal support pressure needed while winding is

$$
p_\text{support} = \max\!\left(p_\text{ext} - \frac{p_\text{cr}}{2},\ 0\right)
$$

The check is a **warning** only: it tells the operator what to set. It never fails. Finite length,
boss support, liner creep and the stiffening effect of layers already wound are ignored.

*Example* (HDPE, $t_l = 5$ mm, $R = 107.5$ mm): $p_\text{cr} = 0.031$ MPa, but the tension model gives
$\sigma_{\theta,l} = -7.6$ MPa, so $p_\text{ext} = 0.355$ MPa. The liner must be pressurised to at least
0.34 MPa (3.4 bar) while it is wound.

---

## 8. Design checks

**Where in the code:** `core/design.py checks` (plus `_polymer_checks`). Each check has a status: `ok`,
`warn`, `fail` or `info`. `suggest_layup` treats `fail` as blocking, except for the `tension.*` checks.
It adds hoop or helical layers according to which check fails, as described in the code of
`suggest_layup`. In the table, $SR_\text{lim}$ = `stress_ratio_limit` (0.6),
$N_\text{req}$ = `design_cycles` × `fatigue_scatter_factor` and $p_\text{req}$ = MEOP × `burst_factor`.

| id | Applies to | Meaning | Criterion (otherwise) |
|---|---|---|---|
| `geo.boss` | unequal openings | Geodesic paths use one turnaround radius, set by the larger boss | info |
| `layer.<id>` | any layer | Build warnings: pattern gaps, dwell above the limit, no pattern within dwell, unreachable pattern number, geodesic with unequal bosses | warn |
| `layer.<id>.path` | non-geodesic | Requested non-geodesic path infeasible (a geodesic fallback is shown) | fail |
| `layer.<id>.slip` | non-geodesic | Required slippage $\max\lvert k_g/k_n\rvert$ against friction $\mu$ | $\le \mu$ ok; $\le 1.25\mu$ warn; else fail |
| `layup.empty` | – | No layers | fail |
| `burst` | all | Cylinder burst (first fibre failure, §3.11) | $p_b \ge p_\text{req}$ (fail) |
| `burst.mode` | layups with hoops | Hoop-first failure | mode = hoop (warn) |
| `burst.balance` | hoop-first burst | Helical fibre ratio when the hoops fail | $< 0.95$ (warn) |
| `sr.hoop` | all | Hoop fibre stress ratio at MEOP, $T_\text{ref}$ (§3.9) | $\le SR_\text{lim}$ (fail) |
| `sr.helical` | all | Helical fibre stress ratio at MEOP | $\le SR_\text{lim}$ (fail) |
| `sr.temp` | all | Worst stress ratio at MEOP over $T_\text{ref}$, $T_\text{min}$, $T_\text{max}$, including cure residual (§3.10) | $\le SR_\text{lim}$ (fail) |
| `sr.reliability` | all | Stress-rupture failure probability over the service life, with credit for autofrettage and proof holds (`core/rupture.py`) | $P_f \le$ `rupture_pf_target` (fail) |
| `cure.exotherm` | cure simulated | Laminate temperature rise from reaction heat | $\le$ `max_exotherm` (fail) |
| `cure.degree` | cure simulated | Least-cured point | $\ge$ `min_cure` (fail) |
| `cure.tg` | cure simulated | $T_g$ of the least-cured laminate | $\ge T_\text{max}$ + `tg_margin` (fail) |
| `liner.cure_temp` | metal, cure simulated | Peak liner temperature during cure (temper and ageing) | $\le$ `max_temp` (fail) |
| `liner.temp` | metal | Liner stays elastic at 0 and MEOP, at $T_\text{min}$ and $T_\text{max}$ (§3.10); value = max $\sigma_\text{vm}/\sigma_{y,\text{hard}}$ | no plastic increment (fail) |
| `liner.lbb` | metal | Leak-before-burst, through crack $2t_l$ at max MEOP hoop stress (§3.13); value = $K_I/K_{Ic}$ | $\le 1$ (fail) |
| `af.window` | metal | Autofrettage window exists (§3.8) | $p_\text{hi} \ge p_\text{lo}$ (fail) |
| `af.reverse` | metal | Residual liner $\sigma_\text{vm}/\sigma_y$ after autofrettage | $\le 0.9$ (fail) |
| `af.fiber` | metal | Peak fibre ratio at autofrettage | $\le 0.75$ ok; $< 1$ warn; else fail |
| `liner.meop` | metal | Liner elastic at MEOP: $\sigma_\text{vm}/(\sigma_y + H\bar\varepsilon_p)$ | $\le 1$ (fail) |
| `liner.proof` | metal | No new plastic strain at proof | $\Delta\bar\varepsilon_p \le 10^{-6}$ (warn) |
| `fatigue` | metal | SWT liner life, cylinder (§3.14) | $N_f \ge N_\text{req}$ (fail) |
| `liner.strain` | polymer | Liner strain at proof (§7.1) | $\le$ `strain_limit` (fail) |
| `liner.cure` | polymer | Peak liner temperature in cure (§7.2) | $\le$ `max_temp` (fail) |
| `liner.service_temp` | polymer | $T_\text{max}$ against liner limit | $\le$ `max_temp` (fail) |
| `liner.permeation` | polymer with permeability data | Steady H₂ permeation at MEOP (§7.3) | $\le$ `permeation_limit` (fail) |
| `liner.support` | polymer | Internal support pressure needed while winding (§7.4) | value > 0 → warn; never fails |
| `tension.loss` | layers | Largest winding-prestress loss (§6) | $\le 0.6$ ok; else warn if the layer keeps positive prestress or the liner is polymer, fail if it goes slack on a metal liner |
| `layup.bridging` | helicals | Fibre lift-off over concave meridional regions, gap $\approx\lvert k_n\rvert L^2/8$ | gap > 0.05 mm → warn |
| `fe.burst` | all | Dome-inclusive burst from the shell FE (§4.5) | $p_{b,\text{FE}} \ge p_\text{req}$ (fail) |
| `fe.liner` | metal | Liner fatigue at the FE hot spot (§4.5) | $N_\text{hot} \ge N_\text{req}$ (fail) |
| `dome.netting` | helicals | Dome/cylinder helical netting stress ratio (§2.2) | $\le 1.1$ (warn) |

Notes:

* The progressive analysis (§5) is not a check in `checks`. It is run on demand (`/api/progressive`, the
  report with `progressive=true`, or `suggest_layup(progressive=True)`, which adds layers until the
  progressive burst reaches $p_\text{req}$).
* The cure checks appear only when `analyze(..., with_cure=True)` runs the cure simulation. The sizing
  loops use `with_cure=False`.

---

## 9. Validation and known limitations

`docs/VALIDATION.md` is the authoritative list. The automated tests are in `backend/tests/`, mainly
`test_structural.py`, `test_shellfe.py`, `test_progressive.py`, `test_ccx.py`, `test_type4.py` and
`test_calibration.py`. The points relevant to this chapter:

**Verified against closed-form results or internal consistency**

| Quantity | Reference | Agreement |
|---|---|---|
| Liner return mapping | stays on the yield surface; uniaxial tangent $EH/(E+H)$ | exact |
| Cylinder hoop equilibrium | $pR_i$ | 1e-6 |
| Free body after autofrettage / cure cool-down | forces cancel | 1e-6 |
| Shell FE, liner-only cylinder | hoop $pR_i/t$, axial resultant $pR_i^2/(2R)$ | 0.2 % |
| Shell FE, sphere | equal biaxial membrane | 0.5 % |
| Shell FE vs cylinder model (thick composite) | independent formulation | 1-6 % |
| Puck IFF under pure $\sigma_2^+$, $\tau_{21}$, $\sigma_2^-$ | $Y_t$, $S_{12}$, $Y_c$ | exact |
| H₂ permeation vs thickness and temperature | Fick $1/t$, Arrhenius | exact |

**Independent solver: CalculiX.** `ccx_export.py` (CLI `windlab ccx project.json --run DIR`, API
`/api/ccx-export`) writes an axisymmetric solid model with CAX8/CAX6 elements. It has one element row per
liner and layer, an isotropic-hardening plastic liner, orthotropic plies with orthotropic CTEs, and the
same load sequence (cure cool-down, autofrettage, proof, MEOP) and rigid-ring ends. For the desktop
example, the composite hoop strain at the cylinder mid-plane agrees with the cylinder model within
**2-6 %** in every state. The comparison is made with matrix cracking off, because the deck is
linear-elastic. The test `test_ccx.py` asserts 6 %.

| State | CalculiX liner inner | CalculiX composite outer | WindLab cylinder model |
|---|---|---|---|
| after cure | −0.00119 | −0.00131 | −0.00124 |
| autofrettage peak | 0.00902 | 0.00771 | 0.00774 |
| after autofrettage | 0.00298 | 0.00225 | 0.00206 |
| proof | 0.00589 | 0.00488 | 0.00480 |
| MEOP | 0.00492 | 0.00401 | 0.00388 |

The same comparison shows the main blind spot of the thin-wall cylinder model: at autofrettage, the
**liner inner surface** strains about 15 % more than the composite, because of through-thickness
compression and the $1/r$ variation. Where the plastic strain of the liner at autofrettage is critical,
use the CalculiX export.

**Progressive vs cylinder model.** The desktop burst agrees within −25 % / +5 % (§5.7).

**Burst calibration.** `core/calibration.py` fits the translation efficiency to measured bursts. Burst
scales almost linearly with $\eta_t$ because the liner's share is small. It reports the mean-based
efficiency and a B-basis value (one-sided tolerance factor, 90 % content and 95 % confidence). Re-running
with the suggested efficiency reproduces $0.92\times$ the prediction within 3 %.

**Documented limitations**

* Material data are datasheet values. Burst and fatigue predictions need test calibration
  (`/api/calibrate`).
* The Puck parameters and the transverse and shear strengths are generic carbon/epoxy values. The
  progressive burst needs the same test calibration as every other prediction.
* The Abaqus deck (`fea_export.py`) has not been run in Abaqus. Its conventions were reviewed, and the
  independent FE check is the CalculiX comparison.
* The polymer permeability data are indicative literature values.
* The cylinder model's own limitations are summarised in §3.16. Also: the shell FE is linear and
  isothermal (§4.4), winding prestress is not coupled into the stress analysis (§6), there is no
  Bauschinger effect (only the 0.9 knock-down), there is no geometric nonlinearity and no delamination.

---

## 10. References

1. R. M. Jones, *Mechanics of Composite Materials*, 2nd ed., Taylor & Francis, 1999. Classical
   lamination theory, reduced and transformed stiffness, ABD matrices.
2. J. C. Halpin and J. L. Kardos, "The Halpin-Tsai equations: a review", *Polymer Engineering and
   Science* 16(5), 1976, 344-352.
3. R. A. Schapery, "Thermal expansion coefficients of composite materials based on energy principles",
   *Journal of Composite Materials* 2(3), 1968, 380-404.
4. J. C. Simo and R. L. Taylor, "A return mapping algorithm for plane stress elastoplasticity",
   *International Journal for Numerical Methods in Engineering* 22, 1986, 649-670.
5. J. C. Simo and T. J. R. Hughes, *Computational Inelasticity*, Springer, 1998. J2 plasticity, return
   mapping, continuum and consistent tangents.
6. VDI 2014 Part 3, *Development of Fibre-Reinforced Plastic Components: Analysis*, Verein Deutscher
   Ingenieure, 2006. Puck inter-fibre failure criterion, inclination parameters, degradation.
7. A. Puck and H. Schürmann, "Failure analysis of FRP laminates by means of physically based
   phenomenological models", *Composites Science and Technology* 58, 1998, 1045-1067.
8. K. N. Smith, P. Watson and T. H. Topper, "A stress-strain function for the fatigue of metals",
   *Journal of Materials* 5(4), 1970, 767-778.
9. O. H. Basquin, "The exponential law of endurance tests", *Proceedings ASTM* 10, 1910, 625-630.
10. T. L. Anderson, *Fracture Mechanics: Fundamentals and Applications*, CRC Press. Through-crack stress
    intensity and leak-before-burst.
11. S. P. Timoshenko and J. M. Gere, *Theory of Elastic Stability*, 2nd ed., McGraw-Hill, 1961. Buckling
    of rings and long tubes under external pressure (Bresse).
12. J. Crank, *The Mathematics of Diffusion*, 2nd ed., Oxford University Press, 1975. Fickian diffusion
    and steady-state permeation; Arrhenius temperature dependence.
13. V. V. Vasiliev, *Composite Pressure Vessels: Analysis, Design, and Manufacturing*, Bull Ridge
    Publishing, 2009. Netting analysis, geodesic and isotensoid domes.
14. S. T. Peters (ed.), *Composite Filament Winding*, ASM International, 2011.
15. P. E. Grafton and D. R. Strome, "Analysis of axisymmetrical shells by the direct stiffness method",
    *AIAA Journal* 1(10), 1963, 2342-2347. Conical frustum shell elements.
16. O. C. Zienkiewicz, R. L. Taylor and J. Z. Zhu, *The Finite Element Method: Its Basis and
    Fundamentals*, Butterworth-Heinemann. Hermite beam and shell interpolation, Newton-Raphson with line
    search.
