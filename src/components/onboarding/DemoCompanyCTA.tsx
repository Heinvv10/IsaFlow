/**
 * DemoCompanyCTA — dismissable inline banner encouraging new users to explore
 * the demo company. Dismiss state is stored in localStorage only (lightweight).
 */

import { useState, useEffect } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';

const DISMISSED_KEY = 'isaflow_demo_cta_dismissed';

interface DemoCompanyCTAProps {
  /** Optional override text. Defaults to the standard copy. */
  message?: string;
}

export function DemoCompanyCTA({ message }: DemoCompanyCTAProps) {
  const [dismissed, setDismissed] = useState(true); // default hidden until we read localStorage
  const [demoCompanyId, setDemoCompanyId] = useState<string | null>(null);
  const { companies, switchCompany } = useCompany();

  useEffect(() => {
    const stored = localStorage.getItem(DISMISSED_KEY);
    if (!stored) setDismissed(false);
  }, []);

  useEffect(() => {
    // Find a company whose name contains "demo" (case-insensitive)
    const demo = companies.find(c =>
      c.companyName.toLowerCase().includes('demo'),
    );
    setDemoCompanyId(demo?.companyId ?? null);
  }, [companies]);

  const handleDismiss = () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    setDismissed(true);
  };

  const handleTryDemo = async () => {
    if (demoCompanyId) {
      await switchCompany(demoCompanyId);
    }
    handleDismiss();
  };

  if (dismissed || !demoCompanyId) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-700/40 text-sm">
      <Sparkles className="w-4 h-4 flex-shrink-0 text-teal-600 dark:text-teal-400" />
      <p className="flex-1 text-teal-800 dark:text-teal-200">
        {message ?? 'New here? Explore our demo company to see ISAFlow in action.'}
      </p>
      <button
        onClick={() => void handleTryDemo()}
        className="flex-shrink-0 px-3 py-1 rounded-md bg-teal-600 hover:bg-teal-500 text-white text-xs font-medium transition-colors"
      >
        Try Demo
      </button>
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
