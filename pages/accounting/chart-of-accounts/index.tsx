/**
 * Chart of Accounts — standalone page.
 * Replaces the redirect shim that previously bounced to /accounting?tab=chart-of-accounts.
 */

import { useState, useEffect, useCallback } from 'react';
import { Layers } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui/PageHeader';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { ChartOfAccountsTab } from '@/components/accounting/dashboard/ChartOfAccountsTab';

export default function ChartOfAccountsPage() {
  const [accountCount, setAccountCount] = useState<number | null>(null);

  const loadCount = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts');
      const json = await res.json() as { data?: unknown[] } | unknown[];
      const list = Array.isArray(json) ? json : (json as { data?: unknown[] }).data ?? [];
      setAccountCount(list.length);
    } catch (err) {
      log.error('Failed to load account count', { error: err }, 'chart-of-accounts-page');
    }
  }, []);

  useEffect(() => { void loadCount(); }, [loadCount]);

  const subtitle =
    accountCount === null
      ? 'Manage your general ledger accounts'
      : accountCount === 0
        ? 'Pick a template to set up your general ledger'
        : `${accountCount} account${accountCount !== 1 ? 's' : ''} in your general ledger`;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={Layers}
          title="Chart of Accounts"
          subtitle={subtitle}
          backLink={{ label: 'Accounting', href: '/accounting' }}
        />
        <div className="px-6 pb-8">
          <ChartOfAccountsTab />
        </div>
      </div>
    </AppLayout>
  );
}
