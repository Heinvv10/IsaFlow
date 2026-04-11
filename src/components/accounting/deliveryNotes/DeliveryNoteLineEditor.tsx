/**
 * Delivery Note Line Items Editor — sub-component
 */

import { Plus, Trash2 } from 'lucide-react';

export interface LineItem {
  description: string;
  quantity: number;
  unit: string;
}

export const emptyLine = (): LineItem => ({ description: '', quantity: 1, unit: '' });

interface Props {
  lines: LineItem[];
  onChange: (lines: LineItem[]) => void;
}

export function DeliveryNoteLineEditor({ lines, onChange }: Props) {
  const update = (index: number, field: keyof LineItem, value: string | number) => {
    const next = [...lines];
    next[index] = { ...next[index]!, [field]: value };
    onChange(next);
  };

  const remove = (index: number) => onChange(lines.filter((_, i) => i !== index));

  const add = () => onChange([...lines, emptyLine()]);

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-3">
      <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] uppercase tracking-wide">
        Line Items
      </h2>

      <div className="grid grid-cols-12 gap-2 text-xs text-[var(--ff-text-secondary)] px-1">
        <span className="col-span-6">Description *</span>
        <span className="col-span-3 text-right">Quantity</span>
        <span className="col-span-2">Unit</span>
        <span className="col-span-1" />
      </div>

      {lines.map((line, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 items-center">
          <input
            value={line.description}
            onChange={(e) => update(i, 'description', e.target.value)}
            placeholder="Item description"
            className="ff-input text-sm col-span-6"
          />
          <input
            type="number"
            min="0"
            step="any"
            value={line.quantity}
            onChange={(e) => update(i, 'quantity', Number(e.target.value))}
            className="ff-input text-sm col-span-3 text-right"
          />
          <input
            value={line.unit}
            onChange={(e) => update(i, 'unit', e.target.value)}
            placeholder="ea"
            className="ff-input text-sm col-span-2"
          />
          <button
            onClick={() => remove(i)}
            disabled={lines.length === 1}
            className="col-span-1 p-1.5 rounded hover:bg-red-500/10 text-red-400 disabled:opacity-30 justify-self-center"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      <button
        onClick={add}
        className="flex items-center gap-1.5 text-xs text-teal-400 hover:text-teal-300 mt-1"
      >
        <Plus className="h-3.5 w-3.5" /> Add line
      </button>
    </div>
  );
}
