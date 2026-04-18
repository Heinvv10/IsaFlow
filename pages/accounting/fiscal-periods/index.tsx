/**
 * Fiscal Periods — standalone page.
 * Replaces the redirect shim that previously bounced to /accounting?tab=fiscal-periods.
 */

import { Calendar } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui/PageHeader';
import { FiscalPeriodsTab } from '@/components/accounting/dashboard/FiscalPeriodsTab';

export default function FiscalPeriodsPage() {
  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={Calendar}
          title="Fiscal Periods"
          subtitle="Manage accounting periods — open, close, lock, or reopen"
          backLink={{ label: 'Accounting', href: '/accounting' }}
          chipColor="bg-amber-500/10 text-amber-500 dark:text-amber-400"
        />
        <div className="px-6 pb-8">
          <FiscalPeriodsTab />
        </div>
      </div>
    </AppLayout>
  );
}
