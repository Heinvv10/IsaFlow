/**
 * PRD-02 Phase 2 — Payroll golden-path smoke test.
 *
 * Walk-through:
 *  1. Create a pay component (Basic Salary <suffix>)
 *  2. Create an employee
 *  3. Assign the component with amount R 25,000
 *  4. Create a payroll run for the current month
 *  5. Calculate — verify non-zero gross-pay cell
 *
 * Auth: uses storageState from auth.setup.ts (chromium project dependency).
 * Run with: bunx playwright test tests/e2e/payroll-smoke.spec.ts --config playwright-test.config.ts
 */
import { test, expect } from '@playwright/test';

const SUFFIX = String(Date.now()).slice(-6);
const COMP_NAME = `Basic Salary ${SUFFIX}`;
const EMP_NO = `E-P2-${SUFFIX}`;

test.describe('PRD-02 Phase 2 — payroll golden path', () => {
  test('create component → create employee → assign → create run → calculate', async ({ page }) => {
    // ── 1. Create pay component ──────────────────────────────────────────────
    await page.goto('/payroll/components');
    await page.waitForLoadState('networkidle');

    // Fill name — use placeholder-based selector (unique on the page)
    await page.getByPlaceholder('e.g. Basic Salary').fill(COMP_NAME);

    // SARS code defaults to 3601 — leave as-is.
    // Type defaults to "earning" — leave as-is.
    // Taxable / UIF / SDL checkboxes are all checked by default — leave as-is.

    await page.getByRole('button', { name: 'Add component' }).click();

    // Wait for the new row to appear in the table
    await expect(page.locator('table')).toContainText(COMP_NAME, { timeout: 10_000 });

    // ── 2. Create employee ───────────────────────────────────────────────────
    await page.goto('/payroll/employees/new');
    await page.waitForLoadState('networkidle');

    // Labels are plain siblings to their inputs inside a div wrapper.
    // Use CSS adjacent-sibling: label:has-text("...") + input
    await page.locator('label:has-text("First name *") + input').fill('Phase');
    await page.locator('label:has-text("Last name *") + input').fill('Two');
    await page.locator('label:has-text("Employee number *") + input').fill(EMP_NO);
    // Start date defaults to today — leave as-is.

    await page.getByRole('button', { name: 'Create Employee' }).click();

    // Expect redirect to /payroll/employees/<uuid>
    await expect(page).toHaveURL(/\/payroll\/employees\/[0-9a-f-]{36}/, { timeout: 10_000 });

    // ── 3. Assign Basic Salary component ────────────────────────────────────
    // Wait for the EmployeeComponentsCard to load (component list is fetched async)
    // The select initially shows "Select a component…" — wait until our component appears.
    await expect(
      page.locator('select').filter({ hasText: COMP_NAME }),
    ).toBeVisible({ timeout: 10_000 });

    // Select by the visible option text: "<COMP_NAME> (earning)"
    await page.locator('label:has-text("Component") + select').selectOption({ label: `${COMP_NAME} (earning)` });

    // Amount field — label "Amount (R)" followed by <input type="number">
    await page.locator('label:has-text("Amount (R)") + input').fill('25000');

    // Effective-from defaults to today — leave as-is.

    await page.getByRole('button', { name: 'Assign' }).click();

    // The assignment should now appear in the table as a <td> with componentName
    await expect(page.locator('td').filter({ hasText: COMP_NAME })).toBeVisible({ timeout: 10_000 });

    // ── 4. Create payroll run for current month ──────────────────────────────
    const today = new Date();
    const currentMonth = today.getMonth() + 1; // 1-based
    const currentYear = today.getFullYear();

    await page.goto('/payroll/runs/new');
    await page.waitForLoadState('networkidle');

    // Month select — option values are 1-12, option text is full month name
    await page.locator('label:has-text("Month") + select').selectOption(String(currentMonth));

    // Year input — already set to current year; overwrite to be safe
    const yearInput = page.locator('label:has-text("Year") + input');
    await yearInput.fill(String(currentYear));

    await page.getByRole('button', { name: 'Create Run' }).click();

    // Expect redirect to /payroll/runs/<uuid>
    await expect(page).toHaveURL(/\/payroll\/runs\/[0-9a-f-]{36}/, { timeout: 10_000 });

    // ── 5. Calculate ─────────────────────────────────────────────────────────
    // Wait for the page to finish loading (status badge and Calculate button appear)
    await expect(page.getByRole('button', { name: /Calculate|Recalculate/ })).toBeEnabled({ timeout: 10_000 });

    await page.getByRole('button', { name: /Calculate|Recalculate/ }).click();

    // After calculation, the run lines table should show the employee's gross pay.
    // formatCurrency(25000) with en-ZA locale = "R 25 000,00"
    // Allow for minor locale variations: match "R" followed by "25" somewhere in the cell.
    await expect(
      page.locator('td').filter({ hasText: /R\s*25[\s,]?000/ }),
    ).toBeVisible({ timeout: 20_000 });
  });
});
