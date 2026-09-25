import { useMemo } from 'react';
import type { ThicknessMapResult } from '../api/types';
import { scaleDomain, viridis, type Rgb } from '../viewer/colormaps';
import { useUi, type ThkScale } from './uiStore';

export interface ThicknessScale {
  /** Upper end of the colour scale [mm] (values above saturate). */
  hi: number;
  /** Largest finite value in the map [mm]. */
  max: number;
  /** True when the scale is clipped below the maximum. */
  clipped: boolean;
  /** Any cell without a finite value. */
  nodata: boolean;
  /** Colour for a thickness [mm] (viridis over 0..hi). */
  color: (t: number) => Rgb;
}

const cache = new WeakMap<ThicknessMapResult, Map<ThkScale, ThicknessScale>>();

/** Colour scale of a thickness map (cached per map object and scale mode). */
export function thicknessScale(map: ThicknessMapResult, mode: ThkScale): ThicknessScale {
  let m = cache.get(map);
  if (!m) cache.set(map, (m = new Map()));
  const hit = m.get(mode);
  if (hit) return hit;
  let nodata = false;
  const vals: (number | null)[] = [];
  for (const row of map.t)
    for (const v of row) {
      if (v == null || !Number.isFinite(v)) nodata = true;
      vals.push(v);
    }
  const d = scaleDomain(vals, mode === 'robust');
  const max = d.max;
  const hi = mode === 'nominal' && map.nominal > 0 ? 2 * map.nominal : d.hi;
  const sc: ThicknessScale = {
    hi,
    max,
    clipped: max > hi * (1 + 1e-6),
    nodata,
    color: (t: number) => viridis(t / hi),
  };
  m.set(mode, sc);
  return sc;
}

/** Colour scale of the current thickness map in the UI store. */
export function useThicknessScale(): ThicknessScale | null {
  const { thk, overlay } = useUi();
  const mode = overlay.thkScale;
  return useMemo(() => (thk ? thicknessScale(thk, mode) : null), [thk, mode]);
}
