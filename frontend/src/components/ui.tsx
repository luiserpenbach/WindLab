import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Status } from '../api/types';
import { Icon, type IconName } from './Icon';

// ------------------------------------------------------------------ buttons
export function Button({
  icon,
  variant = 'default',
  size,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm';
}) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${!children ? 'btn-icon' : ''} ${className ?? ''}`}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

// ------------------------------------------------------------------ status
export const STATUS_LABEL: Record<Status, string> = {
  ok: 'OK',
  warn: 'Warning',
  fail: 'Fail',
  info: 'Info',
};

const STATUS_ICON: Record<Status, IconName> = { ok: 'check', warn: 'alert', fail: 'x', info: 'info' };

export function StatusDot({ status, title }: { status: Status | null; title?: string }) {
  return (
    <span
      className={`status-dot s-${status ?? 'none'}`}
      title={title ?? (status ? STATUS_LABEL[status] : 'Not evaluated')}
      role="img"
      aria-label={status ? STATUS_LABEL[status] : 'not evaluated'}
    />
  );
}

export function StatusPill({ status, children }: { status: Status | null; children?: ReactNode }) {
  return (
    <span className={`status-pill s-${status ?? 'none'}`}>
      {status ? <Icon name={STATUS_ICON[status]} size={12} strokeWidth={2.4} /> : null}
      <span>{children ?? (status ? STATUS_LABEL[status] : '—')}</span>
    </span>
  );
}

export function StatusIcon({ status }: { status: Status }) {
  return (
    <span className={`status-icon s-${status}`} aria-label={STATUS_LABEL[status]} role="img">
      <Icon name={STATUS_ICON[status]} size={12} strokeWidth={2.6} />
    </span>
  );
}

// ------------------------------------------------------------------ feedback
export function Spinner({ size = 14, label = 'Loading' }: { size?: number; label?: string }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label={label} />;
}

export function Banner({
  kind = 'fail',
  children,
  onClose,
  action,
}: {
  kind?: Status;
  children: ReactNode;
  onClose?: () => void;
  action?: ReactNode;
}) {
  return (
    <div className={`banner b-${kind}`} role={kind === 'fail' ? 'alert' : 'status'}>
      <Icon name={STATUS_ICON[kind]} size={14} />
      <div className="banner-body">{children}</div>
      {action}
      {onClose ? (
        <button type="button" className="banner-close" aria-label="Dismiss" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function WarningList({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="warn-list">
      {items.map((w, i) => (
        <li key={i}>
          <Icon name="alert" size={12} /> <span>{w}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ KPI tile
export function Kpi({
  label,
  value,
  unit,
  sub,
  status,
  title,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  status?: Status | null;
  title?: string;
}) {
  return (
    <div className={`kpi ${status ? `k-${status}` : ''}`} title={title}>
      <div className="kpi-label">
        {status ? <StatusDot status={status} /> : null}
        {label}
      </div>
      <div className="kpi-value">
        {value}
        {unit ? <span className="kpi-unit">{unit}</span> : null}
      </div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------------ modal
export function Modal({
  title,
  open,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open ? (
        <div className="modal-inner">
          <header className="modal-head">
            <h2>{title}</h2>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
              <Icon name="x" />
            </button>
          </header>
          <div className="modal-body">{children}</div>
          {footer ? <footer className="modal-foot">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** Horizontal meter: value against a limit (used by KPI tiles). */
export function Meter({ value, limit, invert }: { value: number; limit: number; invert?: boolean }) {
  // invert: higher is better (e.g. burst vs required)
  const max = Math.max(value, limit) * 1.15 || 1;
  const pct = Math.min(100, (value / max) * 100);
  const lim = Math.min(100, (limit / max) * 100);
  const ok = invert ? value >= limit : value <= limit;
  return (
    <div className="meter" aria-hidden="true">
      <div className={`meter-fill ${ok ? 'ok' : 'bad'}`} style={{ width: `${pct}%` }} />
      <div className="meter-limit" style={{ left: `${lim}%` }} />
    </div>
  );
}
