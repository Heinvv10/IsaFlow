// golden:dev-only
/**
 * Golden path (z26): the salary bank file on an approved pay run (master plan wave 6, BF).
 *
 *  - The platform switch payroll_salary_bank_file is OFF on every database this runs on (spec rule 20; no agent turns it
 *    on), so the real POST is refused 403 FEATURE_DISABLED and the card says so.
 *  - The generate / confirm flow is then driven against intercepted bank-file routes (page.route): the download is
 *    caught, the card shows the generated file, "Bank accepted it" asks first, and a confirmed file shows "The bank has
 *    paid this run". No bank file is written on the server by this spec.
 *  - axe reports 0 critical and 0 serious with the card showing, in both themes, at 1568 and 390 (no sideways scroll).
 *  - EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Dev only: it writes payroll data and posts a payroll journal in its own sandbox company, never in Demo. Approval is
 * cleared as z10 clears it (a second approver, or the sole-approver exception on a fresh CI database; skipped with the
 * reason where self-approval is refused). Its one run (Oct 2026) stays approved between executions; nothing reopens it.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { clearPayRunApproval } from './helpers/payRunApproval';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX = { name: '0GP Golden Bank File Sandbox', onboardingId: 'e1bfbc2d-f9d7-4db7-805b-de47de2462f5' };
const RUN = { month: 10, year: 2026 };
const EMPLOYEE = { employeeNumber: 'Z26-1', firstName: 'Bongi', lastName: 'Bank', salary: 28000 };
const FILE_ID = '26262626-2626-4626-8626-262626262626';
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
    await api.put(`/api/payroll/employees/${id}/bank-details`, {
      bankName: 'FNB', branchCode: '250655', accountNumber: '62000262626', accountType: 'cheque', accountHolder: 'Bongi Bank',
    });
  }
  const runs = await api.get<Run[]>('/api/payroll/runs');
  const runId = runs.find((r) => r.periodMonth === RUN.month && r.periodYear === RUN.year)?.id
    ?? (await api.post<Run>('/api/payroll/runs', RUN)).id;
  const run = await api.get<Run>(`/api/payroll/runs/${runId}`);
  if (run.status === 'approved') return runId;
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
  expect(new URL(baseURL).hostname, 'z26 writes payroll data: dev/CI localhost only').toBe('localhost');
  const api = await Api.login(baseURL);
  const sandboxId = await findOrCreateSandbox(api, SANDBOX);
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  return { api, runId: await approvedRun(api, baseURL) };
}

const ok = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
const file = (status: string) => ({
  id: FILE_ID, status, layout: 'fnb_obe_2023_02', sha256: 'a'.repeat(64), lineCount: 1, totalCents: 2_345_678, actionDate: '2099-01-15',
  createdAt: '2026-11-16T10:00:00.000Z', confirmedAt: status === 'confirmed' ? '2026-11-16T11:00:00.000Z' : null, voidedAt: null, stale: false,
});

/** Intercept the run's bank-file routes; the state moves generate -> confirm as the card calls them. */
async function interceptBankFile(page: Page, runId: string): Promise<void> {
  let files: unknown[] = [];
  await page.route(`**/api/payroll/runs/${runId}/bank-file`, (route) => {
    if (route.request().method() === 'POST') {
      files = [file('generated')];
      return route.fulfill(ok({ id: FILE_ID, filename: 'salaries-2026-10-2099-01-15.acb.txt', content: `02${'0'.repeat(178)}\r\n`,
        sha256: 'a'.repeat(64), lineCount: 1, totalCents: 2_345_678, actionDate: '2099-01-15', warnings: ['Payment 1 account name "Bongi Bank" is cut'] }));
    }
    return route.fulfill(ok({ enabled: true, files, paymentConfirmed: files.length > 0 && (files[0] as { status: string }).status === 'confirmed' }));
  });
  await page.route(`**/api/payroll/runs/${runId}/bank-file/${FILE_ID}/confirm`, (route) => {
    files = [file('confirmed')];
    return route.fulfill(ok({ id: FILE_ID, status: 'confirmed' }));
  });
}

async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto(`/payroll/runs/${runId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Payroll Run — Oct 2026' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Salary bank file' })).toBeVisible({ timeout: 30_000 });
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

test('switch off: the real POST is refused FEATURE_DISABLED and the card says so', async ({ page, context, baseURL }) => {
  const { api, runId } = await sandbox(context, baseURL!);
  try {
    test.skip(runId === null, NEEDS_APPROVER);
    const refused = await api.postRaw(`/api/payroll/runs/${runId}/bank-file`, { actionDate: '2099-01-15' });
    expect([refused.status, refused.json?.error?.details?.reason]).toEqual([403, 'FEATURE_DISABLED']);
    const state = await page.context().request.get(`/api/payroll/runs/${runId}/bank-file`);
    expect(state.headers()['cache-control']).toBe('no-store');
    expect((await state.json()).data).toMatchObject({ enabled: false, files: [] });
    await openRun(page, runId!);
    await expect(page.getByText(/Salary bank files are not switched on yet/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate bank file' })).toHaveCount(0);
  } finally {
    await api.dispose();
  }
});

test('generate downloads the file, then "Bank accepted it" asks first and shows the run as paid by the bank', async ({ page, context, baseURL }) => {
  const { api, runId } = await sandbox(context, baseURL!);
  try {
    test.skip(runId === null, NEEDS_APPROVER);
    await interceptBankFile(page, runId!);
    await openRun(page, runId!);
    const date = page.getByLabel('Action date');
    await date.fill('15 Jan 2099');
    await date.press('Enter');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Generate bank file' }).click();
    expect((await download).suggestedFilename()).toBe('salaries-2026-10-2099-01-15.acb.txt');
    await expect(page.getByRole('list', { name: 'Bank file warnings' })).toContainText('Bongi Bank');
    await expect(page.getByText('Generated, not yet confirmed')).toBeVisible();
    await snap(page, 'bank-file-generated', 'session-theme');

    await page.getByRole('button', { name: 'Bank accepted it' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Only do this once the bank shows the salaries as accepted');
    await dialog.getByRole('button', { name: 'Bank accepted it' }).click();
    await expect(page.getByText(/The bank has paid this run/)).toBeVisible();
    await expect(page.getByText('Payment confirmed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reopen Period' })).toBeVisible();
    await snap(page, 'bank-file-confirmed', 'session-theme');
  } finally {
    await api.dispose();
  }
});

for (const theme of THEMES) {
  test(`no serious axe violation with the bank-file card, at 1568 and 390 (${theme})`, async ({ page, context, baseURL }) => {
    const { api, runId } = await sandbox(context, baseURL!);
    await api.dispose();
    test.skip(runId === null, NEEDS_APPROVER);
    await interceptBankFile(page, runId!);
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await openRun(page, runId!);
    expect(await seriousAxe(page)).toEqual([]);
    await snap(page, 'bank-file-1568', theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(width.scroll, 'the page must not scroll sideways').toBeLessThanOrEqual(width.client);
    expect(await seriousAxe(page)).toEqual([]);
    await snap(page, 'bank-file-390', theme);
  });
}
