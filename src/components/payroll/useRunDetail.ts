/**
 * useRunDetail — the pay-run page's state: load, calculate, reopen and the
 * approval hand-over, split out of pages/payroll/runs/[id].tsx.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { announcePayrollRunChanged } from './payrollRunEvents';
import { apiFetch, assertOk, apiErrorMessage, apiJson, ApiRequestError } from '@/lib/apiFetch';
import type { ApproveResult } from '@/components/payroll/PayrollApproveDialog';
import type { RunLineWarning } from '@/components/payroll/PayrollRunWarnings';
import { payrollLoadMessage } from '@/lib/payrollDetailAccess';
import type { DocumentApprovalState } from '@/modules/accounting/types/approval.types';
import type { PayRunDecisionSummary } from '@/modules/accounting/types/payRunDecision.types';

export interface RunDetailLine {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  grossPay: number;
  /** Non-cash benefits (taxed and levied, not paid): not in grossPay. */
  nonCashBenefits?: number;
  /** RF: of nonCashBenefits, the employer's 3817 / 3825 / 3828 fund contributions. */
  employerRetirement?: number;
  taxableIncome: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
  netPay: number;
  validationResults?: RunLineWarning[];
}

export interface RunDetail {
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
  /** Wave 6 OC: 'off_cycle' with its reason and pay date; absent or 'regular' for a regular run. */
  runKind?: string;
  offCycleReason?: string | null;
  runDate?: string | null;
  /** A cancelled off-cycle run: when and by whom (wave 6 OC). */
  cancelledAt?: string | null;
  cancelledByName?: string | null;
  /** Wave 6 FQd: labels a weekly or fortnightly run by its dates (RunCards.periodLabel). */
  payFrequency?: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  approval: DocumentApprovalState | null;
  /** Who decided the approval and whether it was the requester's own (sole-approver exception); null when not approved or grandfathered. */
  approvalDecision?: PayRunDecisionSummary | null;
  /** The payslips are final: the R-035 finalisation guard clears the run (never its status). */
  payslipsFinal?: boolean;
  lines: RunDetailLine[];
}

/** The banner when calculate is refused for a pay-frequency change: the card below says which days and what to do. */
export const STRADDLE_POINTER = 'This run cannot be calculated yet: settle the pay-frequency changes listed below, then calculate again.';

const LOAD_FAILED = 'Could not load the payroll run - try again';

export function useRunDetail(runId: string) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [calculating, setCalculating] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  // What the last approval did: posted a new journal, or re-locked onto the one the run carried.
  const [approvedNow, setApprovedNow] = useState<'posted' | 'relocked' | null>(null);
  const hasRun = useRef(false);
  const currentRun = useRef(runId);

  // `keepNotice`: the reload that follows an approval keeps its notice; any
  // other load clears it. The page is never blanked while it reloads a run it
  // already shows, and a failed reload of one says so without contradicting it.
  const load = useCallback(async (keepNotice = false) => {
    if (!runId) return;
    setIsLoading(true);
    setError('');
    try {
      const loaded = (await apiJson(`/api/payroll/runs/${runId}`, undefined, 'Could not load the payroll run - try again')) as RunDetail;
      if (currentRun.current !== runId) return; // the page moved to another run while this one was loading
      setRun(loaded);
      // A reload of a run already on screen follows calculate / approve / reopen: the period strip reads again.
      if (hasRun.current) announcePayrollRunChanged();
      hasRun.current = true;
      if (!keepNotice) setApprovedNow(null);
    } catch (err) {
      if (currentRun.current !== runId) return;
      const status = err instanceof ApiRequestError ? err.status : 0;
      setError(hasRun.current
        ? 'Could not refresh this run — reload the page to see its latest state.'
        : status === 404 ? 'Pay run not found'
        : payrollLoadMessage(status, status >= 500 ? LOAD_FAILED : apiErrorMessage(err, LOAD_FAILED)));
    } finally {
      if (currentRun.current === runId) setIsLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    // Another run: never show this one's figures under the new run's URL.
    currentRun.current = runId;
    hasRun.current = false;
    setRun(null);
    void load();
  }, [load, runId]);

  const calculate = async () => {
    if (!runId) return;
    setCalculating(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}/calculate`, { method: 'POST' });
      // A pay-frequency change to settle (wave 6 FQd): the run page's card names the days; the banner only points to it,
      // so the sentence shows once (review #1622 UI r2 L1).
      if (res.status === 409) {
        const body = await res.clone().json().catch(() => null) as { error?: { details?: { code?: unknown } } } | null;
        if (body?.error?.details?.code === 'FREQUENCY_CHANGE_STRADDLE') {
          setError(STRADDLE_POINTER);
          return;
        }
      }
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
      // Wave 6 OC (review #1620 final breaker M): a paid off-cycle run is corrected here only in the payroll records.
      (run?.runKind === 'off_cycle'
        ? 'This off-cycle run may already have been paid: reopening corrects the payroll records only. Recovering an over-payment from the employee happens outside payroll.\n\n'
        : '') +
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

  return { run, setRun, isLoading, error, calculating, reopening, approveOpen, setApproveOpen, approvedNow, load, calculate, onApproved, reopen };
}
