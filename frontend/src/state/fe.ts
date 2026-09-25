import type { FEResult, LinerSpec } from '../api/types';

/**
 * Elements outside the rigid-ring boss clamp zone (`FEResult.valid`); the
 * backend uses them for peaks and hot spots. Older backends without `valid`:
 * r > boss radius + 3 x wall (the same rule).
 */
export function feValidMask(fe: FEResult, l: LinerSpec): boolean[] {
  if (fe.valid?.length === fe.z.length) return fe.valid;
  return fe.z.map((z, i) => fe.r[i] > (z < 0 ? l.boss_radius_a : l.boss_radius_b) + 3 * l.wall_thickness);
}
