/**
 * EmptyStateDemo — showcase section for the EmptyState component.
 */

import { FileText, Inbox } from 'lucide-react';
import { EmptyState } from '@/components/ui';

export function EmptyStateDemo() {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700">
        <EmptyState
          icon={FileText}
          title="No invoices yet"
          description="Create your first invoice to get paid faster. Import from Sage or start from scratch."
          primaryAction={{ label: 'New Invoice', onClick: () => undefined }}
          secondaryAction={{ label: 'Import from Sage', href: '/accounting/migration' }}
        />
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700">
        <EmptyState
          icon={Inbox}
          title="Your inbox is empty"
        />
      </div>
    </div>
  );
}
