/**
 * The three-way page's fetchers (budgets P6 spec §7). `apiFetch` RESOLVES on a 4xx, so every call checks
 * `res.ok` (through the workspace's `call`, or here for the save) and returns an `ApiResult`: data, or a typed
 * failure. Nothing throws on a status or a dropped connection. Money on the wire is CENTS.
 *
 * The save adds what the generic mapping drops: 409 BUDGET_ASSUMPTIONS_STALE with the row's token now
 * (`stale` → the reload prompt), 409 BUDGET_VERSION_LOCKED (`locked` → read-only) and 400
 * BUDGET_ASSUMPTIONS_INVALID's issues by path.
 */
import { apiFetch } from '@/lib/apiFetch';
import { call } from '@/components/accounting/budgets/workspace/budgetWorkspaceClient';
import type { ApiResult } from '@/components/accounting/budgets/workspace/types';
import type { AssumptionsView, CompareView, DeriveView, ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import type { StoredAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsRepo';
import type { GLAccount } from '@/modules/accounting/types/gl.types';

export type SavedAssumptions = StoredAssumptions & { versionId: string };

export type SaveFailure =
  | { ok: false; kind: 'stale'; message: string; currentUpdatedAt: string | null }
  | { ok: false; kind: 'locked'; message: string }
  | { ok: false; kind: 'invalid'; message: string; issues: string[] }
  | { ok: false; kind: 'forbidden' | 'rateLimited' | 'conflict' | 'failed' | 'network'; message: string };
export type SaveResult = { ok: true; data: SavedAssumptions } | SaveFailure;

export function fetchThreeWay(versionId: string): Promise<ApiResult<ThreeWayView>> {
  return call(`/api/accounting/budget-three-way?version_id=${encodeURIComponent(versionId)}`, undefined, 'Could not load the three-way budget.');
}

/** 400 BUDGET_ASSUMPTIONS_INVALID on a READ: the stored document no longer validates (schema drift, a hand edit). */
export type InvalidDocFailure = { ok: false; kind: 'invalidDoc'; message: string; issues: string[] };

/**
 * The assumptions view. A stored document that no longer validates answers 400 BUDGET_ASSUMPTIONS_INVALID with its
 * issues: returned as `invalidDoc` so the form can offer the replacement (derive, then save over it).
 */
export async function fetchAssumptions(versionId: string): Promise<ApiResult<AssumptionsView> | InvalidDocFailure> {
  const fallback = 'Could not load the assumptions.';
  let res: Response;
  try {
    res = await apiFetch(`/api/accounting/budget-three-way/assumptions?version_id=${encodeURIComponent(versionId)}`);
  } catch {
    return { ok: false, kind: 'network', message: fallback };
  }
  const text = await res.text();
  let body: (ErrorBody & { data?: unknown }) | null;
  try { body = JSON.parse(text) as ErrorBody & { data?: unknown }; } catch { body = null; } // an HTML page: no data
  if (!res.ok) {
    const message = body?.error?.message || body?.message || fallback;
    const code = body?.error?.details?.code;
    if (res.status === 400 && code === 'BUDGET_ASSUMPTIONS_INVALID') return { ok: false, kind: 'invalidDoc', message, issues: issuesOf(body?.error?.details?.issues) };
    if (res.status === 403) return { ok: false, kind: 'forbidden', message };
    if (res.status === 404) return { ok: false, kind: 'notFound', message };
    return { ok: false, kind: 'failed', message, status: res.status };
  }
  const data = body?.data as AssumptionsView | undefined;
  return data && typeof data === 'object' && 'resolved' in data ? { ok: true, data } : { ok: false, kind: 'failed', message: fallback, status: res.status };
}

/** The derived defaults for the version's year (computes, never writes). */
export function fetchDerive(versionId: string): Promise<ApiResult<DeriveView>> {
  return call('/api/accounting/budget-three-way/derive', { method: 'POST', body: JSON.stringify({ version_id: versionId }) }, 'Could not derive the defaults.');
}

export function fetchCompare(versionIds: readonly string[]): Promise<ApiResult<CompareView>> {
  return call(`/api/accounting/budget-three-way/compare?version_ids=${encodeURIComponent(versionIds.join(','))}`, undefined, 'Could not compare the versions.');
}

/** Active LEAF liability accounts (candidates for the income-tax and dividends payable pickers). */
export async function fetchLiabilityAccounts(): Promise<ApiResult<Array<Pick<GLAccount, 'id' | 'accountCode' | 'accountName'>>>> {
  const fallback = 'Could not load the liability accounts.';
  const r = await call('/api/accounting/chart-of-accounts', undefined, fallback);
  if (!r.ok) return r;
  if (!Array.isArray(r.data)) return { ok: false, kind: 'failed', message: fallback, status: 200 };
  const accounts = r.data as GLAccount[];
  const parents = new Set(accounts.map((a) => a.parentAccountId).filter((p): p is string => typeof p === 'string'));
  const leaves = accounts.filter((a) => a.accountType === 'liability' && a.isActive && !parents.has(a.id));
  return { ok: true, data: leaves.map((a) => ({ id: a.id, accountCode: a.accountCode, accountName: a.accountName })) };
}

interface ErrorBody { message?: string; error?: { message?: string; details?: { code?: unknown; currentUpdatedAt?: unknown; issues?: unknown } } }

function issuesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((i: { path?: unknown; message?: unknown }) => `${String(i.path ?? '')}: ${String(i.message ?? '')}`);
}

function saveFailure(status: number, text: string, fallback: string): SaveFailure {
  let body: ErrorBody | null;
  try { body = JSON.parse(text) as ErrorBody; } catch { body = null; } // an HTML error page: the fallback speaks
  const message = body?.error?.message || body?.message || fallback;
  const d = body?.error?.details;
  const code = typeof d?.code === 'string' ? d.code : null;
  if (status === 409 && code === 'BUDGET_ASSUMPTIONS_STALE') {
    return { ok: false, kind: 'stale', message, currentUpdatedAt: typeof d?.currentUpdatedAt === 'string' ? d.currentUpdatedAt : null };
  }
  if (status === 409 && code === 'BUDGET_VERSION_LOCKED') return { ok: false, kind: 'locked', message };
  if (status === 400 || status === 422) return { ok: false, kind: 'invalid', message, issues: issuesOf(d?.issues) };
  if (status === 403) return { ok: false, kind: 'forbidden', message };
  if (status === 429) return { ok: false, kind: 'rateLimited', message };
  if (status === 409) return { ok: false, kind: 'conflict', message };
  return { ok: false, kind: 'failed', message };
}

/** PUT the document with the token it was read with (null = no row stored yet). */
export async function saveAssumptionsDoc(versionId: string, doc: Record<string, unknown>, expectedUpdatedAt: string | null): Promise<SaveResult> {
  const fallback = 'Could not save the assumptions.';
  let res: Response;
  try {
    res = await apiFetch('/api/accounting/budget-three-way/assumptions', {
      method: 'PUT', body: JSON.stringify({ version_id: versionId, doc, expected_updated_at: expectedUpdatedAt }),
    });
  } catch {
    return { ok: false, kind: 'network', message: fallback };
  }
  const text = await res.text();
  if (!res.ok) return saveFailure(res.status, text, fallback);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = null; } // a 2xx proxy page is not the saved row
  const data = (parsed as { data?: unknown } | null)?.data as SavedAssumptions | undefined;
  if (!data || typeof data.updatedAt !== 'string') return { ok: false, kind: 'failed', message: fallback };
  return { ok: true, data };
}

export interface LoanOption { id: string; label: string }

/** The company's loans (for "include an existing loan"); the schedules are the server's (`previewSchedule`). */
export async function fetchLoans(): Promise<ApiResult<LoanOption[]>> {
  const fallback = 'Could not load the loans.';
  const r = await call('/api/accounting/loans', undefined, fallback);
  if (!r.ok) return r;
  if (!Array.isArray(r.data)) return { ok: false, kind: 'failed', message: fallback, status: 200 };
  return {
    ok: true,
    data: (r.data as Array<{ id?: unknown; reference?: unknown; description?: unknown }>)
      .filter((l) => typeof l.id === 'string')
      .map((l) => ({ id: l.id as string, label: [l.reference, l.description].filter((x) => typeof x === 'string' && x !== '').join(' · ') || (l.id as string) })),
  };
}
