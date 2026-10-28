/**
 * DemoCompanyCTA — dismissable inline banner encouraging new users to explore
 * the demo company. Dismiss state is stored in localStorage only (lightweight).
 */

import { useState, useEffect } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';
import { log } from '@/lib/logger';
import { findDemoMembership } from './demoMembership';
import { TryDemoLink } from './TryDemoLink';

const DISMISSED_KEY = 'isaflow_demo_cta_dismissed';

/** Storage can refuse a write (blocked, full): the banner is then dismissed for this visit only. */
function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch (err) {
    log.error('Could not remember that the demo banner was dismissed', { error: err }, 'demo-company-cta');
  }
}

interface DemoCompanyCTAProps {
  /** Optional override text. Defaults to the standard copy. */
  message?: string;
}

export function DemoCompanyCTA({ message }: DemoCompanyCTAProps) {
  const [dismissed, setDismissed] = useState(true); // default hidden until we read localStorage
  const { companies, activeCompany } = useCompany();
  const demoCompanyId = findDemoMembership(companies, activeCompany?.id)?.companyId ?? null;

  useEffect(() => {
    const stored = localStorage.getItem(DISMISSED_KEY);
    if (!stored) setDismissed(false);
  }, []);

  const handleDismiss = () => {
    rememberDismissed();
    setDismissed(true);
  };

  if (dismissed || !demoCompanyId) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-700/40 text-sm">
      <Sparkles className="w-4 h-4 flex-shrink-0 text-teal-600 dark:text-teal-400" />
      <p className="flex-1 text-teal-800 dark:text-teal-200">
        {message ?? 'New here? Explore our demo company to see ISAFlow in action.'}
      </p>
      {/* Persist only: unmounting the banner would take TryDemoLink's busy overlay with it before the reload lands. */}
      <TryDemoLink onSwitched={rememberDismissed} />
      <button
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="flex-shrink-0 text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
