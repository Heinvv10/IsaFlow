/**
 * Edit Recurring Invoice Page
 * Dedicated edit form for an existing recurring invoice template.
 */

import { useRouter } from 'next/router';
import { RecurringInvoiceEditor } from '@/components/accounting/recurringInvoices/RecurringInvoiceEditor';

export default function EditRecurringInvoicePage() {
  const { id } = useRouter().query as { id?: string };
  if (typeof id !== 'string') return null;
  return <RecurringInvoiceEditor key={id} id={id} />;
}
