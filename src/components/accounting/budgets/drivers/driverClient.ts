/**
 * Fetchers for P4's driver, headcount, planned-hire and reforecast routes
 * (`pages/api/accounting/budget-drivers/**`, `budget-versions/[id]/reforecast`). Each returns the
 * workspace's `ApiResult` (apiFetch resolves on a 4xx: nothing here throws on a status). Every
 * write sends the version token as `expectedUpdatedAt` (in the query for a DELETE), and every
 * write's answer carries the new token, which the caller must adopt before its next write.
 */
import type { DriverLine, StoredDriverLine } from '@/modules/accounting/services/budgets/drivers/driverLine';
import type { PlannedHireInput, StoredPlannedHire } from '@/modules/accounting/services/budgets/drivers/driverRepository';
import type { VersionHeadcount } from '@/modules/accounting/services/budgets/drivers/plannedHireService';
import type { RestrictedHeadcount } from '@/modules/accounting/services/budgets/drivers/perHeadAccess';
import type { UnplacedActualLine } from '@/modules/accounting/services/budgets/drivers/reforecastInputs';
import type { ReforecastCreated } from '@/modules/accounting/services/budgets/drivers/reforecastService';
import type { RollOutcome } from '@/modules/accounting/services/budgets/drivers/rollingForecastService';
import type { RollingStatus } from '@/modules/accounting/services/budgets/drivers/rollingStatus';
import { call } from '@/components/accounting/budgets/workspace/budgetWorkspaceClient';
import type { ApiResult } from '@/components/accounting/budgets/workspace/types';

export type { RestrictedHeadcount, RollingStatus, StoredPlannedHire, UnplacedActualLine, VersionHeadcount };
/** The route's answers, typed from the services they pass through (tsc catches drift). */
export type ReforecastCreatedView = ReforecastCreated;
export type RollNowView = RollOutcome;


/** A recompute warning as the routes answer it (REF_MISSING, SECTION_EMPTY, BASE_MISSING, DRIVER_SKIPPED), labelled. */
export interface DriverWarningView { code: string; rowKey: string; message: string }

/** What every driver, override, hire and refresh write answers besides its own value. */
export interface DriverWriteAnswer { updatedAt: string; recomputed: number; warnings: DriverWarningView[] }

const enc = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** Narrows a union answer to the member the caller asked for; anything else is a failed result. */
function pick<T, N>(r: ApiResult<T>, is: (d: T) => boolean, fallback: string): ApiResult<N> {
  if (!r.ok) return r;
  return is(r.data) ? { ok: true, data: r.data as unknown as N } : { ok: false, kind: 'failed', message: fallback, status: 200 };
}

const has = (k: string) => (d: unknown): boolean => typeof d === 'object' && d !== null && k in d;

// ── Drivers ──────────────────────────────────────────────────────────────────

/** The fields of `line` its kind uses, as the PUT body wants them. */
export function driverBody(versionId: string, expectedUpdatedAt: string, line: DriverLine): Record<string, unknown> {
  const base = {
    versionId, expectedUpdatedAt, glAccountId: line.glAccountId, cc1Id: line.cc1Id, cc2Id: line.cc2Id, buId: line.buId,
    kind: line.kind, fromMonth: line.fromMonth, toMonth: line.toMonth, rounding: line.rounding,
  };
  switch (line.kind) {
    case 'fixed': return { ...base, amount: line.amount };
    case 'per_head': return { ...base, amount: line.amount, headcountCostCentreId: line.headcountCostCentreId };
    case 'pct_of_line': return { ...base, pct: line.pct, ref: line.ref };
    case 'pct_of_section': return { ...base, pct: line.pct, section: line.section, scope: line.scope };
    case 'growth': return { ...base, pct: line.pct, baseMonth: line.baseMonth };
  }
}

export async function saveDriver(versionId: string, token: string, line: DriverLine): Promise<ApiResult<DriverWriteAnswer & { driver: StoredDriverLine }>> {
  const fallback = 'Could not save the driver.';
  return pick(await call('/api/accounting/budget-drivers', json('PUT', driverBody(versionId, token, line)), fallback), has('driver'), fallback);
}

export async function deleteDriver(versionId: string, token: string, id: string): Promise<ApiResult<DriverWriteAnswer & { deleted: true }>> {
  const fallback = 'Could not delete the driver.';
  const url = `/api/accounting/budget-drivers?versionId=${enc(versionId)}&expectedUpdatedAt=${enc(token)}&id=${enc(id)}`;
  return pick(await call(url, { method: 'DELETE' }, fallback), has('deleted'), fallback);
}

export interface ResetTarget { glAccountId: string; cc1Id: string | null; cc2Id: string | null; buId: string | null; month: string | null }

/** Reset one override cell (`month`) or every override of the row (`month: null`) to the driver. */
export async function resetOverride(versionId: string, token: string, target: ResetTarget): Promise<ApiResult<DriverWriteAnswer & { reset: number }>> {
  const fallback = 'Could not reset the override.';
  return pick(await call('/api/accounting/budget-drivers/override', json('POST', { versionId, expectedUpdatedAt: token, ...target }), fallback), has('reset'), fallback);
}

// ── Headcount and planned hires ──────────────────────────────────────────────

/** The counts, or for a budget reader `perHeadRestricted` and no counts (perHeadAccess). */
export async function fetchHeadcount(versionId: string, costCentreId: string | null): Promise<ApiResult<VersionHeadcount | RestrictedHeadcount>> {
  const fallback = 'Could not read the headcount.';
  const cc = costCentreId ? `&costCentreId=${enc(costCentreId)}` : '';
  const answer = (d: unknown) => has('months')(d) || has('perHeadRestricted')(d);
  return pick(await call(`/api/accounting/budget-drivers/headcount?versionId=${enc(versionId)}${cc}`, undefined, fallback), answer, fallback);
}

export async function refreshHeadcount(versionId: string, token: string): Promise<ApiResult<DriverWriteAnswer & { headcountAsOf: string }>> {
  const fallback = 'Could not refresh the headcount.';
  return pick(await call('/api/accounting/budget-drivers/headcount', json('POST', { versionId, expectedUpdatedAt: token }), fallback), has('headcountAsOf'), fallback);
}

export async function listHires(versionId: string): Promise<ApiResult<{ hires: StoredPlannedHire[] }>> {
  const fallback = 'Could not read the planned hires.';
  return pick(await call(`/api/accounting/budget-drivers/planned-hires?versionId=${enc(versionId)}`, undefined, fallback), has('hires'), fallback);
}

/** Create (no `id`) or update a planned hire. */
export async function saveHire(versionId: string, token: string, hire: PlannedHireInput & { id?: string }): Promise<ApiResult<DriverWriteAnswer & { hire: StoredPlannedHire }>> {
  const fallback = 'Could not save the planned hire.';
  const body = { versionId, expectedUpdatedAt: token, ...hire };
  return pick(await call('/api/accounting/budget-drivers/planned-hires', json(hire.id ? 'PUT' : 'POST', body), fallback), has('hire'), fallback);
}

export async function deleteHire(versionId: string, token: string, id: string): Promise<ApiResult<DriverWriteAnswer & { deleted: true }>> {
  const fallback = 'Could not delete the planned hire.';
  const url = `/api/accounting/budget-drivers/planned-hires?versionId=${enc(versionId)}&expectedUpdatedAt=${enc(token)}&id=${enc(id)}`;
  return pick(await call(url, { method: 'DELETE' }, fallback), has('deleted'), fallback);
}

// ── Reforecast and the rolling forecast ──────────────────────────────────────

const reforecastUrl = (id: string) => `/api/accounting/budget-versions/${enc(id)}/reforecast` as const;

export async function fetchRollingStatus(versionId: string): Promise<ApiResult<RollingStatus>> {
  const fallback = 'Could not read the rolling forecast status.';
  return pick(await call(reforecastUrl(versionId), undefined, fallback), has('staleMonths'), fallback);
}

/** A new draft reforecast from `sourceId`: closed months = actuals, open months = the source's cells. */
export async function createReforecast(sourceId: string, body: { name: string; rolling: boolean }): Promise<ApiResult<ReforecastCreatedView>> {
  const fallback = 'Could not create the reforecast.';
  return pick(await call(reforecastUrl(sourceId), json('POST', body), fallback), has('unplaced'), fallback);
}

export async function rollNow(versionId: string, token: string): Promise<ApiResult<RollNowView>> {
  const fallback = 'Could not roll the forecast.';
  return pick(await call(reforecastUrl(versionId), json('POST', { action: 'roll', expectedUpdatedAt: token }), fallback), has('changed'), fallback);
}

export async function setRolling(versionId: string, token: string, rolling: boolean): Promise<ApiResult<{ rolling: boolean; changed: boolean; updatedAt: string }>> {
  const fallback = 'Could not change the rolling forecast.';
  return pick(await call(reforecastUrl(versionId), json('PUT', { rolling, expectedUpdatedAt: token }), fallback), has('rolling'), fallback);
}
