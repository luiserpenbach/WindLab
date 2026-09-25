import { useMemo } from 'react';
import type { CustomLiner, Fiber, LinerMaterial, MaterialLibrary, Project, Resin } from '../api/types';
import type { Option } from '../components/fields';
import { useCatalog } from './analysis';
import { useProject } from './projectStore';

/**
 * Built-in (GET /api/materials) + project-specific (Project.materials)
 * materials. Custom records take precedence over a built-in with the same id,
 * as in the backend (core/materials.py get_fiber / get_resin / get_liner).
 */
export type MatKind = keyof MaterialLibrary;

export interface MatEntry<T> {
  rec: T;
  custom: boolean;
  /** Built-in record hidden by a custom one with the same id. */
  shadowed: boolean;
}

export interface MaterialLists {
  fibers: MatEntry<Fiber>[];
  resins: MatEntry<Resin>[];
  liners: MatEntry<LinerMaterial>[];
  /** Built-in catalog loaded. */
  loaded: boolean;
}

/** Linear plastic hardening fitted between yield and ultimate (mirrors LinerMaterial.hardening). */
export function linerHardening(m: Pick<CustomLiner, 'E' | 'yield' | 'ultimate' | 'elongation'>): number {
  const epsP = Math.max(m.elongation - m.yield / m.E, 1e-3);
  return Math.max((m.ultimate - m.yield) / epsP, 1);
}

function merge<T extends { id: string }>(builtin: T[], custom: T[]): MatEntry<T>[] {
  const ids = new Set(custom.map((c) => c.id));
  return [
    ...custom.map((rec) => ({ rec, custom: true, shadowed: false })),
    ...builtin.map((rec) => ({ rec, custom: false, shadowed: ids.has(rec.id) })),
  ];
}

export function mergeMaterials(
  catalog: { fibers: Fiber[]; resins: Resin[]; liners: LinerMaterial[] } | null,
  lib: MaterialLibrary,
): MaterialLists {
  return {
    fibers: merge(catalog?.fibers ?? [], lib.fibers),
    resins: merge(catalog?.resins ?? [], lib.resins),
    liners: merge(
      catalog?.liners ?? [],
      lib.liners.map((l) => ({ ...l, hardening: linerHardening(l) })),
    ),
    loaded: !!catalog,
  };
}

export function useMaterialLists(): MaterialLists {
  const { materials } = useCatalog();
  const { project } = useProject();
  const lib = project.materials;
  return useMemo(() => mergeMaterials(materials, lib), [materials, lib]);
}

/** The effective record for an id (custom first). */
export function findMat<T extends { id: string }>(
  list: MatEntry<T>[],
  id: string | null | undefined,
): MatEntry<T> | null {
  if (!id) return null;
  return list.find((e) => e.rec.id === id && !e.shadowed) ?? null;
}

/** Select options: custom records first, marked "custom"; shadowed built-ins left out. */
export function matOptions<T extends { id: string; name: string }>(list: MatEntry<T>[]): Option<string>[] {
  return list
    .filter((e) => !e.shadowed)
    .map((e) => ({ value: e.rec.id, label: e.custom ? `${e.rec.name} (custom)` : e.rec.name }));
}

/** Where a material id is used in the project (for delete / rename). */
export function materialUsage(p: Project, kind: MatKind, id: string): string[] {
  const out: string[] = [];
  if (kind === 'fibers') {
    if (p.composite.fiber === id) out.push('project fibre');
    const ls = p.layers.filter((l) => l.fiber === id).map((l) => l.id);
    if (ls.length) out.push(`layer${ls.length > 1 ? 's' : ''} ${ls.join(', ')}`);
  } else if (kind === 'resins') {
    if (p.composite.resin === id) out.push('project resin');
  } else if (p.liner.material === id) out.push('liner');
  return out;
}

/** Replace every reference to material `from` by `to` (id rename). */
export function renameMaterialRefs(p: Project, kind: MatKind, from: string, to: string): Project {
  if (from === to) return p;
  if (kind === 'fibers')
    return {
      ...p,
      composite: p.composite.fiber === from ? { ...p.composite, fiber: to } : p.composite,
      layers: p.layers.some((l) => l.fiber === from)
        ? p.layers.map((l) => (l.fiber === from ? { ...l, fiber: to } : l))
        : p.layers,
    };
  if (kind === 'resins') return p.composite.resin === from ? { ...p, composite: { ...p.composite, resin: to } } : p;
  return p.liner.material === from ? { ...p, liner: { ...p.liner, material: to } } : p;
}
