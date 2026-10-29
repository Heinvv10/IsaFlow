/**
 * Shared by golden-paths/z-budget-drivers (budgets P4 spec §8 T7): the precheck (no writes), the stale `GP-` sweep,
 * the delete of this run's own versions (re-read first: non-primary, unlocked, `GP-` named), and the route guard
 * that aborts any budget write the page sends outside this run's own versions (budgets contract, golden-spec write
 * rule: docs/plans/budgets/00-shared-contract.md "Golden specs and prod verify").
 */
import { test, type Page, type Route } from '@playwright/test';
import { type Api, ApiError } from '../golden-paths/_api';
import type { BudgetYearsAnswer } from './budgetWorkspace';

export interface Version { id: string; fiscalYear: number; name: string; kind: string; status: string; isPrimary: boolean }
export interface GridAccount { id: string; code: string; name: string; band: string; isActive: boolean; isHeader: boolean }
interface GridRead { year: { monthKeys: string[] }; accounts: GridAccount[] }
interface Period { startDate: string; status: string }

export interface DriverPlan {
  fiscalYear: number;
  months: string[];
  sales: GridAccount;
  cogs: GridAccount;
  salaries: GridAccount;
  /** The year's months whose fiscal periods are closed or locked (step 5 needs one; the spec never closes one). */
  closedMonths: string[];
}

/** Versions this run created and has not yet deleted, in creation order. */
export const created = new Set<string>();

/** Deletes one GP- version after re-reading it: never a primary, a locked or a foreign-named one. 404 = already gone. */
export async function deleteGpVersion(api: Api, id: string): Promise<void> {
  const res = await api.getRaw(`/api/accounting/budget-versions/${id}`);
  if (res.status === 404) { created.delete(id); return; }
  const v = res.json?.data as Version | undefined;
  if (res.status !== 200 || !v) throw new Error(`could not read version ${id}: ${res.status}`);
  if (v.isPrimary || !v.name.startsWith('GP-') || v.status === 'locked') {
    throw new Error(`refusing to delete version ${id} ("${v.name}", primary=${v.isPrimary}, ${v.status})`);
  }
  try {
    await api.del(`/api/accounting/budget-versions/${id}`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  created.delete(id);
}

/** Deletes this run's versions, newest first (a reforecast before the version it is based on); returns what failed. */
export async function cleanUp(api: Api): Promise<string[]> {
  const errors: string[] = [];
  for (const id of [...created].reverse()) {
    try { await deleteGpVersion(api, id); } catch (err) { errors.push(`delete ${id}: ${(err as Error).message}`); }
  }
  return errors;
}

/** A crashed run's leftovers: unlocked, non-primary `GP-` versions in any year; newest first. A locked one is reported. */
export async function sweep(api: Api): Promise<void> {
  const { items } = await api.get<{ items: Version[] }>('/api/accounting/budget-versions');
  for (const v of items.filter((x) => x.name.startsWith('GP-') && !x.isPrimary).reverse()) {
    if (v.status === 'locked') {
      test.info().annotations.push({ type: 'sweep', description: `left locked GP version ${v.id} "${v.name}" alone` });
      continue;
    }
    await deleteGpVersion(api, v.id);
    test.info().annotations.push({ type: 'sweep', description: `deleted stale ${v.status} version "${v.name}" (${v.fiscalYear})` });
  }
}

const line = (accounts: GridAccount[], band: string, prefer?: RegExp): GridAccount | undefined => {
  const lines = accounts.filter((a) => a.isActive && !a.isHeader && a.band === band);
  return (prefer ? lines.find((a) => prefer.test(a.name)) : undefined) ?? lines[0];
};

/** The precheck (no writes): the plan, or why this environment cannot run the spec. */
export async function precheck(api: Api): Promise<DriverPlan | string> {
  const companies = await api.get<{ items: { companyId: string; role: string }[]; activeCompanyId: string | null }>(
    '/api/accounting/companies?action=user-companies');
  const role = companies.items.find((c) => c.companyId === companies.activeCompanyId)?.role ?? null;
  if (role !== 'owner' && role !== 'admin') return `the session's role is ${role ?? 'none'}; deleting an approved version needs owner/admin`;

  const years = await api.get<BudgetYearsAnswer>('/api/accounting/budgets?years_only=1');
  const periods = await api.get<Period[]>('/api/accounting/fiscal-periods');
  const reasons: string[] = [];
  for (const fiscalYear of [years.fiscalYear, ...years.years.map((y) => y.fiscalYear).filter((y) => y !== years.fiscalYear)].slice(0, 3)) {
    const { items } = await api.get<{ items: Version[] }>(`/api/accounting/budget-versions?fiscalYear=${fiscalYear}`);
    if (items.length === 0) { reasons.push(`${fiscalYear}: no version yet (a first version would be the year's original)`); continue; }
    const grid = await api.get<GridRead>(`/api/accounting/budget-grid?fiscal_year=${fiscalYear}`);
    const sales = line(grid.accounts, 'turnover', /sales/i);
    const cogs = line(grid.accounts, 'cost_of_sales');
    const salaries = line(grid.accounts, 'operating_expense', /salar|wage|staff/i);
    if (!sales || !cogs || !salaries) { reasons.push(`${fiscalYear}: needs an active turnover, cost-of-sales and operating-expense line`); continue; }
    // By date, as the reforecast reads it (legacy period labels can differ from the budget year's).
    const months = grid.year.monthKeys;
    const closed = new Set(periods.filter((p) => p.status === 'closed' || p.status === 'locked').map((p) => p.startDate.slice(0, 7)));
    // Only the reforecast reads them: the GP scenario holds no actuals, so all its months take typing.
    const closedMonths = months.filter((m) => closed.has(m));
    return { fiscalYear, months, sales, cogs, salaries, closedMonths };
  }
  return `no usable financial year (${reasons.join('; ')})`;
}

/**
 * Aborts any budget write the page sends other than this run's own: saves, driver / override / hire / headcount
 * writes on a version in `created`, and a reforecast from one of them named `<runName>…`, never rolling. `blocked`
 * rejects on the first blocked write, so a step waiting on that write fails at once (race it).
 */
export async function guardBudgetWrites(page: Page, runName: string): Promise<{ blocked: Promise<never>; violations: string[] }> {
  const violations: string[] = [];
  let fail: (err: Error) => void = () => undefined;
  const blocked = new Promise<never>((_, reject) => { fail = reject; });
  blocked.catch(() => undefined);
  await page.route(/\/api\/accounting\/budget/, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.continue();
    const url = new URL(req.url());
    let body: Record<string, unknown> = {};
    try { body = (req.postDataJSON() ?? {}) as Record<string, unknown>; } catch { body = { unreadable: req.postData()?.slice(0, 80) }; }
    const versionId = String(body.versionId ?? url.searchParams.get('versionId'));
    const reforecast = /^\/api\/accounting\/budget-versions\/([0-9a-f-]{36})\/reforecast$/.exec(url.pathname);
    const ok = (/^\/api\/accounting\/budget-(grid\/save|drivers(\/override|\/headcount|\/planned-hires)?)$/.test(url.pathname) && created.has(versionId))
      || (reforecast !== null && created.has(reforecast[1]!) && req.method() === 'POST'
        && typeof body.name === 'string' && body.name.startsWith(runName) && body.rolling === false && !('action' in body));
    if (ok) return route.continue();
    violations.push(`${req.method()} ${url.pathname}${url.search} ${JSON.stringify(body).slice(0, 200)}`);
    fail(new Error(`blocked a budget write outside this run's own versions: ${violations.at(-1)}`));
    return route.abort('blockedbyclient');
  });
  return { blocked, violations };
}
