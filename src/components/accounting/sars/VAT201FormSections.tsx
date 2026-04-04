/**
 * VAT201 summary view (form rows) and detail view (transaction tables).
 */
import { formatDate } from '@/utils/formatters';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

// ── FormRow ──────────────────────────────────────────────────────────────────

export function FormRow({
  field, label, amount, highlight,
}: {
  field: string;
  label: string;
  amount: number;
  highlight?: boolean;
}) {
  return (
    <div className={`px-4 py-3 flex items-center justify-between ${highlight ? 'bg-[var(--ff-bg-primary)]/30' : ''}`}>
      <div className="flex items-center gap-3">
        <span className="text-sm font-mono text-[var(--ff-text-tertiary)] w-8">{field}</span>
        <span className={`text-sm ${highlight ? 'font-semibold text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}`}>
          {label}
        </span>
      </div>
      <span className={`text-sm font-medium ${highlight ? 'text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}`}>
        {fmt(amount)}
      </span>
    </div>
  );
}

// ── TransactionTable ──────────────────────────────────────────────────────────

interface VAT201Invoice {
  id: string;
  invoiceNumber: string;
  counterpartyName: string;
  invoiceDate: string;
  totalExclVat: number;
  vatAmount: number;
  vatType: string;
}

interface TransactionTableProps {
  title: string;
  sectionColor: 'teal' | 'blue';
  invoices: VAT201Invoice[];
  totalLabel: string;
  totalVat: number;
}

export function TransactionTable({ title, sectionColor, invoices, totalLabel, totalVat }: TransactionTableProps) {
  const colorClasses = sectionColor === 'teal'
    ? { bg: 'bg-teal-500/5', text: 'text-teal-500', badge: 'bg-teal-500/10 text-teal-400', border: 'border-teal-500/20' }
    : { bg: 'bg-blue-500/5', text: 'text-blue-500', badge: 'bg-blue-500/10 text-blue-400', border: 'border-blue-500/20' };

  const totalNet = invoices.reduce((s, i) => s + i.totalExclVat, 0);
  const totalVatCalc = invoices.reduce((s, i) => s + i.vatAmount, 0);
  const totalGross = totalNet + totalVatCalc;

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
      <div className={`px-4 py-2.5 ${colorClasses.bg} border-b ${colorClasses.border}`}>
        <div className="flex items-center justify-between">
          <p className={`text-xs font-semibold ${colorClasses.text} uppercase tracking-wider`}>{title}</p>
          <span className="text-xs text-[var(--ff-text-tertiary)]">{invoices.length} transactions</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-tertiary)] text-xs uppercase tracking-wider">
              <th className="px-4 py-2.5">Date</th>
              <th className="px-4 py-2.5">Invoice #</th>
              <th className="px-4 py-2.5">Counterparty</th>
              <th className="px-4 py-2.5">VAT Type</th>
              <th className="px-4 py-2.5 text-right">Net (Excl.)</th>
              <th className="px-4 py-2.5 text-right">VAT</th>
              <th className="px-4 py-2.5 text-right">Gross (Incl.)</th>
            </tr>
          </thead>
          <tbody>
            {invoices.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-[var(--ff-text-tertiary)]">
                  No transactions for this period.
                </td>
              </tr>
            ) : invoices.map((inv) => (
              <tr key={inv.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/30">
                <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{formatDate(inv.invoiceDate)}</td>
                <td className="px-4 py-2 text-[var(--ff-text-primary)] font-medium">{inv.invoiceNumber}</td>
                <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{inv.counterpartyName}</td>
                <td className="px-4 py-2">
                  <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${colorClasses.badge}`}>
                    {inv.vatType}
                  </span>
                </td>
                <td className="px-4 py-2 text-right text-[var(--ff-text-primary)]">{fmt(inv.totalExclVat)}</td>
                <td className="px-4 py-2 text-right text-[var(--ff-text-primary)]">{fmt(inv.vatAmount)}</td>
                <td className="px-4 py-2 text-right text-[var(--ff-text-primary)]">{fmt(inv.totalExclVat + inv.vatAmount)}</td>
              </tr>
            ))}
          </tbody>
          {invoices.length > 0 && (
            <tfoot>
              <tr className={`${colorClasses.bg} font-semibold`}>
                <td colSpan={4} className={`px-4 py-2.5 text-sm ${colorClasses.text}`}>{totalLabel}</td>
                <td className="px-4 py-2.5 text-right text-[var(--ff-text-primary)]">{fmt(totalNet)}</td>
                <td className={`px-4 py-2.5 text-right ${colorClasses.text} font-bold`}>{fmt(totalVatCalc)}</td>
                <td className="px-4 py-2.5 text-right text-[var(--ff-text-primary)]">{fmt(totalGross)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
