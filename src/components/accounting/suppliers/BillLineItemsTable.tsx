/**
 * BillLineItemsTable — editable line-item grid for supplier bill creation.
 * Behind "Dimensions", each line may name its CC2 project and BU (migration
 * 870); the CC1 is derived from the CC2, never picked. The pickers are the
 * customer invoice table's, offering the same active masters.
 */
import { useCallback, useState } from 'react';
import { Plus, Tags } from 'lucide-react';
import { useOverflowX } from '@/hooks/useOverflowX';
import { useElementWidth } from '@/hooks/useElementWidth';
import type { InvoiceLineCodingOptions } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';
import { billLineFields } from './BillLineFields';
import { BillLinesCards, BillLinesTable } from './BillLineLayouts';
import { useCostCentreLadder } from './billLineCc1';

/** Narrower than this the columns would crush the description, so each line stacks as a card instead of a row. */
const TABLE_MIN_WIDTH = 820;
const TABLE_MIN_WIDTH_DIMENSIONS = 1060;
/** Under this a stacked card puts every field on its own row. */
const CARD_ONE_COLUMN = 420;

export interface BillLineItem {
  key: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  glAccountId: string;
  /** The PO line this line was copied from: it nets the PO's commitment (`poBillLines.ts`). */
  poItemId?: string;
  /** A copied PO line's CC1, kept with its CC2; picking a CC2 drops it, and the server derives it again. */
  cc1Id?: string;
  /** Migration 870's CC2 project and BU ('' = none); the CC1 is derived from the CC2 or the supplier's default. */
  cc2Id?: string;
  buId?: string;
}

export interface GLAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType?: string;
}

interface Props {
  lines: BillLineItem[];
  glAccounts: GLAccount[];
  onAdd: () => void;
  onUpdate: (key: string, field: keyof BillLineItem, value: string | number) => void;
  onRemove: (key: string) => void;
  /** CC2 / BU picker options; without them the Dimensions toggle is not offered. */
  codingOptions?: InvoiceLineCodingOptions;
  /** The supplier's pre-filled CC2 / BU (migration 890) and what the server applies on save; see useSupplierDimensionDefaults. */
  supplierDefaults?: { cc2Id: string; buId: string; note: string; /** The supplier's default FNO, shown as the CC1 of a line with no project. */ cc1Id?: string };
}

export function BillLineItemsTable({ lines, glAccounts, onAdd, onUpdate, onRemove, codingOptions, supplierDefaults }: Props) {
  const { attach: attachLines, overflows: linesOverflow } = useOverflowX();
  const [dimensionsToggled, setDimensionsToggled] = useState<boolean | null>(null);
  // Open by default once a line carries a dimension (a supplier default), so the user sees what will post.
  const showDimensions = codingOptions !== undefined
    && (dimensionsToggled ?? lines.some(l => Boolean(l.cc2Id) || Boolean(l.buId)));
  const ladder = useCostCentreLadder(showDimensions);
  const { attach: attachWidth, width } = useElementWidth();
  const attachRegion = useCallback((el: HTMLElement | null) => { attachLines(el); attachWidth(el); }, [attachLines, attachWidth]);
  // Stack once the region cannot hold the columns (width 0 = not measured / no layout: keep the table).
  const stacked = width > 0 && width < (showDimensions ? TABLE_MIN_WIDTH_DIMENSIONS : TABLE_MIN_WIDTH);
  const ctx = { glAccounts, onUpdate, onRemove, codingOptions, supplierDefaults, ladder, showDimensions };
  const rows = lines.map((line, i) => ({ key: line.key, f: billLineFields(line, i, ctx) }));
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
          <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">
            2
          </span>
          Line Items
        </h3>
        <div className="flex flex-wrap items-center gap-2">
        {codingOptions && (
          <button
            type="button"
            aria-expanded={showDimensions}
            onClick={() => setDimensionsToggled(!showDimensions)}
            className={`inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border font-medium transition-colors ${showDimensions ? 'border-teal-400/60 text-teal-600 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/20' : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-amber-400/50 hover:text-amber-500'}`}
          >
            <Tags className="h-3 w-3" />
            {showDimensions ? 'Hide Dimensions' : 'Dimensions'}
          </button>
        )}
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-semibold transition-colors"
        >
          <Plus className="h-3 w-3" />
          Add Line
        </button>
        </div>
      </div>
      {supplierDefaults?.note && (
        <p className="px-5 pt-3 text-xs text-slate-500 dark:text-slate-400">{supplierDefaults.note}</p>
      )}
      {showDimensions && codingOptions?.error && (
        <p className="px-5 pt-3 text-xs text-red-600 dark:text-red-400">
          {codingOptions.error}{' '}
          <button type="button" onClick={codingOptions.retry} className="underline font-medium">Retry</button>
        </p>
      )}

      {!stacked && linesOverflow && <p className="px-5 pt-2 text-xs text-slate-600 dark:text-slate-400">Scroll sideways to see every column.</p>}
      <div
        ref={attachRegion}
        className={stacked ? 'mx-5 my-4' : 'rounded-xl border border-slate-200 dark:border-slate-800 overflow-x-auto mx-5 my-4'}
        role="region" aria-label="Invoice lines" tabIndex={0}
      >
        {stacked
          ? <BillLinesCards rows={rows} showDimensions={showDimensions} oneColumn={width < CARD_ONE_COLUMN} />
          : <BillLinesTable rows={rows} showDimensions={showDimensions} />}
      </div>
    </div>
  );
}
