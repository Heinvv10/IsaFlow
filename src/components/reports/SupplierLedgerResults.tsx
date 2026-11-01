/** The supplier ledger once it has run: the transaction table with its totals, and the summary strip. */
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';

interface LedgerRow {
  type: string;
  transaction_id: string;
  reference: string | null;
  transaction_date: string;
  debit: number;
  credit: number;
  status: string;
  running_balance: number;
}

export interface LedgerData {
  supplier_name: string;
  opening_balance: number;
  closing_balance: number;
  transactions: LedgerRow[];
}

const fmt = (n: number) => formatMoney(n);

export function typeLabel(type: string): string {
  if (type === 'invoice') return 'Invoice';
  if (type === 'payment') return 'Payment';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function SupplierLedgerResults({ ledger }: { ledger: LedgerData }) {
  const totalDebits = ledger.transactions.reduce((sum, r) => sum + r.debit, 0);
  const totalCredits = ledger.transactions.reduce((sum, r) => sum + r.credit, 0);

  return (
    <>
      {ledger.supplier_name && (
        <p className="text-sm text-[var(--ff-text-secondary)]">
          Ledger for{' '}
          <span className="font-semibold text-[var(--ff-text-primary)]">
            {ledger.supplier_name}
          </span>
        </p>
      )}

      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Reference</th>
              <th className="px-4 py-3 text-right">Debit</th>
              <th className="px-4 py-3 text-right">Credit</th>
              <th className="px-4 py-3 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {ledger.transactions.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]"
                >
                  No transactions for the selected period
                </td>
              </tr>
            )}
            {ledger.transactions.map((row) => (
              <tr
                key={row.transaction_id}
                className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50"
              >
                <td className="px-4 py-2 text-[var(--ff-text-secondary)] font-mono text-xs">
                  {formatDisplayDate(row.transaction_date)}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      row.type === 'invoice'
                        ? 'bg-orange-500/10 text-orange-800 dark:text-orange-400'
                        : 'bg-teal-500/10 text-teal-800 dark:text-teal-400'
                    }`}
                  >
                    {typeLabel(row.type)}
                  </span>
                </td>
                <td className="px-4 py-2 text-[var(--ff-text-primary)]">
                  {row.reference ?? '—'}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {row.debit > 0 ? (
                    <span className="text-red-700 dark:text-red-400">{fmt(row.debit)}</span>
                  ) : (
                    <span className="text-[var(--ff-text-tertiary)]">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {row.credit > 0 ? (
                    <span className="text-teal-800 dark:text-teal-400">{fmt(row.credit)}</span>
                  ) : (
                    <span className="text-[var(--ff-text-tertiary)]">—</span>
                  )}
                </td>
                <td
                  className={`px-4 py-2 text-right tabular-nums font-medium ${row.running_balance > 0.005 ? 'text-[var(--ff-text-primary)]' : 'text-teal-800 dark:text-teal-400'}`}
                >
                  {fmt(row.running_balance)}
                </td>
              </tr>
            ))}

            {/* Footer totals */}
            {ledger.transactions.length > 0 && (
              <tr className="bg-[var(--ff-bg-primary)] font-medium border-t-2 border-[var(--ff-border-light)]">
                <td
                  colSpan={3}
                  className="px-4 py-3 text-[var(--ff-text-secondary)] text-xs uppercase tracking-wide"
                >
                  Totals
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-red-700 dark:text-red-400">
                  {fmt(totalDebits)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-teal-800 dark:text-teal-400">
                  {fmt(totalCredits)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-[var(--ff-text-primary)]">
                  {fmt(ledger.closing_balance)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Summary strip */}
      {ledger.transactions.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            {
              label: 'Opening Balance',
              value: ledger.opening_balance,
              color: 'text-[var(--ff-text-primary)]',
            },
            { label: 'Total Debits', value: totalDebits, color: 'text-red-700 dark:text-red-400' },
            { label: 'Total Credits', value: totalCredits, color: 'text-teal-800 dark:text-teal-400' },
            {
              label: 'Closing Balance',
              value: ledger.closing_balance,
              color:
                ledger.closing_balance > 0.005
                  ? 'text-[var(--ff-text-primary)]'
                  : 'text-teal-800 dark:text-teal-400',
            },
          ].map(({ label, value, color }) => (
            <div
              key={label}
              className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] px-4 py-3"
            >
              <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">{label}</p>
              <p className={`tabular-nums font-semibold text-base ${color}`}>{fmt(value)}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
