/**
 * Payroll Run Detail — Phase 2.
 * Route: /payroll/runs/[id]
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch, assertOk, apiErrorMessage, apiJson, ApiRequestError } from '@/lib/apiFetch';
import { CalendarDays, ArrowLeft, Loader2, AlertCircle, Calculator, CheckCircle2, Lock, Unlock, GitCompare, BookOpen, ShieldCheck } from 'lucide-react';
import { PayrollApproveDialog, type ApproveResult } from '@/components/payroll/PayrollApproveDialog';
import { useCompany } from '@/contexts/CompanyContext';
import { PayrollRunStatusBadge as StatusBadge, isLocked } from '@/components/payroll/PayrollRunStatusBadge';
import { canWrite } from '@/lib/auth/writeRoles';
import { PayrollRunWarnings, type RunLineWarning } from '@/components/payroll/PayrollRunWarnings';
import { PayrollRunLinesTable, PayrollRunTotals } from '@/components/payroll/PayrollRunLinesTable';
import { payrollLoadMessage } from '@/lib/payrollDetailAccess';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

interface Line {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  grossPay: number;
  taxableIncome: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
  netPay: number;
  validationResults?: RunLineWarning[];
}

interface RunDetail {
  id: string;
  periodMonth: number;
  periodYear: number;
  status: string;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalEti: number;
  totalNet: number;
  employeeCount: number;
  journalEntryId: string | null;
  lines: Line[];
}

export default function PayrollRunDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const runId = typeof id === 'string' ? id : '';

  const [run, setRun] = useState<RunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [calculating, setCalculating] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  // What the last approval did: posted a new journal, or re-locked onto the one the run carried.
  const [approvedNow, setApprovedNow] = useState<'posted' | 'relocked' | null>(null);
  const { companyRole } = useCompany(); // the active company's role — who may approve
  const hasRun = useRef(false);

  // `keepNotice`: the reload that follows an approval keeps its notice; any
  // other load clears it. The page is never blanked while it reloads a run it
  // already shows, and a failed reload of one says so without contradicting it.
  const load = useCallback(async (keepNotice = false) => {
    if (!runId) return;
    setIsLoading(true);
    setError('');
    try {
      setRun((await apiJson(`/api/payroll/runs/${runId}`, undefined, 'Could not load the payroll run - try again')) as RunDetail);
      hasRun.current = true;
      if (!keepNotice) setApprovedNow(null);
    } catch (err) {
      const status = err instanceof ApiRequestError ? err.status : 0;
      setError(hasRun.current
        ? 'Could not refresh this run — reload the page to see its latest state.'
        : status === 404 ? 'Pay run not found'
        : payrollLoadMessage(status, 'Could not load the payroll run - try again'));
    } finally {
      setIsLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    // Another run: never show this one's figures under the new run's URL.
    hasRun.current = false;
    setRun(null);
    void load();
  }, [load]);

  const calculate = async () => {
    if (!runId) return;
    setCalculating(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}/calculate`, { method: 'POST' });
      await assertOk(res, 'Could not calculate the payroll run - try again');
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not calculate the payroll run - try again'));
    } finally {
      setCalculating(false);
    }
  };

  const onApproved = (result: ApproveResult, newJournal: boolean) => {
    setApproveOpen(false);
    setApprovedNow(newJournal ? 'posted' : 'relocked');
    setRun((prev) => (prev ? { ...prev, status: result.status, journalEntryId: result.journalEntryId } : prev));
    void load(true);
  };

  const reopen = async () => {
    if (!runId) return;
    const reason = window.prompt(
      'Reopening will move the run back to "calculated" so it can be edited and re-approved.\n\n' +
      'Note: the GL journal posted at approval is NOT automatically reversed — reverse it manually if the period also needs that.\n\n' +
      'Reason (≥ 5 characters):'
    );
    if (!reason || reason.trim().length < 5) {
      if (reason !== null) alert('Reason must be at least 5 characters');
      return;
    }
    setReopening(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      await assertOk(res, 'Could not reopen the payroll run - try again');
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not reopen the payroll run - try again'));
    } finally {
      setReopening(false);
    }
  };

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
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/payroll/runs" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
                <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
              </Link>
              <div className="p-2 rounded-lg bg-teal-500/10">
                <CalendarDays className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Payroll Run — {period}</h1>
                <div className="flex items-center gap-2 mt-1"><StatusBadge status={run.status} /></div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {run.journalEntryId && (
                <Link href={`/accounting/journal-entries/${run.journalEntryId}`}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] text-sm font-medium"
                  title="The GL journal this run posted at approval">
                  <BookOpen className="h-4 w-4" /> View journal
                </Link>
              )}
              <Link href={`/payroll/runs/${runId}/variance`}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] text-sm font-medium"
                title="Compare to the prior run — spot ≥20% swings before approving">
                <GitCompare className="h-4 w-4" /> Variance
              </Link>
              <Link href={`/payroll/runs/${runId}/cost-centre-summary`}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] text-sm font-medium"
                title="Totals per cost centre">
                Cost centres
              </Link>
              <Link href={`/payroll/runs/${runId}/cash-register`}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] text-sm font-medium"
                title="ZAR denomination breakdown for cash-paid employees">
                Cash register
              </Link>
              {canReopen && (
                <button onClick={reopen} disabled={reopening}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-400 text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-500/10 disabled:opacity-50 text-sm font-medium"
                  title="Move the run back to 'calculated' so it can be edited and re-approved">
                  {reopening ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlock className="h-4 w-4" />}
                  Reopen Period
                </button>
              )}
              {/* The calculate route is withWriteAccess: a viewer would only get a 403. */}
              {canWrite(companyRole) && (
                <button onClick={calculate} disabled={calculating || !canCalculate}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium"
                  title={locked ? 'Run is locked — reopen first to edit' : ''}>
                  {calculating ? <Loader2 className="h-4 w-4 animate-spin" /> : locked ? <Lock className="h-4 w-4" /> : <Calculator className="h-4 w-4" />}
                  {locked ? 'Locked' : run.status === 'draft' ? 'Calculate' : 'Recalculate'}
                </button>
              )}
              {canApprove && (
                <button onClick={() => setApproveOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium"
                  title="Review the journal this run will post, then approve it">
                  <ShieldCheck className="h-4 w-4" /> Review &amp; approve
                </button>
              )}
            </div>
          </div>
        </div>

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
