/**
 * TryDemoLink: "Try the demo company" for a true first run. Shown only when
 * the user belongs to the demo tenant (found by `isDemo`) and is not on it.
 */
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
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
      notify.error(apiErrorMessage(e, 'Could not switch company - try again'));
      return; // still on the old company: keep the offer
    } finally {
      setBusy(false);
    }
    onSwitched?.();
  };

  return (
    <button
      type="button"
      onClick={() => void go()}
      disabled={busy}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300 disabled:opacity-60"
    >
      <Sparkles className="h-4 w-4" aria-hidden="true" />
      Try the demo company
    </button>
  );
}
