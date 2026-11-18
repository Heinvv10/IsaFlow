// golden:dev-only
/**
 * Golden path (z24): emailing payslips (master plan wave 6, PE). NOTHING IS SENT.
 *
 *  - The send route is page.route'd: the request is caught in the browser and answered here, so it never reaches
 *    the server, and the spec asserts it was caught exactly once, with the body the card sends.
 *  - The platform switch payroll_payslip_email is never set: the settings GET/PUT reach the server (the company
 *    setting is really written, in this spec's own sandbox) and only their `platformEnabled` is answered as on.
 *  - The employee's address (z24@example.invalid, spec rule 21) is saved through the work card's field.
 *  - The run is cleared through R-035 (clearPayRunApproval): by E2E_APPROVER_* when set (a member of this sandbox),
 *    else by the suite user as sole approver; where that cannot happen here the flow test is SKIPPED with the reason.
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
const SELF_REFUSED = 'the suite user may not approve its own pay run here and no E2E_APPROVER_* is set: the flow needs an approved run';

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
  // Each execution saves the address and turns the switch on through the card: start with neither, so a crashed
  // execution cannot leave the switch on.
  await api.put(`/api/payroll/employees/${employeeId}/email`, { email: null });
  await api.put('/api/payroll/settings/payslip-email', { enabled: false });
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

/**
 * Approved through R-035, or a reason it cannot be here: with E2E_APPROVER_* set, that person decides (they must be a
 * member of this sandbox); without, the suite user is the sole eligible approver (a fresh CI database), and where
 * its self-approval is refused (dev) the reason is returned. Never a faked approval.
 */
async function approved(api: Api, baseURL: string, runId: string): Promise<string | null> {
  const clearance = await clearPayRunApproval(api, baseURL, runId, { reportSelfRefusal: true }).catch((err: Error) => {
    if (/not a member/.test(err.message)) return `${process.env.E2E_APPROVER_EMAIL} is not a member of "${SANDBOX_NAME}": ${err.message}`;
    throw err;
  });
  if (clearance === 'self-approval-refused') return SELF_REFUSED;
  if (clearance !== 'cleared') return clearance;
  const plan = await api.get<{ planHash: string }>(`/api/payroll/runs/${runId}/journal-plan`);
  expect((await api.post<Run>(`/api/payroll/runs/${runId}/approve`, { expectedPlanHash: plan.planHash })).status).toBe('approved');
  return null;
}

/** The send route caught in the browser: never reaches the server. Returns the bodies it caught. */
async function interceptSend(page: Page, employeeId: string): Promise<unknown[]> {
  const caught: unknown[] = [];
  await page.route('**/api/payroll/runs/*/payslips/email', async (route: Route) => {
    if (route.request().method() === 'GET') {
      // Who has been emailed: answered here too, so the card's list shows a sent and an unconfirmed delivery.
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: caught.length === 0 ? [] : [
        { employeeId, employeeNumber: EMPLOYEE.employeeNumber, employeeName: `${EMPLOYEE.firstName} ${EMPLOYEE.lastName}`,
          status: 'sent', recipient: ADDRESS, at: '2026-11-17T06:00:00.000Z', attempts: 1 },
        { employeeId: 'x', employeeNumber: 'Z24-3', employeeName: 'Slow Server', status: 'unknown',
          recipient: 'z24-slow@example.invalid', at: '2026-11-17T06:00:05.000Z', attempts: 1 },
        { employeeId: 'y', employeeNumber: 'Z24-4', employeeName: 'Bounced One', status: 'failed',
          recipient: 'z24-bounce1@example.invalid', at: '2026-11-17T06:00:06.000Z', attempts: 1 },
        { employeeId: 'z', employeeNumber: 'Z24-5', employeeName: 'Bounced Two', status: 'failed',
          recipient: 'z24-bounce2@example.invalid', at: '2026-11-17T06:00:07.000Z', attempts: 1 },
      ] }) });
      return;
    }
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
  const field = page.getByRole('textbox', { name: 'Payslip email', exact: true });
  await expect(field).toBeEnabled({ timeout: 60_000 });
  await field.fill(ADDRESS);
  await page.getByRole('button', { name: 'Save email' }).click();
  await expect(page.getByText('Payslip email saved.')).toBeVisible();
  if (EVIDENCE_DIR) await field.screenshot({ path: `${EVIDENCE_DIR}/employee-email-field-${theme}.png` });

  await page.goto(`/payroll/runs/${runId}`, { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('payslip-email-card');
  await expect(card).toBeVisible({ timeout: 60_000 });
  const on = card.getByRole('button', { name: 'Turn payslip email on' });
  if (await on.isVisible()) await on.click();
  await card.getByRole('button', { name: 'Email payslips' }).click();
  const dialog = page.getByRole('dialog', { name: 'Email payslips?' });
  await expect(dialog).toContainText('40-bit RC4');
  // The modal fades and zooms in (~300 ms): axe run mid-animation reads blended colours and flags the Cancel button
  // (measured: 1.12:1 at 40 ms, 2.98:1 at 120 ms; 11.9:1 settled, 11.3:1 hovered). Wait for the finite animations to end.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)).map((a) => a.finished)));
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/payslip-email-confirm-${theme}.png` });
  expect(await seriousAxe(page), `axe ${theme} confirm`).toEqual([]);
  await dialog.getByRole('button', { name: 'Email payslips' }).click();
  await expect(page.getByTestId('payslip-email-outcome')).toContainText('Sent to 1 employee.');
  await expect(page.getByTestId('payslip-email-outcome')).toContainText('Not sent to No Address (Z24-2): no email address on file.');
  const list = page.getByTestId('payslip-email-deliveries');
  await expect(list).toContainText(ADDRESS);
  await expect(list).toContainText('May have been sent (the mail server did not confirm)');
  await expect(list.getByRole('button', { name: `Send ${EMPLOYEE.firstName} ${EMPLOYEE.lastName}'s payslip again` })).toBeVisible();
  // Review #1542 E-S1: failed rows are retried by a plain send (Try again / Retry all failed), not a resend.
  await expect(list.getByRole('button', { name: "Try sending Bounced One's payslip again" })).toBeVisible();
  await expect(list.getByRole('button', { name: "Try sending Bounced Two's payslip again" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry all failed (2)' })).toBeVisible();
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
      const cannot = await approved(api, baseURL!, runId);
      isApproved = cannot === null;
      test.skip(!isApproved, cannot ?? '');
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
