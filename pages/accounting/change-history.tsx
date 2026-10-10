/**
 * Change History (forensic-controls step 3): every recorded change to the
 * company's master data — suppliers, customers, GL and bank accounts,
 * employees, members, invitations and permissions, company tax / VAT / bank
 * settings, approval rules and switches — newest first, filterable by kind.
 * Owner / admin only (the API refuses everyone else); each record's own
 * History tab shows its timeline to whoever may open it.
 */
import { useState } from 'react';
import { History } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui/PageHeader';
import { useCompany } from '@/contexts/CompanyContext';
import { EntityHistoryTimeline } from '@/components/accounting/entity-history/EntityHistoryTimeline';
import {
  ENTITY_TYPES, ENTITY_TYPE_LABELS, isHistoryAdmin, type EntityType,
} from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';

export default function ChangeHistoryPage() {
  const { companyRole, loading } = useCompany();
  const [entityType, setEntityType] = useState<EntityType | ''>('');

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={History}
          title="Change History"
          subtitle="Who changed which supplier, customer, account, employee, member or company setting — and from what to what"
          backLink={{ label: 'Accounting', href: '/accounting' }}
        />
        <div className="px-6 pb-8 space-y-4 max-w-5xl">
          {!loading && !isHistoryAdmin(companyRole ?? undefined) ? (
            <p className="text-sm text-[var(--ff-text-secondary)]">
              Only an owner or admin can view the company-wide change history. Each supplier, customer and account
              shows its own history on its page.
            </p>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
                Show
                <select value={entityType} onChange={(e) => setEntityType(e.target.value as EntityType | '')}
                  data-testid="change-history-filter"
                  className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-2 py-1.5 text-sm text-[var(--ff-text-primary)]">
                  <option value="">Everything</option>
                  {ENTITY_TYPES.map((t) => <option key={t} value={t}>{ENTITY_TYPE_LABELS[t]}</option>)}
                </select>
              </label>
              {!loading && <EntityHistoryTimeline key={entityType || 'all'} entityType={entityType || undefined} />}
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
