/**
 * After a save that moved the financial year start, the server rebuilt the
 * fiscal periods on it. Re-read only what the server derives (the month the
 * periods now use, and the lock) and merge it into the form, so an edit typed
 * while the save ran survives. A failed re-read keeps the company on screen and
 * says so, unless an error is already showing (a partial save's error wins).
 * Scoped to the company it was read for: if the user switched company before
 * the answer came, it is merged nowhere and its failure is not reported.
 */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { Company } from './settingsTypes';
import { mapApiCompany } from './mapApiCompany';

export const NOT_REFRESHED = 'Changes saved, but the page could not refresh them - reload the page';

export async function refreshFinancialYearView(
  companyId: string,
  setCompany: Dispatch<SetStateAction<Company | null>>,
  setError: Dispatch<SetStateAction<string>>,
  stillActive: () => boolean,
): Promise<void> {
  try {
    const res = await apiFetch(`/api/accounting/companies?id=${companyId}`);
    await assertOk(res, NOT_REFRESHED);
    const row = ((await res.json()) as { data?: Record<string, unknown> | null }).data;
    if (!row) throw new Error('The company re-read answered no company');
    const { financialYearStartActual, financialYearStartLocked, financialYearStartLockReason } = mapApiCompany(row);
    setCompany(prev => prev?.id === companyId
      ? { ...prev, financialYearStartActual, financialYearStartLocked, financialYearStartLockReason } : prev);
  } catch (err) {
    log.warn('Company re-read after save failed', { error: err, companyId }, 'settings-general');
    if (stillActive()) setError(prev => prev || NOT_REFRESHED);
  }
}

/**
 * The page's entry point: remount General (its year panel reads the year again)
 * and re-read the company's derived fields, scoped to `activeCompanyId` at the
 * time the answer comes back.
 */
export function useFinancialYearRefresh(
  activeCompanyId: string | undefined,
  setCompany: Dispatch<SetStateAction<Company | null>>,
  setError: Dispatch<SetStateAction<string>>,
  setReloads: Dispatch<SetStateAction<number>>,
): (companyId: string) => void {
  const active = useRef(activeCompanyId);
  useEffect(() => { active.current = activeCompanyId; }, [activeCompanyId]);
  return useCallback((companyId: string) => {
    setReloads(n => n + 1);
    void refreshFinancialYearView(companyId, setCompany, setError, () => active.current === companyId);
  }, [setCompany, setError, setReloads]);
}
