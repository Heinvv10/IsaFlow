/**
 * DebouncedAmountInput - an amount filter that waits for the person to stop typing (WP3). The parent's value (and so
 * the list query) changes 500 ms after the last keystroke, on blur or on Enter; before that the draft is local. The old
 * inputs pushed every keystroke straight to the parent and armed a timer that did nothing.
 * A bound that is not a plain non-negative amount (a sign, an exponent, more than 4 decimals) is flagged on the field and
 * never sent: the list keeps its rows instead of blanking on the API's 400.
 */
import { useEffect, useRef, useState } from 'react';
import { AMOUNT_BOUND_RE } from '@/modules/accounting/utils/bankAmountBound';

export const AMOUNT_DEBOUNCE_MS = 500;

interface Props { id: string; label: string; value: string; placeholder: string; onCommit: (v: string) => void }

export function DebouncedAmountInput({ id, label, value, placeholder, onCommit }: Props) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  // The parent changed it (Clear, an account switch): the draft follows.
  useEffect(() => { clearTimer(); setDraft(value); }, [value]);
  useEffect(() => clearTimer, []);
  const invalid = draft.trim() !== '' && !AMOUNT_BOUND_RE.test(draft.trim());
  const commit = (v: string) => { clearTimer(); if (v.trim() !== '' && !AMOUNT_BOUND_RE.test(v.trim())) return; if (v !== value) onCommit(v); };
  return (
    <>
      <label htmlFor={id} className="shrink-0">{label}</label>
      <input
        id={id} type="number" min="0" step="0.01" value={draft} placeholder={placeholder}
        aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={e => { setDraft(e.target.value); clearTimer(); const v = e.target.value; timer.current = setTimeout(() => commit(v), AMOUNT_DEBOUNCE_MS); }}
        onBlur={() => commit(draft)}
        onKeyDown={e => { if (e.key === 'Enter') commit(draft); }}
        className="w-20 px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
      />
      {invalid && <span id={`${id}-error`} role="alert" className="shrink-0 text-xs text-red-700 dark:text-red-400">Enter an amount like 100 or 100.50</span>}
    </>
  );
}
