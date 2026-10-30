// golden:dev-only
/**
 * Golden path (y6): document dates elsewhere, the VAT201 request count, timesheets contrast, the module-nav grid
 * (master plan wave 2, PR Y).
 *
 * Read-only (typing into a form is not submitting it). Dev-only: it measures layout, contrast and the request count of
 * a dev server under React StrictMode, which a production build does not reproduce.
 *   - leave new and the practice job form: no native date input; typed text is understood, "zz" is refused;
 *   - timesheets in dark: 0 texts below AA;
 *   - VAT201 Generate sends exactly one vat-exceptions request;
 *   - the module-nav tabs pad on the 4 px grid.
 * EVIDENCE_DIR=<dir> also saves a screenshot of each screen; THEME=light|dark picks the theme it is taken in.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { auditContrast } from '../helpers/themeContrast';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const THEME = process.env.THEME === 'light' ? 'light' : 'dark';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem('accounting-theme', t), THEME);
});

async function snap(page: Page, name: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${THEME}.png`, fullPage: false });
}

/** A required DateField's label carries a "*", so match the label by its start. */
function dateField(page: Page, label: string): Locator {
  return page.getByLabel(new RegExp(`^${label}`));
}

async function typeDate(page: Page, label: string, text: string): Promise<void> {
  const field = dateField(page, label);
  await field.fill(text);
  await field.press('Tab');
}

test.setTimeout(180_000);

test('leave new: typed dates are understood and "zz" is refused', async ({ page }) => {
  await page.goto('/payroll/leave/new');
  await expect(page.getByRole('heading', { name: 'New Leave Request' })).toBeVisible({ timeout: 60_000 });
  await page.locator('input[placeholder="dd MMM yyyy"]').first().waitFor({ state: 'visible', timeout: 30_000 });
  expect(await page.locator('input[type="date"]').count(), 'no native date input').toBe(0);
  await typeDate(page, 'Start Date', '5 Oct 2026');
  await expect(page.getByText('Monday, 5 October 2026')).toBeVisible();
  await typeDate(page, 'End Date', 'zz');
  await expect(dateField(page, 'End Date')).toHaveAttribute('aria-invalid', 'true');
  await snap(page, 'y6-leave-new');
});

test('practice job form: the due date is a typed field', async ({ page }) => {
  await page.goto('/accounting/practice/jobs/new');
  await page.locator('input[placeholder="dd MMM yyyy"]').first().waitFor({ state: 'visible', timeout: 60_000 });
  expect(await page.locator('input[type="date"]').count(), 'no native date input').toBe(0);
  await typeDate(page, 'Due Date', '31 Dec 2026');
  await expect(page.getByText('Thursday, 31 December 2026')).toBeVisible();
  await snap(page, 'y6-practice-job-new');
});

test('timesheets: no text below AA', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/accounting/timesheets', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Timesheets' }).waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector('.animate-spin, .animate-pulse, [aria-busy="true"]'), undefined, { timeout: 30_000 });
  const report = await auditContrast(page);
  await snap(page, 'y6-timesheets');
  expect(report.total, 'page measured').toBeGreaterThan(20);
  expect(report.failing, JSON.stringify(report.failing.slice(0, 5))).toEqual([]);
});

test('VAT201 Generate sends one vat-exceptions request', async ({ page }) => {
  const exceptionRequests: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/accounting/sars/vat-exceptions')) exceptionRequests.push(r.url()); });
  await page.goto('/accounting/sars/vat201');
  const generate = page.getByRole('button', { name: /generate/i }).first();
  await generate.waitFor({ state: 'visible', timeout: 60_000 });
  await expect(generate).toBeEnabled({ timeout: 30_000 });
  await generate.click();
  await expect(page.getByRole('heading', { name: 'Pre-filing Exceptions' })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500); // a second request, if any, is sent right after the first
  expect(exceptionRequests, exceptionRequests.join('\n')).toHaveLength(1);
  await snap(page, 'y6-vat201-generate');
});

test('module nav: the tabs pad on the 4 px grid', async ({ page }) => {
  await page.goto('/accounting/sars/vat201');
  await page.locator('[data-tour^="nav-"]').first().waitFor({ state: 'visible', timeout: 60_000 });
  const off = await page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll('[data-tour^="nav-"] a, [data-tour^="nav-"] button').forEach((el) => {
      const s = getComputedStyle(el);
      for (const k of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'] as const) {
        const v = parseFloat(s[k]);
        if (v > 0 && v % 4 !== 0) bad.push(`${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 20)} ${k}=${v}`);
      }
    });
    return bad;
  });
  expect(off, 'off-grid module-nav padding').toEqual([]);
});
