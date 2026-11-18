/**
 * After a save that moved the financial year start, the server rebuilt the
 * fiscal periods on it. Re-read only what the server derives (the month the
 * periods now use, and the lock) and merge it into the form, so an edit typed
 * while the save ran survives. A failed re-read keeps the company on screen and
 * says so, unless an error is already showing (a partial save's error wins).
 */
import type { Dispatch, SetStateAction } from 'react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { Company } from './settingsTypes';
import { mapApiCompany } from './mapApiCompany';

export const NOT_REFRESHED = 'Changes saved, but the page could not refresh them - reload the page';

export async function refreshFinancialYearView(
  companyId: string,
  setCompany: Dispatch<SetStateAction<Company | null>>,
  setError: Dispatch<SetStateAction<string>>,
): Promise<void> {
  try {
    const res = await apiFetch(`/api/accounting/companies?id=${companyId}`);
    await assertOk(res, NOT_REFRESHED);
    const row = ((await res.json()) as { data?: Record<string, unknown> | null }).data;
    if (!row) throw new Error('The company re-read answered no company');
    const { financialYearStartActual, financialYearStartLocked, financialYearStartLockReason } = mapApiCompany(row);
    setCompany(prev => prev && { ...prev, financialYearStartActual, financialYearStartLocked, financialYearStartLockReason });
  } catch (err) {
    log.warn('Company re-read after save failed', { error: err }, 'settings-general');
    setError(prev => prev || NOT_REFRESHED);
  }
}
