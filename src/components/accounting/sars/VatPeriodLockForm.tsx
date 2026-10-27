/**
 * "Lock a period" form for VAT period locks — records the filed VAT201
 * figures and blocks any posting that would change them.
 *
 * Fetches the blocking VAT exceptions count for the chosen period
 * (GET /api/accounting/sars/vat-exceptions) and shows VatGateOverrideBox when
 * any are outstanding; an owner/admin may supply a reason to proceed, which
 * the route/service (vatGateOverrideService) records — everyone else sees
 * only the count and a note that they cannot override it.
 */
import { useEffect, useState } from 'react';
import { Lock, Loader2 } from 'lucide-react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { fetchVatExceptions } from './vatExceptionsFetch';
import { log } from '@/lib/logger';
import { useCompany } from '@/contexts/CompanyContext';
import { VatGateOverrideBox, type VatGateCounts } from './VatGateOverrideBox';
import { GatedDateField, useDateGate } from '@/components/forms/GatedDateField';

const COUNT_FAILED = 'Could not check the VAT exceptions for this period - the server will check again when you lock it';
const OVERRIDE_ROLES = ['owner', 'admin', 'super_admin'];

interface Props {
  onLock: (periodStart: string, periodEnd: string, notes: string, overrideReason: string) => Promise<string | null>;
}

export function VatPeriodLockForm({ onLock }: Props) {
  const dateGate = useDateGate();
  const { companyRole, activeCompany } = useCompany();
  const companyId = activeCompany?.id;
  const isOwnerOrAdmin = OVERRIDE_ROLES.includes(companyRole ?? '');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [notes, setNotes] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [counts, setCounts] = useState<VatGateCounts | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [countsError, setCountsError] = useState('');

  useEffect(() => {
    setCounts(null); setCountsError('');
    if (!periodStart || !periodEnd || periodEnd < periodStart) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchVatExceptions(periodStart, periodEnd, COUNT_FAILED, 'VatPeriodLockForm', { companyId }) as VatGateCounts | undefined;
        if (!cancelled) setCounts(typeof data?.totalExceptions === 'number' ? data : null);
      } catch (e) {
        // Non-fatal: the form still submits and the server's own gate is authoritative, but the person is told.
        log.warn('VAT exception count did not load', { error: e }, 'VatPeriodLockForm');
        if (!cancelled) { setCounts(null); setCountsError(apiErrorMessage(e, COUNT_FAILED)); }
      }
    })();
    return () => { cancelled = true; };
  }, [periodStart, periodEnd, companyId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!periodStart || !periodEnd) return;
    setSubmitting(true); setError('');
    let err: string | null | undefined;
    try {
      err = await onLock(periodStart, periodEnd, notes.trim(), overrideReason.trim());
    } catch (thrown) {
      err = apiErrorMessage(thrown, 'Could not lock the period - try again');
    } finally {
      setSubmitting(false);
    }
    if (err) { setError(err); return; }
    setPeriodStart(''); setPeriodEnd(''); setNotes(''); setOverrideReason(''); setCounts(null);
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4">
      <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Lock a period</h3>
      <p className="mt-1 text-xs text-[var(--ff-text-secondary)]">
        Locking records the filed VAT201 figures and blocks any posting that would change them.
      </p>
      {error && <p className="mt-2 rounded-lg bg-red-500/10 p-2 text-sm text-red-400">{error}</p>}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div>
          <GatedDateField gate={dateGate} gateKey="period-start" id="vat-lock-periodStart" name="periodStart" label="Period start" required value={periodStart || null} onValue={(iso) => setPeriodStart(iso)} />
        </div>
        <div>
          <GatedDateField gate={dateGate} gateKey="period-end" id="vat-lock-periodEnd" name="periodEnd" label="Period end" required value={periodEnd || null} onValue={(iso) => setPeriodEnd(iso)} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="vat-lock-notes" className="block text-xs font-medium text-[var(--ff-text-secondary)]">Notes (optional)</label>
          <input
            type="text" id="vat-lock-notes" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]"
            placeholder="e.g. Filed on eFiling 2026-09-24"
          />
        </div>
      </div>

      {countsError && <p role="alert" className="mt-3 rounded-lg bg-amber-500/10 p-2 text-sm text-amber-400">{countsError}</p>}
      <VatGateOverrideBox
        counts={counts}
        isOwnerOrAdmin={isOwnerOrAdmin}
        reason={overrideReason}
        onReasonChange={setOverrideReason}
        exceptionsHref="/accounting/sars/vat201"
      />

      <button
        type="submit" disabled={submitting || dateGate.blocked}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Lock period
      </button>
    </form>
  );
}
