/**
 * Supplier bill detail, intercompany P4-E: "Clear against the intercompany loan". Asks the preview (GET loan-clearings?billId=) once per bill:
 * with the dark flag off the route answers 403 and nothing shows; a bill that is not linked on a loan connection shows nothing either; a preview
 * that fails otherwise says so in one line. Otherwise
 * a short section with the action; the dialog (`LoanClearingModal`) previews and confirms. A posted clearing names its payment and journal:
 * the PAGE holds that result (`cleared`, fix round 2 MED-1 of the blind review), because the page reloads the bill after a clearing behind its
 * full-page spinner, which unmounts this panel. Only the latest preview request is applied (a sequence number: an older answer that resolves
 * later is dropped).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Landmark } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import type { LoanClearingPreview, LoanClearResult } from '@/modules/accounting/services/intercompany/payerLoanClearTypes';
import { LoanClearingModal } from './LoanClearingModal';

interface Props {
  billId: string;
  /** The clearing this page posted (kept by the page: the panel is unmounted while the page reloads the bill), or null. */
  cleared: LoanClearResult | null;
  /** A clearing posted: the page keeps the result and reloads the bill. */
  onCleared: (out: LoanClearResult) => void;
}

export const LOAN_CLEARING_ACTION = 'Clear against the intercompany loan';

const PREVIEW_FAIL = 'Could not check whether this bill can be cleared against the intercompany loan.';

async function loadPreview(billId: string): Promise<LoanClearingPreview | null> {
  const res = await apiFetch(`/api/accounting/intercompany/loan-clearings?billId=${encodeURIComponent(billId)}`);
  // 403 is the answer with the dark flag off for this company (or without a write role): the action does not exist here, nothing to say
  if (res.status === 403) return null;
  await assertOk(res, PREVIEW_FAIL);
  const body = (await res.json()) as { data?: LoanClearingPreview };
  return body.data ?? null;
}

export function LoanClearingPanel({ billId, cleared: done, onCleared }: Props) {
  const [preview, setPreview] = useState<LoanClearingPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState('');
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await loadPreview(billId);
      if (mine !== seq.current) return;
      setPreview(next);
      setFailed('');
    } catch (err) {
      if (mine !== seq.current) return;
      // the action hides, and says why (the bill page itself still works)
      setPreview(null);
      setFailed(apiErrorMessage(err, PREVIEW_FAIL));
    }
  }, [billId]);
  useEffect(() => { void reload(); }, [reload]);

  if (failed && !done) return <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">{failed}</p>;
  if (!preview?.linked && !done) return null;
  return (
    <section aria-label="Intercompany loan" className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4 space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-[var(--ff-text-secondary)] inline-flex items-center gap-2">
          <Landmark className="h-4 w-4 text-teal-500" aria-hidden />
          This bill is linked to {preview?.partnerName ?? 'a group company'}&apos;s invoice on a loan connection.
        </p>
        {preview?.linked && (
          <button type="button" onClick={() => setOpen(true)}
            className="px-3 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">
            {LOAN_CLEARING_ACTION}
          </button>
        )}
      </div>
      {done && (
        <p role="status" className="text-sm text-teal-700 dark:text-teal-400">
          Cleared: payment {done.paymentNumber} posted.{' '}
          <Link href={`/accounting/journal-entries/${done.journalEntryId}`} className="underline">View the journal</Link>
        </p>
      )}
      {preview && (
        <LoanClearingModal open={open} preview={preview} onClose={() => setOpen(false)}
          onDone={(out) => { setOpen(false); onCleared(out); void reload(); }} onStale={() => { void reload(); }} />
      )}
    </section>
  );
}
