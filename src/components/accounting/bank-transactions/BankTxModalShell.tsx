/**
 * BankTxModalShell - the ONE shell of the modals the bank-transactions page opens (Query, Link, Split, Exclude, Find match,
 * Create rule, Create entity). It gives each the same dialog behaviour, from the kit's `useFocusTrap` (not a second
 * implementation): `role="dialog"` + `aria-modal` + a name, Tab kept inside, Escape closes, focus moves in on open and goes
 * back to what opened it on close. It renders into `document.body`, so the page's stacking context cannot draw the top
 * navigation over the backdrop.
 *
 * `busy`: while a save or send is in flight Escape and a backdrop click do nothing (a half-finished request must not be
 * abandoned by a stray key); the modal's own buttons say what is running.
 * `closeOnBackdrop`: a click on the dim area closes (the Exclude dialog always did; the rest ask for it explicitly).
 */

import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/components/ui/useFocusTrap';

interface Props {
  /** The dialog's accessible name. */
  label: string;
  onClose: () => void;
  busy?: boolean;
  closeOnBackdrop?: boolean;
  /** Stacking: a modal opened over another needs a higher layer (default z-50). */
  zClass?: string;
  /** Extra classes for the overlay (e.g. `p-4`). */
  className?: string;
  children: ReactNode;
}

export function BankTxModalShell({ label, onClose, busy = false, closeOnBackdrop = false, zClass = 'z-50', className = 'p-4', children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, () => { if (!busy) onClose(); });
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} data-testid="bank-tx-modal-shell"
      className={`fixed inset-0 ${zClass} flex items-center justify-center bg-black/60 outline-none ${className}`}
      onClick={e => { if (closeOnBackdrop && !busy && e.target === e.currentTarget) onClose(); }}>
      {children}
    </div>,
    document.body,
  );
}
