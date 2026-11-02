/**
 * useRunDetail — the pay-run page's state: load, calculate, reopen and the
 * approval hand-over, split out of pages/payroll/runs/[id].tsx.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { apiFetch, assertOk, apiErrorMessage, apiJson, ApiRequestError } from '@/lib/apiFetch';
import type { ApproveResult } from '@/components/payroll/PayrollApproveDialog';
import type { RunLineWarning } from '@/components/payroll/PayrollRunWarnings';
import { payrollLoadMessage } from '@/lib/payrollDetailAccess';

export interface RunDetailLine {
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
  lines: RunDetailLine[];
}

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

  return { run, setRun, isLoading, error, calculating, reopening, approveOpen, setApproveOpen, approvedNow, load, calculate, onApproved, reopen };
}
