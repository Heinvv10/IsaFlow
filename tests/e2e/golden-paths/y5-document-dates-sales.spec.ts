// golden:dev-only
/**
 * Golden path Y5 - document dates in Sales, Purchases, Banking and Inventory are typed DateFields (master plan
 * wave 2, PR A), and the off-core pages A touched pass AA contrast.
 *
 * Dev only (axe and the contrast walker are keyed to dev data). Read-only: nothing is saved.
 *   - payment new, PO new and supplier invoice new: "t" and "+30" are understood and echoed, and the page has
 *     no native date input;
 *   - payment new has 0 critical axe violations;
 *   - Credit Notes, Supplier Ledger, VAT Adjustments and PO new have 0 text below AA in both themes.
 * EVIDENCE_DIR=<dir> saves a screenshot of each screen; THEME=light|dark picks the theme for the date screens.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { auditContrast } from '../helpers/themeContrast';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const THEME = process.env.THEME === 'light' ? 'light' : 'dark';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DATE_SCREENS = [
  { slug: 'payment-new', path: '/accounting/customer-payments/new', heading: 'Record Customer Payment', label: 'Payment Date' },
  { slug: 'po-new', path: '/accounting/purchase-orders/new', heading: 'Purchase Order', label: 'Order Date' },
  { slug: 'supplier-invoice-new', path: '/accounting/supplier-invoices/new', heading: 'Supplier Invoice', label: 'Invoice Date' },
] as const;

const CONTRAST_PAGES = [
  { slug: 'credit-notes', path: '/accounting/credit-notes' },
  { slug: 'supplier-ledger', path: '/accounting/reports/supplier-ledger' },
  { slug: 'vat-adjustments', path: '/accounting/vat-adjustments' },
  { slug: 'po-new', path: '/accounting/purchase-orders/new' },
] as const;

async function settle(page: Page): Promise<void> {
  await page.waitForSelector('main', { timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector('.animate-spin, .animate-pulse, [aria-busy="true"]'), undefined, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

async function snap(page: Page, name: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` });
}

/** What DateField shows for today + n days ("27 Nov 2026"), from the browser's own clock, the one DateField reads. */
async function shownIn(page: Page, days: number): Promise<string> {
  return page.evaluate(([n, months]) => {
    const d = new Date();
    d.setDate(d.getDate() + (n as number));
    return `${String(d.getDate()).padStart(2, '0')} ${(months as string[])[d.getMonth()]} ${d.getFullYear()}`;
  }, [days, MONTHS] as const);
}

/** The ledger's own buttons and rows only render once a supplier is chosen and the report has run. */
async function runLedger(page: Page): Promise<void> {
  await page.getByPlaceholder('Search supplier…').fill('Golden');
  await page.getByRole('button', { name: /Golden-Supplier/ }).first().click();
  await page.getByRole('button', { name: 'Run Report' }).click();
  await expect(page.getByRole('table').first()).toBeVisible({ timeout: 30_000 });
  await settle(page);
}

for (const s of DATE_SCREENS) {
  test(`${s.slug}: "t" and "+30" are understood, with no native date input`, async ({ page }) => {
    await page.addInitScript((t) => window.localStorage.setItem('accounting-theme', t), THEME);
    await page.goto(s.path);
    await expect(page.getByRole('heading', { name: s.heading })).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname, 'no redirect').toBe(s.path);
    await settle(page);
    expect(await page.locator('input[type="date"]').count(), 'native date inputs').toBe(0);

    const field = page.getByLabel(s.label);
    await field.fill('t');
    await field.press('Tab');
    await expect(field).toHaveValue(await shownIn(page, 0));
    await expect(page.getByText(/^\w+day, \d{1,2} \w+ \d{4}$/).first()).toBeVisible();

    await field.fill('+30');
    await field.press('Tab');
    await expect(field).toHaveValue(await shownIn(page, 30));

    await field.fill('zz');
    await field.press('Tab');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await snap(page, `${s.slug}-${THEME}`);
  });
}

test('payment new: 0 critical axe violations', async ({ page }) => {
  await page.goto('/accounting/customer-payments/new');
  await expect(page.getByRole('heading', { name: 'Record Customer Payment' })).toBeVisible({ timeout: 30_000 });
  await settle(page);
  const results = await new AxeBuilder({ page }).exclude('header button[aria-label^="Setup guide"]').analyze();
  const critical = results.violations.filter((v) => v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(critical).toEqual([]);
});

test.describe('AA contrast on the pages A touched', () => {
  test.setTimeout(240_000);
  for (const pg of CONTRAST_PAGES) {
    test(`${pg.slug}: 0 text below AA in light and dark`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      for (const theme of ['light', 'dark'] as const) {
        await page.addInitScript((t) => window.localStorage.setItem('accounting-theme', t), theme);
        await page.goto(pg.path, { waitUntil: 'domcontentloaded' });
        await settle(page);
        if (pg.slug === 'supplier-ledger') await runLedger(page);
        if (pg.slug === 'vat-adjustments') await page.getByRole('button', { name: /new adjustment/i }).click();
        const walker = await auditContrast(page);
        await snap(page, `${pg.slug}-contrast-${theme}`);
        const detail = walker.failing.slice(0, 8).map((f) => `${f.ratio}<${f.required} ${f.el} "${f.text}"`);
        expect(walker.total, `${pg.slug}.${theme}: page measured`).toBeGreaterThan(10);
        expect(walker.failing, `${pg.slug}.${theme}: text below AA\n${detail.join('\n')}`).toHaveLength(0);
      }
    });
  }
});
