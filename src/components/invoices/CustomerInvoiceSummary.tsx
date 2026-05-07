/**
 * CustomerInvoiceSummary — Summary cards and line items table for the customer invoice detail page.
 */

import type { CustomerInvoiceItem } from '@/modules/accounting/types/customerInvoice.types';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Props {
  invoiceDate: string;
  dueDate: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  taxRate: number;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  balance: number;
  notes: string;
  items: CustomerInvoiceItem[];
}

export function CustomerInvoiceSummary({
  invoiceDate, dueDate, billingPeriodStart, billingPeriodEnd,
  taxRate, subtotal, taxAmount, totalAmount, balance, notes, items,
}: Props) {
  const cards = [
    { label: 'Invoice Date', value: invoiceDate?.split('T')[0] },
    { label: 'Due Date', value: dueDate?.split('T')[0] || '—' },
    {
      label: 'Billing Period',
      value: billingPeriodStart && billingPeriodEnd
        ? `${String(billingPeriodStart).split('T')[0]} → ${String(billingPeriodEnd).split('T')[0]}`
        : '—',
    },
    { label: 'VAT Rate', value: `${taxRate}%` },
    { label: 'Subtotal', value: fmt(Number(subtotal)) },
    { label: 'VAT', value: fmt(Number(taxAmount)) },
    { label: 'Total', value: fmt(Number(totalAmount)), hl: true },
    { label: 'Balance Due', value: fmt(balance), hl: balance > 0 },
  ];

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((c, i) => (
          <div key={i} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
            <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">{c.label}</p>
            <p className={`text-lg font-semibold mt-1 ${c.hl ? 'text-blue-400' : 'text-[var(--ff-text-primary)]'}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
          <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Line Items</h3>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
              {['Description', 'Qty', 'Unit Price', 'Tax Rate', 'Amount'].map(h => (
                <th key={h} className={`px-4 py-3 text-xs font-medium text-[var(--ff-text-secondary)] uppercase ${h === 'Description' ? 'text-left' : 'text-right'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ff-border-light)]">
            {(items || []).map(item => (
              <tr key={item.id} className="hover:bg-[var(--ff-bg-tertiary)]">
                <td className="px-4 py-3 text-sm text-[var(--ff-text-primary)]">{item.description || '—'}</td>
                <td className="px-4 py-3 text-sm text-right font-mono">{item.quantity}</td>
                <td className="px-4 py-3 text-sm text-right font-mono">{fmt(Number(item.unit_price))}</td>
                <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-secondary)]">{Number(item.tax_rate)}%</td>
                <td className="px-4 py-3 text-sm text-right font-mono font-medium">{fmt(Number(item.amount))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--ff-border-medium)] bg-[var(--ff-bg-tertiary)]">
              <td colSpan={3}></td>
              <td className="px-4 py-3 text-sm text-right font-medium text-[var(--ff-text-secondary)]">Total:</td>
              <td className="px-4 py-3 text-sm text-right font-mono font-bold text-blue-400">{fmt(Number(totalAmount))}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {notes && (
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
          <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-1">Notes</p>
          <p className="text-sm text-[var(--ff-text-secondary)]">{notes}</p>
        </div>
      )}
    </>
  );
}
