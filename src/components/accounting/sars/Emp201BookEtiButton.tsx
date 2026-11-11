/**
 * "Book ETI for this month" on the EMP201 (wave 5 ET, review round 4 M1(c)): POST /api/accounting/sars/emp201-book-eti.
 * Brings a run-less month's ETI journal to what this EMP201 declares (ETI Act s9(1), s10(1)); idempotent. Owner, admin
 * or manager only (the route enforces it; hidden for anyone else).
 */
import { useState } from 'react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { log } from '@/lib/logger';
import { formatDate } from '@/utils/formatters';
import { canWrite } from '@/lib/auth/writeRoles';

interface Outcome { status: 'booked' | 'nothing_to_book' | 'not_ended' | 'run_journal_in_force' | 'no_open_period'; entryDate: string | null }

function describe(o: Outcome): string {
  switch (o.status) {
    case 'booked': return `ETI journal posted, dated ${formatDate(o.entryDate ?? '')}.`;
    case 'nothing_to_book': return 'The ledger already books this month\'s ETI as declared. Nothing was posted.';
    case 'not_ended': return 'The month has not ended yet. Book its ETI after the last day of the month.';
    case 'run_journal_in_force': return 'This month\'s pay run journal books its ETI. Nothing was posted.';
    default: return 'No open fiscal period on or after the month end. Open one, then try again.';
  }
}

export function Emp201BookEtiButton({ month, onBooked }: { month: string; onBooked?: () => void }) {
  const { companyRole } = useCompany();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!canWrite(companyRole)) return null;

  const book = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const res = await apiFetch('/api/accounting/sars/emp201-book-eti', { method: 'POST', body: JSON.stringify({ month }) });
      await assertOk(res, 'Could not book the ETI for this month');
      const json = await res.json() as { data: Outcome };
      setMessage(describe(json.data));
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
      <button type="button" onClick={() => void book()} disabled={busy}
        className="text-xs font-medium text-teal-600 hover:text-teal-500 dark:text-teal-400 disabled:opacity-50">
        {busy ? 'Booking ETI...' : 'Book ETI for this month'}
      </button>
      {message && <p role="status" className="text-xs text-[var(--ff-text-secondary)]">{message}</p>}
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
