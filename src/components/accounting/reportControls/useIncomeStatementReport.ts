import { useCallback, useEffect, useRef, useState } from 'react';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';
import { localISODate } from '@/lib/dateUtils';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';

interface ShownReport { key: string; report: IncomeStatementReport; start: string; end: string; cc: string; bu: string; cmp: boolean }
interface Inputs {
  ready: boolean; periodStart: string; periodEnd: string; periodResolved: boolean; datesOk: boolean;
  costCentreId: string; businessUnitId: string; showComparative: boolean;
}

function localDate(iso: string): Date {
  const [y = 0, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const addDays = (iso: string, n: number): string => { const d = localDate(iso); d.setDate(d.getDate() + n); return localISODate(d); };
export function priorRange(start: string, end: string): { start: string; end: string } {
  const priorEnd = addDays(start, -1);
  return { start: addDays(priorEnd, -daysBetween(start, end)), end: priorEnd };
}
const daysBetween = (a: string, b: string): number => Math.round((localDate(b).getTime() - localDate(a).getTime()) / 86_400_000);

/**
 * Loads the P&L. The report is stored with the inputs it was run for and shown only while they equal the live
 * ones, so the heading, drill-downs and present link never name a range the data is not for. Refused text
 * changes neither the key nor what is in flight; only a changed key invalidates a request.
 */
export function useIncomeStatementReport(i: Inputs) {
  const { ready, periodStart, periodEnd, periodResolved, datesOk, costCentreId, businessUnitId, showComparative } = i;
  const [shown, setShown] = useState<ShownReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const reportRequestRef = useRef(0);
  const requestedKeyRef = useRef<string | null>(null); // the key of the newest request, in flight or done
  const shownKeyRef = useRef<string | null>(null);
  const live = { start: periodStart, end: periodEnd, cc: costCentreId, bu: businessUnitId, cmp: showComparative };
  const liveKey = JSON.stringify(live);
  const view = shown && shown.key === liveKey ? shown : null;
  const loadReport = useCallback(async () => {
    // Refused text changes neither the key nor what is in flight; only a changed key invalidates a request.
    if (!ready || !periodStart || !periodEnd || !periodResolved || !datesOk) {
      if (requestedKeyRef.current !== liveKey) {
        reportRequestRef.current += 1;
        requestedKeyRef.current = null;
        if (!datesOk) setIsLoading(false);
      }
      return;
    }
    if (requestedKeyRef.current === liveKey) return;
    requestedKeyRef.current = liveKey;
    const requestId = ++reportRequestRef.current;
    if (shownKeyRef.current === liveKey) { setIsLoading(false); return; } // already on screen: no refetch
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
      if (costCentreId) params.set('cost_centre_id', costCentreId);
      if (businessUnitId) params.set('business_unit_id', businessUnitId);
      if (showComparative) {
        const { start: priorStart, end: priorEnd } = priorRange(periodStart, periodEnd);
        params.set('compare_start', priorStart);
        params.set('compare_end', priorEnd);
      }
      const res = await apiFetch(`/api/accounting/reports-income-statement?${params}`);
      await assertOk(res, 'Could not load income statement - try again');
      const json = await res.json();
      if (requestId === reportRequestRef.current) {
        shownKeyRef.current = liveKey;
        setShown({ key: liveKey, report: json.data || json, start: periodStart, end: periodEnd, cc: costCentreId, bu: businessUnitId, cmp: showComparative });
      }
    } catch (err) {
      if (requestId === reportRequestRef.current) { requestedKeyRef.current = null; shownKeyRef.current = null; setShown(null); setError(apiErrorMessage(err, 'Could not load income statement - try again')); }
    } finally {
      if (requestId === reportRequestRef.current) setIsLoading(false);
    }
  }, [ready, periodStart, periodEnd, costCentreId, businessUnitId, showComparative, periodResolved, datesOk, liveKey]);

  useEffect(() => { void loadReport(); }, [loadReport]);

  return { report: view?.report ?? null, vw: view ?? live, shown, live, isLoading, error };
}
