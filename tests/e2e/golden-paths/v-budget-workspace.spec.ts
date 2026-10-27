/**
 * Golden path (v): the budget workspace (budgets P2 spec §14 E2E) at /accounting/budgets/workspace.
 *
 * Wizard (prior-year actuals +10%, rounded to R1000, a non-primary scenario `GP-<runId>`) → one account's FY is
 * roundToUnit(PY × 1.1) → a one-row, 12-month TSV pasted on that account's first month → 12 dirty cells, GP and NP
 * move by exactly the pasted change → Ctrl+S → Approve → reload → Approved and the pasted months persisted.
 *
 * It runs in prod post-deploy verify against Demo (scripts/verify-deploy.sh), so it obeys the budgets contract's
 * golden-spec write rule (docs/plans/budgets/00-shared-contract.md):
 *   - prechecks through the API BEFORE any write (owner/admin role; a year that already has a version, so the new one
 *     can be a non-primary scenario; a turnover / cost-of-sales line with prior-year actuals) and skips with a reason;
 *   - sweeps stale unlocked non-primary `GP-` versions first (a crashed run's leftovers), then writes only its own
 *     version: a route guard aborts any other budget write the page attempts (seed must be a non-primary scenario
 *     with this run's name; saves and status moves only on the version this run created; approve only, never lock);
 *   - deletes its version by id in a `finally` and again in `afterAll`, after re-reading it as non-primary, unlocked
 *     and `GP-` named. The approve's audit row stays (accepted by the contract).
 * The paste is ONE row with 12 tab-separated values: a 12-row column pastes DOWN the accounts, not across months.
 * axe is report-only (annotations + an attached JSON, never a failure). Screenshots: light + dark at 1280 and 390,
 * attached to the report, and written to EVIDENCE_DIR when it is set.
 */
import { mkdirSync } from 'fs';
import { test, expect, type Page, type Route } from '@playwright/test';
import { Api, ApiError, gpRef } from './_api';
import {
  accountRow, cellCents, openWorkspace, pasteTsv, pickYearAndVersion, rowCell, totalFyCell, upliftTarget, waitForGrid, type BudgetYearsAnswer,
} from '../helpers/budgetWorkspace';

const UPLIFT_PCT = 10;
const UNIT = 1000;
const PASTE_MONTHS = 12;
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

interface Version { id: string; fiscalYear: number; name: string; kind: string; status: string; isPrimary: boolean }
interface GridAccount { id: string; code: string; name: string; band: string; isActive: boolean; isHeader: boolean }
interface GridRead { version: Version | null; year: { monthKeys: string[] }; accounts: GridAccount[]; cells: { glAccountId: string; cc1Id: string | null; cc2Id: string | null; buId: string | null; month: string; amount: number }[] }
interface Plan { fiscalYear: number; months: string[]; account: GridAccount; pyCents: number; expectedFyCents: number }

/** Versions this run created and has not yet deleted. */
const created = new Set<string>();

const toCents = (rand: number): number => Math.round(rand * 100);

/** Deletes one GP- version after re-reading it: never a primary, a locked or a foreign-named one. 404 = already gone. */
async function deleteGpVersion(api: Api, id: string): Promise<void> {
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
    // A concurrent cleanup (the finally of a timed-out test runs beside afterAll) got there first.
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  created.delete(id);
}

/** Deletes every version this run created; returns what failed (empty = clean). */
async function cleanUp(api: Api): Promise<string[]> {
  const errors: string[] = [];
  for (const id of [...created]) {
    try { await deleteGpVersion(api, id); } catch (err) { errors.push(`delete ${id}: ${(err as Error).message}`); }
  }
  return errors;
}

/** A crashed run's leftovers: unlocked, non-primary `GP-` versions in any year. A locked one is reported, not touched. */
async function sweep(api: Api): Promise<void> {
  const { items } = await api.get<{ items: Version[] }>('/api/accounting/budget-versions');
  for (const v of items.filter((x) => x.name.startsWith('GP-') && !x.isPrimary)) {
    if (v.status === 'locked') {
      test.info().annotations.push({ type: 'sweep', description: `left locked GP version ${v.id} "${v.name}" alone` });
      continue;
    }
    await deleteGpVersion(api, v.id);
    test.info().annotations.push({ type: 'sweep', description: `deleted stale ${v.status} version "${v.name}" (${v.fiscalYear})` });
  }
}

/** The precheck (no writes): the plan, or why this environment cannot run the spec. */
async function precheck(api: Api): Promise<Plan | string> {
  const companies = await api.get<{ items: { companyId: string; role: string }[]; activeCompanyId: string | null }>(
    '/api/accounting/companies?action=user-companies');
  const role = companies.items.find((c) => c.companyId === companies.activeCompanyId)?.role ?? null;
  if (role !== 'owner' && role !== 'admin') return `the session's role is ${role ?? 'none'}; deleting an approved version needs owner/admin`;

  const years = await api.get<BudgetYearsAnswer>('/api/accounting/budgets');
  const candidates = [years.fiscalYear, ...years.years.map((y) => y.fiscalYear).filter((y) => y !== years.fiscalYear)].slice(0, 3);
  const reasons: string[] = [];
  for (const fiscalYear of candidates) {
    const { items } = await api.get<{ items: Version[] }>(`/api/accounting/budget-versions?fiscalYear=${fiscalYear}`);
    if (items.length === 0) { reasons.push(`${fiscalYear}: no version yet (a first version would be the year's original)`); continue; }
    const grid = await api.get<GridRead>(`/api/accounting/budget-grid?fiscal_year=${fiscalYear}`);
    if (grid.year.monthKeys.length < PASTE_MONTHS) { reasons.push(`${fiscalYear}: ${grid.year.monthKeys.length} months`); continue; }
    const prior = await api.get<{ cells: { glAccountId: string; dimensionId: string | null; amount: number }[] }>(
      `/api/accounting/budget-grid/prior-actuals?fiscal_year=${fiscalYear}&grain=company`);
    const py = new Map<string, number>();
    for (const c of prior.cells) py.set(c.glAccountId, (py.get(c.glAccountId) ?? 0) + toCents(c.amount));
    const lines = grid.accounts.filter((a) => a.isActive && !a.isHeader && (a.band === 'turnover' || a.band === 'cost_of_sales'));
    const scored = lines.map((a) => ({ a, py: py.get(a.id) ?? 0 }))
      .filter((x) => upliftTarget(x.py, UPLIFT_PCT, UNIT) !== 0)
      .sort((x, y) => Number(y.a.band === 'turnover') - Number(x.a.band === 'turnover') || Math.abs(y.py) - Math.abs(x.py));
    const pick = scored[0];
    if (!pick) { reasons.push(`${fiscalYear}: no turnover / cost-of-sales line with prior-year actuals`); continue; }
    return { fiscalYear, months: grid.year.monthKeys, account: pick.a, pyCents: pick.py, expectedFyCents: upliftTarget(pick.py, UPLIFT_PCT, UNIT) };
  }
  return `no usable financial year (${reasons.join('; ')})`;
}

/**
 * Aborts any budget write the page sends other than this run's own (contract write rule). Seed: a non-primary
 * scenario named `runName`. Save and status: only a version in `created`; status: approve only. `blocked` rejects on
 * the first blocked write, so a step waiting on that write fails at once (race it), not at the timeout.
 */
async function guardBudgetWrites(page: Page, runName: string): Promise<{ blocked: Promise<never>; violations: string[] }> {
  const violations: string[] = [];
  let fail: (err: Error) => void = () => undefined;
  const blocked = new Promise<never>((_, reject) => { fail = reject; });
  blocked.catch(() => undefined); // raced by the steps; never an unhandled rejection
  await page.route(/\/api\/accounting\/budget/, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.continue();
    const path = new URL(req.url()).pathname;
    let body: Record<string, unknown> = {};
    try { body = (req.postDataJSON() ?? {}) as Record<string, unknown>; } catch { body = { unreadable: req.postData()?.slice(0, 80) }; }
    const statusOf = /^\/api\/accounting\/budget-versions\/([0-9a-f-]{36})\/status$/.exec(path);
    const ok = (path === '/api/accounting/budget-grid/seed' && body.makePrimary === false && body.kind === 'scenario' && body.name === runName)
      || (path === '/api/accounting/budget-grid/save' && created.has(String(body.versionId)))
      || (statusOf !== null && created.has(statusOf[1]!) && body.action === 'approve');
    if (ok) return route.continue();
    violations.push(`${req.method()} ${path} ${JSON.stringify(body).slice(0, 200)}`);
    fail(new Error(`blocked a budget write outside this run's own version: ${violations.at(-1)}`));
    return route.abort('blockedbyclient');
  });
  return { blocked, violations };
}

/** axe over the workspace, report-only: serious/critical rules as annotations, the full result attached. */
async function axeReport(page: Page, tag: string): Promise<void> {
  const info = test.info();
  let AxeBuilder: (typeof import('@axe-core/playwright'))['default'];
  try {
    AxeBuilder = (await import('@axe-core/playwright')).default;
  } catch (err) {
    info.annotations.push({ type: 'a11y-report', description: `${tag}: not run, @axe-core/playwright did not load (${String(err).slice(0, 120)})` });
    return;
  }
  const results = await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  await info.attach(`axe-${tag}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  info.annotations.push({
    type: 'a11y-report',
    description: `${tag}: ${serious.length === 0 ? 'no serious/critical violations' : serious.map((v) => `[${v.impact}] ${v.id} ×${v.nodes.length}`).join(', ')}`,
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  const body = await page.screenshot({ fullPage: false });
  await test.info().attach(`${name}.png`, { body, contentType: 'image/png' });
  if (EVIDENCE_DIR) { mkdirSync(EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: `${EVIDENCE_DIR}/budget-workspace-${name}.png` }); }
}

test.afterAll(async ({}, testInfo) => {
  if (created.size === 0) return;
  const api = await Api.login(testInfo.project.use.baseURL!);
  try {
    const errors = await cleanUp(api);
    if (errors.length > 0) throw new Error(`budget workspace cleanup: ${errors.join('; ')}`);
  } finally {
    await api.dispose();
  }
});

test('budget workspace: PY+10% scenario → paste a year → save → approve → reload persists', async ({ page, baseURL }) => {
  test.setTimeout(120_000); // ~10x a warm local run (7-10 s); a cold `next dev` compile adds ~10 s
  const api = await Api.login(baseURL!);
  let failed = true;
  try {
    const plan = await precheck(api);
    test.skip(typeof plan === 'string', `budget workspace precheck: ${String(plan)}`);
    if (typeof plan === 'string') return;
    await sweep(api);

    const runName = gpRef('BWS');
    const { blocked, violations } = await guardBudgetWrites(page, runName);
    page.on('response', (r) => {
      if (!r.url().endsWith('/api/accounting/budget-grid/seed') || r.status() !== 201 && r.status() !== 200) return;
      void r.json().then((j: { data?: { versionId?: string } }) => { if (j.data?.versionId) created.add(j.data.versionId); }, () => undefined);
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => window.localStorage.setItem('accounting-theme', 'light'));
    await openWorkspace(page, { fiscalYear: plan.fiscalYear });

    // 2. Wizard: prior-year actuals +10%, R1000, scenario, not primary.
    await page.getByTestId('version-actions').getByRole('button', { name: 'New reforecast' }).click();
    const wizard = page.getByRole('dialog', { name: 'New budget version' });
    await wizard.getByLabel('Name').fill(runName);
    await expect(wizard.getByLabel('Kind')).toBeEnabled();
    await wizard.getByLabel('Kind').selectOption('scenario');
    const primary = wizard.getByLabel('Make primary');
    if (await primary.count()) await expect(primary).not.toBeChecked();
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByLabel('Prior-year actuals').check();
    await wizard.getByLabel('Uplift (%)').fill(String(UPLIFT_PCT));
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByLabel('Round each month to').selectOption(String(UNIT));
    const seeded = page.waitForResponse((r) => r.url().endsWith('/api/accounting/budget-grid/seed'));
    await wizard.getByRole('button', { name: 'Create' }).click();
    const seedRes = await Promise.race([seeded, blocked]);
    expect(seedRes.status(), `the seed created the version: ${await seedRes.text()}`).toBeLessThan(300);
    const versionId = ((await seedRes.json()) as { data: { versionId: string } }).data.versionId;
    created.add(versionId);
    await expect(wizard).toBeHidden({ timeout: 60_000 });
    await waitForGrid(page, versionId);

    const v = await api.get<GridRead>(`/api/accounting/budget-grid?version_id=${versionId}`);
    expect(v.version, 'the new version is a non-primary draft scenario with this run\'s name').toMatchObject({ name: runName, kind: 'scenario', status: 'draft', isPrimary: false });

    // 3. One account's FY = roundToUnit(PY × 1.1), on screen and in the version.
    const row = accountRow(page, plan.account.id);
    const n = plan.months.length;
    await expect.poll(() => cellCents(rowCell(row, n)), { message: `${plan.account.code} FY = roundToUnit(PY ${plan.pyCents / 100} × 1.1, R${UNIT})` })
      .toBe(plan.expectedFyCents);
    const held = v.cells.filter((c) => c.glAccountId === plan.account.id && !c.cc1Id && !c.cc2Id && !c.buId);
    expect(held.reduce((s, c) => s + toCents(c.amount), 0)).toBe(plan.expectedFyCents);
    await shoot(page, 'seeded-light-1280');

    // 4–5. Paste one row of 12 months on the account's first month: 12 dirty cells, GP and NP move by the change.
    const before = await Promise.all(Array.from({ length: PASTE_MONTHS }, (_, c) => cellCents(rowCell(row, c))));
    const gp0 = await cellCents(totalFyCell(page, 'Gross profit'));
    const np0 = await cellCents(totalFyCell(page, 'Net profit'));
    const pasted = Array.from({ length: PASTE_MONTHS }, (_, i) => 12_345 + i * 7);
    await rowCell(row, 0).click();
    await expect(rowCell(row, 0)).toBeFocused();
    const took = await pasteTsv(page, `${pasted.join('\t')}\r\n`);
    expect(took.defaultPrevented, `the grid took the paste (target ${took.target})`).toBe(true);
    await expect(page.locator('td[data-dirty="true"]')).toHaveCount(PASTE_MONTHS);
    await expect(row.locator('td[data-dirty="true"]')).toHaveCount(PASTE_MONTHS);
    const change = pasted.reduce((s, p, i) => s + p * 100 - (before[i] ?? 0), 0);
    const sign = plan.account.band === 'turnover' ? 1 : -1;
    await expect.poll(() => cellCents(totalFyCell(page, 'Gross profit'))).toBe((gp0 ?? 0) + sign * change);
    await expect.poll(() => cellCents(totalFyCell(page, 'Net profit'))).toBe((np0 ?? 0) + sign * change);
    await shoot(page, 'pasted-light-1280');

    // 6. Ctrl+S.
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/accounting/budget-grid/save'));
    await page.keyboard.press('Control+s');
    expect((await Promise.race([saved, blocked])).status(), 'save').toBe(200);
    await expect(page.getByTestId('save-bar-status')).toContainText('Saved');
    await expect(page.locator('td[data-dirty="true"]')).toHaveCount(0);

    // 7. Approve (never lock: a locked version cannot be deleted).
    await page.getByTestId('version-approve').click();
    const dialog = page.getByTestId('version-dialog-approve');
    const approved = page.waitForResponse((r) => r.url().endsWith(`/api/accounting/budget-versions/${versionId}/status`));
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
    expect((await Promise.race([approved, blocked])).status(), 'approve').toBe(200);
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    await expect(page.getByTestId('version-status-chip')).toHaveText('Approved, edits are audited');

    // 8–9. Reload: still approved, the pasted months held.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await pickYearAndVersion(page, { fiscalYear: plan.fiscalYear, versionId });
    await expect(page.getByTestId('version-status-chip')).toHaveText('Approved, edits are audited');
    const after = await Promise.all(pasted.map((_, c) => cellCents(rowCell(accountRow(page, plan.account.id), c))));
    expect(after, 'the pasted months persisted').toEqual(pasted.map((p) => p * 100));
    const stored = await api.get<GridRead>(`/api/accounting/budget-grid?version_id=${versionId}`);
    expect(stored.version?.status).toBe('approved');
    const byMonth = new Map(stored.cells.filter((c) => c.glAccountId === plan.account.id && !c.cc1Id && !c.cc2Id && !c.buId).map((c) => [c.month, toCents(c.amount)]));
    expect(plan.months.slice(0, PASTE_MONTHS).map((m) => byMonth.get(m))).toEqual(pasted.map((p) => p * 100));

    // Screens + axe (report-only): light and dark, 1280 and 390.
    await shoot(page, 'approved-light-1280');
    await axeReport(page, 'light-1280');
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot(page, 'approved-light-390');
    await page.addInitScript(() => window.localStorage.setItem('accounting-theme', 'dark'));
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkspace(page, { fiscalYear: plan.fiscalYear, versionId });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await shoot(page, 'approved-dark-1280');
    await axeReport(page, 'dark-1280');
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot(page, 'approved-dark-390');

    expect(violations, 'the page attempted no budget write outside this run\'s own version').toEqual([]);
    failed = false;
  } finally {
    const errors = await cleanUp(api);
    await api.dispose();
    // A failed step's error stands; a clean run whose cleanup failed is a failure (it would leave a GP version).
    if (errors.length > 0) {
      test.info().annotations.push({ type: 'cleanup', description: errors.join('; ') });
      if (!failed) throw new Error(`budget workspace cleanup: ${errors.join('; ')}`);
    }
  }
});
