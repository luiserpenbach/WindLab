import type { Check, Status } from '../api/types';
import { StatusIcon } from '../components/ui';
import { sig } from '../util/format';

const ORDER: Record<Status, number> = { fail: 0, warn: 1, info: 2, ok: 3 };

/** The most severe check of a list (fail > warn > info > ok), or null. */
export function worstCheck(checks: Check[]): Check | null {
  let w: Check | null = null;
  for (const c of checks) if (!w || ORDER[c.status] < ORDER[w.status]) w = c;
  return w;
}

export function ChecksList({
  checks,
  title = 'Checks',
  sort = true,
}: {
  checks: Check[];
  title?: string;
  sort?: boolean;
}) {
  if (!checks.length) return null;
  const list = sort ? [...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]) : checks;
  return (
    <div className="checks">
      <div className="checks-title">{title}</div>
      <ul>
        {list.map((c) => (
          <li key={c.id} className={`check c-${c.status}`} title={c.detail || undefined}>
            <StatusIcon status={c.status} />
            <div className="check-main">
              <div className="check-label">{c.label}</div>
              {c.detail ? <div className="check-detail">{c.detail}</div> : null}
            </div>
            {c.value != null ? (
              <div className="check-val">
                {sig(c.value, 4)}
                {c.limit != null ? <span className="check-lim"> / {sig(c.limit, 4)}</span> : null}
                {c.unit ? <span className="check-unit"> {c.unit}</span> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
