/**
 * Customer statement preview: party + period, summary cards and the
 * transaction table with a running balance. Extracted from
 * pages/accounting/customers/statement.tsx to keep that page under 300 lines.
 */
import { useRouter } from 'next/router';
import { ClipboardList, ExternalLink } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';

export interface Customer { id: string; name: string; email?: string | null; phone?: string | null; }

export interface StatementTransaction {
  id: string;
  date: string;
  type: 'invoice' | 'payment' | 'credit_note' | 'opening_balance';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface StatementSummary {
  openingBalance: number;
  totalInvoiced: number;
  totalPaid: number;
  totalCredits: number;
  balance: number;
}

export interface StatementResult {
  customer: Customer;
  fromDate: string;
  toDate: string;
  transactions: StatementTransaction[];
  summary: StatementSummary;
}

const TYPE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit Note',
  opening_balance: 'Opening',
};

const TYPE_COLORS: Record<string, string> = {
  invoice: 'bg-blue-500/10 text-blue-400',
  payment: 'bg-teal-500/10 text-teal-400',
  credit_note: 'bg-amber-500/10 text-amber-400',
  opening_balance: 'bg-gray-500/10 text-gray-400',
};

function formatDate(d: string): string {
  const parts = d.split('T')[0]?.split('-') ?? [];
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : d;
}

function getTxnUrl(txn: StatementTransaction): string | null {
  if (txn.type === 'invoice') return `/accounting/customer-invoices/${txn.id}`;
  if (txn.type === 'payment') return `/accounting/customer-payments/${txn.id}`;
  return null;
}

export function CustomerStatementPreview({ statement }: { statement: StatementResult }) {
  const router = useRouter();
  const { summary } = statement;
  // The brought-forward line is not a transaction; it is counted into the
  // column totals below so they foot to the closing balance.
  const txnCount = statement.transactions.filter(t => t.type !== 'opening_balance').length;
  const openingDebit = summary.openingBalance > 0 ? summary.openingBalance : 0;
  const openingCredit = summary.openingBalance < 0 ? -summary.openingBalance : 0;
  return (
    <div className="space-y-4">
      {/* Customer + Period */}
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-[var(--ff-text-primary)]">{statement.customer.name}</h3>
            {statement.customer.email && (
              <p className="text-sm text-[var(--ff-text-secondary)]">{statement.customer.email}</p>
            )}
            {statement.customer.phone && (
              <p className="text-sm text-[var(--ff-text-secondary)]">{statement.customer.phone}</p>
            )}
          </div>
          <div className="text-right text-sm text-[var(--ff-text-secondary)]">
            <p>Period: {formatDate(statement.fromDate)} — {formatDate(statement.toDate)}</p>
            <p>{txnCount} transaction{txnCount !== 1 ? 's' : ''}</p>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className={`grid grid-cols-2 gap-4 ${summary.openingBalance !== 0 ? 'md:grid-cols-5' : 'md:grid-cols-4'}`}>
        {[
          ...(summary.openingBalance !== 0 ? [{ label: 'Opening Balance', value: summary.openingBalance, color: 'gray' }] : []),
          { label: 'Total Invoiced', value: statement.summary.totalInvoiced, color: 'blue' },
          { label: 'Total Paid', value: statement.summary.totalPaid, color: 'teal' },
          { label: 'Credits Applied', value: statement.summary.totalCredits, color: 'amber' },
          {
            label: 'Balance Outstanding',
            value: statement.summary.balance,
            color: statement.summary.balance > 0 ? 'red' : 'teal',
          },
        ].map(card => (
          <div key={card.label} className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
            <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">{card.label}</p>
            <p className={`text-xl font-bold text-${card.color}-400`}>{formatCurrency(card.value)}</p>
          </div>
        ))}
      </div>

      {/* Transactions Table */}
      {statement.transactions.length === 0 ? (
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-8 text-center">
          <ClipboardList className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
          <p className="text-[var(--ff-text-secondary)]">No transactions in this date range</p>
        </div>
      ) : (
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
          <div className="px-5 py-3 border-b border-[var(--ff-border-light)]">
            <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Transactions</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]/50">
                  <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Date</th>
                  <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Type</th>
                  <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Reference</th>
                  <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Description</th>
                  <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Debit</th>
                  <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Credit</th>
                  <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Balance</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {statement.transactions.map((txn, i) => {
                  const url = getTxnUrl(txn);
                  return (
                    <tr key={`${txn.type}-${txn.id}-${i}`}
                      onClick={url ? () => router.push(url) : undefined}
                      className={`border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50 ${url ? 'cursor-pointer' : ''}`}>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)] whitespace-nowrap">
                        {formatDate(txn.date)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[txn.type] || ''}`}>
                          {TYPE_LABELS[txn.type] || txn.type}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[var(--ff-text-primary)]">{txn.reference}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-tertiary)] max-w-[200px] truncate">
                        {txn.description || '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                        {txn.debit > 0 ? formatCurrency(txn.debit) : ''}
                      </td>
                      <td className={`px-4 py-3 text-right font-mono ${txn.type === 'payment' ? 'text-teal-400' : 'text-amber-400'}`}>
                        {txn.credit > 0 ? formatCurrency(txn.credit) : ''}
                      </td>
                      <td className={`px-4 py-3 text-right font-mono font-medium ${txn.balance > 0 ? 'text-[var(--ff-text-primary)]' : 'text-teal-400'}`}>
                        {formatCurrency(txn.balance)}
                      </td>
                      <td className="px-2 py-3">
                        {url && <ExternalLink className="h-3.5 w-3.5 text-[var(--ff-text-tertiary)]" />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]/50">
                  <td colSpan={4} className="px-4 py-3 text-sm font-semibold text-[var(--ff-text-secondary)]">
                    Closing Balance
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-bold text-[var(--ff-text-primary)]">
                    {formatCurrency(summary.totalInvoiced + openingDebit)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-bold text-teal-400">
                    {formatCurrency(summary.totalPaid + summary.totalCredits + openingCredit)}
                  </td>
                  <td className={`px-4 py-3 text-right font-mono font-bold text-lg ${statement.summary.balance > 0 ? 'text-red-400' : 'text-teal-400'}`}>
                    {formatCurrency(statement.summary.balance)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
