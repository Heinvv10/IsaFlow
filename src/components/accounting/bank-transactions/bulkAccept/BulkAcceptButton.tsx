/** "Accept N high-confidence suggestions": the button on the New tab, with the modal it opens. */
import { useEffect, useRef, useState } from 'react';
import { CheckCheck } from 'lucide-react';
import { BulkAcceptModal } from './BulkAcceptModal';
import { useBulkCount } from './useBulkCount';

interface Props {
  bankAccountId: string | null; active: boolean; onChanged: () => void;
  /** Anything that moves when the list changes (the page's total): the count is read again, within the throttle. */
  refreshKey?: unknown;
}

export function BulkAcceptButton({ bankAccountId, active, onChanged, refreshKey }: Props) {
  const [open, setOpen] = useState(false);
  const { count, readNow } = useBulkCount(bankAccountId, active, refreshKey);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const hidden = !bankAccountId || !active || (count !== null && count.n === 0 && !open);

  // Focus goes back to the button when the dialog closes; the button is gone when nothing is left to accept, so then the grid.
  useEffect(() => {
    if (open || !returnFocus.current) return;
    returnFocus.current = false;
    (trigger.current ?? document.querySelector<HTMLElement>('[role="group"][aria-label^="Bank transactions"]'))?.focus();
  }, [open, hidden]);

  // The button went away (the count reached 0) while focus was on it, or on nothing after the dialog closed: the grid takes it.
  const wasHidden = useRef(hidden);
  useEffect(() => {
    if (hidden && !wasHidden.current && (!document.activeElement || document.activeElement === document.body)) {
      document.querySelector<HTMLElement>('[role="group"][aria-label^="Bank transactions"]')?.focus();
    }
    wasHidden.current = hidden;
  }, [hidden]);

  if (hidden) return null;
  const label = count ? `Accept ${count.n}${count.more ? '+' : ''} high-confidence suggestion${count.n === 1 && !count.more ? '' : 's'}` : 'Accept high-confidence suggestions';
  return (
    <div className="flex justify-end px-4 pt-2">
      <button type="button" ref={trigger} onClick={() => { returnFocus.current = true; setOpen(true); }}
        className="inline-flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
        <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />{label}
      </button>
      <BulkAcceptModal open={open} bankAccountId={bankAccountId} onClose={() => setOpen(false)} onChanged={() => { readNow(); onChanged(); }} />
    </div>
  );
}
