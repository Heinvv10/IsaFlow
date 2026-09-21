/**
 * The customer statement detail page's row types and its per-row pieces,
 * split out of pages/accounting/customer-statements/[clientId].tsx for the
 * 300-line cap.
 */

export interface Transaction {
  id: number | string;
  date: string;
  type: 'invoice' | 'payment' | 'credit_note';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface ClientInfo {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface Summary {
  totalInvoiced: number;
  totalPaid: number;
  totalCredits: number;
  balance: number;
}

export type TypeFilter = 'all' | 'invoice' | 'payment' | 'credit_note';

export function getTransactionUrl(txn: Transaction): string | null {
  switch (txn.type) {
    case 'invoice': return `/accounting/customer-invoices/${txn.id}`;
    case 'payment': return `/accounting/customer-payments/${txn.id}`;
    default: return null;
  }
}

export function TypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    invoice: 'bg-blue-500/10 text-blue-400',
    payment: 'bg-teal-500/10 text-teal-400',
    credit_note: 'bg-amber-500/10 text-amber-400',
  };
  const labels: Record<string, string> = {
    invoice: 'Invoice',
    payment: 'Payment',
    credit_note: 'Credit Note',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[type] || ''}`}>
      {labels[type] || type}
    </span>
  );
}
