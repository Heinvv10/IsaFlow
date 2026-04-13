/**
 * CustomerStatementTable — reusable table for statement run page.
 * Shows customer balances with selectable checkboxes and email indicator.
 */

import { CheckSquare, Square, Mail } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';

export interface CustomerBalance {
  client_id: string;
  client_name: string;
  email?: string;
  phone?: string;
  total_invoiced: number;
  total_paid: number;
  balance: number;
  invoice_count: number;
}

interface Props {
  customers: CustomerBalance[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}

export function CustomerStatementTable({
  customers,
  selected,
  onToggle,
  onToggleAll,
}: Props) {
  const allSelected = customers.length > 0 && selected.size === customers.length;

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)]">
            <th className="text-center px-4 py-3 w-10">
              <button
                onClick={onToggleAll}
                className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
              >
                {allSelected ? (
                  <CheckSquare className="h-4 w-4" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
              </button>
            </th>
            <th className="text-left px-4 py-3 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">
              Customer
            </th>
            <th className="text-right px-4 py-3 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">
              Invoiced
            </th>
            <th className="text-right px-4 py-3 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">
              Paid
            </th>
            <th className="text-right px-4 py-3 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">
              Balance
            </th>
            <th className="text-center px-4 py-3 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">
              # Inv
            </th>
            <th className="text-center px-4 py-3 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">
              Email
            </th>
          </tr>
        </thead>
        <tbody>
          {customers.map(c => (
            <tr
              key={c.client_id}
              className="border-b border-[var(--ff-border-light)] hover:bg-teal-500/[0.04]"
            >
              <td className="text-center px-4 py-3">
                <button
                  onClick={() => onToggle(c.client_id)}
                  className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
                >
                  {selected.has(c.client_id) ? (
                    <CheckSquare className="h-4 w-4 text-purple-400" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                </button>
              </td>
              <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">
                {c.client_name}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-[var(--ff-text-primary)]">
                {formatCurrency(c.total_invoiced)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-teal-400">
                {formatCurrency(c.total_paid)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums font-medium text-[var(--ff-text-primary)]">
                {formatCurrency(c.balance)}
              </td>
              <td className="px-4 py-3 text-center text-[var(--ff-text-secondary)]">
                {c.invoice_count}
              </td>
              <td className="px-4 py-3 text-center">
                {c.email ? (
                  <Mail className="h-4 w-4 text-teal-400 mx-auto" />
                ) : (
                  <span className="text-[var(--ff-text-tertiary)]">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
