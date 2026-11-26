// golden:dev-only
/**
 * Golden path (z36): "Cancel run" on a calculated regular pay run (master plan wave 7, CX, W28).
 *
 *  - The page of a calculated, never-approved regular run offers "Cancel run"; the dialog says what is released and that
 *    an approved run is reopened instead. "Keep run" sends nothing.
 *  - Cancelling it through the real route removes the run: the page returns to the runs list, the run is gone (404), and
 *    a new run for the same period is created at once (its period is free). The spec ends with the run calculated
 *    again, so it repeats.
 *  - axe reports 0 critical and 0 serious with the dialog open, in both themes, at 1568 and 390, and the page does not
 *    scroll sideways at 390.
 *  - EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Dev only: it writes payroll data in its own sandbox company, never in Demo. Its one run (Oct 2026) is calculated,
 * cancelled and calculated again; nothing approves it.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX = { name: '0GP Golden Cancel Run Sandbox', onboardingId: '6c1f3c52-9a4e-4b8e-a1d2-36c0ce1a2b36' };
const RUN = { month: 10, year: 2026 };
const EMPLOYEE = { employeeNumber: 'Z36-1', firstName: 'Kagiso', lastName: 'Cancel', salary: 24000 };

type Run = { id: string; periodMonth: number; periodYear: number; status: string; runKind: string };

/** The sandbox's Oct 2026 regular run, calculated (created first when a cancel removed it). */
async function calculatedRun(api: Api): Promise<string> {
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
  const runId = runs.find((r) => r.runKind === 'regular' && r.periodMonth === RUN.month && r.periodYear === RUN.year)?.id
    ?? (await api.post<Run>('/api/payroll/runs', RUN)).id;
  const run = await api.get<Run>(`/api/payroll/runs/${runId}`);
  if (run.status !== 'calculated') await api.post(`/api/payroll/runs/${runId}/calculate`);
  return runId;
}

async function sandbox(context: BrowserContext, baseURL: string) {
  expect(new URL(baseURL).hostname, 'z36 writes payroll data: dev/CI localhost only').toBe('localhost');
  const api = await Api.login(baseURL);
  const sandboxId = await findOrCreateSandbox(api, SANDBOX);
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  return { api, runId: await calculatedRun(api) };
}

async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto(`/payroll/runs/${runId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Payroll Run — Oct 2026' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('regular-run-cancel')).toBeVisible({ timeout: 30_000 });
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

test('cancel removes the calculated run; its period takes a new run at once', async ({ page, context, baseURL }) => {
  const { api, runId } = await sandbox(context, baseURL!);
  try {
    await openRun(page, runId);
    const card = page.getByTestId('regular-run-cancel');
    await card.getByRole('button', { name: 'Cancel run' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this pay run?' });
    await expect(dialog).toContainText('Loan instalments it took are given back');
    await expect(dialog).toContainText('reopen it instead');
    await dialog.getByRole('button', { name: 'Keep run' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await api.get<Run>(`/api/payroll/runs/${runId}`)).status).toBe('calculated');

    await card.getByRole('button', { name: 'Cancel run' }).click();
    await snap(page, 'cancel-dialog', 'session-theme');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel run' }).click();
    await page.waitForURL('**/payroll/runs', { timeout: 30_000 });
    expect((await api.getRaw(`/api/payroll/runs/${runId}`)).status).toBe(404);
    const again = await api.post<Run>('/api/payroll/runs', RUN);
    expect(again.id).not.toBe(runId);
    await api.post(`/api/payroll/runs/${again.id}/calculate`);
  } finally {
    await api.dispose();
  }
});

for (const theme of THEMES) {
  test(`no serious axe violation with the cancel dialog open, at 1568 and 390 (${theme})`, async ({ page, context, baseURL }) => {
    const { api, runId } = await sandbox(context, baseURL!);
    await api.dispose();
    await seedTheme(page, theme);
    for (const width of [1568, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await openRun(page, runId);
      if (width === 390) {
        const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(size.scroll, 'the page must not scroll sideways').toBeLessThanOrEqual(size.client);
      }
      await snap(page, `cancel-card-${width}`, theme);
      await page.getByTestId('regular-run-cancel').getByRole('button', { name: 'Cancel run' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      // The dialog fades in: axe measures a button mid-fade as low contrast, so wait for every transition to end.
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
      await settle(page);
      expect(await seriousAxe(page)).toEqual([]);
      await snap(page, `cancel-dialog-${width}`, theme);
      await page.getByRole('button', { name: 'Keep run' }).click();
    }
  });
}
