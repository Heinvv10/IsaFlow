// golden:dev-only
/**
 * Golden path (z29): IRP5/EMP501 pre-validation (master plan wave 6, PV).
 *
 *  - Run approval: an employee with no ID number is on a calculated, R-035-cleared run. The approve dialog lists
 *    "Missing ID/passport number" for them as an IRP5 warning, and Approve stays enabled (never a block).
 *  - Approved from the dialog, the run is final: the compliance hub's pre-validation card lists the employee with
 *    "Fix: ID number", which opens the profile at the ID number field; the profile carries the one IRP5 line.
 *  - axe reports 0 critical and 0 serious on the card, in both themes, at 1568 and 390; 390 does not scroll sideways.
 *  - Cleared as z10 does (clearPayRunApproval): where self-approval is refused and no second approver is set, the
 *    approval test is SKIPPED with the reason. Never a faked approval. The axe test runs either way.
 *  - EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Dev only: it writes payroll data and posts a payroll journal, in its own sandbox company, never in Demo. Its one
 * run (Oct 2026) is reopened in `finally` and its journal reversed before the next calculation.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { clearPayRunApproval } from './helpers/payRunApproval';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX = { name: '0GP Golden Pre-validation Sandbox', onboardingId: '5d1a9c3e-7b24-4f86-a0c9-3e8b6d2f1a47' };
const RUN = { month: 10, year: 2026 };
const EMPLOYEE = { employeeNumber: 'Z29-1', firstName: 'Zanele', lastName: 'Check', salary: 28000 };
const NAME = `${EMPLOYEE.firstName} ${EMPLOYEE.lastName}`;
const MISSING_ID = 'Missing ID/passport number';
const NEEDS_APPROVER = 'needs a second approver: set E2E_APPROVER_EMAIL / E2E_APPROVER_PASSWORD (an admin of '
  + `"${SANDBOX.name}" other than the suite user); without them this company refuses the suite user's self-approval`;

type Run = { id: string; periodMonth: number; periodYear: number; status: string; journalEntryId: string | null };

/** The sandbox's employee (tax number, no ID number) and its calculated October run, reset from any earlier execution. */
async function sandboxRun(api: Api): Promise<{ runId: string; employeeId: string }> {
  const components = await api.get<Array<{ id: string; name: string }>>('/api/payroll/components');
  const salaryId = components.find((c) => c.name === 'Basic Salary')?.id
    ?? (await api.post<{ id: string }>('/api/payroll/components', { name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning' })).id;
  const existing = await api.get<Array<{ id: string; employeeNumber: string }>>('/api/payroll/employees?limit=50');
  let employeeId = existing.find((e) => e.employeeNumber === EMPLOYEE.employeeNumber)?.id;
  if (!employeeId) {
    employeeId = (await api.post<{ id: string }>('/api/payroll/employees', {
      employeeNumber: EMPLOYEE.employeeNumber, firstName: EMPLOYEE.firstName, lastName: EMPLOYEE.lastName,
      employmentType: 'permanent', startDate: '2024-01-01', taxNumber: '0123456789',
    })).id;
    await api.post(`/api/payroll/employees/${employeeId}/components`, { componentId: salaryId, amount: EMPLOYEE.salary, effectiveFrom: '2024-01-01' });
    await api.put(`/api/payroll/employees/${employeeId}/bank-details`, {
      bankName: 'FNB', branchCode: '250655', accountNumber: '62000129876', accountType: 'cheque', accountHolder: NAME,
    });
  }
  const runs = await api.get<Run[]>('/api/payroll/runs');
  const runId = runs.find((r) => r.periodMonth === RUN.month && r.periodYear === RUN.year)?.id
    ?? (await api.post<Run>('/api/payroll/runs', RUN)).id;
  const run = await api.get<Run>(`/api/payroll/runs/${runId}`);
  if (run.status === 'approved') await api.post(`/api/payroll/runs/${runId}/reopen`, { reason: 'z29 golden sandbox reset' });
  if (run.journalEntryId) {
    const journal = await api.get<{ status: string; reversedAt: string | null }>(`/api/accounting/journal-entries-detail?id=${run.journalEntryId}`);
    if (journal.status === 'posted' && !journal.reversedAt) {
      await api.post('/api/accounting/journal-entries-action', { id: run.journalEntryId, action: 'reverse' });
    }
  }
  await api.post(`/api/payroll/runs/${runId}/calculate`);
  return { runId, employeeId };
}

async function sandbox(context: BrowserContext, baseURL: string) {
  const u = new URL(baseURL);
  expect(u.hostname === 'localhost' && u.port !== '3101', `z29 writes payroll data: dev/CI localhost only, not ${u.host}`).toBe(true);
  const api = await Api.login(baseURL);
  const sandboxId = await findOrCreateSandbox(api, SANDBOX);
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  return { api, sandboxId, ...(await sandboxRun(api)) };
}

async function snap(page: Page, name: string, theme: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}.png`, fullPage: true });
}

async function seriousAxe(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

async function openCompliance(page: Page): Promise<void> {
  await page.goto('/payroll/compliance', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'IRP5 / EMP501 pre-validation' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('pre-validation-summary')).toBeVisible({ timeout: 60_000 });
  await settle(page);
}

test('run approval lists the IRP5 warning without blocking; once final, the card links to the field', async ({ page, context, baseURL }) => {
  test.setTimeout(240_000);
  const { api, sandboxId, runId, employeeId } = await sandbox(context, baseURL!);
  let approved = false;
  try {
    const clearance = await clearPayRunApproval(api, baseURL!, runId, { reportSelfRefusal: true }).catch((err: Error) => {
      if (!/not a member/.test(err.message)) throw err;
      throw new Error(`${process.env.E2E_APPROVER_EMAIL} is not a member of "${SANDBOX.name}" (${sandboxId}). One-time manual dev `
        + 'setup: add it to that company as an admin (company_users) on isaflow_dev; this spec cannot. ' + err.message);
    });
    test.skip(clearance === 'self-approval-refused', NEEDS_APPROVER);

    await page.goto(`/payroll/runs/${runId}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Post approved run — Review & approve' }).click({ timeout: 60_000 });
    const dialog = page.getByRole('dialog', { name: 'Approve payroll — Oct 2026' });
    const warnings = dialog.getByTestId('pre-validation-run-warnings');
    await expect(warnings).toContainText(`${NAME}: ${MISSING_ID}`, { timeout: 60_000 });
    await expect(warnings).toContainText('They do not block approval.');
    const approve = dialog.getByRole('button', { name: 'Approve and post journal' });
    await expect(approve).toBeEnabled();
    await snap(page, 'approve-dialog-warnings', 'session-theme');
    await approve.click();
    await expect(page.getByText('Payroll approved and journal posted.')).toBeVisible({ timeout: 60_000 });
    approved = true;

    await openCompliance(page);
    const item = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: new RegExp(NAME) }) });
    await expect(item).toContainText(MISSING_ID);
    await snap(page, 'compliance-card', 'session-theme');
    await item.getByRole('link', { name: 'Fix: ID number' }).click();
    await page.waitForURL(new RegExp(`/payroll/employees/${employeeId}#employee-id-number$`), { timeout: 60_000 });
    await expect(page.getByTestId('pre-validation-line')).toContainText(MISSING_ID, { timeout: 60_000 });
    await snap(page, 'profile-line', 'session-theme');

    for (const theme of THEMES) {
      await seedTheme(page, theme);
      await page.setViewportSize({ width: 1568, height: 900 });
      await openCompliance(page);
      expect(await seriousAxe(page)).toEqual([]);
      await snap(page, 'compliance-card-1568', theme);
      await page.setViewportSize({ width: 390, height: 844 });
      await settle(page);
      const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(width.scroll, 'the page must not scroll sideways').toBeLessThanOrEqual(width.client);
      expect(await seriousAxe(page)).toEqual([]);
      await snap(page, 'compliance-card-390', theme);
    }
  } finally {
    if (approved) await api.post(`/api/payroll/runs/${runId}/reopen`, { reason: 'z29 golden sandbox reset' });
    await api.dispose();
  }
});

for (const theme of THEMES) {
  test(`no serious axe violation on the pre-validation card, at 1568 and 390 (${theme})`, async ({ page, context, baseURL }) => {
    const { api } = await sandbox(context, baseURL!);
    await api.dispose();
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await openCompliance(page);
    expect(await seriousAxe(page)).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(width.scroll, 'the page must not scroll sideways').toBeLessThanOrEqual(width.client);
    expect(await seriousAxe(page)).toEqual([]);
  });
}
