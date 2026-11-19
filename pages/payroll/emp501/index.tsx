/**
 * EMP501 Reconciliation Dashboard.
 * Route: /payroll/emp501
 */
import { useEffect, useState, useCallback } from 'react';
import { Scale, Loader2, AlertCircle, Download, CheckCircle } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch, assertOk, apiErrorMessage, ApiEnvelopeError } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { payrollLoadMessage } from '@/lib/payrollDetailAccess';
import { Emp501ReturnSection } from '@/components/payroll/emp501/Emp501ReturnSection';
import { defaultEmp501Kind, type Emp501Kind } from '@/components/payroll/emp501/emp501Kind';
import { payeTaxYearOf } from '@/modules/accounting/utils/payeTaxYear';

interface ReconciliationRow {
  month: number;
  monthLabel: string;
  year: number;
  emp201Paye: number;
  irp5Paye: number;
  variance: number;
  status: 'balanced' | 'variance' | 'no_data';
}

interface Emp501Summary {
  taxYear: number;
  rows: ReconciliationRow[];
  totalEmp201: number;
  totalIrp5: number;
  totalVariance: number;
}

const STATUS_STYLES: Record<string, string> = {
  balanced: 'bg-teal-500/10 text-teal-400',
  variance: 'bg-red-500/10 text-red-400',
  no_data: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]',
};
const STATUS_LABELS: Record<string, string> = {
  balanced: 'Balanced',
  variance: 'Variance',
  no_data: 'No Data',
};

function taxYearLabel(y: number) {
  return `${y - 1}/${y} (Mar ${y - 1} – Feb ${y})`;
}

interface RunKindRefusal { error?: { details?: { code?: string; reasons?: Array<{ detail?: string }> } } }

/** The annual blocked by weekly or fortnightly runs (409 RUN_KIND_UNSUPPORTED), said plainly, naming the run. */
function blockedAnnualMessage(taxYear: number, body: RunKindRefusal | null): string | null {
  if (body?.error?.details?.code !== 'RUN_KIND_UNSUPPORTED') return null;
  const why = body.error.details.reasons?.[0]?.detail;
  return `The annual EMP501 for ${taxYear - 1}/${taxYear} is blocked by weekly or fortnightly pay runs`
    + `${why ? `: ${why}` : ''}. The interim (March to August) can still be reconciled and filed.`;
}

export default function Emp501Page() {
  const today = new Date();
  const currentYear = today.getFullYear();
  // The tax year running today (March to February): in January and February that is this calendar year's, not the next.
  const runningTaxYear = payeTaxYearOf(today.getMonth() + 1, currentYear);
  const [taxYear, setTaxYear] = useState(runningTaxYear);
  const [kind, setKind] = useState<Emp501Kind>(() => defaultEmp501Kind(runningTaxYear));
  const [blocked, setBlocked] = useState('');
  const [summary, setSummary] = useState<Emp501Summary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    setBlocked('');
    try {
      const res = await apiFetch(`/api/payroll/emp501/reconciliation?taxYear=${taxYear}&period=${kind}`);
      if (res.status === 409 && kind === 'annual') {
        const plain = blockedAnnualMessage(taxYear, await res.clone().json().catch(() => null) as RunKindRefusal | null);
        if (plain) {
          setSummary(null);
          setBlocked(plain);
          return;
        }
      }
      await assertOk(res, 'Could not load the EMP501 reconciliation - try again');
      const json = await res.json() as { data?: Emp501Summary };
      setSummary((json.data ?? null) as Emp501Summary | null);
    } catch (err) {
      setSummary(null);
      setBlocked('');
      setError(apiErrorMessage(err, 'Could not load the EMP501 reconciliation - try again'));
    } finally {
      setIsLoading(false);
    }
  }, [taxYear, kind]);

  useEffect(() => { void load(); }, [load]);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const res = await apiFetch(`/api/payroll/emp501/export?taxYear=${taxYear}`);
      if (res.status === 403) throw new ApiEnvelopeError(payrollLoadMessage(403, 'Could not export the EMP501 file - try again'));
      await assertOk(res, 'Could not export the EMP501 file - try again');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `EMP501_${taxYear - 1}_${taxYear}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not export the EMP501 file - try again'));
    } finally {
      setIsExporting(false);
    }
  };

  const yearOptions = [currentYear - 1, currentYear, currentYear + 1];
  const allBalanced = summary?.rows.every(r => r.status !== 'variance') ?? false;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Scale className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">EMP501 Reconciliation</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Monthly PAYE variance — EMP201 vs IRP5</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <select
                aria-label="Tax year"
                value={taxYear}
                onChange={e => { const y = Number(e.target.value); setTaxYear(y); setKind(defaultEmp501Kind(y)); }}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                {yearOptions.map(y => <option key={y} value={y}>{taxYearLabel(y)}</option>)}
              </select>
              <button
                onClick={handleExport}
                disabled={isExporting || !summary}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-50"
              >
                {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Export e@syFile CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {/* One selector (the section's "Reconciliation") drives the return and the table below (review #1622 L-K). */}
          <Emp501ReturnSection taxYear={taxYear} kind={kind} onKindChange={setKind} />
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : blocked ? (
            <div role="alert" className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300 text-sm">
              <div className="flex items-start gap-2 flex-1 min-w-0"><AlertCircle className="h-5 w-5 shrink-0" /><span>{blocked}</span></div>
              <button type="button" onClick={() => setKind('interim')}
                className="self-start sm:self-auto shrink-0 px-3 py-1.5 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]">
                Show the interim
              </button>
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-4">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : summary && (
            <>
              {allBalanced && summary.rows.some(r => r.status === 'balanced') && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm font-medium">
                  <CheckCircle className="h-4 w-4" /> All periods reconcile. Ready for filing through e@syFile
                </div>
              )}

              <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                      <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Period</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">EMP201 PAYE</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">IRP5 PAYE</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Variance</th>
                      <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rows.map(r => (
                      <tr key={`${r.year}-${r.month}`} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)]">
                        <td className="py-3 px-4 text-[var(--ff-text-primary)] font-medium">{r.monthLabel}</td>
                        <td className="py-3 px-4 text-right text-[var(--ff-text-primary)]">{r.status === 'no_data' ? '—' : formatCurrency(r.emp201Paye)}</td>
                        <td className="py-3 px-4 text-right text-[var(--ff-text-primary)]">{r.status === 'no_data' ? '—' : formatCurrency(r.irp5Paye)}</td>
                        <td className={`py-3 px-4 text-right font-medium ${r.variance !== 0 && r.status !== 'no_data' ? 'text-red-400' : 'text-[var(--ff-text-secondary)]'}`}>
                          {r.status === 'no_data' ? '—' : formatCurrency(Math.abs(r.variance))}
                          {r.variance < 0 && r.status !== 'no_data' && ' ↑'}
                          {r.variance > 0 && r.status !== 'no_data' && ' ↓'}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[r.status]}`}>
                            {STATUS_LABELS[r.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {/* Totals row */}
                    <tr className="border-t-2 border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                      <td className="py-3 px-4 font-semibold text-[var(--ff-text-primary)]">Total</td>
                      <td className="py-3 px-4 text-right font-semibold text-[var(--ff-text-primary)]">{formatCurrency(summary.totalEmp201)}</td>
                      <td className="py-3 px-4 text-right font-semibold text-[var(--ff-text-primary)]">{formatCurrency(summary.totalIrp5)}</td>
                      <td className={`py-3 px-4 text-right font-semibold ${Math.abs(summary.totalVariance) > 0.01 ? 'text-red-400' : 'text-teal-400'}`}>
                        {formatCurrency(Math.abs(summary.totalVariance))}
                      </td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${Math.abs(summary.totalVariance) < 0.01 ? STATUS_STYLES.balanced : STATUS_STYLES.variance}`}>
                          {Math.abs(summary.totalVariance) < 0.01 ? 'Balanced' : 'Variance'}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
