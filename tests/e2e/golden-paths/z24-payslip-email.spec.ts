// golden:dev-only
/**
 * Golden path (z24): emailing payslips (master plan wave 6, PE). NOTHING IS SENT.
 *
 *  - The send route is page.route'd: the request is caught in the browser and answered here, so it never reaches
 *    the server, and the spec asserts it was caught exactly once, with the body the card sends.
 *  - The platform switch payroll_payslip_email is never set: the settings GET/PUT reach the server (the company
 *    setting is really written, in this spec's own sandbox) and only their `platformEnabled` is answered as on.
 *  - The employee's address (z24@example.invalid, spec rule 21) is saved through the work card's field.
 *  - The run is cleared through R-035 by the suite user itself (selfApprove: the sandbox has no second approver);
 *    where self-approval is refused (dev) the flow test is SKIPPED with the reason, never a faked approval.
 *  - axe reports 0 critical and 0 serious on the run page with the card and its outcome, in both themes, at 1568
 *    and 390. EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Dev only: it writes payroll data, posts and reverses a payroll journal and sets the company switch, in its own
 * sandbox company, never in Demo. In `finally` the run is reopened and the switch turned off again.
 */
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { clearPayRunApproval } from './helpers/payRunApproval';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX_NAME = '0GP Golden Payslip Email Sandbox';
const SANDBOX_ONBOARDING_ID = '6d1f3a82-4b7e-4c95-8a20-3e9b5c7d1f46';
const RUN = { month: 10, year: 2026 };
const EMPLOYEE = { employeeNumber: 'Z24-1', firstName: 'Zinhle', lastName: 'Mail', salary: 28000, idNumber: '8001015009087' };
const ADDRESS = 'z24@example.invalid';
const SELF_REFUSED = 'the suite user may not approve its own pay run in this database (dev): the flow needs an approved run';

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
      employmentType: 'permanent', startDate: '2024-01-01', taxNumber: '0123456789', idNumber: EMPLOYEE.idNumber,
    })).id;
    await api.post(`/api/payroll/employees/${employeeId}/components`, { componentId: salaryId, amount: EMPLOYEE.salary, effectiveFrom: '2024-01-01' });
  }
  const runs = await api.get<Run[]>('/api/payroll/runs');
  const found = runs.find((r) => r.periodMonth === RUN.month && r.periodYear === RUN.year);
  const runId = found?.id ?? (await api.post<Run>('/api/payroll/runs', RUN)).id;
  const run = await api.get<Run>(`/api/payroll/runs/${runId}`);
  if (run.status === 'approved') await api.post(`/api/payroll/runs/${runId}/reopen`, { reason: 'z24 golden sandbox reset' });
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
  expect(new URL(baseURL).hostname, 'z24 writes payroll data: dev/CI localhost only').toBe('localhost');
  const api = await Api.login(baseURL);
  const sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  return { api, ...(await sandboxRun(api)) };
}

/** Approved through R-035 by the suite user, or null where this database refuses its self-approval. */
async function approved(api: Api, baseURL: string, runId: string): Promise<boolean> {
  if ((await clearPayRunApproval(api, baseURL, runId, { selfApprove: true, reportSelfRefusal: true })) === 'self-approval-refused') return false;
  const plan = await api.get<{ planHash: string }>(`/api/payroll/runs/${runId}/journal-plan`);
  expect((await api.post<Run>(`/api/payroll/runs/${runId}/approve`, { expectedPlanHash: plan.planHash })).status).toBe('approved');
  return true;
}

/** The send route caught in the browser: never reaches the server. Returns the bodies it caught. */
async function interceptSend(page: Page, employeeId: string): Promise<unknown[]> {
  const caught: unknown[] = [];
  await page.route('**/api/payroll/runs/*/payslips/email', async (route: Route) => {
    caught.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {
      sent: [{ employeeId, employeeNumber: EMPLOYEE.employeeNumber, employeeName: `${EMPLOYEE.firstName} ${EMPLOYEE.lastName}`, sha256: '0'.repeat(64) }],
      failed: [], skipped: [{ employeeId: 'x', employeeNumber: 'Z24-2', employeeName: 'No Address', reason: 'NO_EMAIL' }],
    } }) });
  });
  // The real setting, with only the platform switch answered as on (it is never set by this spec).
  await page.route('**/api/payroll/settings/payslip-email', async (route: Route) => {
    const real = await route.fetch();
    const body = await real.json() as { data?: Record<string, unknown> };
    await route.fulfill({ response: real, json: { ...body, data: { ...body.data, platformEnabled: true } } });
  });
  return caught;
}

async function seriousAxe(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

async function flow(page: Page, runId: string, employeeId: string, theme: string): Promise<unknown[]> {
  const caught = await interceptSend(page, employeeId);
  await page.goto(`/payroll/employees/${employeeId}`, { waitUntil: 'domcontentloaded' });
  const field = page.getByLabel('Payslip email');
  await expect(field).toBeEnabled({ timeout: 60_000 });
  await field.fill(ADDRESS);
  await page.getByRole('button', { name: 'Save email' }).click();
  await expect(page.getByText('Payslip email saved.')).toBeVisible();

  await page.goto(`/payroll/runs/${runId}`, { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('payslip-email-card');
  await expect(card).toBeVisible({ timeout: 60_000 });
  const on = card.getByRole('button', { name: 'Turn payslip email on' });
  if (await on.isVisible()) await on.click();
  await card.getByRole('button', { name: 'Email payslips' }).click();
  const dialog = page.getByRole('dialog', { name: 'Email payslips?' });
  await expect(dialog).toContainText('40-bit RC4');
  await dialog.getByRole('button', { name: 'Email payslips' }).click();
  await expect(page.getByTestId('payslip-email-outcome')).toContainText('Sent to 1 employee.');
  await expect(page.getByTestId('payslip-email-outcome')).toContainText('Not sent to No Address (Z24-2): no email address on file.');
  await settle(page);
  for (const width of [1568, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/payslip-email-${theme}-${width}.png`, fullPage: true });
    expect(await seriousAxe(page), `axe ${theme} ${width}`).toEqual([]);
  }
  return caught;
}

for (const theme of THEMES) {
  test(`payslip email: address saved, switch on, send caught in the browser, no serious axe violation (${theme})`, async ({ page, context, baseURL }) => {
    test.setTimeout(240_000);
    const { api, runId, employeeId } = await sandbox(context, baseURL!);
    let isApproved = false;
    try {
      isApproved = await approved(api, baseURL!, runId);
      test.skip(!isApproved, SELF_REFUSED);
      await seedTheme(page, theme);
      const caught = await flow(page, runId, employeeId, theme);
      expect(caught).toEqual([{}]);
      expect(await api.get<{ email: string | null }>(`/api/payroll/employees/${employeeId}/email`)).toEqual({ email: ADDRESS });
    } finally {
      if (isApproved) await api.post(`/api/payroll/runs/${runId}/reopen`, { reason: 'z24 golden sandbox reset' });
      await api.put('/api/payroll/settings/payslip-email', { enabled: false });
      await api.dispose();
    }
  });
}
