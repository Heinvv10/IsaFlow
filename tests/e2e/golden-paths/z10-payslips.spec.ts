// golden:dev-only
/**
 * Golden path (z10): payslips from the pay run (master plan wave 4, PS).
 *
 *  - A calculated run: the row's Payslip opens the drawer; the PDF is a PDF, carries the stored net, the bank
 *    account's last four digits only, and "DRAFT" (the R-035 guard has not cleared the run).
 *  - R-035, two people: reporting-qa requests, the second sandbox approver (E2E_APPROVER_EMAIL / _PASSWORD,
 *    reporting-qa-approver@isaflow.dev on dev) decides, then the run is approved: no DRAFT, and the page says
 *    "Payslips are ready".
 *  - axe reports 0 critical and 0 serious with the drawer open, in both themes, at 1568 and 390.
 *  - EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Dev only: it writes payroll data and posts a payroll journal, in its own sandbox company, never in Demo. The
 * approver must be a member of that sandbox (a dev seed adds it; this spec cannot). Its one run (Nov 2026) is
 * reopened in `finally` and its journal reversed before the next calculation, so every execution reuses it.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { clearPayRunApproval, readApprover } from './helpers/payRunApproval';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX_NAME = '0GP Golden Payslip Sandbox';
const SANDBOX_ONBOARDING_ID = '2b7e4f19-6a3c-4d58-9e21-8c0f5a6d3b74';
const RUN = { month: 11, year: 2026 };
const EMPLOYEE = { employeeNumber: 'Z10-1', firstName: 'Zola', lastName: 'Slip', salary: 30000 };
const ACCOUNT = '62000123456';
const NAME = `${EMPLOYEE.firstName} ${EMPLOYEE.lastName}`;

type Run = { id: string; periodMonth: number; periodYear: number; status: string; journalEntryId: string | null };

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
      bankName: 'FNB', branchCode: '250655', accountNumber: ACCOUNT, accountType: 'cheque', accountHolder: NAME,
    });
  }

  const runs = await api.get<Run[]>('/api/payroll/runs');
  const found = runs.find((r) => r.periodMonth === RUN.month && r.periodYear === RUN.year);
  const runId = found?.id ?? (await api.post<Run>('/api/payroll/runs', RUN)).id;
  const run = await api.get<Run>(`/api/payroll/runs/${runId}`);
  if (run.status === 'approved') await api.post(`/api/payroll/runs/${runId}/reopen`, { reason: 'z10 golden sandbox reset' });
  // The reopened run still links the journal the last execution posted: take it out, so approval posts a fresh one.
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
  expect(new URL(baseURL).hostname, 'z10 writes payroll data: dev/CI localhost only').toBe('localhost');
  const api = await Api.login(baseURL);
  const sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  return { api, sandboxId, ...(await sandboxRun(api)) };
}

async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto(`/payroll/runs/${runId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Payroll Run — Nov 2026' })).toBeVisible({ timeout: 60_000 });
  await settle(page);
}

/** The slip's PDF through the browser's own session, as the drawer reads it; latin-1 so jsPDF's text operators read as text. */
async function slipText(page: Page, runId: string, employeeId: string): Promise<string> {
  const res = await page.context().request.get(`/api/payroll/runs/${runId}/payslips?disposition=inline&employeeId=${employeeId}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('no-store');
  const pdf = (await res.body()).toString('latin1');
  expect(pdf.startsWith('%PDF')).toBe(true);
  return pdf;
}

async function openDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: `Payslip for ${NAME}` }).click();
  const drawer = page.getByRole('dialog', { name: `Payslip: ${NAME}, Nov 2026` });
  await expect(drawer.getByTitle('Payslip PDF')).toBeVisible({ timeout: 30_000 });
}

async function snap(page: Page, name: string, theme: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}.png`, fullPage: true });
}

async function seriousAxe(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

test('calculated run: DRAFT payslip; R-035 by two people, approve: final, "Payslips are ready"', async ({ page, context, baseURL }) => {
  expect(readApprover(process.env), 'z10 needs E2E_APPROVER_EMAIL / E2E_APPROVER_PASSWORD (the second sandbox approver)').not.toBeNull();
  const { api, runId, employeeId } = await sandbox(context, baseURL!);
  let approved = false;
  try {
    const net = (await api.get<{ lines: Array<{ employeeId: string; netPay: number }> }>(`/api/payroll/runs/${runId}`))
      .lines.find((l) => l.employeeId === employeeId)!.netPay;
    const netText = net.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    await openRun(page, runId);
    await openDrawer(page);
    await snap(page, 'payslip-drawer-draft', 'light');
    const draft = await slipText(page, runId, employeeId);
    expect(draft).toContain('DRAFT: this run is not approved');
    expect(draft).toContain(netText);
    expect(draft).toContain('account ending 3456');
    expect(draft).not.toContain(ACCOUNT);

    await clearPayRunApproval(api, baseURL!, runId); // requested by reporting-qa, decided by the approver
    const plan = await api.get<{ planHash: string }>(`/api/payroll/runs/${runId}/journal-plan`);
    expect((await api.post<Run>(`/api/payroll/runs/${runId}/approve`, { expectedPlanHash: plan.planHash })).status).toBe('approved');
    approved = true;

    await openRun(page, runId);
    await expect(page.getByText(/^Payslips are ready\./)).toBeVisible();
    const final = await slipText(page, runId, employeeId);
    expect(final).not.toContain('DRAFT');
    expect(final).toContain(netText);
    await snap(page, 'payslip-ready', 'light');
  } finally {
    if (approved) await api.post(`/api/payroll/runs/${runId}/reopen`, { reason: 'z10 golden sandbox reset' });
    await api.dispose();
  }
});

for (const theme of THEMES) {
  test(`no serious axe violation with the payslip drawer open, at 1568 and 390 (${theme})`, async ({ page, context, baseURL }) => {
    const { api, runId } = await sandbox(context, baseURL!);
    await api.dispose();
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await openRun(page, runId);
    await openDrawer(page);
    expect(await seriousAxe(page)).toEqual([]);
    await snap(page, 'payslip-drawer-1568', theme);

    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(width.scroll, 'the page must not scroll sideways').toBeLessThanOrEqual(width.client);
    expect(await seriousAxe(page)).toEqual([]);
    await snap(page, 'payslip-drawer-390', theme);
  });
}
