// golden:dev-only
/**
 * Golden path (z14): a weekly pay run in the product (master plan wave 6, FQd).
 *
 *  - The employee's Pay frequency field on the work card says Weekly (set through its own route).
 *  - New Payroll Run -> Weekly lists the company's pay weeks with their pay dates; the week containing today is
 *    created from the page (or, when an earlier execution created it, the page shows the named 409 and the spec uses
 *    that run). The runs list labels it "Week <dates>".
 *  - Calculate from the run page, clear R-035 (as z10 does), approve: the weekly employee is on the run, the monthly
 *    one is not, and the run is approved. The run is reopened in `finally` and its journal reversed before the next
 *    calculation, so every execution can approve it again.
 *  - axe 0 critical / 0 serious on the new-run page with the weekly period list and pay-week card open, in both themes,
 *    at 1568 and 390, with no sideways scroll at 390.
 *  - EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Dev only: it writes payroll data in its own sandbox company, never in Demo.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { clearPayRunApproval } from './helpers/payRunApproval';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';
import { formatPayDate, formatPeriodRange, periodsAround, DEFAULT_PAY_WEEK } from '@/modules/accounting/services/payroll/payrollPayWeek';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX_NAME = '0GP Golden Weekly Sandbox';
const SANDBOX_ONBOARDING_ID = 'a3f75c19-0be1-4b8e-beb7-c6b3e639843a';
const WEEKLY = { employeeNumber: 'Z14-W', firstName: 'Wanda', lastName: 'Weekly', salary: 2500 };
const MONTHLY = { employeeNumber: 'Z14-M', firstName: 'Mandla', lastName: 'Monthly', salary: 20000 };
const NEEDS_APPROVER = 'needs a second approver: set E2E_APPROVER_EMAIL / E2E_APPROVER_PASSWORD (an admin of '
  + `"${SANDBOX_NAME}" other than the suite user); without them this company refuses the suite user's self-approval`;

type Run = { id: string; status: string; journalEntryId: string | null; payFrequency: string; periodStart: string | null };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
/** The week holding today, by the default pay week (the sandbox never changes it). */
const thisWeek = () => periodsAround('weekly', DEFAULT_PAY_WEEK, today(), 0, 0)[0]!;

async function person(api: Api, p: typeof WEEKLY, salaryId: string): Promise<string> {
  const existing = await api.get<Array<{ id: string; employeeNumber: string }>>('/api/payroll/employees?limit=50');
  const found = existing.find((e) => e.employeeNumber === p.employeeNumber)?.id;
  if (found) return found;
  const id = (await api.post<{ id: string }>('/api/payroll/employees', {
    employeeNumber: p.employeeNumber, firstName: p.firstName, lastName: p.lastName, employmentType: 'permanent',
    startDate: '2024-01-01', taxNumber: '0123456789',
  })).id;
  await api.post(`/api/payroll/employees/${id}/components`, { componentId: salaryId, amount: p.salary, effectiveFrom: '2024-01-01' });
  return id;
}

async function sandbox(context: BrowserContext, baseURL: string) {
  expect(new URL(baseURL).hostname, 'z14 writes payroll data: dev/CI localhost only').toBe('localhost');
  const api = await Api.login(baseURL);
  const sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  const components = await api.get<Array<{ id: string; name: string }>>('/api/payroll/components');
  const salaryId = components.find((c) => c.name === 'Basic Salary')?.id
    ?? (await api.post<{ id: string }>('/api/payroll/components', { name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning' })).id;
  const weeklyId = await person(api, WEEKLY, salaryId);
  await person(api, MONTHLY, salaryId);
  // Set once, before the employee is on any approved run (a later change is refused mid-tax-year, by design).
  const freq = await api.get<{ payFrequency: string }>(`/api/payroll/employees/${weeklyId}/pay-frequency`);
  if (freq.payFrequency !== 'weekly') await api.put(`/api/payroll/employees/${weeklyId}/pay-frequency`, { payFrequency: 'weekly' });
  return { api, sandboxId, weeklyId };
}

async function snap(page: Page, name: string, theme: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}.png`, fullPage: true });
}

async function seriousAxe(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

async function openWeeklyForm(page: Page): Promise<void> {
  await page.goto('/payroll/runs/new', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'New Payroll Run' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('combobox', { name: 'Pay frequency' }).click();
  await page.getByRole('option', { name: 'Weekly' }).click();
  await expect(page.getByTestId('pay-week-card')).toBeVisible({ timeout: 30_000 });
  await settle(page);
}

/** The run for this week, created from the page; an earlier execution's run is met with the page's named 409. */
async function weeklyRunFromPage(page: Page, api: Api): Promise<string> {
  const week = thisWeek();
  await openWeeklyForm(page);
  await page.getByRole('combobox', { name: /^Period/ }).click();
  await page.getByRole('option', { name: `${formatPeriodRange(week.periodStart, week.periodEnd)} (paid ${formatPayDate(week.payDate)})` }).click();
  await page.getByRole('button', { name: 'Create Run' }).click();
  const existing = (await api.get<Run[]>('/api/payroll/runs')).find((r) => r.payFrequency === 'weekly' && r.periodStart === week.periodStart);
  await Promise.race([
    page.waitForURL(/\/payroll\/runs\/[0-9a-f-]{36}$/, { timeout: 60_000 }),
    expect(page.getByText(`A weekly payroll run for ${week.periodStart} already exists.`)).toBeVisible({ timeout: 60_000 }),
  ]);
  const runs = await api.get<Run[]>('/api/payroll/runs');
  const run = runs.find((r) => r.payFrequency === 'weekly' && r.periodStart === week.periodStart);
  expect(run, 'the weekly run exists').toBeTruthy();
  if (existing) expect(run!.id).toBe(existing.id);
  return run!.id;
}

test('a weekly run: frequency on the employee, created per period from the page, calculated and approved', async ({ page, context, baseURL }) => {
  const { api, sandboxId, weeklyId } = await sandbox(context, baseURL!);
  let runId = '';
  let approved = false;
  try {
    await page.goto(`/payroll/employees/${weeklyId}`, { waitUntil: 'domcontentloaded' });
    const field = page.getByTestId('pay-frequency-field');
    await expect(field.getByRole('combobox', { name: 'Pay frequency' })).toContainText('Weekly', { timeout: 60_000 });

    runId = await weeklyRunFromPage(page, api);
    const run = await api.get<Run>(`/api/payroll/runs/${runId}`);
    if (run.status === 'approved') await api.post(`/api/payroll/runs/${runId}/reopen`, { reason: 'z14 golden sandbox reset' });
    if (run.journalEntryId) {
      const journal = await api.get<{ status: string; reversedAt: string | null }>(`/api/accounting/journal-entries-detail?id=${run.journalEntryId}`);
      if (journal.status === 'posted' && !journal.reversedAt) {
        await api.post('/api/accounting/journal-entries-action', { id: run.journalEntryId, action: 'reverse' });
      }
    }

    const week = thisWeek();
    await page.goto(`/payroll/runs/${runId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: `Payroll Run — Week ${formatPeriodRange(week.periodStart, week.periodEnd)}` }))
      .toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Calculate' }).click();
    await expect(page.getByText(`${WEEKLY.firstName} ${WEEKLY.lastName}`).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(`${MONTHLY.firstName} ${MONTHLY.lastName}`)).toHaveCount(0);
    await snap(page, 'weekly-run-calculated', 'session-theme');

    const clearance = await clearPayRunApproval(api, baseURL!, runId, { reportSelfRefusal: true }).catch((err: Error) => {
      if (!/not a member/.test(err.message)) throw err;
      throw new Error(`${process.env.E2E_APPROVER_EMAIL} is not a member of "${SANDBOX_NAME}" (${sandboxId}). One-time manual dev `
        + 'setup: add it to that company as an admin (company_users) on isaflow_dev; this spec cannot. ' + err.message);
    });
    test.skip(clearance === 'self-approval-refused', NEEDS_APPROVER);
    const plan = await api.get<{ planHash: string }>(`/api/payroll/runs/${runId}/journal-plan`);
    expect((await api.post<Run>(`/api/payroll/runs/${runId}/approve`, { expectedPlanHash: plan.planHash })).status).toBe('approved');
    approved = true;

    await page.goto('/payroll/runs', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(`Week ${formatPeriodRange(week.periodStart, week.periodEnd)}`).first()).toBeVisible({ timeout: 60_000 });
    await snap(page, 'weekly-run-listed', 'session-theme');
  } finally {
    if (approved) await api.post(`/api/payroll/runs/${runId}/reopen`, { reason: 'z14 golden sandbox reset' });
    await api.dispose();
  }
});

for (const theme of THEMES) {
  test(`no serious axe violation on the weekly new-run form, at 1568 and 390 (${theme})`, async ({ page, context, baseURL }) => {
    const { api } = await sandbox(context, baseURL!);
    await api.dispose();
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await openWeeklyForm(page);
    expect(await seriousAxe(page)).toEqual([]);
    await snap(page, 'weekly-new-run-1568', theme);

    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(width.scroll, 'the page must not scroll sideways').toBeLessThanOrEqual(width.client);
    expect(await seriousAxe(page)).toEqual([]);
    await snap(page, 'weekly-new-run-390', theme);
  });
}
