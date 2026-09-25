# 3. Reliability, cure and design tools

This chapter documents the parts of WindLab that sit on top of the structural analysis: the
stress-rupture reliability model, the oven cure simulation, the burst sensitivity (statistical margin),
test-data calibration, the automatic layup suggestion and the mass optimiser. Each section states the
theory, the exact form implemented, the simplifications, and worked numbers from the example projects
shipped in `backend/windlab/data/examples/`.

All numbers quoted here were produced by running the current code on the shipped examples
(`windlab.presets.examples()`), unless marked *hypothetical*. They are model outputs, not test results.
The structural quantities they rely on (fibre stress ratios, burst pressure, pressure history) come
from the thin-wall cylinder model described in the structural-analysis chapter.

## Contents

- [3.1 Stress-rupture reliability](#31-stress-rupture-reliability)
  - [3.1.1 Power-law breakdown and cumulative damage](#311-power-law-breakdown-and-cumulative-damage)
  - [3.1.2 Why alpha = beta / (n + 1): the burst ramp](#312-why-alpha--beta--n--1-the-burst-ramp)
  - [3.1.3 Characteristic time from the median burst](#313-characteristic-time-from-the-median-burst)
  - [3.1.4 Calibration of n to the standards' stress ratios](#314-calibration-of-n-to-the-standards-stress-ratios)
  - [3.1.5 Proof-test credit](#315-proof-test-credit)
  - [3.1.6 Life to target and allowed stress ratio](#316-life-to-target-and-allowed-stress-ratio)
  - [3.1.7 Weakest link over ply groups and the reliability curve](#317-weakest-link-over-ply-groups-and-the-reliability-curve)
  - [3.1.8 The `sr.reliability` check and the layup suggester](#318-the-srreliability-check-and-the-layup-suggester)
  - [3.1.9 Worked numbers](#319-worked-numbers)
  - [3.1.10 Assumptions and limitations](#3110-assumptions-and-limitations)
- [3.2 Oven cure simulation](#32-oven-cure-simulation)
  - [3.2.1 Radial finite-volume conduction](#321-radial-finite-volume-conduction)
  - [3.2.2 Thermal properties](#322-thermal-properties)
  - [3.2.3 Cure kinetics, vitrification and heat release](#323-cure-kinetics-vitrification-and-heat-release)
  - [3.2.4 Oven cycle and boundary conditions](#324-oven-cycle-and-boundary-conditions)
  - [3.2.5 Time integration](#325-time-integration)
  - [3.2.6 Exotherm against an inert reference](#326-exotherm-against-an-inert-reference)
  - [3.2.7 Simulated sections](#327-simulated-sections)
  - [3.2.8 Cure checks](#328-cure-checks)
  - [3.2.9 Cure cycle suggestion](#329-cure-cycle-suggestion)
  - [3.2.10 Worked numbers](#3210-worked-numbers)
  - [3.2.11 Assumptions and limitations](#3211-assumptions-and-limitations)
- [3.3 Burst sensitivity and statistical margin](#33-burst-sensitivity-and-statistical-margin)
- [3.4 Test-data calibration](#34-test-data-calibration)
- [3.5 Layup suggestion](#35-layup-suggestion)
- [3.6 Mass optimiser](#36-mass-optimiser)
- [3.7 References](#37-references)

### Notation used throughout

| Symbol | Meaning | Unit |
|---|---|---|
| $p_\text{MEOP}$ | maximum expected operating pressure | MPa |
| $p_\text{req} = \text{BF}\, p_\text{MEOP}$ | required burst pressure (BF: `burst_factor`) | MPa |
| $\varepsilon_{1u}$ | delivered fibre-direction failure strain, $\eta\,\sigma_f / E_f$ | - |
| $\eta$ | fibre strength translation efficiency (`translation_efficiency`) | - |
| $\sigma_f, E_f$ | impregnated strand strength and modulus of the fibre | MPa |
| $\rho$ | fibre stress ratio: fibre strain / $\varepsilon_{1u}$ (equivalently fibre stress / delivered strength) | - |

Note that the stress ratio is defined against the **delivered** strength, i.e. the strength that already
includes the translation efficiency. $\rho = 1$ therefore means "the fibre is at its predicted burst strain",
and the median strength of the reliability model sits exactly at the predicted burst.

---

## 3.1 Stress-rupture reliability

Carbon, aramid and glass fibres under sustained tension fail after a time that depends very steeply on
the stress level (stress rupture, also called creep rupture or static fatigue). The gas-cylinder
standards control it with a minimum ratio of burst to working stress; WindLab additionally estimates the
**probability** of stress-rupture failure over the service life with a Weibull power-law breakdown model
of the kind developed by Coleman and applied to COPVs by Phoenix and co-workers.

**Where in the code:** `backend/windlab/core/rupture.py` (`params`, `_calibrated_n`, `_log_pf`, `damage`,
`pf`, `life_years`, `allowed_ratio`, `family_of`); `backend/windlab/core/design.py` (`_rupture`, the
`sr.reliability` entry of `checks`, and the rupture-driven rules in `suggest_layup`).

### 3.1.1 Power-law breakdown and cumulative damage

A ply group loaded along a stress-ratio history $\rho(t)$ accumulates the damage (Coleman's
"breakdown rule" with a power-law kernel)

$$
\Psi(t) = \frac{1}{t_c}\int_0^t \rho(\tau)^{\,n}\,\mathrm{d}\tau ,
$$

and fails by time $t$ with probability

$$
P(t) = 1 - \exp\!\left[-\Psi(t)^{\alpha}\right].
$$

| Symbol | Meaning | Code |
|---|---|---|
| $\Psi$ | dimensionless cumulative damage | `damage()` |
| $t_c$ | characteristic time (min) | `Params.t_c` |
| $n$ | power-law (stress-rupture) exponent | `Params.n` |
| $\alpha$ | Weibull shape of the lifetime distribution at constant load | `Params.alpha` |
| $\beta$ | Weibull shape of the (short-term) burst strength | `Params.beta` |

For a load profile made of constant holds $(\rho_k, t_k)$ the integral is a sum:

$$
\Psi = \frac{1}{t_c}\sum_k t_k\,\max(\rho_k, 0)^{\,n}.
$$

`damage(p, profile)` evaluates exactly this (times in minutes; negative ratios contribute nothing). At a
constant ratio $\rho$ held for $t$, $\Psi = t\rho^n/t_c$ and the lifetime is Weibull in time with shape
$\alpha$ and a scale that falls as $\rho^{-n}$.

The model has three parameters ($\beta$, $n$, $t_c$) once $\alpha$ is tied to them as shown next.

### 3.1.2 Why alpha = beta / (n + 1): the burst ramp

A burst test is the same model evaluated on a fast load ramp. Load linearly to $\rho$ over the ramp time
$T_r$ (`RAMP_MIN` = 1 min), i.e. $\rho(\tau) = \rho\,\tau/T_r$. Then

$$
\Psi(T_r) = \frac{1}{t_c}\int_0^{T_r}\left(\frac{\rho\,\tau}{T_r}\right)^{n}\mathrm{d}\tau
          = \frac{T_r}{(n+1)\,t_c}\,\rho^{\,n+1},
$$

so the probability of having failed by the time the ramp reaches $\rho$ is

$$
P(\rho) = 1-\exp\!\left[-\left(\frac{T_r}{(n+1)\,t_c}\right)^{\alpha}\rho^{\,\alpha(n+1)}\right].
$$

This is a two-parameter Weibull distribution of the **burst strength** (expressed as a stress ratio) with
shape $\alpha(n+1)$. Requiring that it reproduce the observed burst-strength scatter, whose Weibull shape
is $\beta$, gives

$$
\boxed{\;\beta = \alpha\,(n+1)\quad\Longleftrightarrow\quad \alpha = \frac{\beta}{n+1}\;}
$$

which is `Params.alpha`. Physically: a large exponent $n$ (steep stress dependence) spreads the same
strength scatter over a much wider lifetime scatter, since $\alpha \ll \beta$.

### 3.1.3 Characteristic time from the median burst

The scale is fixed by requiring the median of the ramp-burst strength to be at $\rho = 1$, i.e. at the
predicted (delivered) burst strength. With $P(1) = 1/2$:

$$
\left(\frac{T_r}{(n+1)\,t_c}\right)^{\alpha} = \ln 2
\quad\Longrightarrow\quad
t_c = \frac{T_r}{(n+1)\,(\ln 2)^{1/\alpha}} .
$$

This is `Params.t_c`. `_log_pf` uses the same expression in logarithmic form,
$\ln t_c = \ln\!\big(T_r/(n+1)\big) - \ln(\ln 2)/\alpha$, and computes $\ln P$ for a constant hold as

$$
\ln x = \alpha\left(\ln t + n\ln\rho - \ln t_c\right) \;(= \ln \Psi^\alpha),\qquad
\ln P = \begin{cases}\ln x & \ln x < -30\\ \ln\!\left(-\operatorname{expm1}(-e^{\ln x})\right) & \text{otherwise}\end{cases}
$$

so probabilities as small as $10^{-30}$ and below do not underflow (for $x \ll 1$, $1-e^{-x} \approx x$).

The consequence of anchoring the median at $\rho = 1$ is that the translation efficiency, which sets the
delivered strength, also scales the stress-rupture life: an optimistic $\eta$ is optimistic twice.

### 3.1.4 Calibration of n to the standards' stress ratios

The Weibull shape $\beta$ comes from typical COPV burst scatter per fibre family (coefficient of
variation roughly 4 / 5 / 6 % for carbon / aramid / glass; the module header gives these). The exponent
$n$ is not taken from rupture data (there are none in the material library); instead it is calibrated so
that the model reproduces the minimum burst ratios for stress rupture that the gas-cylinder standards
prescribe (the code's docstring cites ISO 11119-2/-3 and ISO 11439): a vessel whose MEOP fibre stress
ratio equals $1/r_\text{std}$ should have $P = 10^{-6}$ after 15 years at constant pressure without
proof-test credit:

$$
P\!\left(\rho = \tfrac{1}{r_\text{std}},\; t = 15\text{ years}\right) = 10^{-6}.
$$

`_calibrated_n(beta, ratio)` solves this for $n$ with Brent's method on $n\in[2, 1000]$, in log space
(`_log_pf(...) - ln(1e-6) = 0`). The fibre family is chosen from the fibre id/name by `family_of`
(names containing "glass" or starting with "e-", "s2", "s-2" → glass; "aramid", "kevlar", "twaron" →
aramid; everything else → carbon).

| Family | $\beta$ (default) | $r_\text{std}$ | calibrated $n$ | $\alpha = \beta/(n+1)$ | $t_c$ [min] |
|---|---|---|---|---|---|
| carbon | 30 | 2.25 | 56.19 | 0.5246 | 0.0352 |
| aramid | 25 | 3.0 | 35.71 | 0.6810 | 0.0467 |
| glass | 20 | 3.5 | 34.69 | 0.5605 | 0.0539 |

(Computed with `rupture.params(family)`.) The user can override $\beta$ (`composite.strength_weibull_shape`)
and/or $n$ (`composite.rupture_exponent`). If $n$ is given it is used as is and the result is flagged
`calibrated = False`; if only $\beta$ is given, $n$ is re-calibrated for that $\beta$. The coupling is
strong: for carbon, $\beta = 20/25/30/40$ gives $n = 156/76/56/42$ and $\alpha = 0.13/0.32/0.52/0.93$.

What the calibration implies (carbon, no proof credit):

- The damage rate scales as $\rho^{56}$: a 1 % higher stress ratio makes damage accumulate 1.75 times
  faster. For small $P$, $P \approx \Psi^\alpha \propto \rho^{n\alpha}$ with $n\alpha = 29.5$, so a 1 %
  higher ratio raises $P$ by a factor 1.34.
- At the standard ratio $\rho = 0.444$ the 15-year damage is $\Psi = 3.65\times10^{-12}$ and
  $\Psi^{\alpha} = 10^{-6}$ (by construction). At $\rho = 0.5$ the 15-year probability is already
  $3.2\times10^{-5}$ for carbon, $1.9\times10^{-2}$ for aramid and $5.2\times10^{-2}$ for glass.

The standards' ratios and the $10^{-6}$ / 15-year anchor are an engineering choice encoded in the
module constants `FAMILIES`, `REF_YEARS`, `REF_PF`. The ratios are indicative: check the value that
applies to the standard edition and cylinder type you certify to, and prefer an $n$ fitted to
stress-rupture data for the actual fibre/resin system when such data exist (the module docstring says so).

### 3.1.5 Proof-test credit

Every Type III vessel sees an autofrettage cycle and every vessel a proof test before service. A vessel
that survived these holds is, statistically, not one of the weakest; the service failure probability
should be **conditional on survival of the screening**. With $\Psi_s$ the screening damage and $\Psi_v$
the service damage (damage adds because $\Psi$ is a time integral), the survival function
$S(\Psi) = \exp(-\Psi^\alpha)$ gives

$$
P(\text{fail in service}\mid\text{survived screen})
= \frac{S(\Psi_s)-S(\Psi_s+\Psi_v)}{S(\Psi_s)}
= 1-\exp\!\left\{-\left[(\Psi_s+\Psi_v)^{\alpha}-\Psi_s^{\alpha}\right]\right\}.
$$

Because $\alpha < 1$, the bracket is smaller than $\Psi_v^\alpha$: the credit is real, and it is largest
when the screening damage is comparable to or larger than the service damage.

**Numerically stable forms used.** The bracket is the difference of two nearly equal numbers when
$\Psi_v \ll \Psi_s$ and the probabilities of interest are $10^{-6}$ and far below, so `pf` evaluates

$$
(\Psi_s+\Psi_v)^{\alpha}-\Psi_s^{\alpha} = \Psi_s^{\alpha}\left[(1+x)^{\alpha}-1\right]
= \Psi_s^{\alpha}\,\operatorname{expm1}\!\big(\alpha\,\operatorname{log1p}(x)\big),\qquad x = \Psi_v/\Psi_s,
$$

and $P = -\operatorname{expm1}(-\,\cdot\,)$. Without screening, $P = -\operatorname{expm1}(-\Psi_v^\alpha)$.
Both avoid cancellation and keep full relative precision down to the smallest representable
probabilities.

**Screening damage in WindLab** (`design._rupture`): for each ply group,

$$
\Psi_s = \frac{t_h}{t_c}\left(\rho_\text{AF}^{\,n} + \rho_\text{proof}^{\,n}\right),\qquad
\Psi_v = \frac{f\,L\,t_\text{yr}}{t_c}\,\rho_\text{MEOP}^{\,n},
$$

| Symbol | Meaning | Default |
|---|---|---|
| $t_h$ | hold time at the autofrettage and at the proof pressure (`requirements.hold_time`, converted to min) | 60 s |
| $\rho_\text{AF}$ | group ratio at the autofrettage peak (history state before the first unload) | - |
| $\rho_\text{proof}$ | group ratio at the proof peak | - |
| $\rho_\text{MEOP}$ | group ratio at MEOP (after autofrettage and proof, at the reference temperature) | - |
| $f$ | fraction of the life spent at MEOP (`time_at_meop`); the rest is unpressurised, $\rho = 0$ | 1 |
| $L$ | service life (`service_life`) | 15 years |
| $t_\text{yr}$ | minutes per year, $365.25\times24\times60$ | - |

For Type IV vessels the autofrettage pressure equals the proof pressure, so both holds are at the
proof ratio. With `hold_time = 0` there is no credit. The load ramps themselves are not included in
$\Psi_s$ (only the holds at the peaks).

### 3.1.6 Life to target and allowed stress ratio

**Life to target** (`life_years`). The time at a constant ratio $\rho$ until the conditional probability
reaches the target $P_t$ (`rupture_pf_target`, default $10^{-6}$). Set
$\varepsilon = -\ln(1-P_t)$; then $P = P_t$ when

$$
(\Psi_s+\Psi_v)^{\alpha} = \Psi_s^{\alpha}+\varepsilon
\;\Longrightarrow\;
\Psi_v = \Psi_s\left[\left(1+\frac{\varepsilon}{\Psi_s^{\alpha}}\right)^{1/\alpha}-1\right]
       = \Psi_s\,\operatorname{expm1}\!\left(\frac{\operatorname{log1p}(\varepsilon/\Psi_s^{\alpha})}{\alpha}\right),
$$

again written with `expm1`/`log1p` because $\varepsilon \ll \Psi_s^\alpha$ is common. Without screening
$\Psi_v = \varepsilon^{1/\alpha}$. The damage rate per year is $f\,t_\text{yr}\,\rho^n/t_c$, so

$$
t_\text{life} = \frac{\Psi_v\,t_c}{f\,t_\text{yr}\,\rho^{\,n}}\quad[\text{years}].
$$

`_rupture` caps the reported life at $10^{12}$ years.

**Allowed ratio** (`allowed_ratio`). The highest constant MEOP ratio for which the life to target equals
the service life, found by Brent's method on $\ln t_\text{life}(\rho) - \ln L$ over $\rho\in[10^{-3}, 1.5]$.
If even $\rho = 1.5$ meets the target the function returns 1.5; for $L \le 0$ it returns 1. Without
proof credit and with the defaults it returns exactly $1/r_\text{std}$ (0.4444 for carbon), which is the
calibration condition read backwards (verified to $10^{-4}$ in `tests/test_rupture.py`, see
`docs/VALIDATION.md`). With proof credit it is slightly higher.

Note that the allowed ratio is computed **per group, as if that group were alone**; it does not account
for the weakest-link combination below.

### 3.1.7 Weakest link over ply groups and the reliability curve

The cylinder model provides a stress ratio per ply group, where a group is a winding type: `hoop` or
`helical` (`Vessel.fiber_ratio` returns, per type, the maximum over all layers of that type). The vessel
survives only if every group survives; with the groups taken as independent,

$$
P_\text{vessel} = 1-\prod_g\left(1-P_g\right)
= -\operatorname{expm1}\!\left(\sum_g \operatorname{log1p}(-P_g)\right),
$$

with each $P_g$ clipped at $1-10^{-16}$ before the logarithm. Reliability is reported as $1-P_\text{vessel}$.

**The curve.** `_rupture` also evaluates $P_\text{vessel}$ versus exposure time at 40 log-spaced points
from 0.01 years to $\max(10L, 1)$ years (`curve_years`, `curve_pf`), each point with the same screening
credit and time fraction $f$. For the defaults this spans 0.01 to 150 years; the curve is what the UI
plots against the target line.

### 3.1.8 The `sr.reliability` check and the layup suggester

`design.checks` emits

- `sr.hoop`, `sr.helical`, `sr.temp`: the deterministic stress-ratio limits (fibre ratio at MEOP, and the
  worst ratio over the minimum/maximum operating temperature including cure residual stresses, against
  `stress_ratio_limit`, default 0.6);
- `sr.reliability`: **fail** if $P_\text{vessel} > P_t$, with the family, $\beta$, $n$ (and whether it was
  calibrated), and the worst group's allowed MEOP stress ratio and life to target in the detail text.

In `suggest_layup` (section 3.5) the failing groups are extracted,
`rup_fail = {g.group for g in rupture.groups if g.pf > rupture.target}` (only when `sr.reliability`
fails), and they feed the same rules as the deterministic checks: a failing `helical` group adds a
helical layer (first rule), a failing `hoop` group adds a hoop layer (second rule). Because the rules are
evaluated in order, a helical rupture failure is fixed before a hoop one.

### 3.1.9 Worked numbers

Results of `analyze(project)` on the shipped examples (carbon family, calibrated $n = 56.19$,
$\alpha = 0.5246$, 60 s holds, 15 years at MEOP, target $10^{-6}$):

| Example | Group | $\rho_\text{AF}$ | $\rho_\text{proof}$ | $\rho_\text{MEOP}$ | $P$ (with credit) | $P$ (no credit) | Life to $10^{-6}$ [y] | Allowed ratio |
|---|---|---|---|---|---|---|---|---|
| `type3-30mpa-11l` | hoop | 0.377 | 0.312 | 0.261 | $7.4\times10^{-15}$ | $1.4\times10^{-13}$ | $>10^{12}$ (cap) | 0.444 |
| `type3-70mpa-2l` | hoop | 0.384 | 0.279 | 0.196 | $5.3\times10^{-22}$ | $3.3\times10^{-17}$ | $>10^{12}$ (cap) | 0.444 |
| `type3-25mpa-unequal` | hoop | 0.555 | 0.479 | 0.421 | $1.02\times10^{-7}$ | $2.05\times10^{-7}$ | 402 | 0.4466 |
| `type3-25mpa-unequal` | helical | 0.236 | 0.199 | 0.172 | $1.5\times10^{-19}$ | $7.0\times10^{-19}$ | $>10^{12}$ (cap) | 0.444 |
| `type4-35mpa-h2` | hoop | 0.514 | 0.514 | 0.427 | $2.84\times10^{-7}$ | $3.08\times10^{-7}$ | 148 | 0.4448 |
| `grbl-10mpa-1l` | hoop | 0.456 | 0.292 | 0.239 | $3.7\times10^{-19}$ | $1.2\times10^{-14}$ | $>10^{12}$ (cap) | 0.444 |

Vessel probabilities (weakest link): $7.4\times10^{-15}$, $5.3\times10^{-22}$, $1.02\times10^{-7}$,
$2.84\times10^{-7}$ and $3.7\times10^{-19}$ respectively; all pass. The hoop group dominates in every case.

**Hand check, 25 MPa example, hoop group.** With $t_h = 1$ min and $t_c = 0.03517$ min:

- $\Psi_s = (0.5548^{56.19} + 0.4788^{56.19})/t_c \approx 1.20\times10^{-13}$, $\Psi_s^\alpha \approx 1.66\times10^{-7}$;
- $\Psi_v = 15\times525\,960\times0.4212^{56.19}/t_c \approx 1.78\times10^{-13}$, i.e. $x = \Psi_v/\Psi_s \approx 1.49$;
- no credit: $P = 1-e^{-\Psi_v^\alpha} \approx 2.05\times10^{-7}$;
- with credit: $(\Psi_s+\Psi_v)^\alpha - \Psi_s^\alpha \approx 2.69\times10^{-7} - 1.66\times10^{-7} = 1.02\times10^{-7}$.

The autofrettage hold at $\rho = 0.55$ for one minute causes about as much damage as 15 years at 0.42,
which is what makes the credit worth a factor 2 here. For the Type IV example the only screen is two
proof holds at 0.514, $x \approx 118$, and the credit is only 8 %. For the desktop vessel the
autofrettage ratio (0.456) is far above the MEOP ratio (0.239), $x \approx 10^{-9}$, and the credit is
five orders of magnitude; this is the regime where the `log1p`/`expm1` form is essential.

The allowed ratio moves from 0.4444 (no credit) to 0.4466 (25 MPa) or 0.4448 (Type IV): because of
the steep exponent, a large change in probability corresponds to a small change in admissible stress.

### 3.1.10 Assumptions and limitations

- Single fibre-family parameter set; $\beta$ from generic burst scatter, $n$ calibrated to standard
  ratios, not to stress-rupture data for the actual fibre/resin. Matrix, temperature and moisture effects
  on stress rupture are not modelled.
- The MEOP ratio is the cylinder-model value at the reference temperature; the domes, the hot and cold
  MEOP states and stress concentrations do not enter the probability (the hot/cold ratio enters only the
  deterministic `sr.temp` check).
- Pressure cycling is represented only by the time fraction $f$ at MEOP; the rest of the time is
  assumed unpressurised. Fatigue interaction is ignored.
- Each group is represented by its most-stressed layer, and groups are independent: there is no volume
  (size) effect and no correlation between hoop and helical strength.
- The ramps of the autofrettage and proof cycles are not counted in the screening damage (conservative
  for the credit). Screening is credited on the assumption that every vessel is actually tested at the
  modelled pressures and hold times.
- Validation (`docs/VALIDATION.md`): the calibration is reproduced to $10^{-6}$ relative, the ramp burst
  has $P = 0.5$ at the median with Weibull shape $\beta$, and life/allowed-ratio are consistent inverses
  to $10^{-4}$. These are self-consistency checks, not comparisons with rupture tests.

---

## 3.2 Oven cure simulation

The cure module predicts, at the thickest sections of the vessel, the temperature and degree-of-cure
history through the wall during the oven cycle, and from it the exotherm (temperature rise caused by the
reaction heat), the least-cured point, the resulting glass transition temperature, and the peak liner
temperature.

**Where in the code:** `backend/windlab/core/cure.py` (`cycle_of`, `oven_profile`, `_sections`,
`simulate_section`, `analyse`, `_meets`, `suggest_cycle`, `_spread`, `_fibre_thermal`);
`backend/windlab/core/design.py` (`analyze` calls `cure.analyse`; `checks` emits `cure.*`,
`liner.cure_temp`, and via `_polymer_checks` `liner.cure`); `backend/windlab/core/materials.py` (resin
kinetics and liner thermal data); `api.py` routes `/api/analyze` and `/api/suggest-cure`.

### 3.2.1 Radial finite-volume conduction

Each section is a one-dimensional axisymmetric wall: liner (inner) plus overwrap (outer), with heat
flowing only radially. The energy balance for the temperature $T(r,t)$ is

$$
\rho c_p\,\frac{\partial T}{\partial t} = \frac{1}{r}\frac{\partial}{\partial r}\!\left(k\,r\,\frac{\partial T}{\partial r}\right) + \dot q,
$$

| Symbol | Meaning | Unit |
|---|---|---|
| $\rho, c_p, k$ | density, specific heat, radial (transverse) conductivity of the local material | kg/m³, J/(kg K), W/(m K) |
| $\dot q$ | volumetric reaction heat | W/m³ |
| $r$ | radius | m |

**Discretisation.** The liner is divided into $n_l = 3$ cells, the composite into
$n_c = \max(\lceil t_\text{comp}/0.5\,\text{mm}\rceil, 12)$ cells of equal thickness. With cell faces
$r_{i-1/2}, r_{i+1/2}$ and centres $r_i = \tfrac12(r_{i-1/2}+r_{i+1/2})$, per radian and per metre of
length:

$$
V_i = \tfrac12\left(r_{i+1/2}^2 - r_{i-1/2}^2\right),\qquad C_i = \rho_i c_{p,i} V_i .
$$

The exact conduction resistance of a cylindrical shell between radii $a < b$ is $\ln(b/a)/k$ (per
radian per metre). The conductance between neighbouring cells is the series resistance of the two half
cells:

$$
G_{i,i+1} = \left[\frac{\ln(r_{i+1/2}/r_i)}{k_i} + \frac{\ln(r_{i+1}/r_{i+1/2})}{k_{i+1}}\right]^{-1},
$$

which handles the liner/composite property jump at the interface without averaging the conductivities.
The discrete balance of cell $i$ is

$$
C_i\,\frac{\mathrm{d}T_i}{\mathrm{d}t} = G_{i-1,i}(T_{i-1}-T_i) + G_{i,i+1}(T_{i+1}-T_i) + Q_i ,
$$

with the boundary terms of section 3.2.4. The resulting matrix is tridiagonal and constant in time.

### 3.2.2 Thermal properties

`simulate_section` derives the composite properties from the fibre and resin by mixture rules at the
fibre volume fraction $V_f$:

$$
\rho_c = V_f\rho_f + (1-V_f)\rho_m,\qquad
w_r = \frac{(1-V_f)\rho_m}{\rho_c},\qquad
c_{p,c} = (1-w_r)\,c_{p,f} + w_r\,c_{p,m},
$$

where $w_r$ is the resin **mass** fraction (specific heat mixes by mass). The transverse conductivity uses
the Maxwell mixing rule for aligned cylindrical fibres in a matrix (the two-dimensional form, also
associated with Rayleigh):

$$
k_c = k_m\,\frac{(k_f+k_m) + V_f\,(k_f-k_m)}{(k_f+k_m) - V_f\,(k_f-k_m)} .
$$

| Quantity | Value in the code |
|---|---|
| resin $c_{p,m}$, $k_m$ | 1200 J/(kg K), 0.2 W/(m K) (`RESIN_CP`, `RESIN_K`, all resins) |
| carbon/aramid fibre $c_{p,f}$, $k_f$ (transverse) | 750 J/(kg K), 5.0 W/(m K) |
| glass fibre $c_{p,f}$, $k_f$ | 800 J/(kg K), 1.0 W/(m K) (`_fibre_thermal`: "glass" in id/name) |
| fibre and resin densities | from the material library |
| liner $\rho$, $c_p$, $k$ | from the liner material (`density`, `heat_capacity`, `conductivity`) |

Examples of liner data: AA6061-T6 900 J/(kg K), 150 W/(m K); HDPE 1900 J/(kg K), 0.45 W/(m K);
Ti-6Al-4V 526 J/(kg K), 6.7 W/(m K). At $V_f = 0.6$ the Maxwell rule gives $k_c = 0.697$ W/(m K) for
carbon and 0.467 W/(m K) for glass: the composite conducts through the thickness about as badly as a
thick polymer, which is why thick laminates lag the oven and retain reaction heat.

Note: aramid is treated like carbon here (the fibre is classified glass/non-glass only).

### 3.2.3 Cure kinetics, vitrification and heat release

**Kamal-Sourour kinetics.** The degree of cure $a \in [0,1]$ (fraction of the total heat of reaction
released) follows the autocatalytic model

$$
\frac{\mathrm{d}a}{\mathrm{d}t} = f_d(a,T)\,\big(k_1 + k_2\,a^{m}\big)\,(1-a)^{n},\qquad
k_i = A_i\exp\!\left(-\frac{E_i}{R\,T_K}\right),
$$

| Symbol | Meaning | Unit |
|---|---|---|
| $A_1, A_2$ | pre-exponential factors of the n-th order and autocatalytic terms | 1/s |
| $E_1, E_2$ | activation energies | J/mol |
| $m, n$ | autocatalytic exponent, reaction order (this $n$ is unrelated to the rupture exponent) | - |
| $R$ | gas constant, 8.314 J/(mol K) | |
| $T_K$ | absolute temperature | K |
| $f_d$ | diffusion factor (below) | - |

In the implementation $a^m$ is evaluated as $\max(a,10^{-6})^m$ and $(1-a)^n$ as $\max(1-a,0)^n$.

**Diffusion control via the DiBenedetto $T_g$.** As the resin cures its glass transition temperature
rises; when it approaches the cure temperature the resin vitrifies and the reaction becomes diffusion
controlled. The one-parameter DiBenedetto equation (in the form popularised by Pascault and Williams)
gives

$$
\frac{T_g(a) - T_{g0}}{T_{g\infty} - T_{g0}} = \frac{\lambda\,a}{1-(1-\lambda)\,a},
$$

with $T_{g0}$ the uncured and $T_{g\infty}$ the fully cured glass transition temperature and
$0<\lambda\le 1$ a fitted parameter. The rate is multiplied by a smooth switch

$$
f_d = \frac{1}{1+\exp\!\big((T_g(a) - T)/\Delta T_v\big)},\qquad \Delta T_v = 6\ \text{K},
$$

(`DT_VITRIFY` = 6 K; argument clipped to $\pm50$). $f_d \approx 1$ when the material is well above its current $T_g$,
$f_d = 1/2$ at $T = T_g$, and $f_d \to 0$ below it. This makes the final degree of cure depend on the
highest temperature reached: an isothermal cure stalls at the $a$ for which $T_g(a)$ is a few
$\Delta T_v$ above the cure temperature. It is a simple empirical form, not a free-volume model.

**Default kinetic data** (generic per resin family, `materials.RESINS`; override with DSC-fitted values
through a custom resin):

| Resin | $A_1$ [1/s] | $A_2$ [1/s] | $E_1 = E_2$ [kJ/mol] | $m$ | $n$ | $H$ [J/g] | $T_{g0}$ [°C] | $T_{g\infty}$ [°C] | $\lambda$ |
|---|---|---|---|---|---|---|---|---|---|
| Epoxy-DGEBA (anhydride) | 5.0e5 | 5.0e6 | 75 | 0.5 | 1.5 | 350 | -20 | 140 | 0.45 |
| Epoxy-toughened (towpreg) | 2.0e5 | 2.0e6 | 70 | 0.5 | 1.5 | 400 | -10 | 135 | 0.45 |
| Epoxy-HT (amine) | 8.0e5 | 8.0e6 | 80 | 0.5 | 1.5 | 450 | -15 | 200 | 0.45 |
| Epoxy-LT (amine, Type IV) | 7.0e3 | 7.0e4 | 55 | 0.5 | 1.5 | 420 | -25 | 125 | 0.5 |

For Epoxy-DGEBA, $k_1 = 5.4\times10^{-5}$ s⁻¹ at 120 °C and $9.6\times10^{-5}$ s⁻¹ at 130 °C. With these
parameters $T_g(0.95) = 123$ °C and $T_g(0.98) = 133$ °C.

**Heat release.** The volumetric heat source is

$$
\dot q = \rho_c\,w_r\,H\,\frac{\mathrm{d}a}{\mathrm{d}t},
$$

with $H$ the heat of reaction per unit mass of resin (J/kg). In the discrete form the energy released in
cell $i$ over a step is $Q_i\,\Delta t = \rho_c w_r H V_i\,\Delta a_i$ (`q_scale * dq`). Only composite
cells react.

A useful scale is the adiabatic temperature rise $\Delta T_\text{ad} = w_r H / c_{p,c}$: for T800S/DGEBA
at $V_f = 0.6$ it is $0.308\times350\,000/888 \approx 121$ K, for T700S/Epoxy-LT about 143 K. A thick
wall that cannot shed heat would therefore run away; the exotherm limit is really a limit on how fast
heat must be conducted to the oven air.

### 3.2.4 Oven cycle and boundary conditions

**Cycle.** `cycle_of` returns the project's `composite.cure_cycle` if given, else the resin's recommended
cycle with every set point capped at `composite.cure_temperature` (the stress-free temperature used by the
structural model). Each step is (ramp rate K/min, set point °C, hold min). `oven_profile` builds the oven
air temperature $T_\infty(t)$ as a piecewise-linear curve: from ambient (`requirements.temperature_ref`)
ramp to each set point at its rate (in either direction), hold, and after the last hold cool at
`COOL_RATE` = 2 K/min back to ambient. The simulation ends when the **air** is back at ambient; it is
sampled on a uniform grid with $\Delta t = 10$ s.

**Outer surface: oven film.** A convective film coefficient $h$ (`composite.oven_htc`, default
25 W/(m² K), described as a rotating part in an oven) couples the outermost cell to the air. The
resistance from the outermost cell centre to the air is the half-cell conduction plus the film,
$1/(h\,r_\text{out})$ per radian per metre:

$$
G_\text{oven} = \left[\frac{\ln(r_\text{out}/r_N)}{k_c} + \frac{1}{h\,r_\text{out}}\right]^{-1},
\qquad \text{flux into cell } N = G_\text{oven}\,(T_\infty - T_N).
$$

**Inner surface: adiabatic.** No heat crosses the liner inner face: the air trapped inside the closed
vessel is neglected. The module docstring notes that this is conservative for both concerns: the
reaction heat cannot escape inwards (higher exotherm), and the inner laminate lags the oven more (lower
degree of cure at the inside).

**Initial state.** Uniform at the initial oven temperature, $a = 0$ everywhere.

### 3.2.5 Time integration

Each 10 s step is split into kinetics and conduction:

1. **Kinetics, explicit, sub-stepped.** With the temperatures frozen at the start of the step, the
   degree of cure is advanced in 4 explicit Euler sub-steps of $\Delta t/4$:
   $\Delta a = \dot a(T, a)\,\Delta t/4$, clipped so that $a \le 1$. The sub-stepping resolves the
   strong nonlinearity in $a$ (autocatalysis, vitrification) at little cost; the accumulated
   $\Delta a$ of the step is kept for the heat source.
2. **Conduction, implicit (backward Euler).** The temperatures at the new time solve

$$
\left(\frac{C_i}{\Delta t} + \sum_j G_{ij}\right)T_i^{k+1} - \sum_j G_{ij}\,T_j^{k+1}
= \frac{C_i}{\Delta t}\,T_i^{k} + \frac{\rho_c w_r H V_i\,\Delta a_i}{\Delta t} + \big[G_\text{oven}\,T_\infty^{k+1}\big]_{i=N},
$$

   with $G_\text{oven}$ also added to the last diagonal term. The banded (tridiagonal) system is solved
   with `scipy.linalg.solve_banded`; the matrix is assembled once because the properties do not depend
   on temperature or cure.

Backward Euler is unconditionally stable, so the 10 s step is set by accuracy, not by the 0.5 mm cells.
The operator splitting (kinetics at the old temperature) is first-order accurate; the step is short
compared to the cure times (hours) but the peak of a fast exotherm may be slightly smeared.

`docs/VALIDATION.md` reports: the degree of cure with the wall at the oven temperature matches an
independent scipy ODE integration of the kinetics within 0.01; zero heat of reaction gives zero
exotherm exactly; the exotherm increases monotonically with laminate thickness.

### 3.2.6 Exotherm against an inert reference

The **exotherm** is defined as the largest temperature rise, anywhere in the composite and at any time,
caused by the reaction heat. It is *not* $T - T_\infty$, nor $T - T_\text{set}$. `simulate_section`
solves a second temperature field $T^{(0)}$ in the same linear system (a second right-hand-side column):
the same wall, the same oven history, the same properties, but **no reaction heat**. The reported value is

$$
\Delta T_\text{exo} = \max_{t}\;\max_{i\,\in\,\text{composite}}\left(T_i(t) - T^{(0)}_i(t)\right)
\quad(\text{`overshoot`}).
$$

Why the inert reference: a thick wall heated through a film lags the oven air. During a ramp the wall is
colder than the air, during cool-down it is **hotter** than the air, purely by thermal inertia. For the
70 MPa example with the resin's default cycle, the inert wall is up to 30 K below the air during the
ramps and still 32-34 K **above** it when the air has returned to ambient at the end of the cool-down.
Measured against the oven air, that cool-down lag would be reported as a 30 K "exotherm" for a material
that releases no heat at all, and during heating the reaction heat would be partly hidden by the lag.
Because $T$ and $T^{(0)}$ share the same lag, their difference isolates the reaction heat, and the check
limits what the resin chemistry actually does (validated: zero heat of reaction gives exactly zero
exotherm). The same construction is why no special treatment of the cooling phase is needed.

### 3.2.7 Simulated sections

`_sections(b)` returns:

1. **Cylinder**: inner radius $R_\text{liner} - t_\text{liner}$, liner wall $t_\text{liner}$, composite
   thickness = sum of the cylinder thickness of all layers.
2. **Thickest dome section** (only if it is thicker than the cylinder): the dome region
   ($|z| >$ half the cylinder length) is sampled at 800 axial stations; the overwrap thickness at each is
   the sum of the layer thickness distributions; stations where the liner surface normal is nearly axial
   ($|n_r| \le 0.2$, i.e. close to the pole where a radial model makes no sense) are excluded. The
   thickest station is simulated as a cylinder of the local radius (liner radius minus the cylinder
   liner wall thickness), labelled `dome (z = ... mm)`.

The dome section is thus treated with the same 1-D radial model at the local radius; the meridional
slope, the boss thickening of the liner and the axial heat flow are ignored. For the 30 MPa example the
hoop-dominated cylinder (6.2 mm) is thicker than any dome station, so only the cylinder is simulated.

Recorded per section (240 samples): mean liner temperature, composite inner/mid/outer temperature and
degree of cure, oven air; scalars: exotherm, minimum final degree of cure over the composite cells,
$T_g$ at that minimum (`tg_final`), and peak liner temperature (including exotherm).

### 3.2.8 Cure checks

Emitted by `design.checks` when the analysis ran with cure (`analyze(..., with_cure=True)`, which is the
default for `/api/analyze`; the sizing loops use `with_cure=False`):

| Check | Criterion | Default limit |
|---|---|---|
| `cure.exotherm` | worst section $\Delta T_\text{exo} \le$ `max_exotherm` | 15 K |
| `cure.degree` | least-cured point $a_\text{min} \ge$ `min_cure` | 0.90 |
| `cure.tg` | $T_g(a_\text{min}) \ge T_\text{max,service} +$ `tg_margin` | 65 °C + 15 K = 80 °C |
| `liner.cure_temp` (metal liners) | peak liner temperature $\le$ liner `max_temp` | e.g. 150 °C for AA6061 |
| `liner.cure` (polymer liners, in `_polymer_checks`) | same, with the polymer limit | HDPE 85 °C |

All are blocking (`fail`) when violated.

### 3.2.9 Cure cycle suggestion

`suggest_cycle(b, max_evals=60)` searches for the **shortest** cycle meeting all four criteria.

**Candidate generation.**

- Final hold temperatures: $T_\text{top} = \min(T_\text{rec}, T_\text{liner,max} - \delta)$ where
  $T_\text{rec}$ is the highest temperature of the resin's recommended cycle, $T_\text{liner,max}$ the
  liner `max_temp`, and $\delta = 3$ K for polymer liners (margin for the exotherm on the liner), 0 for
  metals. The candidates are $\{T_\text{top}, T_\text{top}-5, T_\text{top}-10\}$ (rounded).
- Ramp rates: 2.0, 1.0, 0.5 K/min (one rate for the whole candidate).
- Final hold: 120, 240, 360, 480, 720 min.
- Either a single-step cycle, or a two-step cycle with an intermediate dwell at
  $T_d \in \{T_f-20, T_f-35, T_f-50\}$ (only if $T_d > T_\text{amb}+10$ K) for 60, 120 or 240 min.

This gives up to $3\times3\times5\times(1+9) = 450$ candidates.

**Ordering.** Candidates are sorted by total duration (ramps + holds + cool-down at 2 K/min to ambient,
the same definition as the oven profile). If there are more than `max_evals`, `_spread` keeps the
`max_evals/2` shortest and then every $k$-th of the rest ($k = \lfloor \text{rest}/(\text{max\_evals}-\text{head})\rfloor$)
so that long cycles remain reachable; for 450 candidates this is the 30 shortest plus every 14th.

**Evaluation and `_meets`.** Every section is simulated for each candidate, in duration order, and the
first candidate that meets all criteria is taken (hence the shortest feasible among those evaluated).
`_meets` returns (ok, badness) with

$$
\text{bad} = \frac{\max(\Delta T_\text{exo}-\Delta T_\text{max},0)}{5}
+ 20\,\max(a_\text{req}-a_\text{min},0)
+ \frac{\max(T_{g,\text{req}}-T_g,0)}{5}
+ \frac{\max(T_\text{liner,peak}-T_\text{liner,max},0)}{2},
$$

(worst values over the sections; the liner limit here is the plain `max_temp` without the 3 K margin).
The weights normalise the violations: 5 K of exotherm, 0.05 of degree of cure, 5 K of $T_g$ or 2 K of
liner temperature each count as one unit. $\text{ok} \iff \text{bad} \le 0$. If no candidate is feasible
the one with the smallest badness is returned with a note ("No candidate cycle meets every cure
criterion; the closest is shown ...").

The chosen cycle is re-analysed with `analyse` and returned with a note giving the number of steps and
the duration including cooling. The API route `/api/suggest-cure` also proposes
`cure_temperature = max(step temperatures)` as the stress-free temperature, so the structural model can
be kept consistent with the new cycle (the cure simulation itself does not feed residual stresses).

### 3.2.10 Worked numbers

**70 MPa, 2 L example (T800S / Epoxy-DGEBA, 3 mm AA6061 liner).** Cylinder composite 11.1 mm, thickest
dome section 14.4 mm at $z = 137$ mm (local inner radius 16.6 mm). $\rho_c = 1560$ kg/m³, $w_r = 0.308$,
$c_{p,c} = 888$ J/(kg K), $k_c = 0.697$ W/(m K).

| Cycle | Duration incl. cooling | $\Delta T_\text{exo}$ cyl / dome [K] | $a_\text{min}$ | $T_g$ [°C] | Peak liner [°C] | Result |
|---|---|---|---|---|---|---|
| Resin default, capped at `cure_temperature` 120 °C: 2 K/min to 90 °C, 120 min; 2 K/min to 120 °C, 240 min | 7.7 h | 17.9 / **23.3** | 0.954 | 124.6 | 141.0 | `cure.exotherm` **fails** (23.3 > 15 K) |
| Example's slow cycle: 0.5 K/min to 80 °C, 240 min; 0.5 K/min to 100 °C, 120 min; 1 K/min to 130 °C, 240 min | 14.1 h | 5.6 / 6.8 | 0.981 | 133.2 | 133.9 | all pass |
| `suggest_cycle`: 2 K/min to 100 °C, 120 min; 2 K/min to 120 °C, 120 min | 5.7 h | 10.3 / 12.1 | 0.928 | 116.5 | 129.5 | all pass |

The default cycle ramps into the reactive range quickly and lets the reaction run away in the thick
dome. The slow cycle consumes most of the reaction at 80-100 °C where the release rate is low and then
post-cures at 130 °C (higher $a$ and $T_g$). The suggester finds a much shorter cycle that also passes,
by dwelling at 100 °C (where roughly half the reaction heat is released slowly) before the final hold;
it trades margin on the degree of cure ($0.928$ vs $0.90$ required) and $T_g$ for time. Note that its
final hold is at 120 °C although $T_\text{top} = 130$ °C: the 120 °C candidates are shorter and one of
them already passes.

**Type IV example (T700S / Epoxy-LT, 5 mm HDPE liner, 85 °C liner limit, service max 85 °C +
10 K margin).** Cylinder 8.95 mm, thickest dome 11.1 mm at $z = -264$ mm.

| Cycle | Duration | $\Delta T_\text{exo}$ cyl / dome [K] | $a_\text{min}$ | $T_g$ [°C] | Peak liner [°C] |
|---|---|---|---|---|---|
| Example's cycle: 0.5 K/min to 50 °C, 240 min; to 70 °C, 240 min; to 80 °C, 480 min | 18.5 h | 4.0 / 4.7 | 0.905 | 98.9 | 80.4 |
| `suggest_cycle`: 0.5 K/min to 62 °C, 240 min; 0.5 K/min to 82 °C, 360 min | 12.6 h | 7.6 / 9.9 | 0.906 | 99.3 | 83.1 |

Here the liner limits the final temperature ($T_\text{top} = \min(85, 85-3) = 82$ °C) and the degree of
cure is limited by vitrification: at 80-82 °C the reaction stalls near $a \approx 0.905$, where
$T_g \approx 99$ °C, i.e. about $3\,\Delta T_v$ above the cure temperature ($f_d \approx 0.04$). That is
why both cycles land just above the 0.90 degree-of-cure and 95 °C $T_g$ requirements, and why
longer holds at the same temperature buy little.

For comparison, the thinner examples with the default DGEBA cycle: 30 MPa (6.2 mm) 9.3 K exotherm,
$a_\text{min} = 0.951$; desktop 1 L (1.5 mm cylinder, 3.7 mm dome) 5.2 K, $a_\text{min} = 0.948$.

### 3.2.11 Assumptions and limitations

- 1-D radial conduction at two sections; no axial or meridional heat flow, no mandrel/shaft heat sink,
  no conduction through the bosses. Dome section as a cylinder at the local radius.
- Adiabatic inner surface; uniform film coefficient (no air-flow model, no rotation dependence beyond
  the chosen $h$).
- Temperature- and cure-independent properties; generic fibre and resin thermal constants
  (aramid treated as carbon).
- Kinetics are generic per resin family (`docs/VALIDATION.md`: "reproduce typical datasheet cure
  behaviour but not a specific product. Fit A, E, m, n and the heat of reaction to DSC data").
- No resin flow, consolidation, void formation, cure shrinkage or residual-stress development; the
  structural stress-free temperature is the separate input `composite.cure_temperature`.
- The suggestion searches a fixed, coarse candidate grid with at most 60 evaluations; it is the shortest
  feasible cycle of that grid, not a continuous optimum, and it may skip feasible cycles among the
  thinned-out long candidates.

---

## 3.3 Burst sensitivity and statistical margin

The nominal burst pressure is a single number; material and process scatter make the real burst a
random variable. WindLab estimates its standard deviation with the first-order second-moment (FOSM)
method and reports a statistical lower bound, the probability of bursting below the requirement, and
which input dominates the variance.

**Where in the code:** `backend/windlab/core/sensitivity.py` (`inputs`, `_burst`, `analyse`, helpers
`_with_fiber`, `_with_liner`, `_composite`, `_liner_geom`); `schemas.SensitivitySpec`; route
`/api/sensitivity`.

### 3.3.1 FOSM with central differences

Let $B(\mathbf{x})$ be the burst pressure as a function of the scattered inputs $x_i$ with means
$\mu_i$ and standard deviations $s_i$. Linearising about the means and assuming independent inputs,

$$
\mu_B \approx B(\boldsymbol\mu),\qquad
\sigma_B^2 \approx \sum_i\left(\frac{\partial B}{\partial x_i}\,s_i\right)^2 .
$$

Each term is obtained by a central difference over $\pm1$ standard deviation:

$$
e_i = \frac{\partial B}{\partial x_i}\,s_i \approx \frac{B(\mu_i + s_i) - B(\mu_i - s_i)}{2},
$$

reported as `effect` (MPa per $+1$ sd), together with `burst_plus` and `burst_minus`. $B$ is the
**cylinder-model burst** from `design.structural(build(p))`, with the whole pressure history
recomputed for each perturbation: cure residual stresses, automatic autofrettage pressure, matrix
cracking. Each analysis takes a fraction of a second, so the 17 evaluations take a few seconds. The mean
is the nominal design ($\mu_B = B(\boldsymbol\mu)$, no second-order bias correction). If an input cannot
be perturbed (for example a geometry limit raises an error) it is reported with the error text and
zero effect.

This is FOSM in the mean-value sense (Cornell). The Hasofer-Lind reliability index, which linearises at
the most probable failure point rather than at the mean, is not used.

### 3.3.2 Inputs and default scatter

| Input | How it is perturbed | Default 1 sd |
|---|---|---|
| Fibre strength | fibre `strength` × $(1 \pm \text{CoV})$ | CoV 5 % |
| Fibre modulus | fibre `E` × $(1 \pm \text{CoV})$ | CoV 3 % |
| Fibre tex (fibre per band) | fibre `tex` × $(1 \pm \text{CoV})$ | CoV 2 % |
| Fibre volume fraction | $V_f \pm s$ | sd 0.015 |
| Translation efficiency | $\eta(1\pm\text{CoV})$, capped at 1 | CoV 3 % |
| Liner yield strength | liner `yield` **and** `ultimate` × $(1\pm\text{CoV})$ | CoV 5 % |
| Liner wall thickness | $t_\text{liner} \pm s$ | sd 0.05 mm |
| Cure (stress-free) temperature | `cure_temperature` $\pm s$ | sd 5 K |

The fibre and liner perturbations are applied by copying the material into the project's custom material
library under the same id, so the library entry is overridden for that evaluation only.

Physical reading of the model's response (it follows from how the inputs enter the ply model):

- Strength and translation efficiency both scale the delivered failure strain
  $\varepsilon_{1u} = \eta\sigma_f/E_f$, and burst is nearly proportional to it.
- The band thickness is computed from fibre area conservation, $t_b = N_\text{tows}\,A_\text{tow}/(B\,V_f)$
  with $A_\text{tow} = \text{tex}/\rho_f$, so a change of $V_f$ changes the thickness but not the amount of
  fibre: burst is almost insensitive to $V_f$. A change of tex changes the amount of fibre per band, and
  burst follows it.
- A higher modulus lowers $\varepsilon_{1u}$ at the same strength and stiffens the overwrap; the net effect
  on burst is small.

### 3.3.3 Lower bound and probability below the requirement

With the burst taken as normal, $B\sim\mathcal N(\mu_B,\sigma_B^2)$:

$$
B_{10} = \mu_B - z_{0.90}\,\sigma_B,\qquad z_{0.90} = 1.2816\;(\texttt{Z90}),
$$

the 10 % one-sided lower value (reported as `lower_90`), and

$$
P(B < p_\text{req}) = \Phi\!\left(\frac{p_\text{req}-\mu_B}{\sigma_B}\right)
= \tfrac12\operatorname{erfc}\!\left(\frac{\mu_B - p_\text{req}}{\sqrt2\,\sigma_B}\right),
$$

with $p_\text{req} = \text{BF}\,p_\text{MEOP}$ (for $\sigma_B = 0$ it is 1 or 0). $B_{10}$ is a percentile
of the assumed distribution with known parameters; it is **not** a statistical tolerance bound (there is
no sample size and no confidence level), unlike the B-basis in section 3.4.

### 3.3.4 Variance shares

$$
\text{share}_i = \frac{e_i^2}{\sum_j e_j^2},
$$

and the items are sorted by $|e_i|$. The shares tell which tolerance or material scatter to tighten first.

### 3.3.5 Worked numbers (default scatter)

| | Desktop `grbl-10mpa-1l` | `type3-30mpa-11l` |
|---|---|---|
| Nominal burst $\mu_B$ | 55.82 MPa | 113.51 MPa |
| $\sigma_B$ (CoV) | 2.96 MPa (5.3 %) | 6.59 MPa (5.8 %) |
| $B_{10} = \mu_B - 1.2816\,\sigma_B$ | 52.03 MPa | 105.06 MPa |
| $p_\text{req}$ | 20.0 MPa | 45.0 MPa |
| $P(B<p_\text{req})$ | $4\times10^{-34}$ | $1.3\times10^{-25}$ |

Effects and shares:

| Input | Desktop effect [MPa] | share | 30 MPa effect [MPa] | share |
|---|---|---|---|---|
| Fibre strength | 2.35 | 63.4 % | 5.34 | 65.6 % |
| Translation efficiency | 1.41 | 22.8 % | 3.20 | 23.6 % |
| Fibre tex | 0.94 | 10.0 % | 2.12 | 10.4 % |
| Liner yield strength | 0.45 | 2.3 % | 0.34 | 0.3 % |
| Liner wall thickness | 0.35 | 1.4 % | 0.19 | 0.1 % |
| Fibre modulus | -0.04 | < 0.1 % | -0.07 | < 0.1 % |
| Fibre volume fraction | -0.03 | < 0.1 % | -0.06 | < 0.1 % |
| Cure temperature | 0.00 | 0 % | 0.01 | 0 % |

As expected for a fibre-dominated burst (and as checked in `docs/VALIDATION.md`), fibre strength
dominates. The liner matters more for the desktop vessel, whose 1.5 mm liner carries a larger share.
Both designs are far above the requirement because they are sized by other criteria (liner, stress
ratio, progressive analysis), so the tiny probabilities mainly say that burst is not the governing
failure mode; they should not be read literally at such extreme tails.

### 3.3.6 Limitations

- **Linearisation:** the response is assumed linear over $\pm1$ sd. Mode switches (hoop-first to
  helical-first, autofrettage window limits) within that range break this.
- **Independence:** strength and translation efficiency act on the same quantity and are treated as
  independent; correlated inputs (e.g. $V_f$ and tex from the same process) are not modelled.
- **Normal tail:** $P(B<p_\text{req})$ extrapolates a normal distribution far into the tail.
- **Cylinder model only:** dome-critical designs are not captured (the result carries the note
  "Cylinder-model burst; dome-critical designs: check the progressive analysis"). The FE dome burst and
  the progressive analysis are not perturbed.
- Geometric tolerances other than the liner wall, winding angle scatter and defects are not included.

---

## 3.4 Test-data calibration

Test records attached to a project (`project.tests`, each with a kind `burst` / `proof` /
`autofrettage` / `cycle`, pressure, cycles, failure location and measured volumetric expansion) are
correlated with the predictions, and the fibre translation efficiency is re-estimated from the cylinder
bursts.

**Where in the code:** `backend/windlab/core/calibration.py` (`calibrate`, `_efficiency_for`, `_k_b`,
table `_K_B`); `schemas.TestRecord`, `schemas.CalibrationResult`; route `/api/calibrate`.

### 3.4.1 Correlation of each test

`calibrate` runs a full `analyze(project)` (with FE and cure), determines the predicted critical location
from the shell FE critical position (cylinder if $|z_\text{crit}|$ is within the cylinder half-length,
else dome A or B), and for each record:

- **burst**: the prediction is the cylinder-model burst if the vessel failed in the cylinder (or if there
  is no FE result), otherwise the FE dome burst (`fe.dome_burst`). The ratio measured/predicted is
  reported. For cylinder, dome-a and dome-b failures the location is compared with the predicted one
  (`location_match`). **Only cylinder failures** enter the calibration ratios
  $r_j = p_{\text{burst},j}/B_\text{pred}$.
- **cycle**: predicted cycles are $\min(N_\text{liner}, N_\text{hotspot,FE})$; the ratio is reported.
- **proof / autofrettage**: if the test pressure is within 5 % of the modelled reference pressure
  (autofrettage pressure, or $p_\text{MEOP}\times$ proof factor) and a total volumetric expansion was
  measured, the ratio measured/predicted total expansion is reported (`expansion_ratio`; the proof
  prediction is the water-jacket expansion measured from the post-autofrettage state).

A note is added when any burst failed at a location other than predicted.

### 3.4.2 Translation-efficiency correlation

The rationale (module docstring): burst is governed by the delivered fibre failure strain, which is
proportional to $\eta$; the liner share at burst is small, so the predicted burst is almost, but not
exactly, proportional to $\eta$. With $N$ cylinder bursts,

$$
\bar r = \frac1N\sum_j r_j,\qquad s_r = \sqrt{\frac{1}{N-1}\sum_j (r_j-\bar r)^2},\qquad \text{CoV} = s_r/\bar r .
$$

The **suggested efficiency** is the $\eta$ whose predicted cylinder burst equals $\bar r\,B_\text{pred}$.

**Secant iteration** (`_efficiency_for`): with $b(\eta)$ the cylinder burst from `analyze(..., with_cure=False)`,
start from $\eta_0$ (current) and $\eta_1 = \eta_0\,b^*/b(\eta_0)$ (the proportional guess), then

$$
\eta_{k+1} = \eta_k + \big(b^* - b(\eta_k)\big)\,\frac{\eta_k-\eta_{k-1}}{b(\eta_k)-b(\eta_{k-1})},
$$

clamped to $[0.3, 1.0]$, for at most 8 iterations or until $|b-b^*| < 10^{-3}b^*$. The result is
accepted only if it is within 1 % of the target; otherwise `None` and a note ("No translation efficiency
in 0.3-1.0 reproduces the measured bursts ..."). `docs/VALIDATION.md`: re-running with the suggested
efficiency reproduces a 0.92 × prediction target within 3 %.

### 3.4.3 B-basis

With $N \ge 2$ cylinder bursts, a B-basis target ratio is formed with the one-sided normal tolerance
factor $k_B(N)$ for 90 % content at 95 % confidence:

$$
r_B = \bar r - k_B(N)\,s_r ,
$$

and the **B-basis efficiency** is the $\eta$ whose predicted burst equals $r_B\,B_\text{pred}$ (same
secant iteration). It is computed only if $r_B > 0.3\,\bar r$; otherwise a note says that more tests are
needed. $k_B$ is tabulated (`_K_B`) for $N$ = 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 50 (e.g.
20.581, 6.155, 4.162, 3.407, ..., 2.355 at 10, 1.926 at 20, 1.646 at 50), linearly interpolated in $N$
between table entries, and extrapolated above 50 as $1.282 + (k_{50} - 1.282)\sqrt{50/N}$ (tending to
the normal quantile $z_{0.90}$). With a single burst only the point estimate is given.

This is the usual normal-distribution B-basis approach (as in CMH-17 / MIL-HDBK-17) applied to the
ratio measured/predicted, not to the raw strengths.

### 3.4.4 Worked example (hypothetical test data)

Desktop example (predicted cylinder burst 55.82 MPa, $\eta = 0.82$) with three *invented* cylinder
bursts at 50.0, 52.5 and 48.8 MPa:

| Quantity | Value |
|---|---|
| ratios $r_j$ | 0.896, 0.941, 0.874 |
| $\bar r$, CoV | 0.904, 3.7 % |
| suggested $\eta$ | 0.726 |
| $k_B(3)$ | 6.155 |
| $r_B = \bar r - k_B s_r$ | ≈ 0.695 |
| B-basis $\eta$ | 0.523 |

The suggested $\eta$ is lower than the proportional estimate $0.82\times0.904 = 0.741$ because the
burst is not exactly proportional to $\eta$ (the secant iteration takes care of this). With only three
tests the large $k_B$ makes the B-basis value very conservative.

### 3.4.5 Limitations

- Only one parameter ($\eta$) is calibrated; stiffness, liner properties and dome performance are
  compared but not fitted. Dome failures do not enter the calibration.
- Normality of the ratios is assumed for the B-basis.
- `calibrate` reports suggestions; it does not modify the project.

---

## 3.5 Layup suggestion

`suggest_layup` produces a complete layer sequence (helical and hoop layers, offsets, start angles,
tensions) from the liner, requirements and material, by a netting estimate followed by a rule-based
iteration on the full analysis checks.

**Where in the code:** `backend/windlab/core/design.py` (`suggest_layup`, inner function `make`,
`netting_thickness`, `_progressive_verify`, `_stagger_patterns`, `_best_stagger`,
`apply_tension_schedule`); `backend/windlab/core/tension.py` (`schedule`); route
`/api/suggest-layup?progressive=`; `presets.generate_examples` (examples are sized with
`progressive=True`).

### 3.5.1 Templates

The first helical and first hoop layers of the project, if present, are used as templates (tows, band
width, tension, winding type, friction...); otherwise a helical of 1 tow, 6 mm band, 25 N and a hoop of
1 tow, 6 mm, 35 N. The band thickness follows from fibre area conservation,

$$
t_b = \frac{N_\text{tows}\,A_\text{tow}}{B\,V_f},\qquad A_\text{tow} = \frac{\text{tex}}{1000\,\rho_f}\ \text{[mm}^2\text{]},
$$

with $B$ the band width. A helical layer ($\pm\alpha$ pair) and a hoop layer with 2 passes each deposit
$2t_b$ on the cylinder.

### 3.5.2 The netting start

`netting_thickness(b, p_req)` evaluates classical netting theory on the cylinder with a load share for the
liner at its yield stress:

$$
t_\text{hel} = \max\!\left(0,\ \frac{p R_i/2 - t_l\,\sigma_y/2}{X\cos^2\alpha}\right),\qquad
t_\text{hoop} = \max\!\left(0,\ \frac{p R_i - t_l\,\sigma_y}{X} - t_\text{hel}\sin^2\alpha\right),
$$

| Symbol | Meaning |
|---|---|
| $p$ | $p_\text{req}$ = BF × MEOP |
| $R_i$ | liner inner radius |
| $t_l$, $\sigma_y$ | liner wall thickness and yield stress |
| $X = E_1\varepsilon_{1u}$ | ply-level fibre-direction strength (delivered) |
| $\alpha$ | mean helical angle; with no helical layers yet, $\arcsin\!\big(\min((r_\text{boss}+3\text{ mm})/R, 0.9)\big)$ |

The layer counts are

$$
n_\text{hel} = \max\!\left(1, \left\lceil 1.15\,s\,\frac{t_\text{hel}}{2t_{b,\text{hel}}}\right\rceil\right),\qquad
n_\text{hoop} = \max\!\left(1, \left\lceil s\,\frac{t_\text{hoop}}{2t_{b,\text{hoop}}}\right\rceil\right),\qquad
s = \max\!\left(1, \frac{1}{\text{SR}\cdot\text{BF}}\right),
$$

where SR is `stress_ratio_limit`. The factor $s$ sizes for stress rupture as well: at MEOP a netting
laminate sized for burst runs at a fibre ratio of about $1/\text{BF}$, so if $1/\text{BF} > \text{SR}$ the
thickness is scaled up. The helicals get an additional fixed 15 %.

*Example, 30 MPa default project* (T700S-12K, 6 mm bands, $V_f = 0.6$: $t_b = 0.444/(6\times0.6) = 0.123$ mm;
SR = 0.6, BF = 1.5, $s = 1.11$): netting at 45 MPa gives $t_\text{hoop} = 1.48$ mm,
$t_\text{hel} = 0.80$ mm, hence $n_\text{hel} = \lceil 4.14\rceil = 5$, $n_\text{hoop} = \lceil 6.66\rceil = 7$.

### 3.5.3 Stacking: interleaving, hoops, helical offsets

`make(nh, nc)` builds the sequence:

- **Interleaving.** For position $k = 0\ldots N-1$ ($N = n_h + n_c$) the layer is helical if
  $\lfloor k\,n_h/N\rfloor \ne \lfloor (k+1)\,n_h/N\rfloor$, else hoop (a Bresenham-type even
  distribution). If the first layer would be helical, it is swapped with the first hoop, so the stack
  starts with a hoop on the liner. With this rule the last position is always helical, so the outermost
  layer is a helical. Example 30 MPa (8 helicals, 16 hoops):
  `hoop hoop hel hoop hoop hel ... hoop hoop hel`.
- **Full-length hoops.** Every hoop layer has 2 passes and zero end offsets (`end_offset_a = end_offset_b = 0`),
  i.e. all hoops run the full cylinder. This is a design rule taken from the progressive failure analysis:
  staggered hoop drop-offs concentrate bending at the ends of the hoop stack, and the 30 MPa example
  bursts at 53.8 MPa with staggered hoops but 73.9 MPa with full-length hoops (matching netting, about
  72 MPa); see `docs/VALIDATION.md`, "Progressive failure findings". The cylinder model cannot see this
  effect.
- **Helicals.** Initial turnaround offsets cycle through $0, 0.5, 1, \ldots, 2.5$ band widths (replaced
  later by `_best_stagger`), and start angles advance by the golden angle $137.508°$ modulo 360 so that
  the crossover lines of successive helical layers do not coincide.

### 3.5.4 Iteration rules

The layup is analysed with `analyze(..., with_cure=False)` (cylinder model, shell FE, tension, paths;
**no cure**), up to `max_iter = 60` times. Checks whose id starts with `tension.` are ignored (tension is
a process setting fixed afterwards). Each iteration applies the **first** matching rule, adds one layer,
rebuilds the stack with `make`, and repeats:

| # | Condition (in this order) | Action | Rationale |
|---|---|---|---|
| 1 | burst mode is helical-first, or `sr.helical` fails, or `burst.balance` warns, or the helical group fails `sr.reliability` | +1 helical | helicals are critical |
| 2 | `burst` fails, or `sr.hoop` fails, or the hoop group fails `sr.reliability` | +1 hoop | cylinder hoop capacity |
| 3 | `fe.burst` fails | +1 helical if the FE critical layer is helical, else +1 hoop | strengthen what fails in the FE |
| 4 | `fe.liner` fails | +1 helical if the liner hot spot is on a dome, else +1 hoop | reinforce the region of the liner bending hot spot |
| 5 | `liner.strain` fails (polymer liner) | +1 helical if the axial proof strain exceeds the hoop strain, else +1 hoop | stiffen the direction that strains most |
| 6 | `sr.temp` or `liner.lbb` fails | +1 hoop | lower the liner/fibre hoop stress |
| 7 | any of `af.window`, `af.reverse`, `fatigue`, `liner.meop`, `liner.temp` fails | +1 hoop, and +1 helical if $\rho_\text{hel} > 0.8\,\rho_\text{hoop}$ at MEOP | liner too dominant: stiffen the overwrap in proportion |
| - | none of the above | stop | converged, or the remaining fails (slippage, path...) cannot be fixed by adding layers; they are listed in a note |

If the analysis raises a `DesignError`, the loop stops and returns the last layup that could be analysed.
If 60 iterations do not converge a note says so.

*Trace, 30 MPa example* (non-progressive): start 5 hel + 7 hoop (burst 53 MPa). Iterations 1-2 add hoops
because the hoop group fails `sr.reliability` (rule 2); then `fe.liner` adds three helicals while the
liner hot spot is on a dome and one hoop once it has moved to the cylinder (rule 4); then the remaining
`liner.temp` failure adds hoops (rule 7; the helical ratio is below 0.8 × the hoop ratio, so no helicals)
until 8 hel + 16 hoop, burst 111 MPa, after 13 iterations. The burst requirement (45 MPa) was never the
governing criterion; the liner and stress-rupture checks were.

*Type IV example*: start 7 hel + 11 hoop; two hoops for `sr.reliability` (hoop group, rule 2), one
helical for a `burst.balance` warning (rule 1), then five helicals for `fe.burst` with a helical critical
layer (rule 3), converging at 13 + 13 after 9 iterations.

Runtime without progressive verification: 2-7 s for these examples.

### 3.5.5 Optional progressive verification

With `progressive=True` (API `?progressive=true`; always used for the shipped examples),
`_progressive_verify` runs the nonlinear progressive-failure shell analysis (`core/progressive.run`) on
the converged layup, up to `max_progressive + 1` = 9 times:

- if its burst pressure $\ge p_\text{req}$: stop with a note;
- otherwise add one layer: a hoop if the layer that failed at burst is a hoop, or if no layer was
  identified and the burst location is within the cylinder; otherwise a helical. Rebuild with `make`.

The layers added here are not re-checked with the rule loop of 3.5.4, and each progressive run takes
roughly 10 s to a minute. The shipped examples show the effect: the check loop alone converges at
8 helicals (30 MPa) and 13 helicals (Type IV), the shipped layups have 9 and 16, consistent with the
progressive analysis finding dome-critical failures (compare `docs/VALIDATION.md`: the 70 MPa example
with hemispherical domes first fails in dome A).

### 3.5.6 Helical turnaround stagger (`_best_stagger`)

Helical turnarounds that all end at the same polar radius build a ridge; later layers then bridge over the
concave flank beside it. With at least two helical layers, three offset patterns (in half band widths
$B/2$) are tried, with $\text{cap} = 0.3\,(R - r_\text{boss,max})$ and
$\text{steps} = \max(\lfloor \text{cap}/(B/2)\rfloor, 1)$, for helical $k = 0, 1, \ldots$:

| Pattern | Offset of helical $k$ |
|---|---|
| cyclic | $(k \bmod 6)\,B/2$ |
| ascending | $k\,B/2$ for $k \le$ steps, then restarting: $((k-\text{steps}-1) \bmod (\text{steps}+1))\,B/2$ |
| zigzag | triangular wave $0 \to \text{steps} \to 0$ in steps of $B/2$ |

Each candidate is analysed (`with_cure=False`); candidates with any failing (non-tension) check are
discarded; among the rest the one with the smallest **largest bridging gap** over all layers is chosen
(ties keep the earlier pattern: cyclic, ascending, zigzag). If none is feasible the layup is kept. For the
30 MPa example (R = 100, boss 20, B = 6 mm: cap = 24 mm, steps = 8) "ascending" is chosen, offsets
0, 3, ..., 24 mm, largest gap 0.16 mm.

Note that the stagger is chosen **after** the progressive verification, which ran with the initial
offsets of `make`.

### 3.5.7 Tension schedule

Finally `apply_tension_schedule` sets the winding tensions so that, after all layers are wound, every
layer retains the same fibre prestress (`tension.schedule`, thin-ring model of the cylinder). Winding
layer $k$ at ply stress $\sigma_{w,k} = T_k/(B_k t_{b,k})$ presses on the stack below with
$q_k = \sigma_{w,k} t_k\sin^2\alpha_k/R_k$; the stack below, of hoop stiffness
$S_k = E_\text{liner}t_\text{liner}/(1-\nu^2) + \sum_{j<k}E_{\theta,j}t_j$, contracts by
$\Delta\varepsilon_\theta = -q_kR_k/S_k$, and each earlier layer $j$ loses
$E_1\sin^2\alpha_j\,|\Delta\varepsilon_\theta|$ of fibre stress. Requiring equal residual stress
$\sigma^*$ in every layer gives a triangular system solved from the outside in:

$$
\sigma_{w,j} = \min\!\left(\sigma^* + E_1\sin^2\alpha_j\sum_{k>j}\frac{\sigma_{w,k}\,t_k\sin^2\alpha_k}{S_k},\ 5\,\sigma^*\right),
\qquad \sigma^* = \frac{T_\text{out}}{B_\text{out} t_{b,\text{out}}},
$$

where the outermost layer keeps its template tension $T_\text{out}$ and inner layers are capped at 5 times
the target stress. Tensions are rounded to 0.5 N. In the 70 MPa and Type IV examples the innermost hoops
hit the cap (150 N = 5 × 30 N of the outermost helical); low-angle helicals need barely more than the
target, since they lose little prestress.

The model neglects axial coupling, thermal and cure effects, resin squeeze-out and relaxation
(`tension.py` docstring); treat the schedule as a relative guide.

### 3.5.8 Limitations

- Only whole layers are added, never removed (use the optimiser, 3.6); the count grows by one per
  iteration, so the result is a feasible, not a minimum, layup.
- Helical angle, band width and tows come from the template; the suggester does not change them.
- Cure checks are not part of sizing (`with_cure=False`); run the full analysis afterwards.
- Warnings (other than `burst.balance`) do not drive the iteration.

---

## 3.6 Mass optimiser

`optimise(project, time_budget=60 s)` reduces the overwrap mass while keeping every check free of
failures, by greedy removal.

**Where in the code:** `backend/windlab/core/optimize.py` (`optimise`, `_moves`, `_evaluate`); route
`/api/optimise` (`time_budget` 5-600 s, default 60 s).

**Algorithm.**

1. Start from the current layup if it passes (`_evaluate`: `analyze(..., with_cure=False)`, no failing
   check except `tension.*`); otherwise from `suggest_layup(project)` (non-progressive). If that also
   fails, raise "No feasible starting layup".
2. Candidate moves (`_moves`): remove any layer as long as at least one helical and one hoop layer remain;
   reduce a hoop layer by one pass (if it has more than one). Each move is ranked by the mass it removes
   (layer fibre + resin mass, or that mass divided by the number of passes), heaviest first.
3. Evaluate the moves in that order and accept the **first** one that is feasible and lighter (by more
   than $10^{-6}$ g). Recompute the moves from the new layup and repeat until no move is accepted or the
   time budget is exhausted.

The result gives the layers, the mass before (of the feasible starting layup, which may be the suggested
one) and after, the number of full analyses, and a note per accepted move.

*Example*: desktop example, 394 g → 355 g (9.9 % lighter) in 8 evaluations by removing `hel2`; the
cylinder burst drops from 55.8 to 50.5 MPa (requirement 20 MPa), FE dome burst 48.4 MPa, and the
`burst.mode` warning appears (helical-first failure), which the optimiser accepts because it is a
warning, not a failure.

**Limitations.**

- Greedy first-improvement descent: a local optimum on a discrete neighbourhood; it never adds layers,
  reorders them, or changes angles, offsets or band widths.
- Cure checks and the progressive-failure analysis are **not** evaluated; the shipped examples were sized
  with progressive verification, so an optimised layup should be re-checked with the progressive
  analysis and the cure simulation.
- Warnings are allowed, and winding-tension checks are ignored.
- Each move costs a full analysis; with the time budget the search may stop early (a note says so).

---

## 3.7 References

1. B. D. Coleman, "Time dependence of mechanical breakdown phenomena," *Journal of Applied Physics* 27
   (1956) 862-866.
2. B. D. Coleman, "Statistics and time dependence of mechanical breakdown in fibers," *Journal of
   Applied Physics* 29 (1958) 968-983.
3. S. L. Phoenix, "Stochastic strength and fatigue of fiber bundles," *International Journal of Fracture*
   14 (1978) 327-344.
4. S. L. Phoenix and co-workers, stress-rupture reliability analyses of carbon/epoxy and Kevlar/epoxy
   COPVs for NASA (Weibull power-law breakdown model with proof-test credit); see also ANSI/AIAA S-081,
   *Space Systems - Composite Overwrapped Pressure Vessels*.
5. ISO 11119-2, *Gas cylinders - Refillable composite gas cylinders and tubes - Part 2: Fully wrapped
   fibre reinforced composite gas cylinders and tubes up to 450 l with load-sharing metal liners*.
6. ISO 11119-3, *Gas cylinders - Refillable composite gas cylinders and tubes - Part 3: Fully wrapped
   fibre reinforced composite gas cylinders and tubes up to 450 l with non-load-sharing metallic or
   non-metallic liners*.
7. ISO 11439, *Gas cylinders - High pressure cylinders for the on-board storage of natural gas as a fuel
   for automotive vehicles*.
8. M. R. Kamal and S. Sourour, "Kinetics and thermal characterization of thermoset cure," *Polymer
   Engineering and Science* 13 (1973) 59-64.
9. A. T. DiBenedetto, "Prediction of the glass transition temperature of polymers: a model based on the
   principle of corresponding states," *Journal of Polymer Science Part B: Polymer Physics* 25 (1987)
   1949-1969.
10. J. P. Pascault and R. J. J. Williams, "Glass transition temperature versus conversion relationships
    for thermosetting polymers," *Journal of Polymer Science Part B: Polymer Physics* 28 (1990) 85-95.
11. J. C. Maxwell, *A Treatise on Electricity and Magnetism*, Clarendon Press, Oxford, 1873.
12. Lord Rayleigh, "On the influence of obstacles arranged in rectangular order upon the properties of a
    medium," *Philosophical Magazine* 34 (1892) 481-502.
13. S. V. Patankar, *Numerical Heat Transfer and Fluid Flow*, Hemisphere, 1980.
14. C. A. Cornell, "A probability-based structural code," *ACI Journal* 66 (1969) 974-985.
15. A. M. Hasofer and N. C. Lind, "Exact and invariant second-moment code format," *Journal of the
    Engineering Mechanics Division, ASCE* 100 (1974) 111-121. (Background only; not used by WindLab.)
16. *Composite Materials Handbook CMH-17*, Volume 1, statistical methods for basis values (formerly
    MIL-HDBK-17).
17. M. G. Natrella, *Experimental Statistics*, NBS Handbook 91, 1963 (one-sided normal tolerance
    factors).
