/**
 * useRunInputs — the review grid's server state (master plan wave 3, R).
 *
 * Commits run one at a time, in the order they were made: the server answers
 * each with the whole run, so a slower earlier answer landing last would put
 * old figures over newer ones. Each PUT carries the amount the cell last held,
 * read when it is sent, so a queued second edit of a cell expects the first.
 * A 4xx wrote nothing; anything else may have, so every failure re-reads the
 * run and its amounts and that one cell shows what is stored. Other cells keep
 * what is typed in them, and the grid stays up if the re-read fails too.
 *
 * `drained` waits for the queue. `settled` waits too, then says what must stop
 * the approval preview: refused text still in a cell, a failed re-read, or a
 * failed save nobody has been told about yet. A failure is reported once: the
 * cell is back on the stored amount and the row says why, so a second press
 * goes ahead on figures that are on screen.
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
export const HELD_REFUSED = 'An amount in the grid could not be read. Correct or clear it before you approve.';
export const HELD_FAILED = 'A save failed: see the row. The grid shows what is stored. Review & approve again to go on without it.';
export const HELD_STALE = 'This run could not be re-read after a failed save. Reload the page before you approve.';

export const cellKey = (employeeId: string, componentId: string) => `${employeeId}:${componentId}`;

export function useRunInputs(runId: string, active: boolean, onRun: (run: RunDetail) => void) {
  const [inputs, setInputs] = useState<RunInputs | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saves, setSaves] = useState<Record<string, RowSave>>({});
  // Bumped for one cell after its commit fails: that cell drops its text for the stored amount.
  const [resets, setResets] = useState<Record<string, number>>({});
  const queue = useRef<Promise<void>>(Promise.resolve());
  const currentRun = useRef(runId);
  const known = useRef<RunInputs | null>(null);
  const refused = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const stale = useRef(false);

  const adopt = useCallback((next: RunInputs | null) => { known.current = next; setInputs(next); }, []);

  const reload = useCallback(async (withRun: boolean) => {
    try {
      const state = await apiJson(`/api/payroll/runs/${runId}/inputs`, undefined, 'Could not load the amounts');
      if (currentRun.current !== runId) return;
      adopt(state.inputs);
      if (withRun) onRun(state.run);
      stale.current = false;
      setLoadError(false);
    } catch (err) {
      log.error('Failed to load pay-run inputs', { error: err }, 'payroll-ui');
      if (currentRun.current !== runId) return;
      stale.current = withRun;
      setLoadError(true);
    }
  }, [runId, adopt, onRun]);

  useEffect(() => {
    currentRun.current = runId;
    adopt(null);
    setLoadError(false);
    setSaves({});
    setResets({});
    refused.current.clear();
    failed.current.clear();
    stale.current = false;
    if (active && runId) void reload(false);
  }, [active, runId, reload, adopt]);

  const commit = useCallback((employeeId: string, componentId: string, cents: number) => {
    const key = cellKey(employeeId, componentId);
    refused.current.delete(key);
    setSaves((s) => ({ ...s, [key]: { state: 'saving' } }));
    queue.current = queue.current.then(async () => {
      try {
        const held = known.current?.amounts.find((a) => a.employeeId === employeeId && a.componentId === componentId);
        const state = await apiJson(`/api/payroll/runs/${runId}/inputs`, {
          method: 'PUT',
          body: JSON.stringify({ employeeId, componentId, amount: cents / 100, expectedAmount: held?.amount ?? 0 }),
        }, SAVE_FAILED);
        if (currentRun.current !== runId) return;
        adopt(state.inputs);
        onRun(state.run);
        failed.current.delete(key);
        stale.current = false;
        setLoadError(false);
        setSaves((s) => ({ ...s, [key]: { state: 'saved', savedAt: Date.now() } }));
      } catch (err) {
        if (currentRun.current !== runId) return;
        failed.current.add(key);
        setSaves((s) => ({ ...s, [key]: { state: 'error', message: apiErrorMessage(err, SAVE_FAILED) } }));
        await reload(true);
        setResets((r) => ({ ...r, [key]: (r[key] ?? 0) + 1 }));
      }
    });
  }, [runId, onRun, reload, adopt]);

  /** The cell holds text MoneyField refused: nothing was sent, and what is on screen is not what is stored. */
  const refuse = useCallback((employeeId: string, componentId: string) => {
    refused.current.add(cellKey(employeeId, componentId));
  }, []);

  /** The column moved off this component: its cells, and any refused text in them, are gone. */
  const forgetRefused = useCallback((componentId: string) => {
    for (const key of refused.current) if (key.endsWith(`:${componentId}`)) refused.current.delete(key);
  }, []);

  const drained = useCallback(async () => {
    let tail: Promise<void>;
    do {
      tail = queue.current;
      await tail;
    } while (tail !== queue.current);
  }, []);

  const settled = useCallback(async (): Promise<string | null> => {
    await drained();
    if (refused.current.size > 0) return HELD_REFUSED;
    if (stale.current) return HELD_STALE;
    if (failed.current.size > 0) {
      failed.current.clear();
      return HELD_FAILED;
    }
    return null;
  }, [drained]);

  return { inputs, loadError, saves, resets, commit, refuse, forgetRefused, drained, settled };
}
