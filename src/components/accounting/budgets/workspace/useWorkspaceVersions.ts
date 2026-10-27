/**
 * The workspace's year and version lists, and the versions bar's actions (spec §10). The years
 * come from the legacy budgets route (the only one that lists the registry years); the first
 * answer also names the year holding today, which the workspace opens on. Every transition
 * sends the version's token, reloads the grid (new token) and refreshes the list; a refusal
 * resolves with the message to show in the dialog. A list answer for a year the user has left
 * is dropped.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import type { BudgetYear } from '@/components/accounting/budgets/budgetClient';
import { deleteVersion, listVersions, setPrimaryVersion, setVersionStatus } from './budgetWorkspaceClient';
import { failureText } from './failureText';
import type { BudgetGridApi } from './useBudgetGrid';
import type { VersionActionRequest } from './VersionStatusDialogs';
import type { ApiResult, BudgetVersion } from './types';

export interface WorkspaceYears {
  years: BudgetYear[];
  /** The year holding today (the first answer's); null until it arrives. */
  initialYear: number | null;
  error: string | null;
  loading: boolean;
  retry(): void;
}

const YEARS_FAILED = 'Could not load the financial years. Try again.';

export function useBudgetYears(): WorkspaceYears {
  const [years, setYears] = useState<BudgetYear[]>([]);
  const [initialYear, setInitialYear] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let gone = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await apiFetch('/api/accounting/budgets');
        await assertOk(res, YEARS_FAILED);
        const json = (await res.json()) as { data?: { fiscalYear?: number; years?: BudgetYear[] } };
        if (gone) return;
        setYears(json.data?.years ?? []);
        setInitialYear(json.data?.fiscalYear ?? null);
        setError(null);
      } catch (err) {
        if (gone) return;
        setYears([]);
        setInitialYear(null);
        setError(apiErrorMessage(err, YEARS_FAILED));
      } finally {
        if (!gone) setLoading(false);
      }
    })();
    return () => { gone = true; };
  }, [attempt]);
  return { years, initialYear, error, loading, retry: () => setAttempt((n) => n + 1) };
}

export interface WorkspaceVersions {
  versions: BudgetVersion[];
  listError: string | null;
  refresh(): void;
  run(req: VersionActionRequest): Promise<string | null>;
}

export function useWorkspaceVersions(fiscalYear: number | null, grid: BudgetGridApi): WorkspaceVersions {
  const [versions, setVersions] = useState<BudgetVersion[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const seq = useRef(0);
  const refresh = useCallback(() => setBump((n) => n + 1), []);

  useEffect(() => {
    const mine = ++seq.current;
    if (fiscalYear === null) { setVersions([]); return; }
    void listVersions(fiscalYear).then((r) => {
      if (mine !== seq.current) return;
      if (r.ok) { setVersions(r.data); setListError(null); } else setListError(failureText(r));
    });
  }, [fiscalYear, bump, grid.token]);

  const { version, token, reload, selectVersion } = grid;
  const run = useCallback(async ({ action, reason }: VersionActionRequest): Promise<string | null> => {
    if (!version) return 'There is no budget version to change.';
    if (grid.dirtyCount > 0) return `Save or discard ${grid.dirtyCount} unsaved changes first.`;
    let r: ApiResult<unknown>;
    if (action === 'primary') r = await setPrimaryVersion(version.id);
    else if (action === 'delete') r = await deleteVersion(version.id);
    else r = await setVersionStatus(version.id, action, { ...(reason ? { reason } : {}), ...(token ? { expectedUpdatedAt: token } : {}) });
    // A stale token: someone moved the version; show theirs (the grid is clean) and say so.
    if (!r.ok && r.kind === 'stale') { await reload(); refresh(); return `${r.message} The latest version is now on screen; check it and try again.`; }
    if (!r.ok) return failureText(r);
    if (action === 'delete') await selectVersion(null); else await reload();
    refresh();
    return null;
  }, [version, token, grid.dirtyCount, reload, selectVersion, refresh]);

  return { versions, listError, refresh, run };
}
