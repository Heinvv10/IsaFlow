// src/components/layout/DemoBanner.tsx
// Amber banner shown to all users when the active tenant is a demo company.
// Dismiss state is keyed by company_id and stored in sessionStorage so:
//   - it reappears on a new browser session, and
//   - it reappears when the user switches to a different tenant.
import { useEffect, useState } from 'react';
import { X as XIcon } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';

function demoBannerKey(companyId: string): string {
  return `isaflow_demo_banner_dismissed_${companyId}`;
}

export function DemoBanner() {
  const { activeCompany } = useCompany();
  const [dismissed, setDismissed] = useState(true); // start hidden to avoid flash

  // Re-evaluate whenever the active company changes.
  useEffect(() => {
    if (!activeCompany?.isDemo) {
      setDismissed(true);
      return;
    }
    const key = demoBannerKey(activeCompany.id);
    const already = typeof window !== 'undefined'
      ? window.sessionStorage.getItem(key) === '1'
      : true;
    setDismissed(already);
  }, [activeCompany?.id, activeCompany?.isDemo]);

  const handleDismiss = () => {
    if (!activeCompany) return;
    window.sessionStorage.setItem(demoBannerKey(activeCompany.id), '1');
    setDismissed(true);
  };

  if (!activeCompany?.isDemo || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full bg-amber-400 text-amber-950 px-4 py-2 flex items-center justify-between text-sm font-medium flex-shrink-0"
    >
      <span>
        Demo data — dates and balances are simulated. This tenant is for demonstrations only.
      </span>
      <button
        onClick={handleDismiss}
        className="ml-4 p-1 rounded hover:bg-amber-500/40 transition-colors flex-shrink-0"
        aria-label="Dismiss demo banner"
      >
        <XIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
