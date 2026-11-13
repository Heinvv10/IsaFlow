// golden:dev-only
/**
 * Golden path (z18): "How was this calculated?" on a calculated pay run (master plan wave 5, EX-core).
 *
 *  - A calculated run: PAYE's button in the row opens the ExplainDrawer with the line's stored steps (the annual
 *    equivalent, the tax for the year, the PAYE already deducted) and its result, which is the PAYE the row shows.
 *  - The payslip drawer's UIF button opens UIF's explanation over the payslip.
 *  - axe reports 0 critical and 0 serious with the explanation open, in both themes, at 1568 and 390, and the page
 *    does not scroll sideways at 390.
 *  - EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Dev only: it writes payroll data (an employee and a calculated run) in its own sandbox company, never in Demo. Its
 * one run (Dec 2026) is recalculated each execution and never approved.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX_NAME = '0GP Golden Explain Sandbox';
const SANDBOX_ONBOARDING_ID = '7c1d2e8a-4b6f-4e93-a2d5-91f0c3b8e6a4';
const RUN = { month: 12, year: 2026 };
const EMPLOYEE = { employeeNumber: 'Z18-1', firstName: 'Zinhle', lastName: 'Explain', salary: 35000 };
const NAME = `${EMPLOYEE.firstName} ${EMPLOYEE.lastName}`;

type Run = { id: string; periodMonth: number; periodYear: number; status: string };
type Line = { employeeId: string; paye: number };

async function sandboxRun(api: Api): Promise<{ runId: string; employeeId: string }> {
  const components = await api.get<Array<{ id: string; name: string }>>('/api/payroll/components');
  const salaryId = components.find((c) => c.name === 'Basic Salary')?.id
    ?? (await api.post<{ id: string }>('/api/payroll/components', { name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning' })).id;
  const existing = await api.get<Array<{ id: string; employeeNumber: string }>>('/api/payroll/employees?limit=50');
  let employeeId = existing.find((e) => e.employeeNumber === EMPLOYEE.employeeNumber)?.id;
  if (!employeeId) {
    employeeId = (await api.post<{ id: string }>('/api/payroll/employees', {
      employeeNumber: EMPLOYEE.employeeNumber, firstName: EMPLOYEE.firstName, lastName: EMPLOYEE.lastName,
      employmentType: 'permanent', startDate: '2024-01-01', taxNumber: '0123456789', dateOfBirth: '1986-04-01',
    })).id;
    await api.post(`/api/payroll/employees/${employeeId}/components`, { componentId: salaryId, amount: EMPLOYEE.salary, effectiveFrom: '2024-01-01' });
  }
  const runs = await api.get<Run[]>('/api/payroll/runs');
  const runId = runs.find((r) => r.periodMonth === RUN.month && r.periodYear === RUN.year)?.id
    ?? (await api.post<Run>('/api/payroll/runs', RUN)).id;
  await api.post(`/api/payroll/runs/${runId}/calculate`);
  return { runId, employeeId };
}

async function sandbox(context: BrowserContext, baseURL: string) {
  expect(new URL(baseURL).hostname, 'z18 writes payroll data: dev/CI localhost only').toBe('localhost');
  const api = await Api.login(baseURL);
  const sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  return { api, ...(await sandboxRun(api)) };
}

async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto(`/payroll/runs/${runId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Payroll Run — Dec 2026' })).toBeVisible({ timeout: 60_000 });
  await settle(page);
}

async function openPayeExplanation(page: Page) {
  await page.getByRole('button', { name: `How was PAYE for ${NAME} calculated?` }).click();
  const drawer = page.getByRole('dialog', { name: `How PAYE was calculated for ${NAME}` });
  await expect(drawer.getByText('Annual equivalent', { exact: true })).toBeVisible({ timeout: 30_000 });
  return drawer;
}

async function snap(page: Page, name: string, theme: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}.png`, fullPage: false });
}

async function seriousAxe(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

const money = (n: number) => `R ${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;

test('a calculated run: PAYE\'s explanation shows its steps and ends at the PAYE the row shows; UIF opens from the payslip', async ({ page, context, baseURL }) => {
  const { api, runId, employeeId } = await sandbox(context, baseURL!);
  try {
    const paye = (await api.get<{ lines: Line[] }>(`/api/payroll/runs/${runId}`)).lines.find((l) => l.employeeId === employeeId)!.paye;
    expect(paye).toBeGreaterThan(0);
    await openRun(page, runId);
    const drawer = await openPayeExplanation(page);
    await expect(drawer.getByText('Tax for the year on the annual equivalent', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Less PAYE already deducted this tax year (tables)', { exact: true })).toBeVisible();
    await expect(drawer.getByText('PAYE this period', { exact: true })).toBeVisible();
    await expect(drawer.getByText(money(paye), { exact: true }).last()).toBeVisible();
    await snap(page, 'explain-paye', 'session-theme');
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    await page.getByRole('button', { name: `Payslip for ${NAME}` }).click();
    const slip = page.getByRole('dialog', { name: `Payslip: ${NAME}, Dec 2026` });
    await slip.getByRole('button', { name: `How was UIF for ${NAME} calculated?` }).click();
    const uif = page.getByRole('dialog', { name: `How UIF was calculated for ${NAME}` });
    await expect(uif.getByText('Monthly ceiling', { exact: true })).toBeVisible({ timeout: 30_000 });
    await snap(page, 'explain-uif-over-payslip', 'session-theme');
  } finally {
    await api.dispose();
  }
});

for (const theme of THEMES) {
  test(`no serious axe violation with PAYE's explanation open, at 1568 and 390 (${theme})`, async ({ page, context, baseURL }) => {
    const { api, runId } = await sandbox(context, baseURL!);
    await api.dispose();
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await openRun(page, runId);
    await openPayeExplanation(page);
    expect(await seriousAxe(page)).toEqual([]);
    await snap(page, 'explain-paye-1568', theme);

    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(width.scroll, 'the page must not scroll sideways').toBeLessThanOrEqual(width.client);
    expect(await seriousAxe(page)).toEqual([]);
    await snap(page, 'explain-paye-390', theme);
  });
}
