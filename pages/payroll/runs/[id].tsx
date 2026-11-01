/**
 * Payroll Run Detail — Phase 2.
 * Route: /payroll/runs/[id]
 */
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { PayrollApproveDialog } from '@/components/payroll/PayrollApproveDialog';
import { useCompany } from '@/contexts/CompanyContext';
import { isLocked } from '@/components/payroll/PayrollRunStatusBadge';
import { canWrite } from '@/lib/auth/writeRoles';
import { PayrollRunWarnings } from '@/components/payroll/PayrollRunWarnings';
import { PayrollRunLinesTable, PayrollRunTotals } from '@/components/payroll/PayrollRunLinesTable';
import { RunHeaderActions } from '@/components/payroll/RunHeaderActions';
import { useRunDetail } from '@/components/payroll/useRunDetail';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default function PayrollRunDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const runId = typeof id === 'string' ? id : '';

  const { companyRole } = useCompany(); // the active company's role — who may approve
  const {
    run, isLoading, error, calculating, reopening, approveOpen, setApproveOpen, approvedNow, load, calculate, onApproved, reopen,
  } = useRunDetail(runId);

  if (isLoading && !run) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center bg-[var(--ff-bg-primary)]">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }
  if (error && !run) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center bg-[var(--ff-bg-primary)] flex-col gap-2">
          <AlertCircle className="h-8 w-8 text-red-400" />
          <p className="text-red-400 text-sm">{error}</p>
          <Link href="/payroll/runs" className="text-teal-400 text-sm">Back</Link>
        </div>
      </AppLayout>
    );
  }
  if (!run) return null;

  const warningCount = run.lines.reduce((n, l) => n + (l.validationResults?.length ?? 0), 0);

  const period = `${MONTHS[run.periodMonth - 1]} ${run.periodYear}`;
  const locked = isLocked(run.status);
  const canCalculate = !locked && (run.status === 'draft' || run.status === 'calculated');
  const canReopen = run.status === 'approved';
  // approvePayrollRun's own states; an approved run without its journal was
  // stranded before K-079 and re-approving it posts the journal.
  const canApprove = canWrite(companyRole) && (run.status === 'calculated' || run.status === 'processed'
    || (run.status === 'approved' && !run.journalEntryId));

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <RunHeaderActions runId={runId} period={period} run={run} companyRole={companyRole} locked={locked}
          canCalculate={canCalculate} canReopen={canReopen} canApprove={canApprove} calculating={calculating} reopening={reopening}
          calculate={calculate} reopen={reopen} openApprove={() => setApproveOpen(true)} />

        <div className="p-6 space-y-6">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
          )}
          {approvedNow && (
            <div className="px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm">
              {approvedNow === 'posted' ? 'Payroll approved and journal posted.' : 'Payroll approved — no new journal posted.'}
              {' '}Next: declare it on the{' '}
              <Link href="/accounting/sars/emp201" className="underline">EMP201</Link>.
            </div>
          )}

          <PayrollRunTotals run={run} />

          <PayrollRunWarnings lines={run.lines} />

          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--ff-border-primary)] flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Line items</h2>
              {run.status === 'calculated' && (
                <span className="flex items-center gap-1 text-xs text-teal-400">
                  <CheckCircle2 className="h-4 w-4" /> Calculated
                </span>
              )}
            </div>
            {run.lines.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-tertiary)] text-sm">
                No lines yet{canWrite(companyRole)
                  ? <> — press <span className="text-teal-400 font-medium">Calculate</span> to generate payroll for this period.</>
                  : '.'}
              </div>
            ) : (
              <div className="overflow-x-auto"><PayrollRunLinesTable lines={run.lines} /></div>
            )}
          </section>
        </div>
      </div>
      <PayrollApproveDialog runId={runId} period={period} warningCount={warningCount}
        open={approveOpen} onClose={() => setApproveOpen(false)} onApproved={onApproved} onUncertain={() => void load()} />
    </AppLayout>
  );
}
