/**
 * useRunInputs — the review grid's server state (master plan wave 3, R).
 *
 * Commits run one at a time, in the order they were made: the server answers
 * each with the whole run, so a slower earlier answer landing last would put
 * old figures over newer ones. `settled` lets the page wait for them before it
 * opens the approval preview. A 4xx wrote nothing; anything else may have, so
 * every failure re-reads the state and the cell shows what is stored.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import type { ResponseFor } from '@/lib/apiRoutes';
import { log } from '@/lib/logger';
import type { RunDetail } from '@/components/payroll/useRunDetail';

type State = ResponseFor<'/api/payroll/runs/{}/inputs'>;
export type RunInputs = State['inputs'];
export type RunInputComponent = RunInputs['components'][number];

export interface RowSave {
  state: 'saving' | 'saved' | 'error';
  savedAt?: number;
  message?: string;
}

const SAVE_FAILED = 'Could not save this amount - try again';

export function useRunInputs(runId: string, active: boolean, onRun: (run: RunDetail) => void) {
  const [inputs, setInputs] = useState<RunInputs | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saves, setSaves] = useState<Record<string, RowSave>>({});
  // Bumped after a failed commit: tells the cells to drop their text for the stored amount.
  const [resetKey, setResetKey] = useState(0);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const reload = useCallback(async () => {
    try {
      setInputs((await apiJson(`/api/payroll/runs/${runId}/inputs`, undefined, 'Could not load the amounts')).inputs);
      setLoadError(false);
    } catch (err) {
      log.error('Failed to load pay-run inputs', { error: err }, 'payroll-ui');
      setInputs(null);
      setLoadError(true);
    }
  }, [runId]);

  useEffect(() => {
    if (!active || !runId) { setInputs(null); setLoadError(false); return; }
    setSaves({});
    void reload();
  }, [active, runId, reload]);

  const commit = useCallback((employeeId: string, componentId: string, cents: number) => {
    setSaves((s) => ({ ...s, [employeeId]: { state: 'saving' } }));
    queue.current = queue.current.then(async () => {
      try {
        const state = await apiJson(`/api/payroll/runs/${runId}/inputs`, {
          method: 'PUT',
          body: JSON.stringify({ employeeId, componentId, amount: cents / 100 }),
        }, SAVE_FAILED);
        setInputs(state.inputs);
        onRun(state.run);
        setSaves((s) => ({ ...s, [employeeId]: { state: 'saved', savedAt: Date.now() } }));
      } catch (err) {
        setSaves((s) => ({ ...s, [employeeId]: { state: 'error', message: apiErrorMessage(err, SAVE_FAILED) } }));
        await reload();
        setResetKey((k) => k + 1);
      }
    });
  }, [runId, onRun, reload]);

  const settled = useCallback(() => queue.current, []);

  return { inputs, loadError, saves, resetKey, commit, settled };
}
