/**
 * WhatIfEventRow — one what-if event: date, kind, amount, remove. Stacks on narrow screens (date on its own
 * line, then kind + amount + remove) so the date field keeps room for its error; one grid row from `lg` up.
 * Every control is named per row, so a screen reader hears "Event 2 amount", not three anonymous inputs.
 */

import { useId } from 'react';
import { X } from 'lucide-react';
import { Input, inputVariants } from '@/components/ui';
import { cn } from '@/utils/cn';
import { GatedDateField, type GatedDateFieldProps } from '@/components/forms/GatedDateField';

export interface WhatIfEvent {
  /** Stable per row: keys the row and its date gate, so removing a row never moves a refusal onto another. */
  id: number;
  kind: string;
  date: string;
  amount: string;
}

interface Props {
  event: WhatIfEvent;
  /** 1-based position, for the control names. */
  position: number;
  gate: GatedDateFieldProps['gate'];
  canRemove: boolean;
  onChange: (field: Exclude<keyof WhatIfEvent, 'id'>, value: string) => void;
  onRemove: () => void;
}

const LABEL = 'text-sm font-medium text-gray-700 dark:text-gray-300';

export function WhatIfEventRow({ event, position, gate, canRemove, onChange, onRemove }: Props) {
  const uid = useId();
  const kindId = `${uid}-kind`;
  const amountId = `${uid}-amount`;
  return (
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_2.25rem]">
      <GatedDateField
        gate={gate} gateKey={`event-date-${event.id}`} label={`Event ${position} date`}
        value={event.date || null} onValue={iso => onChange('date', iso)}
      />
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_2.25rem] gap-2 lg:contents">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={kindId} className={LABEL}>Type</label>
          <select
            id={kindId} aria-label={`Event ${position} type`} value={event.kind}
            onChange={e => onChange('kind', e.target.value)}
            className={cn(inputVariants(), 'px-2 text-sm')}
          >
            <option value="LUMP">Lump Sum</option>
            <option value="SKIP">Skip</option>
          </select>
        </div>
        {event.kind === 'LUMP' ? (
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={amountId} className={LABEL}>Amount</label>
            <Input
              id={amountId} aria-label={`Event ${position} amount`} type="number" step="0.01" placeholder="0.00"
              value={event.amount} onChange={e => onChange('amount', e.target.value)}
            />
          </div>
        ) : (
          <div />
        )}
        <button
          type="button" onClick={onRemove} disabled={!canRemove} aria-label={`Remove event ${position}`}
          className="mt-6 inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:text-red-500 disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
