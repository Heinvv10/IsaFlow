/**
 * The purchase-order detail page's line editor (moved out of `pages/accounting/purchase-orders/[poId].tsx`), with
 * per-line CC1 / CC2 / BU pickers (budgets P5-3; `PoLineDimensions.tsx`, shared with the new-PO page). A stored id
 * the lists do not offer keeps its label (`storedLabels`, from the GET), so a save never silently recodes it.
 */
import { useState, type ReactNode } from 'react';
import { Plus, Tags, Trash2 } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';
import { PoDimensionCells, PoDimensionHeaders, usePoDimensionOptions } from './PoLineDimensions';

export interface PoEditLine {
  /** Stable per-row React key, made when the row is (the stored id, or a new uuid): never the row's index. */
  key: string;
  id?: string;
  description: string;
  quantity: string;
  unit_price: string;
  tax_rate: string;
  gl_account_id: string;
  product_id: string;
  cc1_id: string;
  cc2_id: string;
  bu_id: string;
}

export type PoEditField = Exclude<keyof PoEditLine, 'id' | 'key'>;

interface Props {
  items: PoEditLine[];
  accounts: Array<{ id: string; name: string; code: string }>;
  /** id → "code name" of the dimensions the PO's lines already carry. */
  storedLabels: Readonly<Record<string, string>>;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, field: PoEditField, value: string) => void;
  /** Rendered under the table, inside the card (the page's totals). */
  children?: ReactNode;
}

export function PoLineItemsEditor({ items, accounts, storedLabels, onAdd, onRemove, onUpdate, children }: Props) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  // Open by default once a line carries a dimension, so an edit shows what it will save.
  const showDims = toggled ?? items.some((i) => i.cc1_id !== '' || i.cc2_id !== '' || i.bu_id !== '');
  const dims = usePoDimensionOptions(showDims, storedLabels);

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Line Items</h2>
        <div className="flex items-center gap-3">
          <button type="button" aria-expanded={showDims} onClick={() => setToggled(!showDims)}
            className="inline-flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300">
            <Tags className="h-3 w-3" /> {showDims ? 'Hide Dimensions' : 'Dimensions'}
          </button>
          <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300">
            <Plus className="h-3 w-3" /> Add Item
          </button>
        </div>
      </div>
      {showDims && dims.error && (
        <p className="text-xs text-red-500">{dims.error}{' '}
          <button type="button" onClick={dims.retry} className="underline font-medium">Retry</button>
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[var(--ff-text-secondary)] border-b border-[var(--ff-border-light)]">
              <th className="pb-2 pr-2">Description</th>
              <th className="pb-2 pr-2 w-24 text-right">Qty</th>
              <th className="pb-2 pr-2 w-32 text-right">Unit Price</th>
              <th className="pb-2 pr-2 w-20 text-right">VAT %</th>
              <th className="pb-2 pr-2 w-48">Account</th>
              {showDims && <PoDimensionHeaders className="pb-2 pr-2 w-40" />}
              <th className="pb-2 w-28 text-right">Total</th>
              <th className="pb-2 w-8" />
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={item.key} className="border-b border-[var(--ff-border-light)]">
                <td className="py-2 pr-2">
                  <input type="text" required name="description" value={item.description} aria-label={`Line ${idx + 1} description`}
                    onChange={e => onUpdate(idx, 'description', e.target.value)} className="ff-input w-full text-sm" placeholder="Item description" />
                </td>
                <td className="py-2 pr-2">
                  <input type="number" required name="quantity" min="0.01" step="0.01" value={item.quantity} aria-label={`Line ${idx + 1} quantity`}
                    onChange={e => onUpdate(idx, 'quantity', e.target.value)} className="ff-input w-full text-sm text-right" />
                </td>
                <td className="py-2 pr-2">
                  <input type="number" required name="unitPrice" min="0" step="0.01" value={item.unit_price} aria-label={`Line ${idx + 1} unit price`}
                    onChange={e => onUpdate(idx, 'unit_price', e.target.value)} className="ff-input w-full text-sm text-right" />
                </td>
                <td className="py-2 pr-2">
                  <input type="number" name="taxRate" min="0" step="0.01" value={item.tax_rate} aria-label={`Line ${idx + 1} VAT rate`}
                    onChange={e => onUpdate(idx, 'tax_rate', e.target.value)} className="ff-input w-full text-sm text-right" />
                </td>
                <td className="py-2 pr-2">
                  <select name="glAccountId" value={item.gl_account_id} aria-label={`Line ${idx + 1} account`}
                    onChange={e => onUpdate(idx, 'gl_account_id', e.target.value)} className="ff-select w-full text-sm">
                    <option value="">No account</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.code} – {a.name}</option>)}
                  </select>
                </td>
                {showDims && (
                  <PoDimensionCells index={idx} value={{ cc1: item.cc1_id, cc2: item.cc2_id, bu: item.bu_id }} options={dims}
                    cellClassName="py-2 pr-2" onChange={(slot, v) => onUpdate(idx, `${slot}_id`, v)} />
                )}
                <td className="py-2 pr-2 text-right text-[var(--ff-text-primary)]">
                  {formatMoney(Number(item.quantity || 0) * Number(item.unit_price || 0))}
                </td>
                <td className="py-2">
                  {items.length > 1 && (
                    <button type="button" onClick={() => onRemove(idx)} aria-label={`Remove line ${idx + 1}`} className="text-red-400 hover:text-red-300">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {children}
    </div>
  );
}
