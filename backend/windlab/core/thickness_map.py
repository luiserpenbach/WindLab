"""Band-level thickness simulation.

Every band of every circuit is laid onto the surface with its real width and
cross-section: along the fibre centre-line, the band spans ``+/- B/2`` in the
surface direction perpendicular to the fibre; each lateral strip deposits
``t_band * shape(d) * dd * dl`` of composite volume into a grid over the
meridian arclength ``s`` (of the liner, shared by all layers) and the
azimuth ``phi``. Thickness = deposited volume / cell area.

This resolves what the axisymmetric band-averaged model cannot: gaps and
overlaps from the pattern, crossover ridges, hoop pitch ridges and the
real distribution of the polar build-up.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .design import Build, BuiltLayer
from .winding import helical_layer_path, hoop_layer_path

SHAPES = ("rectangular", "lenticular", "elliptical")


def band_shape(kind: str, x: np.ndarray) -> np.ndarray:
    """Normalised cross-section (mean 1 over x in [-1, 1])."""
    if kind == "lenticular":  # parabolic
        return 1.5 * np.clip(1.0 - x**2, 0.0, None)
    if kind == "elliptical":
        return 4.0 / math.pi * np.sqrt(np.clip(1.0 - x**2, 0.0, None))
    return np.ones_like(x)


@dataclass
class ThicknessMap:
    s: np.ndarray  # cell centres, liner meridian arclength [mm]
    z: np.ndarray  # axial position of the cell centres [mm]
    phi: np.ndarray  # cell centres [rad]
    t: np.ndarray  # (len(s), len(phi)) thickness [mm]
    nominal: float  # nominal cylinder thickness of the layer(s) [mm]

    def stats(self, cyl_half: float) -> dict:
        cyl = np.abs(self.z) < cyl_half - 5.0
        t = self.t
        mean = t.mean(axis=1)
        out = {
            "mean": mean,
            "min": t.min(axis=1),
            "max": t.max(axis=1),
            "peak": float(t.max()),
        }
        if cyl.any() and self.nominal > 0:
            tc = t[cyl]
            out["cyl_mean"] = float(tc.mean())
            out["gap_fraction"] = float(np.mean(tc < 0.5 * self.nominal))
            out["overlap_fraction"] = float(np.mean(tc > 1.5 * self.nominal))
            out["cyl_cv"] = float(tc.std() / max(tc.mean(), 1e-12))
        else:
            out.update(cyl_mean=0.0, gap_fraction=0.0, overlap_fraction=0.0, cyl_cv=0.0)
        return out


def _grid(b: Build, ds: float, n_phi: int):
    s_l = b.liner_outer.s
    n_s = max(int(math.ceil(s_l[-1] / ds)), 2)
    edges = np.linspace(0.0, s_l[-1], n_s + 1)
    centres = 0.5 * (edges[1:] + edges[:-1])
    return edges, centres, n_phi


def _layer_points(b: Build, bl: BuiltLayer, step: float):
    """Dense centre-line of the whole layer: z, r, phi, alpha, liner-s."""
    from .kinematics import layer_path

    if bl.spec.type == "helical":
        path = layer_path(b, bl, samples=max(int(bl.gp.length / step), 200))
    else:
        path = layer_path(b, bl, samples=max(int(2 * math.pi * bl.R_mid / step), 72))
    # map the path onto the liner meridian coordinate via the shared point index of the profiles
    base = bl.base
    # meridian arclength on the base surface -> point index -> liner arclength (profiles share indices);
    # base.s is monotone even where the build-up folds in z
    idx = np.interp(path.s, base.s, np.arange(len(base.s), dtype=float))
    s_liner = np.interp(idx, np.arange(len(base.s)), b.liner_outer.s)
    return path, s_liner, np.asarray(path.s, dtype=float)


def layer_map(b: Build, bl: BuiltLayer, ds: float = 1.0, n_phi: int = 720, shape: str | None = None,
              lateral: float = 0.5) -> ThicknessMap:
    edges, centres, n_phi = _grid(b, ds, n_phi)
    # sample finer than the cells in both directions (the splat is only anti-aliasing)
    cell = min(ds, 2 * math.pi * float(np.median(bl.base.r)) / n_phi)
    lateral = min(lateral, 0.45 * cell)
    path, s_liner, s_base = _layer_points(b, bl, step=0.45 * cell)
    B = bl.spec.band_width
    t_b = bl.t_band
    r = path.r
    alpha = path.alpha if path.alpha is not None else np.full(len(r), math.pi / 2)
    # segment lengths on the surface (centre-line)
    P = path.xyz()
    dl = np.zeros(len(r))
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    dl[:-1] += 0.5 * seg
    dl[1:] += 0.5 * seg
    m = max(int(math.ceil(B / lateral)), 4)
    x = (np.arange(m) + 0.5) / m * 2 - 1  # strip centres in [-1, 1]
    dd = B / m
    w = band_shape(shape or bl.spec.band_shape, x)
    # lateral offset: meridian component -d sin(a), circumferential d cos(a) (arc length)
    sa, ca = np.sin(alpha), np.cos(alpha)
    d = 0.5 * B * x
    # base-surface arclength scale -> liner arclength (dS_liner / dS_base) for meridional offsets
    ratio = np.gradient(s_liner) / np.where(np.abs(np.gradient(s_base)) > 1e-12, np.gradient(s_base), 1.0)
    ratio = np.clip(np.nan_to_num(ratio, nan=1.0), 0.2, 5.0)
    # the width direction must be perpendicular to the direction of travel (A->B vs B->A passes)
    sgn = np.sign(np.gradient(s_liner))
    sgn[sgn == 0] = 1.0
    s_pts = s_liner[:, None] - d[None, :] * (sgn * sa * ratio)[:, None]
    phi_pts = path.phi[:, None] + d[None, :] * ca[:, None] / np.maximum(r[:, None], 1e-6)
    vol = ((t_b * dd) * dl[:, None] * w[None, :]).ravel()
    # bilinear splatting onto cell centres (anti-aliased band edges)
    n_s = len(centres)
    h = edges[1] - edges[0]
    fs = np.clip(s_pts.ravel() / h - 0.5, 0.0, n_s - 1.000001)
    fp = np.mod(phi_pts.ravel(), 2 * math.pi) / (2 * math.pi) * n_phi - 0.5
    i0 = np.floor(fs).astype(np.int64)
    j0 = np.floor(fp).astype(np.int64)
    ws, wp = fs - i0, fp - j0
    i1 = np.minimum(i0 + 1, n_s - 1)
    j0m, j1m = j0 % n_phi, (j0 + 1) % n_phi
    acc = np.zeros(n_s * n_phi)
    for ii, jj, ww in ((i0, j0m, (1 - ws) * (1 - wp)), (i1, j0m, ws * (1 - wp)),
                       (i0, j1m, (1 - ws) * wp), (i1, j1m, ws * wp)):
        acc += np.bincount(ii * n_phi + jj, weights=vol * ww, minlength=n_s * n_phi)
    acc = acc.reshape(n_s, n_phi)
    # cell area on the base surface: (ds_liner * ds_base/ds_liner) * r * dphi
    base = bl.base
    s_l = b.liner_outer.s
    r_c = np.interp(centres, s_l, base.r)
    ratio_b = np.interp(centres, s_l, np.gradient(base.s) / np.maximum(np.gradient(s_l), 1e-12))
    # where offset cleaning collapsed the build-up surface the local arc ratio tends to 0: floor it so the
    # deposited volume is spread over a physical area instead of producing infinite thickness
    ratio_b = np.maximum(ratio_b, 0.3)
    r_l = np.interp(centres, s_l, b.liner_outer.r)
    area = ratio_b * np.diff(edges) * np.maximum(r_c, 0.5 * r_l) * (2 * math.pi / n_phi)
    t = acc / area[:, None]
    z_c = np.interp(centres, s_l, b.liner_outer.z)
    phis = (np.arange(n_phi) + 0.5) * 2 * math.pi / n_phi
    return ThicknessMap(centres, z_c, phis, t, bl.t_cyl)


_MAP_CACHE: dict = {}


def _layer_key(b: Build, idx: int, kw: dict) -> str:
    import hashlib

    p = b.project
    blob = "|".join([p.liner.model_dump_json(), p.composite.model_dump_json(), p.materials.model_dump_json(),
                     p.machine.model_dump_json(include={"samples_per_pass"})]
                    + [L.model_dump_json() for L in p.layers[: idx + 1]] + [repr(sorted(kw.items()))])
    return hashlib.sha1(blob.encode()).hexdigest()


def cached_layer_map(b: Build, idx: int, **kw) -> ThicknessMap:
    key = _layer_key(b, idx, kw)
    if key not in _MAP_CACHE:
        if len(_MAP_CACHE) > 96:
            _MAP_CACHE.pop(next(iter(_MAP_CACHE)))
        _MAP_CACHE[key] = layer_map(b, b.layers[idx], **kw)
    return _MAP_CACHE[key]


def cumulative_map(b: Build, upto: int, **kw) -> ThicknessMap:
    maps = [cached_layer_map(b, i, **kw) for i in range(upto + 1)]
    t = sum(mp.t for mp in maps)
    nominal = sum(bl.t_cyl for bl in b.layers[: upto + 1])
    m0 = maps[0]
    return ThicknessMap(m0.s, m0.z, m0.phi, t, nominal)


def block_rows(a: np.ndarray, fs: int, how: str) -> np.ndarray:
    ns = len(a) // fs
    blk = a[: ns * fs].reshape(ns, fs)
    return {"mean": blk.mean, "min": blk.min, "max": blk.max}[how](axis=1)


def downsample(tm: ThicknessMap, max_s: int = 240, max_phi: int = 360) -> ThicknessMap:
    fs = max(int(math.ceil(len(tm.s) / max_s)), 1)
    fp = max(int(math.ceil(len(tm.phi) / max_phi)), 1)
    ns, npp = len(tm.s) // fs, len(tm.phi) // fp
    t = tm.t[: ns * fs, : npp * fp].reshape(ns, fs, npp, fp).mean(axis=(1, 3))
    s = tm.s[: ns * fs].reshape(ns, fs).mean(axis=1)
    z = tm.z[: ns * fs].reshape(ns, fs).mean(axis=1)
    phi = tm.phi[: npp * fp].reshape(npp, fp).mean(axis=1)
    return ThicknessMap(s, z, phi, t, tm.nominal)


def map_result(b: Build, layer_id: str, cumulative: bool, ds: float, n_phi: int):
    from .. import schemas as S

    idx = next((i for i, bl in enumerate(b.layers) if bl.spec.id == layer_id), None)
    if idx is None:
        raise KeyError(f"Layer '{layer_id}' not found")
    bl = b.layers[idx]
    tm = cumulative_map(b, idx, ds=ds, n_phi=n_phi) if cumulative else cached_layer_map(b, idx, ds=ds, n_phi=n_phi)
    half = b.project.liner.cyl_length / 2
    st = tm.stats(half)
    layers = b.layers[: idx + 1] if cumulative else [bl]
    s_l = b.liner_outer.s
    analytic = sum(np.interp(tm.s, s_l, L.thickness) for L in layers)
    ds_ = downsample(tm)
    fs_ = max(int(math.ceil(len(tm.s) / 240)), 1)
    warnings = []
    if st["gap_fraction"] > 0.005:
        warnings.append(f"{st['gap_fraction'] * 100:.1f}% of the cylinder is below half the nominal thickness (gaps)")
    if st["overlap_fraction"] > 0.05:
        warnings.append(f"{st['overlap_fraction'] * 100:.1f}% of the cylinder is above 1.5x nominal (overlaps)")
    a_peak = float(np.max(analytic)) if len(analytic) else 0.0
    if a_peak > 0 and st["peak"] > 1.25 * a_peak:
        warnings.append(f"Local build-up peak {st['peak']:.2f} mm is {st['peak'] / a_peak:.2f}x the axisymmetric "
                        "estimate (crossover / turnaround ridges)")
    rnd = lambda a: np.round(np.asarray(a, dtype=float), 4).tolist()  # noqa: E731
    return S.ThicknessMapResult(
        layer_id=layer_id, cumulative=cumulative,
        z=rnd(ds_.z), s=rnd(ds_.s), r=rnd(np.interp(ds_.s, s_l, bl.top.r)),
        z_surface=rnd(np.interp(ds_.s, s_l, bl.top.z)), phi=rnd(np.degrees(ds_.phi)),
        t=np.round(ds_.t, 4).tolist(),
        mean=rnd(block_rows(st["mean"], fs_, "mean")),
        min=rnd(block_rows(st["min"], fs_, "min")),
        max=rnd(block_rows(st["max"], fs_, "max")),
        analytic=rnd(np.interp(ds_.s, tm.s, analytic)),
        nominal=tm.nominal, peak=st["peak"], analytic_peak=a_peak, cyl_mean=st["cyl_mean"], cyl_cv=st["cyl_cv"],
        gap_fraction=st["gap_fraction"], overlap_fraction=st["overlap_fraction"], warnings=warnings,
    )
