/**
 * The budget review page's fetchers (budgets P5-6). Typed through the route registry where the
 * route is registered (holders, slice moves); the member, centre, unit and version lists the assign
 * form reads are narrowed here from `unknown`. Every call throws on a 4xx/5xx with the server's
 * message (`apiJson`); callers show `apiErrorMessage(err, …)`.
 */
import { apiJson } from '@/lib/apiFetch';
import type { SliceReview } from '@/modules/accounting/services/budgets/sliceReviewRead';
import type { SliceAction } from '@/modules/accounting/services/budgets/sliceReviewState';
import type { BudgetYear } from '@/components/accounting/budgets/budgetClient';

export type { SliceReview, SliceAction };

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** Every slice the caller may see (an owner/admin: all; anyone else: their own), optionally of one version. */
export async function fetchSlices(versionId?: string | null): Promise<SliceReview[]> {
  const data = await apiJson(versionId ? `/api/accounting/budgets/holders?versionId=${encodeURIComponent(versionId)}` : '/api/accounting/budgets/holders',
    undefined, 'Could not load the budget slices.');
  return 'slices' in data ? data.slices : [];
}

export async function moveSlice(id: string, action: SliceAction, note?: string): Promise<SliceReview> {
  const body = post(note === undefined ? {} : { note });
  const sid = encodeURIComponent(id);
  if (action === 'submit') return apiJson(`/api/accounting/budgets/slices/${sid}/submit`, body, 'Could not submit the slice.');
  if (action === 'approve') return apiJson(`/api/accounting/budgets/slices/${sid}/approve`, body, 'Could not approve the slice.');
  return apiJson(`/api/accounting/budgets/slices/${sid}/return`, body, 'Could not return the slice.');
}

export interface AssignBody {
  versionId: string; userId: string; cc1Id: string | null; cc2Id: string | null; buId: string | null; dueDate: string | null;
}

export async function assignHolder(body: AssignBody): Promise<SliceReview> {
  const data = await apiJson('/api/accounting/budgets/holders', post(body), 'Could not assign the budget holder.');
  if ('slices' in data) throw new Error('unexpected answer');
  return data;
}

export interface Option { id: string; label: string }
export interface MemberOption extends Option { role: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Members who may hold a slice (manager, admin, owner), from GET /api/accounting/company-users. */
export async function fetchHolderCandidates(): Promise<MemberOption[]> {
  const data: unknown = await apiJson('/api/accounting/company-users', undefined, 'Could not load the members.');
  return (Array.isArray(data) ? data : []).filter(isObj)
    .filter((m) => ['owner', 'admin', 'manager'].includes(str(m.role)))
    .map((m) => ({ id: str(m.userId), label: `${str(m.name) || str(m.email)} (${str(m.role)})`, role: str(m.role) }))
    .filter((m) => m.id !== '');
}

const items = (data: unknown): Record<string, unknown>[] =>
  (isObj(data) && Array.isArray(data.items) ? data.items : []).filter(isObj);

/** Active CC1 or CC2 centres, or business units, as options. */
export async function fetchSliceMembers(kind: 'cc1' | 'cc2' | 'bu'): Promise<Option[]> {
  const data: unknown = kind === 'bu'
    ? await apiJson('/api/accounting/business-units', undefined, 'Could not load the business units.')
    : await apiJson(`/api/accounting/cost-centres?active=true&cc_type=${kind}`, undefined, 'Could not load the cost centres.');
  return items(data).filter((r) => r.isActive !== false)
    .map((r) => ({ id: str(r.id), label: `${str(r.code)} ${str(r.name)}`.trim() })).filter((o) => o.id !== '');
}

/** The registry years (the legacy budgets route's years_only mode, as the workspace reads them) and the year holding today. */
export async function fetchYears(): Promise<{ years: BudgetYear[]; current: number | null }> {
  const data: unknown = await apiJson('/api/accounting/budgets?years_only=1', undefined, 'Could not load the financial years.');
  if (!isObj(data)) return { years: [], current: null };
  return { years: Array.isArray(data.years) ? (data.years as BudgetYear[]) : [], current: typeof data.fiscalYear === 'number' ? data.fiscalYear : null };
}

/** The DRAFT versions of a year (holders are assigned on drafts only). */
export async function fetchDraftVersions(fiscalYear: number): Promise<Option[]> {
  const data = await apiJson(`/api/accounting/budget-versions?fiscalYear=${fiscalYear}`, undefined, 'Could not load the budget versions.');
  const list = 'items' in data ? data.items : [];
  return list.filter((v) => v.status === 'draft').map((v) => ({ id: v.id, label: v.name }));
}
