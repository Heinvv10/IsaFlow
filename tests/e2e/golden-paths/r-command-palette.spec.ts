/**
 * Golden path (r): Ctrl+K finds pages, actions and records, and the "?" overlay opens (master plan W1 PR P).
 *
 *  - "vat" + Enter lands on VAT201.
 *  - A demo customer and a demo employee are found by name and open their page.
 *  - "New invoice" runs, and so does "Keyboard shortcuts" from inside the palette.
 *  - A real "?" key press opens the shortcut overlay.
 *  - axe `shell:command-palette` reports 0 serious violations, in both themes.
 *
 * This file imports axe (through helpers/axe and themeSpec), so playwright-golden.config.ts ignores it in the
 * post-deploy run (GOLDEN_SKIP_A11Y=1), like the other axe specs. EVIDENCE=1 saves the screenshots.
 *
 * Read-only: nothing is created (New invoice opens the blank form and leaves it unsaved).
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = 'docs/evidence/master-plan/wave1/palette';
const DIALOG = '[role="dialog"][aria-label="Command palette"]';

async function openPalette(page: Page): Promise<void> {
  await page.goto('/accounting');
  await settle(page);
  await page.keyboard.press('Control+k');
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(page.getByRole('combobox')).toBeFocused();
}

/** First name from a list endpoint, so the spec follows whatever the demo company holds. */
async function firstName(page: Page, url: string, pick: (row: Record<string, unknown>) => string): Promise<string> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} -> ${res.status()}`).toBe(true);
  const body = (await res.json()) as { data: unknown };
  const rows = (Array.isArray(body.data) ? body.data : (body.data as { items?: unknown[] }).items ?? []) as Record<string, unknown>[];
  const name = rows.map(pick).find((n) => n.length >= 4);
  expect(name, `no row in ${url}`).toBeTruthy();
  return name as string;
}

test('"vat" then Enter lands on VAT201, and the row shows where it lives', async ({ page }) => {
  await openPalette(page);
  await page.getByRole('combobox').fill('vat');
  const first = page.getByRole('option').first();
  await expect(first).toContainText('VAT201');
  await expect(first).toContainText('Tax');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/accounting\/sars\/vat201/, { timeout: 30_000 });
});

test('finds a demo customer and a demo employee by name', async ({ page }) => {
  const customer = await firstName(page, '/api/accounting/customers', (r) => String(r.name ?? ''));
  const employee = await firstName(page, '/api/payroll/employees', (r) => String(r.firstName ?? ''));
  await openPalette(page);
  await page.getByRole('combobox').fill(customer.slice(0, 8));
  await expect(page.getByRole('option', { name: new RegExp(customer.slice(0, 8), 'i') }).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('combobox').fill(employee);
  const row = page.getByRole('option').filter({ hasText: 'Employee' }).first();
  await expect(row).toContainText(employee);
  await row.click();
  await page.waitForURL(/\/payroll\/employees\/[0-9a-f-]{36}/, { timeout: 30_000 });
});

test('"New invoice" runs and opens the blank invoice form', async ({ page }) => {
  await openPalette(page);
  await page.getByRole('combobox').fill('new inv');
  await expect(page.getByRole('option').first()).toContainText('New invoice');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/accounting\/customer-invoices\/new/, { timeout: 30_000 });
});

test('"?" opens the shortcut overlay from the page, and from the palette', async ({ page }) => {
  await page.goto('/accounting');
  await settle(page);
  await page.keyboard.press('Shift+Slash');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
  await openPalette(page);
  await page.getByRole('option', { name: /Keyboard shortcuts/ }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});

test('Escape closes the palette and puts focus back on the control that opened it', async ({ page }) => {
  await page.goto('/accounting');
  await settle(page);
  const trigger = page.locator('header button').filter({ hasText: 'Ctrl+K' }).first();
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

for (const theme of THEMES) {
  test(`${theme} theme: the palette is axe-clean, empty and with results`, async ({ page }) => {
    await seedTheme(page, theme);
    await openPalette(page);
    await expect(page.getByRole('option').first()).toBeVisible();
    await expectNoSeriousA11yViolations(page, { include: [DIALOG], key: 'shell:command-palette', includeShell: true });
    if (process.env.EVIDENCE === '1') {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: `${EVIDENCE_DIR}/palette-empty-${theme}.png` });
    }
    await page.getByRole('combobox').fill('vat');
    await expect(page.getByRole('option').first()).toContainText('VAT201');
    await expectNoSeriousA11yViolations(page, { include: [DIALOG], key: 'shell:command-palette', includeShell: true });
    if (process.env.EVIDENCE === '1') await page.screenshot({ path: `${EVIDENCE_DIR}/palette-vat-${theme}.png` });
  });
}
