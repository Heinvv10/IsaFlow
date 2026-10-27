/**
 * TryDemoLink: "Try the demo company" for a true first run. Shown only when
 * the user belongs to the demo tenant (found by `isDemo`) and is not on it.
 *
 * switchCompany resolves as soon as it has started a full reload (the active
 * company lives in a cookie every request reads), so the old, empty page used
 * to sit there, clickable, until the reload landed. A busy overlay now covers
 * it from the click until the page is gone; only a refused switch removes it.
 */
import { useState } from 'react';
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

export function TryDemoLink({ onSwitched }: TryDemoLinkProps) {
  const { companies, activeCompany, switchCompany } = useCompany();
  const [busy, setBusy] = useState(false);
  const demo = findDemoMembership(companies, activeCompany?.id);
  if (!demo) return null;

  const go = async () => {
    setBusy(true);
    try {
      await switchCompany(demo.companyId);
    } catch (e) {
      setBusy(false);
      notify.error(apiErrorMessage(e, 'Could not switch company - try again'));
      return; // still on the old company: keep the offer
    }
    // Still busy: the reload switchCompany started replaces this page.
    onSwitched?.();
  };

  return (
    <>
    {busy && typeof document !== 'undefined' && createPortal(
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60">
        <p role="status" aria-live="polite" className="flex items-center gap-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-5 py-3 text-sm font-medium text-[var(--ff-text-primary)]">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          Opening the demo company…
        </p>
      </div>,
      document.body,
    )}
    <button
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
