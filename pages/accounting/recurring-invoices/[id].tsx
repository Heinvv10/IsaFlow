/**
 * Edit Recurring Invoice Page
 * Dedicated edit form for an existing recurring invoice template. The layout is rendered here so it
 * survives both the router query loading (hard load of the prerendered route) and a change of id.
 */

import { useRouter } from 'next/router';
import { Loader2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { RecurringInvoiceEditor } from '@/components/accounting/recurringInvoices/RecurringInvoiceEditor';

export default function EditRecurringInvoicePage() {
  const { id } = useRouter().query as { id?: string };
  return (
    <AppLayout>
      {typeof id === 'string' ? (
        <RecurringInvoiceEditor key={id} id={id} />
      ) : (
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
        </div>
      )}
    </AppLayout>
  );
}
