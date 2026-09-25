/** Number formatting helpers (engineering display). */

export function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(Math.max(1, digits - 1));
  return v.toFixed(digits);
}

/** Significant-figure formatting without trailing zero noise. */
export function sig(v: number | null | undefined, n = 4): string {
  if (v == null || !Number.isFinite(v)) return '–';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e7 || a < 1e-4) return v.toExponential(n - 1);
  const d = Math.max(0, n - 1 - Math.floor(Math.log10(a)));
  return String(Number(v.toFixed(Math.min(d, 10))));
}

export function fmtInt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '–';
  return Math.round(v).toLocaleString('en-US');
}

export function fmtCycles(v: number | null | undefined): string {
  if (v == null) return '–';
  if (!Number.isFinite(v) || v >= 1e9) return '∞';
  if (v >= 1e5) return v.toExponential(2);
  return fmtInt(v);
}

export function fmtTime(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '–';
  const neg = s < 0;
  s = Math.abs(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const body = h
    ? `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(0).padStart(2, '0')}`
    : `${m}:${sec.toFixed(1).padStart(4, '0')}`;
  return (neg ? '-' : '') + body;
}

export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '–';
  if (s < 60) return `${s.toFixed(0)} s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

export function fmtMass(g: number | null | undefined): string {
  if (g == null || !Number.isFinite(g)) return '–';
  return g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${g.toFixed(0)} g`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function downloadText(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(s: string): string {
  return (
    s
      .trim()
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'project'
  );
}
