// golden:dev-only
/**
 * Golden path (z6): the pay-run review grid (master plan wave 3, R).
 *
 *  - Type a once-off amount, Enter: the cursor moves down, the row says Saved and the server's new net is on screen, with no Calculate.
 *  - Open approve, read the plain sentence, Cancel. Nothing is approved.
 *  - HD: an hourly employee (Z6-3) has an Hours cell; typing hours shows the server's pricing (hours x rate) and the line's gross
 *    is exactly that. The monthly employees have no Hours cell. An hourly employee with no hours blocks the approval sentence.
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
import { clearPayRunApproval } from './helpers/payRunApproval';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';
import { formatCurrency } from '../../../src/utils/formatters';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX_NAME = '0GP Golden Pay Run Sandbox';
const SANDBOX_ONBOARDING_ID = '0f6d1a52-7c3e-4e0b-9a44-5b1e6c2f7d10';
const RUN = { month: 11, year: 2026 };
const EMPLOYEES = [['Z6-1', 'Zanele', 'Grid', 30000], ['Z6-2', 'Pieter', 'Grid', 24000]] as const;
const HOURLY = { employeeNumber: 'Z6-3', firstName: 'Hanna', lastName: 'Grid', rate: 85.5, baseline: 160 } as const;
const CELL = 'Once-off earning, Zanele Grid';

type Named = { id: string; name: string };
type Employee = { id: string; employeeNumber: string };
type Run = { id: string; periodMonth: number; periodYear: number; status: string };

type Assignment = { id: string; componentId: string; effectiveFrom: string; effectiveTo: string | null };

/**
 * The grid's precondition: no Overtime cell in conflict (an employee-page row the grid cannot show), else that row's
 * cell is "Edit on the employee page" and the column has no cell to type in. A throwaway wave-3 probe spec (zz-tmp,
 * 2026-11-01) left one on Z6-2. A conflicting employee's Overtime rows are voided the way a user would (end with
 * cancel: no paid run read them), so z6 is idempotent.
 */
async function voidStrayOvertime(api: Api, employeeId: string, overtimeId: string): Promise<void> {
  const rows = await api.get<Assignment[]>(`/api/payroll/employees/${employeeId}/components`);
  // Dates arrive as ISO instants; compare them as instants. A cancelled row ends the day before it starts.
  const live = (a: Assignment) => a.effectiveTo === null || Date.parse(a.effectiveTo) >= Date.parse(a.effectiveFrom);
  for (const a of rows.filter((r) => r.componentId === overtimeId && live(r))) {
    // cancel voids the row whatever the date (payrollComponentDateEdit); the date only has to parse.
    await api.del(`/api/payroll/employees/${employeeId}/components?aid=${a.id}`, { effectiveTo: '2026-01-01', cancel: true });
  }
}

type InputsState = { inputs: { amounts: Array<{ employeeId: string; quantity: number | null }>; hours: { componentId: string | null } } };

/** The grid's own request: the quantity, with what the cell holds; the server prices it. */
async function setHours(api: Api, runId: string, employeeId: string, quantity: number): Promise<void> {
  const { inputs } = await api.get<InputsState>(`/api/payroll/runs/${runId}/inputs`);
  const held = inputs.amounts.find((a) => a.employeeId === employeeId)?.quantity ?? 0;
  if (held !== quantity) await api.put(`/api/payroll/runs/${runId}/inputs`, { employeeId, quantity, expectedQuantity: held });
}

/** One sandbox run with two salaried employees and an Overtime component, made once through the API. */
async function sandboxRun(api: Api): Promise<{ runId: string; overtimeId: string; employeeId: string; hourlyId: string }> {
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
  // HD: one hourly employee, paid in hours only (no salary row).
  const hourlyId = existing.find((e) => e.employeeNumber === HOURLY.employeeNumber)?.id ?? (await api.post<{ id: string }>('/api/payroll/employees', {
    employeeNumber: HOURLY.employeeNumber, firstName: HOURLY.firstName, lastName: HOURLY.lastName, employmentType: 'permanent',
    startDate: '2024-01-01', payBasis: 'hourly', hourlyRate: HOURLY.rate, hoursPerWeek: 40, hoursPerDay: 8,
  })).id;

  const runs = await api.get<Run[]>('/api/payroll/runs');
  const found = runs.find((r) => r.periodMonth === RUN.month && r.periodYear === RUN.year);
  const runId = found?.id ?? (await api.post<Run>('/api/payroll/runs', RUN)).id;
  const { inputs } = await api.get<{ inputs: { amounts: Array<{ employeeId: string; componentId: string; conflict: boolean }> } }>(`/api/payroll/runs/${runId}/inputs`);
  for (const a of inputs.amounts.filter((x) => x.conflict && x.componentId === overtimeId && ids.includes(x.employeeId))) {
    await voidStrayOvertime(api, a.employeeId, overtimeId);
  }
  // The baseline the other tests approve against: an hourly employee with no hours blocks the approval sentence.
  await setHours(api, runId, hourlyId, HOURLY.baseline);
  await api.post(`/api/payroll/runs/${runId}/calculate`);
  return { runId, overtimeId, employeeId: ids[0]!, hourlyId };
}

async function open(page: Page, runId: string): Promise<void> {
  await page.goto(`/payroll/runs/${runId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Payroll Run — Nov 2026' })).toBeVisible({ timeout: 60_000 });
  const picker = page.getByRole('combobox', { name: 'Once-off earning component' });
  await expect(picker).toBeVisible({ timeout: 30_000 });
  // The kit Select (wave 4 PS): open the picker, choose the option by its label.
  await picker.click();
  await page.getByRole('option', { name: 'Overtime (3607)' }).click();
  await expect(picker).toHaveText('Overtime (3607)');
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
    await expect(row(page).getByText(/^Saved/)).toBeInViewport({ timeout: 15_000 });
    // The recalculation replaces every line row in the database; the cursor must not notice.
    await expect(page.getByLabel('Once-off earning, Pieter Grid')).toBeFocused();
    const after = await netOf();
    expect(after.grossPay).toBeCloseTo(before.grossPay + 1234.5, 2);
    expect(after.netPay).toBeLessThan(after.grossPay);
    expect(after.netPay).toBeGreaterThan(before.netPay);
    await expect(row(page)).toContainText(formatCurrency(after.netPay));
    await snap(page, 'payrun-grid-saved', 'light');

    await clearPayRunApproval(api, baseURL!, runId, { selfApprove: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /review & approve/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/^Paying 3 employees R\s[\d\s]+\.\d\d net for November 2026\. Cost to the company R\s[\d\s]+\.\d\d \(gross plus employer UIF and SDL, less ETI used\)\.$/))
      .toBeVisible({ timeout: 15_000 });
    await snap(page, 'payrun-approve-sentence', 'light');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect((await api.get<Run>(`/api/payroll/runs/${runId}`)).status).toBe('calculated');
  } finally {
    const { inputs } = await api.get<{ inputs: { amounts: Array<{ employeeId: string; componentId: string; amount: number | null }> } }>(`/api/payroll/runs/${runId}/inputs`);
    const held = inputs.amounts.find((a) => a.employeeId === employeeId && a.componentId === overtimeId);
    await api.put(`/api/payroll/runs/${runId}/inputs`, { employeeId, componentId: overtimeId, amount: 0, expectedAmount: held?.amount ?? 0 });
    await api.dispose();
  }
});

test('hours: an hourly employee has an Hours cell, the server prices it, a monthly one has none', async ({ page, context, baseURL }) => {
  const { api, runId, hourlyId } = await sandbox(context, baseURL!);
  const grossOf = async () => (await api.get<{ lines: Array<{ employeeId: string; grossPay: number }> }>(`/api/payroll/runs/${runId}`))
    .lines.find((l) => l.employeeId === hourlyId)!.grossPay;
  try {
    await open(page, runId);
    await expect(page.getByLabel('Hours, Zanele Grid')).toHaveCount(0);
    const hours = page.getByLabel('Hours, Hanna Grid');
    await expect(hours).toHaveValue(String(HOURLY.baseline));
    await hours.click();
    await hours.fill('173,5');
    await hours.press('Enter');
    const hanna = page.getByRole('row').filter({ hasText: 'Z6-3' });
    await expect(hanna.getByText(/^Saved/)).toBeInViewport({ timeout: 15_000 });
    await expect(hours).toHaveValue('173.5');
    expect(await grossOf()).toBeCloseTo(173.5 * HOURLY.rate, 2); // 14 834.25
    await expect(hanna).toContainText(formatCurrency(173.5 * HOURLY.rate));
    await snap(page, 'payrun-grid-hours', 'light');
    await hours.fill('745');
    await hours.press('Tab');
    await expect(page.getByText('A month holds at most 744 hours.')).toBeVisible();
    await snap(page, 'payrun-grid-hours-refused', 'light');
  } finally {
    await setHours(api, runId, hourlyId, HOURLY.baseline);
    await api.dispose();
  }
});

for (const theme of THEMES) {
  test(`no serious axe violation on the grid, and no sideways scroll at 390 (${theme})`, async ({ page, context, baseURL }) => {
    const { api, runId } = await sandbox(context, baseURL!);
    await clearPayRunApproval(api, baseURL!, runId, { selfApprove: true });
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
