/**
 * RunHeaderActions — the pay-run page's title bar and its actions. Moved out
 * of pages/payroll/runs/[id].tsx unchanged.
 */
import Link from 'next/link';
import { CalendarDays, ArrowLeft, Loader2, Calculator, Lock, Unlock, GitCompare, BookOpen, ShieldCheck } from 'lucide-react';
import { PayrollRunStatusBadge as StatusBadge } from '@/components/payroll/PayrollRunStatusBadge';
import { canWrite } from '@/lib/auth/writeRoles';

interface Props {
  runId: string;
  period: string;
  run: { status: string; journalEntryId: string | null };
  companyRole: string | null | undefined;
  locked: boolean;
  canCalculate: boolean;
  canReopen: boolean;
  canApprove: boolean;
  calculating: boolean;
  reopening: boolean;
  calculate: () => void;
  reopen: () => void;
  openApprove: () => void;
}

export function RunHeaderActions({
  runId, period, run, companyRole, locked, canCalculate, canReopen, canApprove, calculating, reopening, calculate, reopen, openApprove,
}: Props) {
  return (
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
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium"
              title={locked ? 'Run is locked — reopen first to edit' : ''}>
              {calculating ? <Loader2 className="h-4 w-4 animate-spin" /> : locked ? <Lock className="h-4 w-4" /> : <Calculator className="h-4 w-4" />}
              {locked ? 'Locked' : run.status === 'draft' ? 'Calculate' : 'Recalculate'}
            </button>
          )}
          {canApprove && (
            <button onClick={openApprove}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-success-700 hover:bg-success-800 text-white text-sm font-medium"
              title="Review the journal this run will post, then approve it">
              <ShieldCheck className="h-4 w-4" /> Review &amp; approve
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
