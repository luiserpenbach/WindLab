import type { Check, Status } from '../api/types';
import { StatusIcon } from '../components/ui';
import { useUi } from '../state/uiStore';
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
  const { revealLayer } = useUi();
  if (!checks.length) return null;
  const list = sort ? [...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]) : checks;
  return (
    <div className="checks">
      <div className="checks-title">{title}</div>
      <ul>
        {list.map((c) => (
          <li
            key={c.id}
            className={`check c-${c.status} ${c.refs?.length ? 'has-refs' : ''}`}
            title={c.detail || undefined}
            // Mouse shortcut: the whole row shows the first layer; the chips below are the keyboard targets.
            onClick={c.refs?.length ? () => revealLayer(c.refs[0]) : undefined}
          >
            <StatusIcon status={c.status} />
            <div className="check-main">
              <div className="check-label">{c.label}</div>
              {c.detail ? <div className="check-detail">{c.detail}</div> : null}
              {c.refs?.length ? (
                <div className="check-refs">
                  {c.refs.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="check-ref"
                      title={`Show layer ${id} in the Layup step`}
                      onClick={(e) => {
                        e.stopPropagation();
                        revealLayer(id);
                      }}
                    >
                      {id}
                    </button>
                  ))}
                </div>
              ) : null}
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
