/**
 * DebouncedAmountInput - an amount filter that waits for the person to stop typing (WP3). The parent's value (and so
 * the list query) changes 500 ms after the last keystroke, on blur or on Enter; before that the draft is local. The old
 * inputs pushed every keystroke straight to the parent and armed a timer that did nothing.
 */
import { useEffect, useRef, useState } from 'react';

export const AMOUNT_DEBOUNCE_MS = 500;

interface Props { id: string; label: string; value: string; placeholder: string; onCommit: (v: string) => void }

export function DebouncedAmountInput({ id, label, value, placeholder, onCommit }: Props) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  // The parent changed it (Clear, an account switch): the draft follows.
  useEffect(() => { clearTimer(); setDraft(value); }, [value]);
  useEffect(() => clearTimer, []);
  const commit = (v: string) => { clearTimer(); if (v !== value) onCommit(v); };
  return (
    <>
      <label htmlFor={id} className="shrink-0">{label}</label>
      <input
        id={id} type="number" step="0.01" value={draft} placeholder={placeholder}
        onChange={e => { setDraft(e.target.value); clearTimer(); const v = e.target.value; timer.current = setTimeout(() => commit(v), AMOUNT_DEBOUNCE_MS); }}
        onBlur={() => commit(draft)}
        onKeyDown={e => { if (e.key === 'Enter') commit(draft); }}
        className="w-20 px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
      />
    </>
  );
}
