/**
 * The controls of one supplier-bill line, built once and placed by BillLineItemsTable either in a table row or in a
 * stacked card, so the two layouts can never drift apart (same labels, same handlers).
 */
import type { ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import {
  NON_SUPPLY_ADVICE, NON_SUPPLY_LABEL, classifyNonSupplyAccount,
  type NonSupplyReason,
} from '@/modules/accounting/services/gl/nonSupplyAccounts';
import { groupBillAccounts } from './billAccountOptions';
import { formatCurrency } from '@/utils/formatters';
import { CodingPicker } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import type { InvoiceLineCodingOptions } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';
import { deriveLineCc1, type LadderCentre } from './billLineCc1';
import type { BillLineItem, GLAccount } from './BillLineItemsTable';

export const billInput =
  'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 ' +
  'rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 ' +
  'focus:ring-amber-500/30 focus:border-amber-500 transition-colors';

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
export function nonSupplyReason(line: BillLineItem, glAccounts: GLAccount[]): NonSupplyReason | null {
  // No tax on the line means no claim to warn about, whatever the account is.
  if (!(line.taxRate > 0)) return null;
  const account = glAccounts.find(a => a.id === line.glAccountId);
  return classifyNonSupplyAccount(account?.accountName ?? '');
}

export interface LineFieldsContext {
  glAccounts: GLAccount[];
  onUpdate: (key: string, field: keyof BillLineItem, value: string | number) => void;
  onRemove: (key: string) => void;
  codingOptions?: InvoiceLineCodingOptions;
  supplierDefaults?: { cc2Id: string; buId: string; cc1Id?: string };
  ladder: LadderCentre[];
  showDimensions: boolean;
}

export interface LineFields {
  description: ReactNode; account: ReactNode; cc2: ReactNode; bu: ReactNode;
  qty: ReactNode; price: ReactNode; total: string; remove: ReactNode;
}

export function billLineFields(line: BillLineItem, index: number, ctx: LineFieldsContext): LineFields {
  const { glAccounts, onUpdate, onRemove, codingOptions, supplierDefaults, ladder, showDimensions } = ctx;
  const reason = nonSupplyReason(line, glAccounts);
  const cc1 = deriveLineCc1(line, ladder, supplierDefaults?.cc1Id ?? '');
  return {
    description: (
      <input type="text" required value={line.description} placeholder="Item description"
        aria-label={`Line ${index + 1} description`}
        onChange={e => onUpdate(line.key, 'description', e.target.value)} className={billInput} />
    ),
    account: (
      <>
        <select aria-label={`Line ${index + 1} account`} value={line.glAccountId}
          onChange={e => onUpdate(line.key, 'glAccountId', e.target.value)} className={billInput}>
          <option value="">Default (5100)</option>
          {groupBillAccounts(glAccounts).map(g => (
            <optgroup key={g.label} label={g.label}>
              {g.accounts.map(a => <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>)}
            </optgroup>
          ))}
        </select>
        {reason && (
          <span className="mt-0.5 block text-xs leading-tight text-amber-500" title={NON_SUPPLY_ADVICE[reason]}>
            ⚠ {NON_SUPPLY_LABEL[reason]} — no supply, so no VAT
          </span>
        )}
      </>
    ),
    cc2: showDimensions && codingOptions ? (
      <>
        <CodingPicker label="CC2 project" value={line.cc2Id ?? ''} options={codingOptions.cc2s} all={codingOptions}
          empty={supplierDefaults?.cc2Id ? 'Supplier default' : 'No CC2 project'} onChange={v => onUpdate(line.key, 'cc2Id', v)} />
        <span className="mt-1 block text-xs text-slate-600 dark:text-slate-400 break-words" data-testid="line-cc1">
          CC1: {cc1 ?? '—'}
        </span>
      </>
    ) : null,
    bu: showDimensions && codingOptions ? (
      <CodingPicker label="BU" value={line.buId ?? ''} options={codingOptions.bus} all={codingOptions}
        empty={supplierDefaults?.buId ? 'Supplier default' : 'No BU'} onChange={v => onUpdate(line.key, 'buId', v)} />
    ) : null,
    qty: (
      <input type="number" aria-label={`Line ${index + 1} quantity`} step="0.01" min="0.01" required value={line.quantity}
        onChange={e => onUpdate(line.key, 'quantity', Number(e.target.value))} className={`${billInput} text-right`} />
    ),
    price: (
      <input type="number" aria-label={`Line ${index + 1} unit price`} step="0.01" min="0" required value={line.unitPrice}
        onChange={e => onUpdate(line.key, 'unitPrice', Number(e.target.value))} className={`${billInput} text-right`} />
    ),
    total: formatCurrency(line.quantity * line.unitPrice),
    remove: (
      <button type="button" aria-label={`Remove line ${index + 1}`} onClick={() => onRemove(line.key)}
        className="p-1.5 rounded-lg text-slate-700 dark:text-slate-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    ),
  };
}
