/**
 * BankTxModalShell - the ONE shell of the modals the bank-transactions page opens (Query, Link, Split, Exclude, Find match,
 * Create rule, Create entity, Attachments). It gives each the same dialog behaviour, from the kit's `useFocusTrap` (not a
 * second implementation): `role="dialog"` + `aria-modal` + a name, Tab kept inside, Escape closes, focus moves in on open and
 * goes back on close. It renders into `document.body`, so the page's stacking context cannot draw the top navigation over the
 * backdrop.
 *
 * Focus in: the first FIELD (`[data-autofocus]`, else the first text input, textarea or select), so Enter or Space right
 * after opening cannot hit the header's close button; the close button is the last resort.
 * Focus back: to what had focus when it opened; where that was nothing (Safari and macOS Firefox do not focus a button on
 * click, so `activeElement` is the body) to the last control clicked, then to the `returnFocus` target if given, then to the
 * transaction grid.
 * `busy` (see `useModalBusy`): while a save or send is in flight Escape and a backdrop click do nothing, and the modal's own
 * close buttons are disabled; after BUSY_RELEASE_MS a request that never answers no longer holds the dialog.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/components/ui/useFocusTrap';
import { notify } from '@/utils/toast';

/** A hung request releases the dialog after this long. */
export const BUSY_RELEASE_MS = 30_000;

/** The control last clicked: where focus goes back to when the browser never focused it (Safari, macOS Firefox). */
let lastClicked: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>('button, a[href], [role="button"], [tabindex]') : null;
    if (t) lastClicked = t;
  }, true);
}

/** `busy`, released after BUSY_RELEASE_MS with a warning: pass the result to the shell's `busy` and to the close buttons' `disabled`. */
export function useModalBusy(busy: boolean): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!busy) { setExpired(false); return undefined; }
    const t = setTimeout(() => {
      setExpired(true);
      notify.warning('This is taking too long', 'You can close this window. If it did go through, refresh the list to see it.');
    }, BUSY_RELEASE_MS);
    return () => clearTimeout(t);
  }, [busy]);
  return busy && !expired;
}

const FIELD = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]), textarea:not([disabled]), select:not([disabled])';

interface Props {
  /** The dialog's accessible name. */
  label: string;
  onClose: () => void;
  busy?: boolean;
  closeOnBackdrop?: boolean;
  /** Where focus goes back to on close, when what had focus on open is gone or was nothing. */
  returnFocus?: () => HTMLElement | null;
  /** Stacking: a modal opened over another needs a higher layer (default z-50). */
  zClass?: string;
  /** Extra classes for the overlay (e.g. `p-4`). */
  className?: string;
  children: ReactNode;
}

export function BankTxModalShell({ label, onClose, busy = false, closeOnBackdrop = false, returnFocus, zClass = 'z-50', className = 'p-4', children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // What had focus when the dialog opened (read once, in the first render, before the trap moves focus).
  const [opener] = useState<HTMLElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const a = document.activeElement;
    return a instanceof HTMLElement && a !== document.body ? a : lastClicked;
  });
  const back = useRef(returnFocus);
  useEffect(() => { back.current = returnFocus; });
  useFocusTrap(ref, true, () => { if (!busy) onClose(); });
  // After the trap took focus in (declared after it, so it runs after): the first field instead of the close button.
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>(FIELD);
    el?.focus();
  }, []);
  // On close, after the trap's own restore: if focus is nowhere, put it where the user was.
  useEffect(() => () => {
    const here = document.activeElement;
    if (here && here !== document.body && here.isConnected) return;
    const target = [opener, back.current?.() ?? null].find(t => t && t.isConnected)
      ?? document.querySelector<HTMLElement>('[data-testid="bank-tx-table"]');
    if (target) { if (!target.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) target.setAttribute('tabindex', '-1'); target.focus(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} data-testid="bank-tx-modal-shell" aria-busy={busy || undefined}
      className={`fixed inset-0 ${zClass} flex items-center justify-center bg-black/60 outline-none ${className}`}
      onClick={e => { if (closeOnBackdrop && !busy && e.target === e.currentTarget) onClose(); }}>
      {children}
    </div>,
    document.body,
  );
}
