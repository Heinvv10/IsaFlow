// golden:dev-only
/**
 * Golden path (z25): the employee self-service portal (master plan wave 6, SS). NOTHING IS SENT, NO ONE IS INVITED.
 *
 *  - Staff side: the employee page's portal card in a sandbox company. The platform switch payroll_employee_portal is
 *    never set: the settings GET reaches the server (the company setting is really written, in this spec's sandbox)
 *    and only its `platformEnabled` is answered as on. The invite POST is page.route'd, so it never reaches the
 *    server; the spec asserts it was caught exactly once. The employee's address is z25@example.invalid (rule 21).
 *  - Portal side: the accept, login and home pages render against page.route'd portal answers (the server side is
 *    proven by tests/integration/ss-employee-portal-*.int.test.ts); the spec asserts what each page posts.
 *  - axe reports 0 critical and 0 serious on each page, in both themes, at 1568 and 390. EVIDENCE_DIR=<dir> saves
 *    screenshots.
 *
 * Dev only: it writes an employee, an address and the company setting in its own sandbox company, never in Demo.
 * In `finally` the setting is turned off again.
 */
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX_NAME = '0GP Golden Employee Portal Sandbox';
const SANDBOX_ONBOARDING_ID = '9b2e4c61-7a3d-4f58-b1c9-5e8d2a6f3c17';
const EMPLOYEE = { employeeNumber: 'Z25-1', firstName: 'Zola', lastName: 'Portal' };
const ADDRESS = 'z25@example.invalid';
const TOKEN = 'z'.repeat(43);
const ok = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });

async function sandbox(context: BrowserContext, baseURL: string): Promise<{ api: Api; employeeId: string }> {
  expect(new URL(baseURL).hostname, 'z25 writes payroll data: dev/CI localhost only').toBe('localhost');
  const api = await Api.login(baseURL);
  const sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  const existing = await api.get<Array<{ id: string; employeeNumber: string }>>('/api/payroll/employees?limit=50');
  const employeeId = existing.find((e) => e.employeeNumber === EMPLOYEE.employeeNumber)?.id
    ?? (await api.post<{ id: string }>('/api/payroll/employees', {
      ...EMPLOYEE, employmentType: 'permanent', startDate: '2024-01-01', taxNumber: '0123456789', idNumber: '8001015009087',
    })).id;
  await api.put(`/api/payroll/employees/${employeeId}/email`, { email: ADDRESS });
  await api.put('/api/payroll/settings/employee-portal', { enabled: false });
  return { api, employeeId };
}

async function seriousAxe(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

async function shoot(page: Page, name: string, theme: string): Promise<void> {
  await settle(page);
  for (const width of [1568, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}-${width}.png`, fullPage: true });
    expect(await seriousAxe(page), `axe ${name} ${theme} ${width}`).toEqual([]);
  }
  await page.setViewportSize({ width: 1568, height: 1000 });
}

async function staffCard(page: Page, employeeId: string, theme: string): Promise<unknown[]> {
  const caught: unknown[] = [];
  await page.route('**/api/payroll/settings/employee-portal', async (route: Route) => {
    const real = await route.fetch();
    const body = await real.json() as { data?: Record<string, unknown> };
    await route.fulfill({ response: real, json: { ...body, data: { ...body.data, platformEnabled: true } } });
  });
  await page.route(`**/api/payroll/employees/${employeeId}/portal-access`, async (route: Route) => {
    if (route.request().method() === 'POST') {
      caught.push(route.request().postDataJSON());
      await route.fulfill(ok({ status: 'invited', sent: true }));
      return;
    }
    if (caught.length === 0) { await route.fallback(); return; }
    await route.fulfill(ok({ status: 'invited', email: ADDRESS, invitedAt: '2026-11-17T08:00:00.000Z', inviteExpiresAt: '2026-11-24T08:00:00.000Z',
      activatedAt: null, lastLoginAt: null, accessEnds: null }));
  });
  await page.goto(`/payroll/employees/${employeeId}`, { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('employee-portal-card');
  await expect(card).toContainText('Not invited', { timeout: 60_000 });
  await card.getByRole('button', { name: 'Turn on' }).click();
  await expect(card).toContainText('Employee self-service turned on.');
  await card.getByRole('button', { name: 'Invite to portal' }).click();
  await expect(card).toContainText('Invitation sent.');
  await expect(card).toContainText('Invited, has not signed in yet (link valid to 2026-11-24)');
  if (EVIDENCE_DIR) await card.screenshot({ path: `${EVIDENCE_DIR}/employee-portal-card-${theme}.png` });
  expect(await seriousAxe(page), `axe ${theme} employee page`).toEqual([]);
  return caught;
}

async function portalPages(page: Page, theme: string): Promise<{ accepted: unknown[]; logins: unknown[] }> {
  const accepted: unknown[] = [];
  const logins: unknown[] = [];
  await page.route('**/api/employee-portal/accept', async (route) => { accepted.push(route.request().postDataJSON()); await route.fulfill(ok({ signedIn: true })); });
  await page.route('**/api/employee-portal/login', async (route) => { logins.push(route.request().postDataJSON()); await route.fulfill(ok({ signedIn: true })); });
  await page.route('**/api/employee-portal/logout', (route) => route.fulfill(ok({ signedIn: false })));
  await page.route('**/api/employee-portal/me', (route) => route.fulfill(ok({ employeeName: 'Zola Portal', employeeNumber: 'Z25-1', employer: SANDBOX_NAME })));
  await page.route('**/api/employee-portal/payslips', (route) => route.fulfill(ok([
    { runId: '00000000-0000-4000-8000-000000000025', periodYear: 2026, periodMonth: 10, runDate: '2026-10-25', netPay: 21456.78 },
    { runId: '00000000-0000-4000-8000-000000000024', periodYear: 2026, periodMonth: 9, runDate: '2026-09-25', netPay: 21456.78 },
  ])));
  await page.route('**/api/employee-portal/leave', (route) => route.fulfill(ok([
    { leaveType: 'Annual', year: 2026, accrued: 15, taken: 3, pending: 0, balance: 12 },
    { leaveType: 'Sick', year: 2026, accrued: 30, taken: 2, pending: 0, balance: 28 },
  ])));

  await page.goto(`/employee-portal/accept#t=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible({ timeout: 60_000 });
  expect(new URL(page.url()).hash, 'the token leaves the address bar once read').toBe('');
  await shoot(page, 'employee-portal-accept', theme);
  await page.getByLabel('New password').fill('correct horse battery');
  await page.getByLabel('Type it again').fill('correct horse battery');
  await page.getByRole('button', { name: 'Set password and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Zola Portal' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('link', { name: 'Download payslip for October 2026' })).toHaveAttribute('href', '/api/employee-portal/payslips/00000000-0000-4000-8000-000000000025');
  await expect(page.getByRole('table').nth(1)).toContainText('Annual');
  await shoot(page, 'employee-portal-home', theme);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible({ timeout: 60_000 });
  await shoot(page, 'employee-portal-login', theme);
  await page.getByLabel('Email address').fill(ADDRESS);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Zola Portal' })).toBeVisible({ timeout: 60_000 });
  return { accepted, logins };
}

for (const theme of THEMES) {
  test(`employee portal: invite caught in the browser, accept, home and sign-in pages, no serious axe violation (${theme})`, async ({ page, context, baseURL }) => {
    test.setTimeout(240_000);
    const { api, employeeId } = await sandbox(context, baseURL!);
    try {
      await seedTheme(page, theme);
      expect(await staffCard(page, employeeId, theme)).toEqual([{}]);
      const { accepted, logins } = await portalPages(page, theme);
      expect(accepted).toEqual([{ token: TOKEN, password: 'correct horse battery' }]);
      expect(logins).toEqual([{ email: ADDRESS, password: 'correct horse battery' }]);
      expect(await api.get<{ enabled: boolean }>('/api/payroll/settings/employee-portal')).toMatchObject({ enabled: true, platformEnabled: false });
    } finally {
      await api.put('/api/payroll/settings/employee-portal', { enabled: false });
      await api.dispose();
    }
  });
}
