/**
 * BillLineItemsTable — editable line-item grid for supplier bill creation.
 */
import {
  NON_SUPPLY_ADVICE, NON_SUPPLY_LABEL, classifyNonSupplyAccount,
  type NonSupplyReason,
} from '@/modules/accounting/services/gl/nonSupplyAccounts';
import { Plus, Trash2 } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';

const inp =
  'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 ' +
  'rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 ' +
  'focus:ring-amber-500/30 focus:border-amber-500 transition-colors';

export interface BillLineItem {
  key: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  glAccountId: string;
}

export interface GLAccount {
  id: string;
  accountCode: string;
  accountName: string;
}

/**
 * Why this line's account can never carry VAT, or null.
 *
 * `approveSupplierInvoice` posts `vatType: 'standard'` on every line whenever
 * the invoice's tax amount is non-zero, against whatever account the line
 * names — and until now no invoice screen said a word about it, while the bank
 * screens have warned since the guard shipped. An approver clicking through a
 * captured invoice miscoded to Salaries & Wages got no signal at all.
 *
 * WARNS, never blocks: same reasoning as the bank screens. The classification
 * is matched on account NAME and a handful of real names are ambiguous —
 * labour-broker wages, investment property, payroll software — so the choice
 * stays the approver's. Unlike the bank screens there is no unattended twin
 * here: nothing posts a supplier invoice on a schedule.
 *
 * WHAT THIS DOES NOT COVER, stated because the correspondence is not exact.
 * `approveSupplierInvoice` posts ONE combined VAT line from the invoice's
 * stored header `taxAmount` — the expense lines it builds carry no vatType at
 * all — so the posting decision is invoice-wide and blind to which line's
 * account is non-supply. On THIS screen the two agree, because the header tax
 * is the sum of the per-line tax (`new.tsx`, totalTax). On an invoice captured
 * or edited elsewhere they need not, and clearing every visible warning here
 * is not proof that the posted claim is clean. The exceptions report is what
 * checks the posted side.
 */
function nonSupplyReason(
  line: BillLineItem,
  glAccounts: GLAccount[],
): NonSupplyReason | null {
  // No tax on the line means no claim to warn about, whatever the account is.
  if (!(line.taxRate > 0)) return null;
  const account = glAccounts.find(a => a.id === line.glAccountId);
  return classifyNonSupplyAccount(account?.accountName ?? '');
}

interface Props {
  lines: BillLineItem[];
  glAccounts: GLAccount[];
  onAdd: () => void;
  onUpdate: (key: string, field: keyof BillLineItem, value: string | number) => void;
  onRemove: (key: string) => void;
}

export function BillLineItemsTable({ lines, glAccounts, onAdd, onUpdate, onRemove }: Props) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
          <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">
            2
          </span>
          Line Items
        </h3>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-semibold transition-colors"
        >
          <Plus className="h-3 w-3" />
          Add Line
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden mx-5 my-4">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/60">
            <tr>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">
                Description
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 w-36">
                GL Account
              </th>
              <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-20">
                Qty
              </th>
              <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-32">
                Unit Price
              </th>
              <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-32">
                Total
              </th>
              <th className="w-9" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {lines.map(line => (
              <tr
                key={line.key}
                className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors"
              >
                <td className="px-3 py-2">
                  <input
                    type="text"
                    required
                    value={line.description}
                    onChange={e => onUpdate(line.key, 'description', e.target.value)}
                    placeholder="Item description"
                    className={inp}
                  />
                </td>
                <td className="px-3 py-2">
                  <select
                    value={line.glAccountId}
                    onChange={e => onUpdate(line.key, 'glAccountId', e.target.value)}
                    className={inp}
                  >
                    <option value="">Default (5100)</option>
                    {glAccounts.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.accountCode} — {a.accountName}
                      </option>
                    ))}
                  </select>
                  {nonSupplyReason(line, glAccounts) && (
                    <span
                      className="mt-0.5 block text-[10px] leading-tight text-amber-500"
                      title={NON_SUPPLY_ADVICE[nonSupplyReason(line, glAccounts)!]}
                    >
                      ⚠ {NON_SUPPLY_LABEL[nonSupplyReason(line, glAccounts)!]} — no supply, so no VAT
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={line.quantity}
                    onChange={e => onUpdate(line.key, 'quantity', Number(e.target.value))}
                    className={`${inp} text-right`}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={line.unitPrice}
                    onChange={e => onUpdate(line.key, 'unitPrice', Number(e.target.value))}
                    className={`${inp} text-right`}
                  />
                </td>
                <td className="px-4 py-2 text-right font-mono text-sm font-semibold text-slate-800 dark:text-slate-200">
                  {formatCurrency(line.quantity * line.unitPrice)}
                </td>
                <td className="px-2 py-2">
                  <button
                    type="button"
                    onClick={() => onRemove(line.key)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
