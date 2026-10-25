/**
 * InvoiceLineItemsTable — the line editor shared by the new and edit customer
 * invoice pages. Each line may name the revenue account it credits (blank =
 * the company's default sales account) and, behind "Dimensions", the job
 * (Project Profitability, migration 874) and the CC2 project and BU (migration
 * 870) its revenue belongs to — labelled apart, since the job and the CC2
 * project are two models until Hein rules. The CC1 is derived (from the CC2,
 * or the customer's FNO), never picked. The bill editor's account column,
 * mirrored; the pickers offer only what the save accepts.
 *
 * The page owns the lines and their total (`lineTotal`), so how a line is
 * priced stays the page's business; this table only renders and edits them.
 * The page also loads the picker options (useInvoiceLineCodingOptions), which
 * its own header Project picker shares.
 */
import { useState } from 'react';
import { Plus, Trash2, SlidersHorizontal, Tags } from 'lucide-react';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import type { CodingOption, InvoiceLineCodingOptions } from './useInvoiceLineCodingOptions';
import { discountInput } from '@/modules/accounting/services/ar/invoiceLineAmount';

export interface InvoiceLine {
  key: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  /** '' = uncoded. */
  glAccountId: string;
  /** The job (`projects`). */
  projectId: string;
  /** Migration 870's CC2 project and business unit. */
  cc2Id: string;
  buId: string;
  /** The new-invoice page's Type column; absent on the edit page. */
  incomeType?: string;
}

interface Props {
  lines: InvoiceLine[];
  currencyCode: string;
  lineTotal: (l: InvoiceLine) => number;
  onUpdate: (key: string, field: keyof InvoiceLine, value: string | number) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
  options: InvoiceLineCodingOptions;
  showIncomeType?: boolean;
}

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const th = 'px-3 py-2.5 text-xs font-semibold text-slate-500 dark:text-slate-400';
const toggle = (on: boolean) => `inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border font-medium transition-colors ${on ? 'border-teal-400/60 text-teal-600 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/20' : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-amber-400/50 hover:text-amber-500'}`;

const UNOFFERED: Record<InvoiceLineCodingOptions['status'], string> = {
  loading: 'Loading…',
  failed: 'Could not load the list — kept as saved',
  ready: 'Unavailable — choose another',
};

export function CodingPicker({ value, options, all, empty, onChange, label, disabled }: {
  value: string; options: CodingOption[]; all: InvoiceLineCodingOptions; empty: string;
  onChange: (v: string) => void; label: string; disabled?: boolean;
}) {
  // A stored id the list does not offer (cancelled, deactivated, past the list's
  // cap, or written by another path) stays selected and says what it is, so
  // saving does not silently recode it.
  const offered = options.some((o) => o.id === value);
  const unoffered = value !== '' && !offered ? (all.known[value] ?? UNOFFERED[all.lookupFailed ? 'failed' : all.status]) : null;
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={inp}>
      <option value="">{empty}</option>
      {unoffered !== null && <option value={value}>{unoffered}</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

export function InvoiceLineItemsTable({
  lines, currencyCode, lineTotal, onUpdate, onAdd, onRemove, options, showIncomeType,
}: Props) {
  const [showDiscount, setShowDiscount] = useState(false);
  const [dimensionsToggled, setDimensionsToggled] = useState<boolean | null>(null);
  // Open by default when a line already carries a dimension, so an edit shows what it will save.
  const showDimensions = dimensionsToggled ?? lines.some((l) => l.projectId !== '' || l.cc2Id !== '' || l.buId !== '');

  return (
    <>
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2"><span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">3</span>Line Items</h3>
        <div className="flex items-center gap-2">
          <button type="button" aria-expanded={showDimensions} onClick={() => setDimensionsToggled(!showDimensions)} className={toggle(showDimensions)}>
            <Tags className="h-3 w-3" />{showDimensions ? 'Hide Dimensions' : 'Dimensions'}
          </button>
          <button type="button" aria-expanded={showDiscount} onClick={() => setShowDiscount((v) => !v)} className={toggle(showDiscount)}>
            <SlidersHorizontal className="h-3 w-3" />{showDiscount ? 'Hide Disc.' : 'Disc. %'}
          </button>
          <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-semibold transition-colors"><Plus className="h-3 w-3" />Add Line</button>
        </div>
      </div>
      {options.error && (
        <p className="px-5 pt-3 text-xs text-red-600 dark:text-red-400">
          {options.error}{' '}
          <button type="button" onClick={options.retry} className="underline font-medium">Retry</button>
        </p>
      )}
      <table className="w-full text-sm">
        <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
          <tr>
            <th className={`${th} px-4 text-left`}>Description</th>
            {showIncomeType && <th className={`${th} text-left w-32`}>Type</th>}
            <th className={`${th} text-left w-44`}>Account</th>
            {showDimensions && <th className={`${th} text-left w-40`}>Job <span className="font-normal">(Project Profitability)</span></th>}
            {showDimensions && <th className={`${th} text-left w-36`}>CC2 project</th>}
            {showDimensions && <th className={`${th} text-left w-32`}>BU</th>}
            <th className={`${th} text-right w-20`}>Qty</th>
            <th className={`${th} text-right w-32`}>Unit Price</th>
            {showDiscount && <th className={`${th} text-right w-20`}>Disc.%</th>}
            <th className={`${th} px-4 text-right w-32`}>Total</th>
            <th className="w-9" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {lines.map((l) => (
            <tr key={l.key} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
              <td className="px-3 py-2"><input name="description" aria-label="Description" value={l.description} onChange={(e) => onUpdate(l.key, 'description', e.target.value)} placeholder="Item description" className={inp} /></td>
              {showIncomeType && <td className="px-3 py-2"><select name="incomeType" value={l.incomeType} onChange={(e) => onUpdate(l.key, 'incomeType', e.target.value)} className={inp}>
                <option value="activation">Activation</option><option value="bonus">Bonus</option><option value="adjustment">Adjustment</option><option value="other">Other</option>
              </select></td>}
              <td className="px-3 py-2"><CodingPicker label="Revenue account" value={l.glAccountId} options={options.accounts} all={options} empty="Default sales" onChange={(v) => onUpdate(l.key, 'glAccountId', v)} /></td>
              {showDimensions && <td className="px-3 py-2"><CodingPicker label="Job (Project Profitability)" value={l.projectId} options={options.projects} all={options} empty="No job" onChange={(v) => onUpdate(l.key, 'projectId', v)} /></td>}
              {showDimensions && <td className="px-3 py-2"><CodingPicker label="CC2 project" value={l.cc2Id} options={options.cc2s} all={options} empty="No CC2 project" onChange={(v) => onUpdate(l.key, 'cc2Id', v)} /></td>}
              {showDimensions && <td className="px-3 py-2"><CodingPicker label="BU" value={l.buId} options={options.bus} all={options} empty="No BU" onChange={(v) => onUpdate(l.key, 'buId', v)} /></td>}
              <td className="px-3 py-2"><input type="number" name="quantity" aria-label="Quantity" value={l.quantity} onChange={(e) => onUpdate(l.key, 'quantity', Number(e.target.value))} className={`${inp} text-right`} /></td>
              <td className="px-3 py-2"><input type="number" name="unitPrice" aria-label="Unit price" value={l.unitPrice} step={0.01} onChange={(e) => onUpdate(l.key, 'unitPrice', Number(e.target.value))} className={`${inp} text-right`} /></td>
              {showDiscount && <td className="px-3 py-2"><input type="number" aria-label="Discount %" min={0} max={100} step={0.01} value={l.discount || ''} onChange={(e) => onUpdate(l.key, 'discount', e.target.value === '' ? 0 : discountInput(Number(e.target.value)))} placeholder="0" className={`${inp} text-right`} /></td>}
              <td className="px-4 py-2 text-right">
                <span className="font-mono text-sm font-semibold text-slate-800 dark:text-slate-200">{formatCurrencyAmount(lineTotal(l), currencyCode)}</span>
                {showDiscount && l.discount > 0 && <span className="block text-xs text-teal-600 dark:text-teal-400 font-medium">-{l.discount}%</span>}
              </td>
              <td className="px-2 py-2"><button type="button" aria-label="Remove line" onClick={() => onRemove(l.key)} className="p-1.5 rounded-lg text-slate-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
