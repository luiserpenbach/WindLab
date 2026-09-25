import type {
  AnalysisResult,
  ExampleProject,
  GcodeResponse,
  Health,
  LayerRequest,
  MachinePreset,
  MaterialsResponse,
  OkResponse,
  PathResult,
  Project,
  ProjectListEntry,
  SimulationResult,
  SuggestLayupResponse,
  TensionScheduleRequest,
  TensionScheduleResult,
  ThicknessMapRequest,
  ThicknessMapResult,
  TravellerResponse,
} from './types';

const BASE = resolveBase();

/** Resolve `/api` relative to where the bundle is served (supports sub-paths). */
function resolveBase(): string {
  // When served at the site root this yields "/api"; when served from a
  // sub-path (e.g. /windlab/) it yields "/windlab/api".
  if (typeof window === 'undefined') return '/api';
  const path = window.location.pathname.replace(/[^/]*$/, '');
  return `${path.replace(/\/$/, '')}/api`;
}

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

interface PydanticErr {
  loc?: (string | number)[];
  msg?: string;
}

/** Turn a FastAPI `detail` (string or pydantic error list) into readable text. */
export function formatDetail(detail: unknown): string {
  if (detail == null) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d: PydanticErr | string) => {
        if (typeof d === 'string') return d;
        const loc = (d.loc ?? []).filter((p) => p !== 'body').join('.');
        return loc ? `${loc}: ${d.msg ?? ''}` : (d.msg ?? JSON.stringify(d));
      })
      .join('; ');
  }
  if (typeof detail === 'object') return JSON.stringify(detail);
  return String(detail);
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'Backend unreachable (is the WindLab server running?)', null);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const detail =
      data && typeof data === 'object' && 'detail' in (data as Record<string, unknown>)
        ? (data as Record<string, unknown>).detail
        : data;
    const msg = formatDetail(detail) || `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg, detail);
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.status ? `${e.message}` : e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

const enc = encodeURIComponent;

export const api = {
  health: (s?: AbortSignal) => request<Health>('GET', '/health', undefined, s),
  materials: (s?: AbortSignal) => request<MaterialsResponse>('GET', '/materials', undefined, s),
  machines: (s?: AbortSignal) => request<MachinePreset[]>('GET', '/machines', undefined, s),
  examples: (s?: AbortSignal) => request<ExampleProject[]>('GET', '/examples', undefined, s),
  analyze: (p: Project, s?: AbortSignal) => request<AnalysisResult>('POST', '/analyze', p, s),
  suggestLayup: (p: Project, s?: AbortSignal) => request<SuggestLayupResponse>('POST', '/suggest-layup', p, s),
  path: (r: LayerRequest, s?: AbortSignal) => request<PathResult>('POST', '/path', r, s),
  simulate: (r: LayerRequest, s?: AbortSignal) => request<SimulationResult>('POST', '/simulate', r, s),
  thicknessMap: (r: ThicknessMapRequest, s?: AbortSignal) =>
    request<ThicknessMapResult>('POST', '/thickness-map', r, s),
  tensionSchedule: (r: TensionScheduleRequest, s?: AbortSignal) =>
    request<TensionScheduleResult>('POST', '/tension-schedule', r, s),
  gcode: (project: Project, layer_ids: string[] | null, s?: AbortSignal) =>
    request<GcodeResponse>('POST', '/gcode', { project, layer_ids }, s),
  traveller: (p: Project, s?: AbortSignal) => request<TravellerResponse>('POST', '/traveller', p, s),
  listProjects: (s?: AbortSignal) => request<ProjectListEntry[]>('GET', '/projects', undefined, s),
  getProject: (name: string, s?: AbortSignal) => request<Project>('GET', `/projects/${enc(name)}`, undefined, s),
  saveProject: (name: string, p: Project) => request<OkResponse>('PUT', `/projects/${enc(name)}`, p),
  deleteProject: (name: string) => request<OkResponse>('DELETE', `/projects/${enc(name)}`),
};
