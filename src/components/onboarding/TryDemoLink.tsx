/**
 * TryDemoLink: "Try the demo company" for a true first run. Shown only when
 * the user belongs to the demo tenant (found by `isDemo`) and is not on it.
 *
 * switchCompany resolves as soon as it has started a full reload (the active
 * company lives in a cookie every request reads), so the old, empty page used
 * to sit there, clickable, until the reload landed. A busy overlay now covers
 * it from the click until the page is gone; only a refused switch removes it.
 *
 * The overlay is modal, not only visual: everything else in <body> is inert
 * while it is up (no clicks, no Tab into the page behind), focus moves onto it,
 * and its live region is mounted empty and filled afterwards, because a
 * role=status inserted with its text already in place is not announced.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Sparkles } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';
import { notify } from '@/utils/toast';
import { apiErrorMessage } from '@/lib/apiFetch';
import { findDemoMembership } from './demoMembership';

interface TryDemoLinkProps {
  /** Called after a good switch (the banner dismisses itself here). */
  onSwitched?: () => void;
}

const OPENING = 'Opening the demo company…';

/** `returnTo`: the trigger. Not read from document.activeElement, which a StrictMode re-run of the effect would find on the dialog itself. */
function BusyOverlay({ returnTo }: { returnTo: RefObject<HTMLButtonElement | null> }) {
  const overlay = useRef<HTMLDivElement>(null);
  const [announce, setAnnounce] = useState(false);

  useEffect(() => {
    const el = overlay.current;
    const target = returnTo.current;
    if (!el) return;
    const behind = Array.from(document.body.children).filter((c) => c !== el && !c.hasAttribute('inert'));
    behind.forEach((c) => c.setAttribute('inert', ''));
    el.focus();
    setAnnounce(true);
    return () => {
      behind.forEach((c) => c.removeAttribute('inert'));
      target?.focus();
    };
  }, [returnTo]);

  return (
    <div ref={overlay} role="dialog" aria-modal="true" aria-label="Opening the demo company" tabIndex={-1}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 outline-none">
      <div className="flex items-center gap-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-5 py-3 text-sm font-medium text-[var(--ff-text-primary)]">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        <p role="status" aria-live="polite">{announce ? OPENING : ''}</p>
      </div>
    </div>
  );
}

export function TryDemoLink({ onSwitched }: TryDemoLinkProps) {
  const { companies, activeCompany, switchCompany } = useCompany();
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const demo = findDemoMembership(companies, activeCompany?.id);
  if (!demo) return null;

  const go = async () => {
    setBusy(true);
    let switched = false;
    try {
      await switchCompany(demo.companyId);
      switched = true;
    } catch (e) {
      notify.error(apiErrorMessage(e, 'Could not switch company - try again'));
      return; // still on the old company: keep the offer
    } finally {
      // Still busy after a good switch: the reload it started replaces this page.
      if (!switched) setBusy(false);
    }
    onSwitched?.();
  };

  return (
    <>
    {busy && typeof document !== 'undefined' && createPortal(<BusyOverlay returnTo={trigger} />, document.body)}
    <button
      ref={trigger}
      type="button"
      onClick={() => void go()}
      disabled={busy}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline dark:text-teal-300 disabled:opacity-60"
    >
      <Sparkles className="h-4 w-4" aria-hidden="true" />
      Try the demo company
    </button>
    </>
  );
}
