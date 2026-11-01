// golden:dev-only
/**
 * Golden path (z6): the pay-run review grid (master plan wave 3, R).
 *
 *  - Type a once-off amount, Enter: the cursor moves down, the row says Saved and the server's new net is on screen, with no Calculate.
 *  - Open approve, read the plain sentence, Cancel. Nothing is approved.
 *  - axe reports 0 critical and 0 serious, in both themes.
 *  - At 390 the page does not scroll sideways: the table scrolls inside its own frame.
 *  - EVIDENCE_DIR=<dir> saves screenshots (light and dark, 1568 and 390).
 *
 * Dev/CI gate: it writes payroll data, in its own sandbox company and never in Demo. The cell is put back to nothing in
 * `finally`, so the next run starts from the same figures.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';
import { formatCurrency } from '../../../src/utils/formatters';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX_NAME = '0GP Golden Pay Run Sandbox';
const SANDBOX_ONBOARDING_ID = '0f6d1a52-7c3e-4e0b-9a44-5b1e6c2f7d10';
const RUN = { month: 11, year: 2026 };
const EMPLOYEES = [['Z6-1', 'Zanele', 'Grid', 30000], ['Z6-2', 'Pieter', 'Grid', 24000]] as const;
const CELL = 'Once-off earning, Zanele Grid';

type Named = { id: string; name: string };
type Employee = { id: string; employeeNumber: string };
type Run = { id: string; periodMonth: number; periodYear: number; status: string };

/** One sandbox run with two salaried employees and an Overtime component, made once through the API. */
async function sandboxRun(api: Api): Promise<{ runId: string; overtimeId: string; employeeId: string }> {
  const components = await api.get<Named[]>('/api/payroll/components');
  const component = async (name: string, sarsSourceCode: string) => components.find((c) => c.name === name)?.id
    ?? (await api.post<Named>('/api/payroll/components', { name, sarsSourceCode, componentType: 'earning' })).id;
  const salaryId = await component('Basic Salary', '3601');
  const overtimeId = await component('Overtime', '3607');

  const existing = await api.get<Employee[]>('/api/payroll/employees?limit=50');
  const ids: string[] = [];
  for (const [employeeNumber, firstName, lastName, salary] of EMPLOYEES) {
    let id = existing.find((e) => e.employeeNumber === employeeNumber)?.id;
    if (!id) {
      id = (await api.post<{ id: string }>('/api/payroll/employees', {
        employeeNumber, firstName, lastName, employmentType: 'permanent', startDate: '2024-01-01',
      })).id;
      await api.post(`/api/payroll/employees/${id}/components`, { componentId: salaryId, amount: salary, effectiveFrom: '2024-01-01' });
    }
    ids.push(id);
  }

  const runs = await api.get<Run[]>('/api/payroll/runs');
  const found = runs.find((r) => r.periodMonth === RUN.month && r.periodYear === RUN.year);
  const runId = found?.id ?? (await api.post<Run>('/api/payroll/runs', RUN)).id;
  await api.post(`/api/payroll/runs/${runId}/calculate`);
  return { runId, overtimeId, employeeId: ids[0]! };
}

async function open(page: Page, runId: string): Promise<void> {
  await page.goto(`/payroll/runs/${runId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Payroll Run — Nov 2026' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('Once-off earning component')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Once-off earning component').selectOption({ label: 'Overtime (3607)' });
  await settle(page);
}

const row = (page: Page) => page.getByRole('row').filter({ hasText: 'Z6-1' });
async function snap(page: Page, name: string, theme: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}.png`, fullPage: true });
}

async function sandbox(context: BrowserContext, baseURL: string) {
  expect(new URL(baseURL).hostname, 'z6 writes payroll data: dev/CI localhost only').toBe('localhost');
  const api = await Api.login(baseURL);
  const sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  return { api, ...(await sandboxRun(api)) };
}

test('type an amount: Saved, the new net, the approval sentence, cancel', async ({ page, context, baseURL }) => {
  const { api, runId, overtimeId, employeeId } = await sandbox(context, baseURL!);
  const netOf = async () => (await api.get<{ lines: Array<{ employeeId: string; netPay: number; grossPay: number }> }>(`/api/payroll/runs/${runId}`))
    .lines.find((l) => l.employeeId === employeeId)!;
  try {
    await open(page, runId);
    const before = await netOf();
    const cell = page.getByLabel(CELL);
    await cell.click();
    await page.keyboard.type('1 234.50');
    await page.keyboard.press('Enter'); // commits and moves down the column
    await expect(row(page).getByText(/^Saved/)).toBeVisible({ timeout: 15_000 });
    // The recalculation replaces every line row in the database; the cursor must not notice.
    await expect(page.getByLabel('Once-off earning, Pieter Grid')).toBeFocused();
    const after = await netOf();
    expect(after.grossPay).toBeCloseTo(before.grossPay + 1234.5, 2);
    expect(after.netPay).toBeLessThan(after.grossPay);
    expect(after.netPay).toBeGreaterThan(before.netPay);
    await expect(row(page)).toContainText(formatCurrency(after.netPay));

    await page.getByRole('button', { name: /review & approve/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/^Paying 2 employees R\s[\d\s]+\.\d\d net for November 2026\. Cost to the company R\s[\d\s]+\.\d\d \(gross plus employer UIF and SDL, less ETI used\)\.$/))
      .toBeVisible({ timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect((await api.get<Run>(`/api/payroll/runs/${runId}`)).status).toBe('calculated');
  } finally {
    await api.put(`/api/payroll/runs/${runId}/inputs`, { employeeId, componentId: overtimeId, amount: 0 });
    await api.dispose();
  }
});

for (const theme of THEMES) {
  test(`no serious axe violation on the grid, and no sideways scroll at 390 (${theme})`, async ({ page, context, baseURL }) => {
    const { api, runId } = await sandbox(context, baseURL!);
    await api.dispose();
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await open(page, runId);
    const bad = (await new AxeBuilder({ page }).analyze()).violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
    expect(bad).toEqual([]);
    await snap(page, 'payrun-grid-1568', theme);

    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(width.scroll, 'the page must not scroll sideways').toBeLessThanOrEqual(width.client);
    // The inner frames clip: an action past the edge would be unreachable with no sideways scroll to show for it.
    const approve = await page.getByRole('button', { name: /review & approve/i }).boundingBox();
    expect(approve!.x + approve!.width, 'Review & approve stays on screen').toBeLessThanOrEqual(390);
    const narrow = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(narrow.map((v) => v.id)).toEqual([]);
    await snap(page, 'payrun-grid-390', theme);
    await page.getByLabel(CELL).scrollIntoViewIfNeeded();
    await snap(page, 'payrun-grid-390-cells', theme);
  });
}
