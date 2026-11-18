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

const grid = () => document.querySelector<HTMLElement>('[role="group"][aria-label^="Bank transactions"]');

export function BulkAcceptButton({ bankAccountId, active, onChanged, refreshKey }: Props) {
  const [open, setOpen] = useState(false);
  // The account the open dialog works on: fixed when it opened, so the page changing its account, tab or count under a confirm
  // in flight can neither retarget nor unmount the dialog (its answer - what posted, the batch to undo - would be lost).
  const [dialogAccount, setDialogAccount] = useState<string | null>(null);
  const { count, invalidate } = useBulkCount(bankAccountId, active, refreshKey);
  const trigger = useRef<HTMLButtonElement>(null);
  const hidden = !bankAccountId || !active || (count !== null && count.n === 0);

  // The button went away (the count reached 0) while focus was on it, or on nothing after the dialog closed: the grid takes it.
  const wasHidden = useRef(hidden);
  useEffect(() => {
    // Never behind an open dialog: its own focus handling (and the shell's return on close) owns focus then.
    if (hidden && !wasHidden.current && !open && (!document.activeElement || document.activeElement === document.body)) grid()?.focus();
    wasHidden.current = hidden;
  }, [hidden, open]);

  const label = count ? `Accept ${count.n}${count.more ? '+' : ''} high-confidence suggestion${count.n === 1 && !count.more ? '' : 's'}` : 'Accept high-confidence suggestions';
  // ONE tree position for the dialog, whether or not the trigger shows: a dialog that moved between two positions would be
  // REMOUNTED when the tab or account flips under it, losing a confirm in flight (its result, run and undo key).
  // Focus back on close is the shell's: the button, or the grid when the button has gone.
  return (
    <>
      {!hidden && (
        <div className="flex justify-end px-4 pt-2">
          <button type="button" ref={trigger} onClick={() => { setDialogAccount(bankAccountId); setOpen(true); }}
            className="inline-flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
            <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />{label}
          </button>
        </div>
      )}
      <BulkAcceptModal open={open} bankAccountId={dialogAccount} onClose={() => setOpen(false)} onChanged={() => { invalidate(dialogAccount); onChanged(); }}
        returnFocus={() => trigger.current ?? grid()} />
    </>
  );
}
