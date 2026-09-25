import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { sig } from '../util/format';

// ------------------------------------------------------------------ layout
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  title,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className="field" title={title}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="field-control">{children}</div>
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export function Section({
  title,
  children,
  actions,
  defaultOpen = true,
}: {
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`section ${open ? 'open' : ''}`}>
      <header className="section-head">
        <button type="button" className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="chev">
            <path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          {title}
        </button>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </header>
      {open ? <div className="section-body">{children}</div> : null}
    </section>
  );
}

// ------------------------------------------------------------------ number input
export interface NumberInputProps {
  value: number | null;
  onCommit: (v: number) => void;
  unit?: string;
  /** inclusive bounds */
  min?: number;
  max?: number;
  /** exclusive bounds */
  gt?: number;
  lt?: number;
  integer?: boolean;
  /** Arrow-key step (Shift = x10, Alt = x0.1). */
  step?: number;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  /** Digits shown when not editing (significant figures). */
  precision?: number;
  className?: string;
  /** If set, an empty field commits "no value" via this callback. */
  onClear?: () => void;
}

function validate(
  v: number,
  { min, max, gt, lt, integer }: Pick<NumberInputProps, 'min' | 'max' | 'gt' | 'lt' | 'integer'>,
): string | null {
  if (!Number.isFinite(v)) return 'Not a number';
  if (integer && !Number.isInteger(v)) return 'Must be an integer';
  if (min != null && v < min) return `Must be ≥ ${min}`;
  if (max != null && v > max) return `Must be ≤ ${max}`;
  if (gt != null && v <= gt) return `Must be > ${gt}`;
  if (lt != null && v >= lt) return `Must be < ${lt}`;
  return null;
}

/** Parse user text: accepts "1,5", "1e3", leading "+", and simple arithmetic like "300/2". */
export function parseNumber(text: string): number {
  const t = text.trim().replace(/,/g, '.').replace(/\s+/g, '');
  if (t === '') return NaN;
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return Number(t);
  // allow a tiny expression grammar: numbers, + - * / ( )
  if (/^[\d.eE+\-*/()]+$/.test(t)) {
    try {
      const v = Function(`"use strict";return (${t});`)() as unknown;
      return typeof v === 'number' ? v : NaN;
    } catch {
      return NaN;
    }
  }
  return NaN;
}

/**
 * Text-based numeric input: edits are local until Enter / blur, Escape
 * reverts, ArrowUp/Down step and commit. Accepts decimals with "." or ",".
 */
export function NumberInput(props: NumberInputProps) {
  const {
    value,
    onCommit,
    unit,
    step = 1,
    disabled,
    placeholder,
    id,
    ariaLabel,
    precision = 6,
    integer,
    className,
  } = props;
  const shown = value == null ? '' : sig(value, precision);
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(shown);
      setErr(null);
    }
  }, [shown, editing]);

  const commit = (text: string): boolean => {
    if (props.onClear && text.trim() === '') {
      setErr(null);
      if (value != null) props.onClear();
      return true;
    }
    const v = parseNumber(text);
    const e = validate(v, props);
    if (e) {
      setErr(e);
      return false;
    }
    setErr(null);
    const out = integer ? Math.round(v) : v;
    if (out !== value) onCommit(out);
    setDraft(sig(out, precision));
    return true;
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (commit(draft)) setEditing(false);
    } else if (e.key === 'Escape') {
      setDraft(shown);
      setErr(null);
      setEditing(false);
      ref.current?.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = Number.isFinite(parseNumber(draft)) ? parseNumber(draft) : (value ?? 0);
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      let next = base + (e.key === 'ArrowUp' ? 1 : -1) * step * mult;
      next = Number(next.toPrecision(12));
      if (props.min != null) next = Math.max(props.min, next);
      if (props.max != null) next = Math.min(props.max, next);
      const s = sig(next, precision);
      setDraft(s);
      commit(s);
    }
  };

  return (
    <div className={`numin ${err ? 'invalid' : ''} ${disabled ? 'disabled' : ''} ${className ?? ''}`}>
      <input
        ref={ref}
        id={id}
        type="text"
        inputMode="decimal"
        data-numeric="1"
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-invalid={!!err}
        title={err ?? undefined}
        disabled={disabled}
        placeholder={placeholder}
        value={draft}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          if (err) setErr(validate(parseNumber(e.target.value), props));
        }}
        onBlur={() => {
          if (!commit(draft)) {
            // keep the invalid text visible briefly, then revert
            setDraft(shown);
            window.setTimeout(() => setErr(null), 2500);
          }
          setEditing(false);
        }}
        onKeyDown={onKey}
      />
      {unit ? <span className="numin-unit">{unit}</span> : null}
    </div>
  );
}

export function NumberField({
  label,
  hint,
  title,
  ...rest
}: NumberInputProps & { label: ReactNode; hint?: ReactNode; title?: string }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint={hint} title={title}>
      <NumberInput id={id} {...rest} />
    </Field>
  );
}

// ------------------------------------------------------------------ text
export function TextInput({
  value,
  onCommit,
  id,
  ariaLabel,
  placeholder,
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      id={id}
      type="text"
      className={`text ${className ?? ''}`}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

// ------------------------------------------------------------------ select
export interface Option<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  id,
  ariaLabel,
  className,
  placeholder,
}: {
  value: T | null;
  options: Option<T>[];
  onChange: (v: T) => void;
  id?: string;
  ariaLabel?: string;
  className?: string;
  placeholder?: string;
}) {
  const known = value != null && options.some((o) => o.value === value);
  return (
    <select
      id={id}
      className={`select ${className ?? ''}`}
      aria-label={ariaLabel}
      value={value == null ? '' : String(value)}
      onChange={(e) => {
        const o = options.find((o) => String(o.value) === e.target.value);
        if (o) onChange(o.value);
      }}
    >
      {value == null || placeholder ? (
        <option value="" disabled>
          {placeholder ?? '—'}
        </option>
      ) : null}
      {!known && value != null ? <option value={String(value)}>{String(value)} (unknown)</option> : null}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function SelectField<T extends string | number>({
  label,
  hint,
  ...rest
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: T | null;
  options: Option<T>[];
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Select id={id} {...rest} />
    </Field>
  );
}

// ------------------------------------------------------------------ segmented / toggle
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  size,
}: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  ariaLabel?: string;
  size?: 'sm';
}) {
  return (
    <div className={`segmented ${size ?? ''}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  id,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      {label ? <span className="switch-label">{label}</span> : null}
    </label>
  );
}

// ------------------------------------------------------------------ slider + number
export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  hint,
  gt,
  lt,
  display,
}: {
  label: ReactNode;
  value: number;
  onChange: (v: number, live: boolean) => void;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: ReactNode;
  gt?: number;
  lt?: number;
  /** Optional formatter for the value next to the slider. */
  display?: (v: number) => string;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="slider-row">
        <input
          type="range"
          className="range"
          aria-label={typeof label === 'string' ? label : undefined}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value), true)}
        />
        <NumberInput
          id={id}
          value={value}
          onCommit={(v) => onChange(v, false)}
          unit={unit}
          gt={gt}
          lt={lt}
          min={gt == null ? min : undefined}
          max={lt == null ? max : undefined}
          step={step}
          precision={4}
          className="numin-sm"
        />
      </div>
      {display ? <span className="sr-only">{display(value)}</span> : null}
    </Field>
  );
}
