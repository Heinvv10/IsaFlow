/**
 * The fiscal-periods-action calls behind the Fiscal Periods tab, single and
 * bulk. Moved out of FiscalPeriodsTab (300-line cap). Close, lock, bulk close
 * and bulk lock send `confirm: true`: the caller only runs them after its
 * confirmation dialog (audit P3.2). A close the readiness checks refuse (single
 * 409, or bulk result rows) lands in `closeRefusal`, for CloseRefusalNotice.
 */

import { useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { BulkAction } from '@/components/accounting/fiscal-periods/BulkConfirmModal';
import type { BlockedPeriod } from '@/modules/accounting/services/gl/periodCloseRefusalShape';
import { bulkCloseRefusal, readCloseRefusal, type CloseRefusal } from './closeRefusal';

export type PeriodAction = 'close' | 'lock' | 'reopen';
/** `failures` excludes periods the close checks refused: those are counted in `refused` and listed in CloseRefusalNotice. */
export interface BulkResult { ok: number; total: number; refused: number; failures: Array<{ id: string; error: string }> }

interface Deps {
  reload: () => Promise<void>;
  /** Receives the plain sentence (apiErrorMessage), never the raw error. */
  showSentence: (sentence: string) => void;
  clearSelection: () => void;
}

const URL = '/api/accounting/fiscal-periods-action';

function post(body: Record<string, unknown>) {
  return apiFetch(URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'include', body: JSON.stringify(body),
  });
}

export function usePeriodActions({ reload, showSentence, clearSelection }: Deps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState<BulkAction | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [closeRefusal, setCloseRefusal] = useState<CloseRefusal | null>(null);

  const runBulk = async (action: BulkAction, ids: string[]) => {
    if (ids.length === 0) return;
    setBulkBusy(action); setBulkResult(null); setCloseRefusal(null);
    try {
      const res = await post(action === 'bulk_reopen' ? { action, ids } : { action, ids, confirm: true });
      await assertOk(res, 'Could not run the bulk action - try again');
      type Row = { id: string; ok: boolean; error?: string; code?: string; periods?: BlockedPeriod[] };
      const json = await res.json() as { data?: { results: Row[]; okCount: number; total: number } };
      const data = json.data!;
      const refusal = bulkCloseRefusal(data.results);
      setCloseRefusal(refusal);
      setBulkResult({
        ok: data.okCount,
        total: data.total,
        refused: data.results.filter(r => !r.ok && r.periods).length,
        failures: data.results.filter(r => !r.ok && !r.periods)
          .map(r => ({ id: r.id, error: r.error || 'This period could not be updated' })),
      });
      clearSelection();
      await reload();
    } catch (err) {
      log.error('Bulk fiscal period action failed', { error: err, action }, 'accounting-ui');
      // Network/server error: the server may have processed some periods
      // before the connection broke. Reload to surface whatever did land,
      // and tell the user the count is best-effort.
      const msg = apiErrorMessage(err, 'Could not run the bulk action - try again');
      setBulkResult({
        ok: 0,
        total: ids.length,
        refused: 0,
        failures: ids.map(id => ({ id, error: `${msg} (partial success possible, list reloaded)` })),
      });
      await reload();
    } finally { setBulkBusy(null); }
  };

  const runSingle = async (periodId: string, action: PeriodAction) => {
    setActionLoading(periodId); setCloseRefusal(null);
    try {
      const res = await post(action === 'reopen' ? { id: periodId, action } : { id: periodId, action, confirm: true });
      const refusal = await readCloseRefusal(res);
      if (refusal) { setCloseRefusal(refusal); return; }
      await assertOk(res, 'Could not update the fiscal period - try again');
      await reload();
    } catch (err) {
      log.error('Fiscal period action failed', { error: err, periodId, action }, 'accounting-ui');
      showSentence(apiErrorMessage(err, 'Could not update the fiscal period - try again'));
    } finally { setActionLoading(null); }
  };

  return { actionLoading, bulkBusy, bulkResult, setBulkResult, closeRefusal, setCloseRefusal, runBulk, runSingle };
}
