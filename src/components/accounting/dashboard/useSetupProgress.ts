/**
 * useSetupProgress — loads the Home setup checklist once, for the checklist card
 * (rendered above the hero while setup is open) and for TodoWidget (which must
 * not say "All caught up!" while setup tasks are still open).
 */

import { useEffect, useState } from 'react';
import { apiJson, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { SetupProgress } from '@/modules/accounting/services/core/setupProgressService';

export interface SetupProgressState {
  /** Null while loading, when the load failed, or before a company is active. */
  progress: SetupProgress | null;
  loading: boolean;
}

/**
 * How long Home waits for the checklist before rendering without it. Home holds
 * its skeleton meanwhile (the card sits above the hero, so arriving late would
 * push the page down); a stuck request must not hold the dashboard hostage.
 */
export const SETUP_WAIT_MS = 1500;

export function useSetupProgress(companyId: string | undefined): SetupProgressState {
  const [state, setState] = useState<SetupProgressState>({ progress: null, loading: true });

  useEffect(() => {
    setState({ progress: null, loading: true });
    // No company yet (the context is still loading): nothing to ask, and asking
    // now would only be repeated when the id arrives.
    if (!companyId) return;
    let cancelled = false;
    const giveUp = setTimeout(() => {
      if (!cancelled) setState((s) => (s.loading ? { progress: null, loading: false } : s));
    }, SETUP_WAIT_MS);
    apiJson('/api/accounting/setup-checklist', undefined, 'Could not load the setup checklist - try again')
      .then((data) => {
        // Late is still shown: an open setup matters more than a layout shift.
        if (!cancelled) setState({ progress: Array.isArray(data?.modules) ? data : null, loading: false });
      })
      .catch((err) => {
        log.error('Failed to load setup checklist', { error: apiErrorMessage(err, 'setup checklist') }, 'accounting-ui');
        if (!cancelled) setState({ progress: null, loading: false });
      })
      .finally(() => clearTimeout(giveUp));
    return () => { cancelled = true; clearTimeout(giveUp); };
  }, [companyId]);

  return state;
}

/**
 * The checklist has not resolved (loading, timed out, failed, or no company
 * yet). Home still renders without it, but must not read that as "complete".
 */
export function isSetupUnknown({ progress }: SetupProgressState): boolean {
  return progress === null;
}

/**
 * Setup may still have open tasks. True while the checklist is unknown too, so
 * "All caught up!" appears only once the checklist has said setup is complete:
 * a slow or failed load must not tell a company with open setup that it is.
 */
export function isSetupOpen(state: SetupProgressState): boolean {
  return isSetupUnknown(state) || !state.progress!.allComplete;
}
