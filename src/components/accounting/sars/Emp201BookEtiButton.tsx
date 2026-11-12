/**
 * "Book ETI for this month" on the EMP201 (wave 5 ET, review round 4 M1(c)): POST /api/accounting/sars/emp201-book-eti.
 * Brings a run-less month's ETI journal to what this EMP201 declares (ETI Act s9(1), s10(1)); idempotent. Write roles
 * only (the route enforces it; hidden for anyone else).
 * Review round 5 (browser M1/M2/L1/L3):
 *  - A booking reloads the EMP201, which remounts this component; the result is kept in `lastResult` (module scope, one
 *    per page session) so the message survives the remount, and focus moves to it once (role=status, tabIndex -1).
 *  - A month that has not ended (its last day is today or later, SAST) cannot be booked: the button is disabled with a hint.
 *  - Text in --ff-brand-eyebrow (#0f766e light, #2dd4bf dark): at least 4.5:1 on the card in both themes.
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { log } from '@/lib/logger';
import { formatDate } from '@/utils/formatters';
import { formatMoney } from '@/lib/money/formatMoney';
import { canWrite } from '@/lib/auth/writeRoles';
import { todayInSast } from '@/lib/saDateParser';

type Status = 'booked' | 'nothing_to_book' | 'not_ended' | 'run_journal_in_force' | 'no_open_period';
interface Outcome { status: Status; entryDate: string | null; used: number; refund: number }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const label = (month: string): string => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
/** 'YYYY-MM-DD' of the month's last day: day 0 of the next month gives the day count, whatever the time zone. */
const lastDay = (month: string): string =>
  `${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;

/** The result of the last booking, kept across the remount a successful booking causes. */
let lastResult: { month: string; text: string; focus: boolean } | null = null;
/** Test seam: forget the kept result. */
export function resetEmp201BookEtiResult(): void { lastResult = null; }

export function describeOutcome(month: string, o: Outcome): string {
  switch (o.status) {
    case 'booked': {
      const parts = [
        ...(Math.abs(o.used) >= 0.005 ? [`${formatMoney(o.used)} used against PAYE`] : []),
        ...(Math.abs(o.refund) >= 0.005 ? [`${formatMoney(o.refund)} refund`] : []),
      ];
      return `Booked ETI for ${label(month)}: ${parts.join(', ')} (journal dated ${formatDate(o.entryDate ?? '')}).`;
    }
    case 'nothing_to_book': return `The ledger already books ${label(month)}'s ETI as declared. Nothing was posted.`;
    case 'not_ended': return `${label(month)} has not ended yet. Book its ETI after ${formatDate(lastDay(month))}.`;
    case 'run_journal_in_force': return `${label(month)}'s pay run journal books its ETI. Nothing was posted.`;
    default: return 'No open fiscal period after the month end. Open one, then try again.';
  }
}

export function Emp201BookEtiButton({ month, onBooked }: { month: string; onBooked?: () => void }) {
  const { companyRole } = useCompany();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(lastResult?.month === month ? lastResult.text : null);
  const [error, setError] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (lastResult?.month === month && lastResult.focus && statusRef.current) {
      statusRef.current.focus();
      lastResult.focus = false;
    }
  }, [month, message]);

  if (!canWrite(companyRole)) return null;
  const ended = lastDay(month) < todayInSast();

  const book = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const res = await apiFetch('/api/accounting/sars/emp201-book-eti', { method: 'POST', body: JSON.stringify({ month }) });
      await assertOk(res, 'Could not book the ETI for this month');
      const json = await res.json() as { data: Outcome };
      const text = describeOutcome(month, json.data);
      lastResult = { month, text, focus: true };
      setMessage(text);
      if (json.data.status === 'booked') onBooked?.();
    } catch (err) {
      log.warn('Emp201BookEtiButton: book failed', { error: err }, 'Emp201BookEtiButton');
      setError(apiErrorMessage(err, 'Could not book the ETI for this month'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-2 space-y-1">
      <button type="button" onClick={() => void book()} disabled={busy || !ended} aria-describedby={ended ? undefined : `eti-book-hint-${month}`}
        className="text-sm font-medium underline text-[var(--ff-brand-eyebrow)] disabled:no-underline disabled:opacity-60 disabled:cursor-not-allowed">
        {busy ? 'Booking ETI...' : 'Book ETI for this month'}
      </button>
      {!ended && (
        <p id={`eti-book-hint-${month}`} className="text-xs text-[var(--ff-text-secondary)]">
          Available after {formatDate(lastDay(month))}, once the month has ended.
        </p>
      )}
      {message && <p ref={statusRef} tabIndex={-1} role="status" className="text-sm text-[var(--ff-text-primary)] outline-none">{message}</p>}
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
