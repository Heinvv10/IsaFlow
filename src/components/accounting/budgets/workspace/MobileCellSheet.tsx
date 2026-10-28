/**
 * The phone / coarse-pointer editor (spec §12): a bottom sheet for ONE cell, opened by tapping it.
 * It names the account and month, takes the amount (`MoneyField`, the kit parser), and offers
 * Save cell, Next month (saves, then moves on) and the row's actions. No range selection, clipboard or fill here.
 * A saved cell joins the normal dirty / undo / save-bar flow.
 */
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { MoneyField } from '@/components/ui/MoneyField';
import { useFocusTrap } from '@/components/ui/useFocusTrap';

export interface MobileCellTarget {
  /** "1000 Sales" */
  accountLabel: string;
  /** "Mar 2026" / "Full year" */
  monthLabel: string;
  cents: number | null;
  editable: boolean;
  readReason: string | null;
  /** The FY column: saving spreads evenly over the months. */
  isTotal: boolean;
  hasNext: boolean;
}

interface MobileCellSheetProps {
  target: MobileCellTarget;
  onSave(cents: number | null): void;
  /** Saves this cell (when editable and changed) and moves to the next month. */
  onNext(cents: number | null): void;
  onClose(): void;
  /** The row's actions (spread …), already bound; empty when none apply. */
  actions: readonly { label: string; onClick(): void }[];
}

export function MobileCellSheet({ target, onSave, onNext, onClose, actions }: MobileCellSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [cents, setCents] = useState<number | null>(target.cents);
  const [valid, setValid] = useState(true);
  useFocusTrap(ref, true, onClose);
  const title = `${target.accountLabel}, ${target.monthLabel}`;

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={onClose} role="presentation">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={`${title} budget`}
        onClick={e => e.stopPropagation()}
        className="w-full rounded-t-xl border-t border-[var(--ff-border-secondary)] bg-[var(--ff-bg-secondary)] p-4 pb-6 space-y-3"
      >
        <div>
          <p className="text-sm font-semibold text-[var(--ff-text-primary)]">{target.accountLabel}</p>
          <p className="text-xs text-[var(--ff-text-tertiary)]">{target.monthLabel}{target.isTotal ? ' (spread evenly over the months)' : ''}</p>
        </div>
        {target.editable ? (
          <MoneyField label="Budget" value={cents} allowNegative
            onChange={(c, validity) => { setCents(c); setValid(validity.valid); }} />
        ) : (
          <p role="status" className="text-sm text-[var(--ff-text-secondary)]">{target.readReason ?? 'Read-only'}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {target.editable && (
            <Button type="button" disabled={!valid} onClick={() => onSave(cents)}>Save cell</Button>
          )}
          {target.hasNext && <Button type="button" variant="secondary" disabled={!valid} onClick={() => onNext(cents)}>Next month</Button>}
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
        </div>
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t border-[var(--ff-border-light)] pt-3">
            {actions.map(a => (
              <Button key={a.label} type="button" size="sm" variant="secondary" onClick={a.onClick}>{a.label}</Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
