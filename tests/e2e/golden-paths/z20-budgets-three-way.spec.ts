// golden:dev-only
/**
 * Golden path (z20): the three-way budget (budgets P6 spec §10 acceptance, §13.23) at /accounting/budgets/three-way.
 * Dev only: it needs the `budgets_three_way` flag (dark everywhere but the company it was enabled for) and it
 * WRITES assumptions, so it never runs in the post-deploy production verify (the marker above, helpers/devOnlySpecs.ts).
 *
 * In its own non-primary versions `GP-3W-<runId>` (never the primary): R1 000 a day of sales, nothing else; debtor
 * days 30 → the "Balances ✓" chip and the runway chart → debtor days 60 saved in the Assumptions tab → closing
 * cash in month 3 drops by exactly R30 000 (30 more days × R1 000) → a "Worst" scenario copied from it, debtor
 * days 90 saved as an OVERRIDE through the UI, and a "Best" scenario (15 days, API) → Compare shows the three
 * versions with Δ closing cash −R30 000 and +R45 000 → screenshots light/dark × 1280/390 (at 390 only the grid
 * scrolls sideways) → flag OFF: the page shows its note, the Management Accounting menu has no link, the tab is
 * titled by its parent. Prechecks (flag, owner/admin role, a turnover line) skip with a reason; sweeps stale `GP-`
 * versions; a route guard aborts any budget write outside its own versions; deletes them by id in afterAll.
 * The flag is written only on up.sh's disposable stack (helpers/hostedFeatureFlag.ts, its guards): there it is turned
 * on when off, turned off for the flag-off step, and put back as it was in afterAll. Elsewhere the flag-off step is
 * skipped with an annotation and a flag that is off skips the spec.
 */
import { mkdirSync } from 'fs';
import { test, expect, type Page, type Route } from '@playwright/test';
import { Api, gpRef } from './_api';
import type { BudgetYearsAnswer } from '../helpers/budgetWorkspace';
import type { ThreeWayAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import { cleanUp, created, sweep, type GridAccount, type Version } from '../helpers/budgetDrivers';
import { hostedFlagAvailable, setHostedFlag } from './helpers/hostedFeatureFlag';
import { runAllCleanups } from './helpers/runAllCleanups';

const PAGE = '/accounting/budgets/three-way';
const PER_DAY = 1_000;
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

const daysIn = (m: string): number => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();

async function shoot(page: Page, name: string): Promise<void> {
  const body = await page.screenshot({ fullPage: true });
  await test.info().attach(`${name}.png`, { body, contentType: 'image/png' });
  if (EVIDENCE_DIR) { mkdirSync(EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: `${EVIDENCE_DIR}/three-way-${name}.png`, fullPage: true }); }
}

interface Plan { fiscalYear: number; months: string[]; sales: GridAccount; companyId: string }

const FLAG = 'budgets_three_way';
/** The flag override as it was before this run wrote it (undefined: never written). */
let flagBefore: { companyId: string; enabled: boolean | null } | undefined;

/** The Management Accounting menu's links on the secondary (Accounting) nav, opened by hover. */
async function managementLinks(page: Page): Promise<number> {
  await page.mouse.move(1, 1); // a pointer left on the tab by the last page would fire no new hover
  await page.getByRole('navigation', { name: 'Accounting sections' }).getByText('Management Accounting', { exact: true }).hover();
  await expect(page.getByRole('link', { name: 'Budget Controls' }).first()).toBeVisible();
  return page.locator(`a[href="${PAGE}"]`).count();
}

async function precheck(api: Api): Promise<Plan | string> {
  const companies = await api.get<{ items: { companyId: string; role: string }[]; activeCompanyId: string | null }>('/api/accounting/companies?action=user-companies');
  const companyId = companies.activeCompanyId ?? '';
  const flag = await api.get<{ enabled: boolean }>(`/api/features/check?code=${FLAG}`);
  if (!flag.enabled) {
    if (!hostedFlagAvailable()) return `the ${FLAG} flag is off for this company`;
    flagBefore = { companyId, enabled: await setHostedFlag(companyId, FLAG, true) };
  }
  const role = companies.items.find((c) => c.companyId === companies.activeCompanyId)?.role ?? null;
  if (role !== 'owner' && role !== 'admin') return `the session's role is ${role ?? 'none'}; deleting its versions needs owner/admin`;
  const years = await api.get<BudgetYearsAnswer>('/api/accounting/budgets?years_only=1');
  const grid = await api.get<{ year: { monthKeys: string[] }; accounts: GridAccount[] }>(`/api/accounting/budget-grid?fiscal_year=${years.fiscalYear}`);
  const sales = grid.accounts.find((a) => a.isActive && !a.isHeader && a.band === 'turnover');
  if (!sales) return `${years.fiscalYear}: no active turnover line`;
  if (grid.year.monthKeys.length < 3) return `${years.fiscalYear}: fewer than 3 months`;
  return { fiscalYear: years.fiscalYear, months: grid.year.monthKeys, sales, companyId };
}

/**
 * Aborts any budget write that is not on one of this run's versions. `blocked` rejects on the first (returned in an
 * object: an async function returning the promise itself would adopt it and never resolve).
 */
async function guardWrites(page: Page): Promise<{ blocked: Promise<never> }> {
  let fail: (e: Error) => void = () => undefined;
  const blocked = new Promise<never>((_, reject) => { fail = reject; });
  blocked.catch(() => undefined);
  await page.route(/\/api\/accounting\/budget/, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.continue();
    let body: Record<string, unknown> = {};
    try { body = (req.postDataJSON() ?? {}) as Record<string, unknown>; } catch { body = {}; }
    const id = String(body.version_id ?? body.versionId ?? '');
    if (new URL(req.url()).pathname === '/api/accounting/budget-three-way/assumptions' && created.has(id)) return route.continue();
    fail(new Error(`blocked a budget write outside this run's versions: ${req.method()} ${req.url()}`));
    return route.abort('blockedbyclient');
  });
  return { blocked };
}

type Doc = ThreeWayAssumptions;

/** Debtor days `d`, everything else that moves cash off: no VAT, no statutory payroll, no provisional tax. */
function plainDoc(resolved: Doc, d: number): Doc {
  const m = <T>(value: T) => ({ value, source: 'manual' as const });
  return {
    ...resolved,
    workingCapital: { debtorDays: m(d), creditorDays: m(0), inventoryDays: m(0) },
    vat: { ...resolved.vat, registered: m(false) },
    payroll: { statutoryShare: m(0) },
    incomeTax: { mode: m('off'), topUpMonthOffset: resolved.incomeTax.topUpMonthOffset },
    capex: [], loans: { existing: [], planned: [] }, equity: { shareIssues: [], dividends: [] }, minimumCash: m(0),
  };
}

const cfCents = async (page: Page, row: string, col: string): Promise<number> =>
  Number(await page.locator(`[data-testid="three-way-cf"] tr[data-row="${row}"] td[data-col="${col}"]`).getAttribute('data-cents'));

async function openTab(page: Page, tab: 'bs' | 'cf' | 'assumptions' | 'compare'): Promise<void> {
  await page.getByTestId(`three-way-tab-${tab}`).click();
}

test.afterAll(async ({}, testInfo) => {
  // Each cleanup in its own try (runAllCleanups): a failed flag restore never skips the version delete, nor the reverse.
  await runAllCleanups([
    ['restore the flag override', async () => {
      if (!flagBefore) return;
      const { companyId, enabled } = flagBefore;
      flagBefore = undefined;
      await setHostedFlag(companyId, FLAG, enabled);
    }],
    ['delete the run\'s versions', async () => {
      if (created.size === 0) return;
      const api = await Api.login(testInfo.project.use.baseURL!);
      try {
        const errors = await cleanUp(api);
        if (errors.length > 0) throw new Error(errors.join('; '));
      } finally {
        await api.dispose();
      }
    }],
  ]);
});

test('three-way: balances, debtor days move cash, a scenario override, compare, light/dark 1280/390', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const api = await Api.login(baseURL!);
  try {
    const plan = await precheck(api);
    test.skip(typeof plan === 'string', `three-way precheck: ${String(plan)}`);
    if (typeof plan === 'string') return;
    await sweep(api);

    // The run's base version: R1 000 a day of sales, every month; debtor days 30.
    const runName = gpRef('3W');
    const base = await api.post<Version>('/api/accounting/budget-versions', { fiscalYear: plan.fiscalYear, name: runName, kind: 'scenario' });
    created.add(base.id);
    expect(base).toMatchObject({ isPrimary: false, status: 'draft' });
    const grid = await api.get<{ updatedAt: string }>(`/api/accounting/budget-grid?version_id=${base.id}`);
    await api.post('/api/accounting/budget-grid/save', {
      versionId: base.id, expectedUpdatedAt: grid.updatedAt,
      cells: plan.months.map((month) => ({ glAccountId: plan.sales.id, cc1Id: null, cc2Id: null, buId: null, month, amount: PER_DAY * daysIn(month), clear: false })),
    });
    const read = await api.get<{ resolved: Doc; stored: { updatedAt: string } | null }>(`/api/accounting/budget-three-way/assumptions?version_id=${base.id}`);
    await api.put('/api/accounting/budget-three-way/assumptions', { version_id: base.id, doc: plainDoc(read.resolved, 30), expected_updated_at: read.stored?.updatedAt ?? null });

    const { blocked } = await guardWrites(page);
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.addInitScript(() => window.localStorage.setItem('accounting-theme', 'light'));
    await page.goto(`${PAGE}?version_id=${base.id}`);

    // 1. Balances ✓ and the runway chart.
    await expect(page.getByTestId('balances-chip')).toHaveText('Balances ✓', { timeout: 120_000 });
    await expect(page.getByTestId('runway-chart').locator('canvas').first()).toBeVisible();
    await expect(page.getByTestId('three-way-bs').locator('tr[data-row="check"] td').first()).toHaveText('0');
    await shoot(page, 'bs-light-1280');
    await openTab(page, 'cf');
    const m3 = plan.months[2]!;
    const before = await cfCents(page, 'closingCash', m3);

    // 2. Debtor days 30 → 60 in the Assumptions tab: month-3 closing cash drops by 30 days × R1 000.
    await openTab(page, 'assumptions');
    const days = page.getByLabel('Debtor days');
    await expect(days).toHaveValue('30');
    await days.fill('60');
    await expect(page.getByTestId('source-chip-workingCapital.debtorDays')).toHaveText('Manual');
    const put = page.waitForResponse((r) => r.url().endsWith('/api/accounting/budget-three-way/assumptions') && r.request().method() === 'PUT');
    const rerun = page.waitForResponse((r) => r.url().includes(`/api/accounting/budget-three-way?version_id=${base.id}`));
    await page.getByRole('button', { name: 'Save assumptions' }).click();
    expect((await Promise.race([put, blocked])).status(), 'save debtor days').toBe(200);
    await rerun;
    await shoot(page, 'assumptions-light-1280');
    await openTab(page, 'cf');
    await expect.poll(() => cfCents(page, 'closingCash', m3), { message: 'closing cash month 3 drops by R30 000' }).toBe(before - 30 * PER_DAY * 100);
    await shoot(page, 'cf-light-1280');

    // 3. "Worst": a scenario copied from the base; debtor days 90 saved through the UI as an override.
    const worst = await api.post<Version>(`/api/accounting/budget-versions/${base.id}/copy`, { name: `${runName}-WORST`, kind: 'scenario' });
    created.add(worst.id);
    const best = await api.post<Version>(`/api/accounting/budget-versions/${base.id}/copy`, { name: `${runName}-BEST`, kind: 'scenario' });
    created.add(best.id);
    await api.put('/api/accounting/budget-three-way/assumptions', {
      version_id: best.id, doc: { schemaVersion: 1, overrides: { workingCapital: { debtorDays: { value: 15, source: 'manual' } } } }, expected_updated_at: null,
    });
    await page.goto(`${PAGE}?version_id=${worst.id}`);
    await expect(page.getByTestId('balances-chip')).toHaveText('Balances ✓', { timeout: 120_000 });
    await openTab(page, 'assumptions');
    await expect(page.getByLabel('Debtor days')).toHaveValue('60');
    await page.getByLabel('Debtor days').fill('90');
    const putWorst = page.waitForResponse((r) => r.url().endsWith('/api/accounting/budget-three-way/assumptions') && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save assumptions' }).click();
    const saved = await Promise.race([putWorst, blocked]);
    expect(saved.status(), 'save the override').toBe(200);
    expect(saved.request().postDataJSON().doc, 'a scenario saves overrides, not a full document').toEqual(
      { schemaVersion: 1, overrides: { workingCapital: { debtorDays: { value: 90, source: 'manual' } } } });

    // 4. Compare from the base: three versions, Δ closing cash −R30 000 (Worst) and +R45 000 (Best).
    await page.goto(`${PAGE}?version_id=${base.id}`);
    await expect(page.getByTestId('balances-chip')).toHaveText('Balances ✓', { timeout: 120_000 });
    await openTab(page, 'compare');
    await page.getByLabel(`${runName}-WORST`, { exact: true }).check();
    const cmp = page.waitForResponse((r) => r.url().includes('/api/accounting/budget-three-way/compare') && r.url().includes(best.id));
    await page.getByLabel(`${runName}-BEST`, { exact: true }).check();
    const answer = (await (await cmp).json()).data as { versions: Array<{ versionId: string; kpis: { closingCash: { delta: number } } }> };
    expect(answer.versions.map((v) => v.versionId)).toEqual([base.id, worst.id, best.id]);
    expect(answer.versions.map((v) => v.kpis.closingCash.delta)).toEqual([0, -30 * PER_DAY * 100, 45 * PER_DAY * 100]);
    await expect(page.getByTestId(`delta-closingCash-${worst.id}`)).toHaveText(/\(R\s30\s000\)/);
    await expect(page.getByTestId(`delta-closingCash-${best.id}`)).toHaveText(/\+R\s45\s000/);
    await expect(page.getByTestId('compare-tab').locator('canvas').first()).toBeVisible();
    await shoot(page, 'compare-light-1280');

    // 5. Dark, and 390 px: only the grid scrolls sideways.
    for (const [theme, width] of [['dark', 1280], ['dark', 390], ['light', 390]] as const) {
      // A later init script runs after the first one (which set light), so this one decides the theme.
      await page.addInitScript((t) => window.localStorage.setItem('accounting-theme', t), theme);
      await page.setViewportSize({ width, height: width === 1280 ? 1400 : 900 });
      await page.goto(`${PAGE}?version_id=${base.id}`);
      await expect(page.getByTestId('balances-chip')).toHaveText('Balances ✓', { timeout: 120_000 });
      await expect(page.getByTestId('runway-chart').locator('canvas').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.classList.contains('dark')), `${theme} theme applied`).toBe(theme === 'dark');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `no page-level sideways scroll at ${width}px`).toBeLessThanOrEqual(1);
      if (width === 390) {
        const grid = page.getByTestId('three-way-bs-scroll');
        expect(await grid.evaluate((el) => el.scrollWidth > el.clientWidth), 'the grid scrolls inside itself').toBe(true);
      }
      await shoot(page, `bs-${theme}-${width}`);
      if (width === 1280) {
        await openTab(page, 'compare');
        await page.getByLabel(`${runName}-WORST`, { exact: true }).check();
        await page.getByLabel(`${runName}-BEST`, { exact: true }).check();
        await expect(page.getByTestId(`delta-closingCash-${best.id}`)).toHaveText(/\+R\s45\s000/);
        await shoot(page, `compare-${theme}-${width}`);
      }
    }

    // 6. Flag OFF (disposable stack only): the page's note, no menu link, the tab titled by its parent.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${PAGE}?version_id=${base.id}`);
    await expect(page.getByTestId('balances-chip')).toHaveText('Balances ✓', { timeout: 120_000 });
    expect(await managementLinks(page), 'flag on: the menu links the page').toBeGreaterThan(0);
    await expect(page).toHaveTitle('Three-Way Budget · Accounting · IsaFlow');
    if (!hostedFlagAvailable()) {
      test.info().annotations.push({ type: 'flag-off', description: 'skipped: the flag can only be switched on the disposable stack' });
      return;
    }
    const was = await setHostedFlag(plan.companyId, FLAG, false);
    flagBefore ??= { companyId: plan.companyId, enabled: was };
    await page.goto(`${PAGE}?version_id=${base.id}`);
    await expect(page.getByTestId('three-way-not-enabled')).toBeVisible({ timeout: 120_000 });
    expect(await managementLinks(page), 'flag off: no menu link').toBe(0);
    await expect(page).toHaveTitle(/^Budgets · /);
    expect((await api.getRaw(`/api/accounting/budget-three-way?version_id=${base.id}`)).status, 'flag off: the API refuses').toBe(403);
    await shoot(page, 'flag-off-light-1280');
    await setHostedFlag(plan.companyId, FLAG, true);
  } finally {
    await api.dispose();
  }
});
