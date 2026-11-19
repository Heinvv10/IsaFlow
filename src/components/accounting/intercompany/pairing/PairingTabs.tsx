/** The two directions as tabs: roving tabindex, arrow / Home / End keys, and the panel they control (WAI-ARIA tabs pattern). */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { PairingDirection } from '@/modules/accounting/services/intercompany/pairingTypes';

export const PANEL_ID = 'ic-pairing-panel';
const ORDER: PairingDirection[] = ['ar', 'ap'];
const tabId = (d: PairingDirection) => `ic-pairing-tab-${d}`;
const TAB = 'px-4 py-2 text-sm font-medium border-b-2 -mb-px';

interface Props {
  direction: PairingDirection;
  labels: Record<PairingDirection, string>;
  onChange: (direction: PairingDirection) => void;
  children: ReactNode;
}

export function PairingTabs({ direction, labels, onChange, children }: Props) {
  const refs = useRef<Record<PairingDirection, HTMLButtonElement | null>>({ ar: null, ap: null });

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const at = ORDER.indexOf(direction);
    const next = e.key === 'ArrowRight' ? ORDER[(at + 1) % ORDER.length]
      : e.key === 'ArrowLeft' ? ORDER[(at + ORDER.length - 1) % ORDER.length]
        : e.key === 'Home' ? ORDER[0] : e.key === 'End' ? ORDER[ORDER.length - 1] : undefined;
    if (!next) return;
    e.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  }

  return (
    <>
      <div role="tablist" aria-label="Which documents to pair" className="flex gap-1 border-b border-[var(--ff-border-light)]">
        {ORDER.map((key) => (
          <button key={key} ref={(el) => { refs.current[key] = el; }} type="button" role="tab" id={tabId(key)} aria-selected={direction === key}
            aria-controls={PANEL_ID} tabIndex={direction === key ? 0 : -1} onKeyDown={onKeyDown} onClick={() => onChange(key)}
            className={`${TAB} ${direction === key ? 'border-blue-500 text-[var(--ff-text-primary)]' : 'border-transparent text-ink-muted hover:text-[var(--ff-text-primary)]'}`}>
            {labels[key]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={PANEL_ID} aria-labelledby={tabId(direction)} tabIndex={0} className="space-y-6 outline-none">{children}</div>
    </>
  );
}
