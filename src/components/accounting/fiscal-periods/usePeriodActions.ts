/**
 * The fiscal-periods-action calls behind the Fiscal Periods tab, single and
 * bulk. Moved out of FiscalPeriodsTab (300-line cap). Close, lock, bulk close
 * and bulk lock send `confirm: true`: the caller only runs them after its
 * confirmation dialog (audit P3.2).
 */

import { useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { BulkAction } from '@/components/accounting/fiscal-periods/BulkConfirmModal';

export type PeriodAction = 'close' | 'lock' | 'reopen';
export interface BulkResult { ok: number; total: number; failures: Array<{ id: string; error: string }> }

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

  const runBulk = async (action: BulkAction, ids: string[]) => {
    if (ids.length === 0) return;
    setBulkBusy(action); setBulkResult(null);
    try {
      const res = await post(action === 'bulk_reopen' ? { action, ids } : { action, ids, confirm: true });
      await assertOk(res, 'Could not run the bulk action - try again');
      const json = await res.json() as { data?: { results: Array<{ id: string; ok: boolean; error?: string }>; okCount: number; total: number } };
      const data = json.data!;
      setBulkResult({
        ok: data.okCount,
        total: data.total,
        failures: data.results.filter(r => !r.ok).map(r => ({ id: r.id, error: r.error || 'This period could not be updated' })),
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
        failures: ids.map(id => ({ id, error: `${msg} (partial success possible, list reloaded)` })),
      });
      await reload();
    } finally { setBulkBusy(null); }
  };

  const runSingle = async (periodId: string, action: PeriodAction) => {
    setActionLoading(periodId);
    try {
      const res = await post(action === 'reopen' ? { id: periodId, action } : { id: periodId, action, confirm: true });
      await assertOk(res, 'Could not update the fiscal period - try again');
      await reload();
    } catch (err) {
      log.error('Fiscal period action failed', { error: err, periodId, action }, 'accounting-ui');
      showSentence(apiErrorMessage(err, 'Could not update the fiscal period - try again'));
    } finally { setActionLoading(null); }
  };

  return { actionLoading, bulkBusy, bulkResult, setBulkResult, runBulk, runSingle };
}
