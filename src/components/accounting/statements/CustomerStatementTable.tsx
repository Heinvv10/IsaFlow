/**
 * CustomerStatementTable
 * Renders the selectable customer list on the Send Statements page.
 */

import { CheckSquare, Square, Eye } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';

export interface CustomerRow {
  client_id: string;
  client_name: string;
  email: string | null;
  total_invoiced: number;
  total_paid: number;
  balance: number;
  overdue: number;
  invoice_count: number;
}

interface Props {
  rows: CustomerRow[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}

function balanceColour(row: CustomerRow): string {
  if (row.overdue > 0) return 'text-red-400';
  if (row.balance > 0) return 'text-yellow-400';
  return 'text-emerald-400';
}

export function CustomerStatementTable({ rows, selected, onToggle, onToggleAll }: Props) {
  const allEligible = rows.filter(r => r.email);
  const allSelected = allEligible.length > 0 && allEligible.every(r => selected.has(r.client_id));

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)]">
            <th className="w-10 text-center px-4 py-3">
              <button
                onClick={onToggleAll}
                className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
                title="Select / deselect all customers with email"
              >
                {allSelected
                  ? <CheckSquare className="h-4 w-4 text-purple-400" />
                  : <Square className="h-4 w-4" />}
              </button>
            </th>
            <th className="text-left px-4 py-3 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Customer</th>
            <th className="text-left px-4 py-3 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Email</th>
            <th className="text-right px-4 py-3 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Balance</th>
            <th className="text-right px-4 py-3 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Overdue</th>
            <th className="text-center px-4 py-3 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Preview</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(c => (
            <tr
              key={c.client_id}
              className="border-b border-[var(--ff-border-light)] hover:bg-teal-500/[0.04]"
            >
              <td className="text-center px-4 py-3">
                {c.email ? (
                  <button
                    onClick={() => onToggle(c.client_id)}
                    className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
                  >
                    {selected.has(c.client_id)
                      ? <CheckSquare className="h-4 w-4 text-purple-400" />
                      : <Square className="h-4 w-4" />}
                  </button>
                ) : (
                  <span className="text-[var(--ff-text-tertiary)] text-xs" title="No email address">—</span>
                )}
              </td>
              <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{c.client_name}</td>
              <td className="px-4 py-3 text-xs text-[var(--ff-text-secondary)]">
                {c.email ?? <span className="text-red-400">No email</span>}
              </td>
              <td className={`px-4 py-3 text-right font-medium tabular-nums ${balanceColour(c)}`}>
                {formatCurrency(c.balance)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-red-400">
                {c.overdue > 0
                  ? formatCurrency(c.overdue)
                  : <span className="text-[var(--ff-text-tertiary)]">—</span>}
              </td>
              <td className="px-4 py-3 text-center">
                <a
                  href={`/api/accounting/customer-statement?customerId=${c.client_id}&format=pdf`}
                  target="_blank"
                  rel="noreferrer"
                  title={`Preview statement for ${c.client_name}`}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs text-blue-400 hover:bg-blue-500/10 transition-colors"
                >
                  <Eye className="h-3.5 w-3.5" /> Preview
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
