/**
 * InvoiceLineItemsTable — the line editor shared by the new and edit customer
 * invoice pages. Each line may name the revenue account it credits (blank =
 * the company's default sales account), its VAT type (a VAT vendor only: the
 * platform list, InvoiceLineVatSelect; the rate comes from the type and the
 * invoice date) and, behind "Dimensions", the job (Project Profitability,
 * migration 874) and the CC2 project and BU (migration 870) its revenue
 * belongs to — labelled apart, since the job and the CC2 project are two
 * models until Hein rules. The dimensions sit on their own row under each line
 * (InvoiceLineDimensions), a third of the row each, so they are never squeezed
 * into a column. The CC1 is derived (from the CC2, or the customer's FNO),
 * never picked. The bill editor's account column, mirrored; the pickers offer
 * only what the save accepts.
 *
 * The page owns the lines, their VAT types and their total (`lineTotal`), so
 * how a line is priced stays the page's business; this table only renders and
 * edits them. The page also loads the picker options
 * (useInvoiceLineCodingOptions), which its own header Project picker shares.
 */
import { Fragment, useState, type ReactNode } from 'react';
import { Plus, Trash2, SlidersHorizontal, Tags } from 'lucide-react';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import type { CodingOption, InvoiceLineCodingOptions } from './useInvoiceLineCodingOptions';
import { Select, type SelectOption } from '@/components/ui/Select';
import { discountInput } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { AmountInput } from '@/components/ui/AmountInput';
import type { LineVatTypeOrNone } from './formVat';
import { InvoiceLineVatSelect } from './InvoiceLineVatSelect';
import { InvoiceLineDimensions } from './InvoiceLineDimensions';

export interface InvoiceLine {
  key: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  /** The new-invoice page only: `discount` is the customer's default, not the user's (useContactDefaults). Never sent. */
  discountFromDefault?: boolean;
  /** The new-invoice page only: `glAccountId` is the customer's default revenue account, not the user's pick. Never sent. */
  accountFromDefault?: boolean;
  /** '' = uncoded. */
  glAccountId: string;
  /** The job (`projects`). */
  projectId: string;
  /** Migration 870's CC2 project and business unit. */
  cc2Id: string;
  buId: string;
  /** The new-invoice page's Type column; absent on the edit page. */
  incomeType?: string;
  /** The line's own VAT type (formVat.lineVatType): absent = the customer's default, null = none yet. */
  vatType?: string | null;
  /** A legacy line off a no-VAT header: the end of its default chain (formVat). */
  vatFallback?: 'zero_rated';
}

interface Props {
  lines: InvoiceLine[];
  currencyCode: string;
  lineTotal: (l: InvoiceLine) => number;
  onUpdate: (key: string, field: keyof InvoiceLine, value: string | number) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
  /** A line that bills a time entry (the edit page's WIP lines): badged, so removing it is not a surprise. */
  billsTimeEntry?: (key: string) => boolean;
  options: InvoiceLineCodingOptions;
  showIncomeType?: boolean;
  /** Inclusive mode: Unit Price holds the gross the user types, and Total the stored ex-VAT amount the subtotal adds up. */
  pricesIncludeVat?: boolean;
  /** Muted note saying where a defaulted line discount came from. */
  discountHint?: string;
  /** Note saying the customer's default revenue account is not applied, and why (new page). */
  accountHint?: string;
  /** Each line's VAT type, in line order; absent for a company not registered for VAT (no VAT column). */
  vatTypes?: readonly LineVatTypeOrNone[];
  /** The invoice date: the standard rate shown beside the type is the one on it. */
  vatDate?: string;
  /** Muted note saying the lines' VAT type came from the customer; a warning when the customer and the lines disagree. */
  vatHint?: string;
  vatWarning?: string;
  /** The settings row ("Amounts are", currency: InvoiceSettingsRow), shown under the Line Items header. */
  settings?: ReactNode;
}

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const th = 'px-3 py-2.5 text-xs font-semibold text-slate-500 dark:text-slate-400';
const toggle = (on: boolean) => `inline-flex items-center gap-1 whitespace-nowrap text-xs px-2.5 py-1.5 rounded-lg border font-medium transition-colors ${on ? 'border-teal-400/60 text-teal-700 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/20' : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-amber-400/50 hover:text-amber-500'}`;

/** The "no value" row: the line's own empty label, stored as ''. */
const NONE = '__none__';

const INCOME_TYPES: SelectOption[] = [
  { value: 'activation', label: 'Activation' }, { value: 'bonus', label: 'Bonus' },
  { value: 'adjustment', label: 'Adjustment' }, { value: 'other', label: 'Other' },
];

const UNOFFERED: Record<InvoiceLineCodingOptions['status'], string> = {
  loading: 'Loading…',
  failed: 'Could not load the list — kept as saved',
  ready: 'Unavailable — choose another',
};

export function CodingPicker({ value, options, all, empty, onChange, label, disabled, id, labelClassName = 'sr-only' }: {
  id?: string; value: string; options: CodingOption[]; all: InvoiceLineCodingOptions; empty: string;
  onChange: (v: string) => void; label: string; disabled?: boolean; labelClassName?: string;
}) {
  // A stored id the list does not offer (cancelled, deactivated, past the list's
  // cap, or written by another path) stays selected and says what it is, so
  // saving does not silently recode it.
  const offered = options.some((o) => o.id === value);
  const unoffered = value !== '' && !offered ? (all.known[value] ?? UNOFFERED[all.lookupFailed ? 'failed' : all.status]) : null;
  // The unoffered stored id is a real row and stays one after the user switches away, so a stray pick can be undone.
  const [keep, setKeep] = useState<SelectOption | null>(null);
  if (unoffered !== null && (keep?.value !== value || keep.label !== unoffered)) setKeep({ value, label: unoffered });
  const kept = keep && !options.some((o) => o.id === keep.value) ? [keep] : [];
  const choices: SelectOption[] = [{ value: NONE, label: empty }, ...kept, ...options.map((o) => ({ value: o.id, label: o.label }))];
  return (
    <Select
      id={id} label={label} labelClassName={labelClassName} size="sm" searchable disabled={disabled}
      options={choices} value={value === '' ? NONE : value}
      onChange={(v) => onChange(v === null || v === NONE ? '' : v)}
    />
  );
}

export function InvoiceLineItemsTable({
  lines, currencyCode, lineTotal, onUpdate, onAdd, onRemove, options, showIncomeType, pricesIncludeVat, discountHint, accountHint, billsTimeEntry,
  vatTypes, vatDate = '', vatHint, vatWarning, settings,
}: Props) {
  const [discountToggled, setDiscountToggled] = useState<boolean | null>(null);
  // Open whenever a line carries a discount, and not hideable: a discount the user cannot see is one they did not give.
  // Typing in the column pins it open, so clearing a discount to retype it does not take the field away.
  const carriesDiscount = lines.some((l) => l.discount > 0);
  const showDiscount = carriesDiscount || discountToggled === true;
  const [dimensionsToggled, setDimensionsToggled] = useState<boolean | null>(null);
  // Open whenever a line carries a dimension, and not hideable, as the discount: coding the user cannot see is saved all
  // the same. Picking one pins them open, so clearing a dimension to pick another does not take the pickers away.
  const carriesDimension = lines.some((l) => l.projectId !== '' || l.cc2Id !== '' || l.buId !== '');
  const showDimensions = carriesDimension || dimensionsToggled === true;
  const updateDimension = (key: string, field: keyof InvoiceLine, value: string) => { setDimensionsToggled(true); onUpdate(key, field, value); };
  const showVat = vatTypes !== undefined;
  const columns = 6 + (showIncomeType ? 1 : 0) + (showDiscount ? 1 : 0) + (showVat ? 1 : 0);

  return (
    <>
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2 whitespace-nowrap"><span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">3</span>Line Items</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-expanded={showDimensions} disabled={carriesDimension} title={carriesDimension ? 'Clear the dimensions to hide them' : undefined} onClick={() => setDimensionsToggled(!showDimensions)} className={`${toggle(showDimensions)} disabled:opacity-60 disabled:cursor-not-allowed`}>
            <Tags className="h-3 w-3" />{showDimensions ? 'Hide Dimensions' : 'Dimensions'}
          </button>
          <button type="button" aria-expanded={showDiscount} disabled={carriesDiscount} title={carriesDiscount ? 'Clear the discounts to hide this column' : undefined} onClick={() => setDiscountToggled(!showDiscount)} className={`${toggle(showDiscount)} disabled:opacity-60 disabled:cursor-not-allowed`}>
            <SlidersHorizontal className="h-3 w-3" />{showDiscount ? 'Hide Disc.' : 'Disc. %'}
          </button>
          <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 whitespace-nowrap text-xs px-2.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-semibold transition-colors"><Plus className="h-3 w-3" />Add Line</button>
        </div>
      </div>
      {settings}
      {discountHint && <p className="px-5 pt-3 text-xs text-gray-600 dark:text-gray-400">{discountHint}</p>}
      {accountHint && <p role="status" className="px-5 pt-3 text-xs text-amber-700 dark:text-amber-400">{accountHint}</p>}
      {/* Always mounted: a status region announces a change only if it was in the page before the change. */}
      {showVat && (
        <div role="status" className="px-5 empty:hidden">
          {vatHint && <p className="pt-3 text-xs text-slate-600 dark:text-slate-400">{vatHint}</p>}
          {vatWarning && <p className="pt-1 text-xs text-amber-700 dark:text-amber-300">{vatWarning}</p>}
        </div>
      )}
      {options.error && (
        <p className="px-5 pt-3 text-xs text-red-600 dark:text-red-400">
          {options.error}{' '}
          <button type="button" onClick={options.retry} className="underline font-medium">Retry</button>
        </p>
      )}
      <p className="px-5 pt-2 text-xs text-slate-600 dark:text-slate-400 md:hidden">Scroll sideways to see every column.</p>
      <div className="overflow-x-auto" role="region" aria-label="Invoice lines" tabIndex={0}>
      <table className="w-full min-w-[760px] text-sm">
        <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
          <tr>
            <th className={`${th} px-4 text-left`}>Description</th>
            {showIncomeType && <th className={`${th} text-left w-32`}>Type</th>}
            <th className={`${th} text-left w-48`}>Account</th>
            <th className={`${th} text-right w-20`}>Qty</th>
            <th className={`${th} text-right w-32`}>Unit Price{pricesIncludeVat && <span className="font-normal"> (incl. VAT)</span>}</th>
            {showDiscount && <th className={`${th} text-right w-20`}>Disc.%</th>}
            {showVat && <th className={`${th} text-left w-44`}>VAT</th>}
            <th className={`${th} px-4 text-right w-32`}>Total{pricesIncludeVat && <span className="font-normal"> (excl. VAT)</span>}</th>
            <th className="w-9"><span className="sr-only">Remove line</span></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <Fragment key={l.key}>
            <tr className={`group transition-colors ${i > 0 ? 'border-t border-slate-100 dark:border-slate-800' : ''}`}>
              <td className="px-3 py-2"><input name="description" aria-label="Description" value={l.description} onChange={(e) => onUpdate(l.key, 'description', e.target.value)} placeholder="Item description" className={inp} />
                {billsTimeEntry?.(l.key) && <span className="mt-1 inline-block rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-900/50 dark:text-sky-100">Time entry</span>}</td>
              {showIncomeType && <td className="px-3 py-2"><Select label="Income type" labelClassName="sr-only" size="sm" options={INCOME_TYPES} value={l.incomeType ?? 'other'} onChange={(v) => onUpdate(l.key, 'incomeType', v ?? 'other')} /></td>}
              <td className="px-3 py-2"><CodingPicker label="Revenue account" value={l.glAccountId} options={options.accounts} all={options} empty="Default sales" onChange={(v) => onUpdate(l.key, 'glAccountId', v)} />
                {l.accountFromDefault && l.glAccountId !== '' && <span className="mt-1 block text-xs text-slate-600 dark:text-slate-400">from customer</span>}</td>
              <td className="px-3 py-2"><AmountInput name="quantity" aria-label="Quantity" value={l.quantity} decimals={2} onValueChange={(n) => onUpdate(l.key, 'quantity', n)} className={`${inp} text-right`} /></td>
              <td className="px-3 py-2"><AmountInput name="unitPrice" aria-label={pricesIncludeVat ? 'Unit price incl. VAT' : 'Unit price'} value={l.unitPrice} min={0} onValueChange={(n) => onUpdate(l.key, 'unitPrice', n)} className={`${inp} text-right`} /></td>
              {showDiscount && <td className="px-3 py-2"><input type="number" inputMode="decimal" aria-label="Discount %" min={0} max={100} step={0.01} value={l.discount || ''} onChange={(e) => { setDiscountToggled(true); onUpdate(l.key, 'discount', e.target.value === '' ? 0 : discountInput(Number(e.target.value))); }} placeholder="0" className={`${inp} text-right`} /></td>}
              {showVat && <td className="px-3 py-2"><InvoiceLineVatSelect value={vatTypes[i] ?? null} date={vatDate} onChange={(t) => onUpdate(l.key, 'vatType', t)} /></td>}
              <td className="px-4 py-2 text-right">
                <span className="tabular-nums text-sm font-semibold text-slate-800 dark:text-slate-200">{formatCurrencyAmount(lineTotal(l), currencyCode)}</span>
                {showDiscount && l.discount > 0 && <span className="block text-xs text-teal-700 dark:text-teal-400 font-medium">-{l.discount}%</span>}
              </td>
              <td className="px-2 py-2"><button type="button" aria-label="Remove line" onClick={() => onRemove(l.key)} className="p-1.5 rounded-lg text-slate-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button></td>
            </tr>
            {showDimensions && (
              <tr><td colSpan={columns} className="px-3 pb-3 pt-0"><InvoiceLineDimensions line={l} options={options} onUpdate={updateDimension} /></td></tr>
            )}
            </Fragment>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}
