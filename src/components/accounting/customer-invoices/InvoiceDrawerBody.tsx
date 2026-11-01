/**
 * The invoice drawer: a read-only summary of one customer invoice, opened from a row of the list. Everything that
 * changes an invoice stays on its page, which "Open invoice" reaches.
 */

import Link from 'next/link';
import { StatusPill } from '@/components/ui';
import { useDrawerRead } from '@/components/ui/useDrawerRead';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import { formatDisplayDate } from '@/utils/dateFormat';
import { isAROpen } from '@/lib/constants/invoiceStatuses';

interface InvoiceDetail {
  invoice_number: string;
  client_name?: string | null;
  status: string;
  currency_code?: string | null;
  invoice_date: string;
  due_date?: string | null;
  subtotal: string | number;
  tax_amount: string | number;
  total_amount: string | number;
  amount_paid: string | number;
  items: { id: string; description?: string | null; quantity: string | number; amount: string | number }[];
}

function Row({ label, value, testId, strong }: { label: string; value: string; testId?: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 py-1 text-sm ${strong ? 'font-semibold text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums" data-testid={testId}>{value}</dd>
    </div>
  );
}

export function InvoiceDrawerBody({ invoiceId }: { invoiceId: string }) {
  const { data: inv, error, loading } = useDrawerRead<InvoiceDetail>(
    `/api/accounting/customer-invoices-detail?id=${invoiceId}`, 'Could not load the invoice - try again');

  if (loading) return <p className="text-sm text-[var(--ff-text-secondary)]">Loading invoice…</p>;
  if (error || !inv) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;

  const money = (n: string | number) => formatCurrencyAmount(Number(n), inv.currency_code || 'ZAR');
  const outstanding = Number(inv.total_amount) - Number(inv.amount_paid);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-words font-medium text-[var(--ff-text-primary)]">{inv.client_name || '-'}</p>
        <StatusPill status={inv.status} />
      </div>
      <dl>
        <Row label="Invoice date" value={formatDisplayDate(inv.invoice_date)} />
        <Row label="Due date" value={inv.due_date ? formatDisplayDate(inv.due_date) : '-'} />
      </dl>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)] text-left text-xs text-[var(--ff-text-secondary)]">
            <th className="py-1 font-medium">Description</th>
            <th className="py-1 pl-2 text-right font-medium">Qty</th>
            <th className="py-1 pl-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {inv.items.map((item) => (
            <tr key={item.id} className="border-b border-[var(--ff-border-light)]/50 align-top text-[var(--ff-text-primary)]">
              <td className="break-words py-1.5">{item.description || '-'}</td>
              <td className="py-1.5 pl-2 text-right tabular-nums">{Number(item.quantity)}</td>
              <td className="whitespace-nowrap py-1.5 pl-2 text-right tabular-nums">{money(item.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl>
        <Row label="Subtotal" value={money(inv.subtotal)} />
        <Row label="VAT" value={money(inv.tax_amount)} />
        <Row label="Total" value={money(inv.total_amount)} strong />
        <Row label="Paid" value={money(inv.amount_paid)} />
        <Row label="Outstanding" value={isAROpen(inv.status) ? money(outstanding) : '-'} testId="invoice-drawer-outstanding" strong />
      </dl>
      <Link href={`/accounting/customer-invoices/${invoiceId}`} className="inline-block text-sm font-medium text-teal-700 hover:underline dark:text-teal-300">
        Open invoice
      </Link>
    </div>
  );
}
