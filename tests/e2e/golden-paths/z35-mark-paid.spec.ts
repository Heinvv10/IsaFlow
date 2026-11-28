// golden:dev-only
/**
 * Golden path (z35): "Mark paid" on an approved pay run, typed bank payment reference (master plan wave 7, MP, W27).
 *
 *  - The real route refuses a blank reference (400 INVALID_REFERENCE) and a payment date in the future (400
 *    INVALID_PAID_ON), writing nothing: the run stays approved.
 *  - The dialog: "Mark paid" opens it, the typed path needs a reference, and its submit posts the trimmed reference and
 *    the date. The POST and the re-read run are intercepted (page.route), so the sandbox run is never marked paid and the
 *    spec repeats; the page then shows who recorded the payment, its date and reference, and offers no "Reopen Period".
 *    The real typed path is proven by tests/integration/w7-mp-mark-paid.int.test.ts and the PR's browser proof.
 *  - axe reports 0 critical and 0 serious with the dialog open and with the paid note, in both themes, at 1568 and 390.
 *  - EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Dev only: it writes payroll data and posts a payroll journal in its own sandbox company, never in Demo. Approval is
 * cleared as z26 clears it. Its one run (Sep 2026) stays approved between executions; nothing reopens or pays it.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { clearPayRunApproval } from './helpers/payRunApproval';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';
import { guardDevTarget } from '../helpers/devTarget';

guardDevTarget(test);

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX = { name: '0GP Golden Mark Paid Sandbox', onboardingId: 'd16dcaf8-1dc0-47bd-8dc5-5e7c96fb6e66' };
const RUN = { month: 9, year: 2026 };
const EMPLOYEE = { employeeNumber: 'Z35-1', firstName: 'Palesa', lastName: 'Paid', salary: 31000 };
const NEEDS_APPROVER = `needs a second approver: set E2E_APPROVER_EMAIL / E2E_APPROVER_PASSWORD (an admin of "${SANDBOX.name}")`;

type Run = { id: string; periodMonth: number; periodYear: number; status: string; journalEntryId: string | null };

async function approvedRun(api: Api, baseURL: string): Promise<string | null> {
  const components = await api.get<Array<{ id: string; name: string }>>('/api/payroll/components');
  const salaryId = components.find((c) => c.name === 'Basic Salary')?.id
    ?? (await api.post<{ id: string }>('/api/payroll/components', { name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning' })).id;
  const existing = await api.get<Array<{ id: string; employeeNumber: string }>>('/api/payroll/employees?limit=50');
  if (!existing.some((e) => e.employeeNumber === EMPLOYEE.employeeNumber)) {
    const id = (await api.post<{ id: string }>('/api/payroll/employees', {
      employeeNumber: EMPLOYEE.employeeNumber, firstName: EMPLOYEE.firstName, lastName: EMPLOYEE.lastName,
      employmentType: 'permanent', startDate: '2024-01-01', taxNumber: '0123456789',
    })).id;
    await api.post(`/api/payroll/employees/${id}/components`, { componentId: salaryId, amount: EMPLOYEE.salary, effectiveFrom: '2024-01-01' });
  }
  const runs = await api.get<Run[]>('/api/payroll/runs');
  const runId = runs.find((r) => r.periodMonth === RUN.month && r.periodYear === RUN.year)?.id
    ?? (await api.post<Run>('/api/payroll/runs', RUN)).id;
  const run = await api.get<Run>(`/api/payroll/runs/${runId}`);
  if (run.status === 'approved' && run.journalEntryId) return runId;
  if (run.journalEntryId) {
    const journal = await api.get<{ status: string; reversedAt: string | null }>(`/api/accounting/journal-entries-detail?id=${run.journalEntryId}`);
    if (journal.status === 'posted' && !journal.reversedAt) await api.post('/api/accounting/journal-entries-action', { id: run.journalEntryId, action: 'reverse' });
  }
  await api.post(`/api/payroll/runs/${runId}/calculate`);
  if ((await clearPayRunApproval(api, baseURL, runId, { reportSelfRefusal: true })) === 'self-approval-refused') return null;
  const plan = await api.get<{ planHash: string }>(`/api/payroll/runs/${runId}/journal-plan`);
  await api.post(`/api/payroll/runs/${runId}/approve`, { expectedPlanHash: plan.planHash });
  return runId;
}

async function sandbox(context: BrowserContext, baseURL: string) {
  const api = await Api.login(baseURL);
  const sandboxId = await findOrCreateSandbox(api, SANDBOX);
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  return { api, runId: await approvedRun(api, baseURL) };
}

/** Intercept the mark-paid POST (recording its body) and, once it has answered, serve the run re-read as paid. */
async function interceptMarkPaid(page: Page, runId: string): Promise<{ bodies: unknown[] }> {
  const seen = { bodies: [] as unknown[], paid: false };
  await page.route(`**/api/payroll/runs/${runId}/mark-paid`, (route) => {
    seen.bodies.push(route.request().postDataJSON());
    seen.paid = true;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { runId, status: 'paid' } }) });
  });
  await page.route(`**/api/payroll/runs/${runId}`, async (route) => {
    const res = await route.fetch();
    if (!seen.paid || route.request().method() !== 'GET') return route.fulfill({ response: res });
    const json = await res.json();
    json.data = { ...json.data, status: 'paid', paidAt: '2026-11-25T08:30:00.000Z', paidOn: '2026-11-25', paidReference: 'FNB EFT Z35', paidByName: 'Golden Admin' };
    return route.fulfill({ response: res, json });
  });
  return seen;
}

async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto(`/payroll/runs/${runId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Payroll Run — Sep 2026' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /Mark paid/ })).toBeVisible({ timeout: 30_000 });
  await settle(page);
}

async function seriousAxe(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

async function snap(page: Page, name: string, theme: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}.png`, fullPage: true });
}

test('the real route refuses a blank reference and a future date; the run stays approved', async ({ context, baseURL }) => {
  const { api, runId } = await sandbox(context, baseURL!);
  try {
    test.skip(runId === null, NEEDS_APPROVER);
    const blank = await api.postRaw(`/api/payroll/runs/${runId}/mark-paid`, { reference: '   ', paidOn: '2026-11-25' });
    expect([blank.status, blank.json?.error?.details?.reason]).toEqual([400, 'INVALID_REFERENCE']);
    const future = await api.postRaw(`/api/payroll/runs/${runId}/mark-paid`, { reference: 'EFT Z35', paidOn: '2099-01-01' });
    expect([future.status, future.json?.error?.details?.reason]).toEqual([400, 'INVALID_PAID_ON']);
    expect((await api.get<Run>(`/api/payroll/runs/${runId}`)).status).toBe('approved');
  } finally {
    await api.dispose();
  }
});

test('typed reference: the dialog posts the trimmed reference and date; the paid run shows who, when and no reopen', async ({ page, context, baseURL }) => {
  const { api, runId } = await sandbox(context, baseURL!);
  try {
    test.skip(runId === null, NEEDS_APPROVER);
    const seen = await interceptMarkPaid(page, runId!);
    await openRun(page, runId!);
    await expect(page.getByRole('button', { name: 'Reopen Period' })).toBeVisible();
    await page.getByRole('button', { name: /Mark paid/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Mark this pay run paid?' });
    await expect(dialog).toContainText('cannot be reopened');
    const submit = dialog.getByRole('button', { name: /Mark paid/ });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel('Bank payment reference').fill('  FNB EFT Z35 ');
    await expect(submit).toBeEnabled();
    await snap(page, 'mark-paid-dialog', 'session-theme');
    await submit.click();
    await expect(page.getByRole('status').filter({ hasText: 'bank reference FNB EFT Z35' })).toBeVisible();
    expect(seen.bodies).toHaveLength(1);
    expect(seen.bodies[0]).toMatchObject({ reference: 'FNB EFT Z35' });
    expect(String((seen.bodies[0] as { paidOn: string }).paidOn)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(page.getByRole('button', { name: 'Reopen Period' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Mark paid/ })).toHaveCount(0);
    await snap(page, 'mark-paid-paid', 'session-theme');
  } finally {
    await api.dispose();
  }
});

for (const theme of THEMES) {
  test(`no serious axe violation with the dialog and the paid note, at 1568 and 390 (${theme})`, async ({ page, context, baseURL }) => {
    const { api, runId } = await sandbox(context, baseURL!);
    await api.dispose();
    test.skip(runId === null, NEEDS_APPROVER);
    await interceptMarkPaid(page, runId!);
    await seedTheme(page, theme);
    for (const width of [1568, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await openRun(page, runId!);
      await page.getByRole('button', { name: /Mark paid/ }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await settle(page);
      expect(await seriousAxe(page)).toEqual([]);
      await snap(page, `mark-paid-dialog-${width}`, theme);
      await page.getByRole('button', { name: 'Not yet' }).click();
    }
    await page.getByRole('button', { name: /Mark paid/ }).click();
    await page.getByRole('dialog').getByLabel('Bank payment reference').fill('FNB EFT Z35');
    await page.getByRole('dialog').getByRole('button', { name: /Mark paid/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'bank reference FNB EFT Z35' })).toBeVisible();
    await settle(page);
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(size.scroll, 'the page must not scroll sideways').toBeLessThanOrEqual(size.client);
    expect(await seriousAxe(page)).toEqual([]);
    await snap(page, 'mark-paid-note-390', theme);
  });
}
