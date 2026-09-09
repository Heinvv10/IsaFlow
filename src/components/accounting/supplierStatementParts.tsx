export function getTransactionUrl(txn: { type: string; id: string | number }): string | null {
  switch (txn.type) {
    case 'invoice': return `/accounting/supplier-invoices/${txn.id}`;
    case 'payment': return `/accounting/supplier-payments/${txn.id}`;
    default: return null;
  }
}

export function TypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    invoice: 'bg-blue-500/10 text-blue-400',
    payment: 'bg-teal-500/10 text-teal-400',
    debit_note: 'bg-amber-500/10 text-amber-400',
  };
  const labels: Record<string, string> = {
    invoice: 'Invoice',
    payment: 'Payment',
    debit_note: 'Debit Note',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[type] || ''}`}>
      {labels[type] || type}
    </span>
  );
}

