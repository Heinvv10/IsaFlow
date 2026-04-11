/**
 * Recurring Invoice — Line Items section (shared between new and edit pages)
 */
import { Plus, Trash2 } from 'lucide-react';

export interface LineItem {
  key: string;
  description: string;
  quantity: number;
  unitPrice: number;
  glAccountId: string;
}

interface Props {
  lines: LineItem[];
  taxRate: number;
  onTaxRateChange: (rate: number) => void;
  onUpdateLine: (key: string, field: keyof Omit<LineItem, 'key'>, value: string | number) => void;
  onAddLine: () => void;
  onRemoveLine: (key: string) => void;
  inputCls: string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export function LineItemsSection({
  lines, taxRate, onTaxRateChange, onUpdateLine, onAddLine, onRemoveLine, inputCls,
}: Props) {
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const taxAmount = Math.round(subtotal * (taxRate / 100) * 100) / 100;
  const total = subtotal + taxAmount;

  return (
    <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] uppercase tracking-wide">Line Items</h2>
        <button
          type="button"
          onClick={onAddLine}
          className="inline-flex items-center gap-1.5 text-xs text-violet-400 hover:text-violet-300 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" /> Add Line
        </button>
      </div>

      <div className="hidden md:grid grid-cols-12 gap-2 text-xs text-[var(--ff-text-secondary)] px-1">
        <div className="col-span-5">Description</div>
        <div className="col-span-2">Qty</div>
        <div className="col-span-2">Unit Price</div>
        <div className="col-span-2 text-right">Line Total</div>
        <div className="col-span-1" />
      </div>

      {lines.map(line => (
        <div key={line.key} className="grid grid-cols-12 gap-2 items-center">
          <div className="col-span-5">
            <input
              className={inputCls}
              value={line.description}
              onChange={e => onUpdateLine(line.key, 'description', e.target.value)}
              placeholder="Description *"
              required
            />
          </div>
          <div className="col-span-2">
            <input
              type="number"
              className={inputCls}
              value={line.quantity}
              min={0.01}
              step="0.01"
              onChange={e => onUpdateLine(line.key, 'quantity', Number(e.target.value))}
              required
            />
          </div>
          <div className="col-span-2">
            <input
              type="number"
              className={inputCls}
              value={line.unitPrice}
              min={0}
              step="0.01"
              onChange={e => onUpdateLine(line.key, 'unitPrice', Number(e.target.value))}
              required
            />
          </div>
          <div className="col-span-2 text-right text-sm text-[var(--ff-text-primary)] pr-1">
            {fmt(line.quantity * line.unitPrice)}
          </div>
          <div className="col-span-1 flex justify-end">
            <button
              type="button"
              onClick={() => onRemoveLine(line.key)}
              disabled={lines.length === 1}
              className="p-1 text-red-400 hover:text-red-300 disabled:opacity-30 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}

      {/* Totals */}
      <div className="border-t border-[var(--ff-border-light)] pt-3 space-y-1 text-sm">
        <div className="flex justify-between text-[var(--ff-text-secondary)]">
          <span>Subtotal</span><span>{fmt(subtotal)}</span>
        </div>
        <div className="flex justify-between items-center text-[var(--ff-text-secondary)]">
          <div className="flex items-center gap-2">
            <span>VAT</span>
            <select
              className="text-xs px-2 py-0.5 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded text-[var(--ff-text-secondary)]"
              value={taxRate}
              onChange={e => onTaxRateChange(Number(e.target.value))}
            >
              <option value={0}>0%</option>
              <option value={15}>15%</option>
            </select>
          </div>
          <span>{fmt(taxAmount)}</span>
        </div>
        <div className="flex justify-between font-semibold text-[var(--ff-text-primary)] text-base pt-1">
          <span>Total</span><span>{fmt(total)}</span>
        </div>
      </div>
    </div>
  );
}
