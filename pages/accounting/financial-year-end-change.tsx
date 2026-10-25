/**
 * Change financial year end (owner/admin): pick the new year-end month, preview
 * the transition year, then confirm with the reason and the CIPC / SARS notices.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiJson, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { StepSelect } from '@/components/accounting/financialYearEnd/StepSelect';
import { StepPreview } from '@/components/accounting/financialYearEnd/StepPreview';
import { StepConfirm } from '@/components/accounting/financialYearEnd/StepConfirm';
import { HistoryPanel } from '@/components/accounting/financialYearEnd/HistoryPanel';
import { CARD_CLS, MONTH_NAMES, fmtDay, monthOf } from '@/components/accounting/financialYearEnd/yearEndTypes';

const BASE = '/api/accounting/financial-year-end-change';
type Overview = Awaited<ReturnType<typeof loadOverview>>;

// The registry types a route by its path; the query string only adds `preview`, which the entry already allows.
function loadOverview(query = '') {
  return apiJson(`${BASE}${query}` as typeof BASE, undefined, 'Could not load the financial year');
}

export default function FinancialYearEndChangePage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [month, setMonth] = useState<number | null>(null);
  const [appliedEnd, setAppliedEnd] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await loadOverview());
    } catch (err) {
      log.error('Failed to load year-end change', { error: err }, 'financial-year-end-change');
      setError(apiErrorMessage(err, 'Could not load the financial year - try again'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const preview = useCallback(async (m: number, k: 'shorten' | 'extend' | undefined) => {
    setChecking(true);
    setError('');
    try {
      const q = `?newYearEndMonth=${m}${k ? `&kind=${k}` : ''}`;
      setData(await loadOverview(q));
      setStep(2);
    } catch (err) {
      log.error('Failed to preview year-end change', { error: err }, 'financial-year-end-change');
      setError(apiErrorMessage(err, 'Could not preview the change - try again'));
    } finally {
      setChecking(false);
    }
  }, []);

  const chosen = data?.preview?.chosen ?? null;

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Change financial year end</h1>
          <p className="text-sm text-[var(--ff-text-secondary)]">Owner and admin only. The change is recorded and can be undone while no journal has posted into the new years.</p>
        </div>

        {error && <div role="alert" data-testid="page-error" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}
        {loading && !data && <p className="text-sm text-[var(--ff-text-secondary)]">Loading...</p>}

        {data && appliedEnd && (
          <section className={CARD_CLS} data-testid="success-panel">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-2">Financial year end changed</h2>
            <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
              The current financial year now ends on {fmtDay(appliedEnd)} ({MONTH_NAMES[monthOf(appliedEnd) - 1]}).
            </p>
            <Link href="/accounting/financial-years" className="text-sm text-teal-500 hover:underline" data-testid="link-financial-years">View financial years</Link>
          </section>
        )}

        {data && !appliedEnd && step === 1 && (
          <StepSelect currentYear={data.currentYear} month={month} loading={checking}
            onMonth={setMonth}
            onNext={() => { if (month !== null) void preview(month, undefined); }} />
        )}
        {data?.preview && !appliedEnd && step === 2 && (
          <StepPreview preview={data.preview}
            onKind={k => { if (month !== null) void preview(month, k); }}
            onBack={() => setStep(1)} onNext={() => setStep(3)} />
        )}
        {data && chosen && month !== null && !appliedEnd && step === 3 && (
          <StepConfirm month={month} kind={chosen.kind} endDate={chosen.endDate}
            onBack={() => setStep(2)}
            onApplied={() => { setAppliedEnd(chosen.endDate); void load(); }} />
        )}

        {data && <HistoryPanel history={data.history} undo={data.undo} onUndone={() => { setAppliedEnd(null); setStep(1); void load(); }} />}
      </div>
    </AppLayout>
  );
}
