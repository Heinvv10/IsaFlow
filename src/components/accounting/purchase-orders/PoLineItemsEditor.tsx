/**
 * The purchase-order detail page's line editor (moved out of `pages/accounting/purchase-orders/[poId].tsx`), with
 * per-line CC1 / CC2 / BU pickers (budgets P5-3; po_items dimensions from migration 954). The pickers are the bill
 * and customer-invoice lines' `CodingPicker`, offering the company's ACTIVE masters of each kind; the server applies
 * the bill lines' rules (a CC2 brings its FNO as CC1, a contradicting CC1 is refused). A stored id the lists do
 * not offer keeps its label (`storedLabels`, from the GET), so a save never silently recodes it.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Tags, Trash2 } from 'lucide-react';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import { CodingPicker } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import {
  centreOptions, useInvoiceLineCodingOptions, type CodingOption,
} from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';

export interface PoEditLine {
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

export type PoEditField = Exclude<keyof PoEditLine, 'id'>;

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

/** Active CC1 centres (the bill table derives CC1; a PO line may name one, as the budget slices do). */
function useCc1Options(): { cc1s: CodingOption[]; error: string } {
  const [state, setState] = useState<{ cc1s: CodingOption[]; error: string }>({ cc1s: [], error: '' });
  useEffect(() => {
    let live = true;
    apiJson('/api/accounting/cost-centres?active=true&cc_type=cc1', undefined, 'Could not load the CC1 cost centres - try again')
      .then((body) => { if (live) setState({ cc1s: centreOptions(body), error: '' }); })
      .catch((err: unknown) => { if (live) setState({ cc1s: [], error: apiErrorMessage(err, 'Could not load the CC1 cost centres - try again') }); });
    return () => { live = false; };
  }, []);
  return state;
}

export function PoLineItemsEditor({ items, accounts, storedLabels, onAdd, onRemove, onUpdate, children }: Props) {
  const coding = useInvoiceLineCodingOptions();
  const { cc1s, error: cc1Error } = useCc1Options();
  const all = { ...coding, known: { ...storedLabels, ...coding.known, ...Object.fromEntries(cc1s.map((o) => [o.id, o.label])) } };
  const [toggled, setToggled] = useState<boolean | null>(null);
  // Open by default once a line carries a dimension, so an edit shows what it will save.
  const showDims = toggled ?? items.some((i) => i.cc1_id !== '' || i.cc2_id !== '' || i.bu_id !== '');
  const error = coding.error || cc1Error;

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
      {showDims && error && (
        <p className="text-xs text-red-500">{error}{' '}
          <button type="button" onClick={coding.retry} className="underline font-medium">Retry</button>
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
              {showDims && <th className="pb-2 pr-2 w-40">CC1</th>}
              {showDims && <th className="pb-2 pr-2 w-40">CC2 project</th>}
              {showDims && <th className="pb-2 pr-2 w-36">BU</th>}
              <th className="pb-2 w-28 text-right">Total</th>
              <th className="pb-2 w-8" />
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={idx} className="border-b border-[var(--ff-border-light)]">
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
                  <td className="py-2 pr-2">
                    <CodingPicker label={`Line ${idx + 1} CC1`} value={item.cc1_id} options={cc1s} all={all} empty="No CC1"
                      onChange={v => onUpdate(idx, 'cc1_id', v)} />
                  </td>
                )}
                {showDims && (
                  <td className="py-2 pr-2">
                    <CodingPicker label={`Line ${idx + 1} CC2 project`} value={item.cc2_id} options={coding.cc2s} all={all} empty="No CC2 project"
                      onChange={v => onUpdate(idx, 'cc2_id', v)} />
                  </td>
                )}
                {showDims && (
                  <td className="py-2 pr-2">
                    <CodingPicker label={`Line ${idx + 1} BU`} value={item.bu_id} options={coding.bus} all={all} empty="No BU"
                      onChange={v => onUpdate(idx, 'bu_id', v)} />
                  </td>
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
