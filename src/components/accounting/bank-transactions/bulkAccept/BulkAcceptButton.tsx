/** "Accept N high-confidence suggestions": the button on the New tab, with the modal it opens. */
import { useEffect, useState } from 'react';
import { CheckCheck } from 'lucide-react';
import { fetchBulkPreview } from './bulkAcceptApi';
import { BulkAcceptModal } from './BulkAcceptModal';

interface Props { bankAccountId: string | null; active: boolean; onChanged: () => void }

export function BulkAcceptButton({ bankAccountId, active, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<{ n: number; more: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!bankAccountId || !active) { setCount(null); return; }
    let live = true;
    fetchBulkPreview(bankAccountId)
      .then((p) => { if (live) setCount({ n: p.lines.length, more: p.truncated || p.scanTruncated }); })
      .catch(() => { if (live) setCount(null); }); // the modal reports a failure when it is opened
    return () => { live = false; };
  }, [bankAccountId, active, tick]);
  if (!bankAccountId || !active || (count !== null && count.n === 0)) return null;
  const label = count ? `Accept ${count.n}${count.more ? '+' : ''} high-confidence suggestion${count.n === 1 && !count.more ? '' : 's'}` : 'Accept high-confidence suggestions';
  return (
    <div className="flex justify-end px-4 pt-2">
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
        <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />{label}
      </button>
      <BulkAcceptModal open={open} bankAccountId={bankAccountId} onClose={() => setOpen(false)} onChanged={() => { setTick((t) => t + 1); onChanged(); }} />
    </div>
  );
}
