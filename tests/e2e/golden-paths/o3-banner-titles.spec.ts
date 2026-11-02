// golden:dev-only
/**
 * Golden path O3 - the pages that once drew an always-dark banner (master plan 3b.1, wave 3 PR V).
 *
 * 16 "New Document" / list pages drew their header on a dark gradient with a near-black h1 in the light theme,
 * held up by a rule in styles/themeContrast.css. They now use the token-based PageHeader and the rule is gone. In
 * both themes this spec requires of each page: the h1 is there and sits on no gradient (a rendered census of the
 * banner; tests/unit/ci/themeContrastBanner.test.ts is the source census), and the walker in
 * tests/e2e/helpers/themeContrast.ts finds no text below AA, the title included, and axe finds nothing serious or
 * critical. It also proves `font-id` keeps the app face. Demo data and axe, so dev-only.
 *
 * Evidence mode: BANNER_EVIDENCE_DIR=<dir> writes a screenshot per page and theme and title-contrast-<page>.json.
 * Read-only: writes no data.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { auditContrast } from '../helpers/themeContrast';
import { THEMES, seedTheme, settle } from '../helpers/themeSpec';

/** The 15 pages wave 3 PR V converted. The 16th, the invoice edit page, needs a draft's id: see its own test. */
const PAGES = [
  { slug: 'bank-transactions-new', path: '/accounting/bank-transactions/new', title: 'Spend Money' },
  { slug: 'batch-payments-new', path: '/accounting/batch-payments/new', title: 'New Batch Payment' },
  { slug: 'credit-notes', path: '/accounting/credit-notes', title: 'Credit Notes' },
  { slug: 'credit-notes-new', path: '/accounting/credit-notes/new', title: 'New Credit Note' },
  { slug: 'customer-payments-new', path: '/accounting/customer-payments/new', title: 'Record Customer Payment' },
  { slug: 'delivery-notes-new', path: '/accounting/delivery-notes/new', title: 'Delivery Note' },
  { slug: 'goods-received-new', path: '/accounting/goods-received/new', title: 'New Goods Received Note' },
  { slug: 'items-new', path: '/accounting/items/new', title: /^New Item/ },
  { slug: 'purchase-orders', path: '/accounting/purchase-orders', title: 'Purchase Orders' },
  { slug: 'purchase-orders-new', path: '/accounting/purchase-orders/new', title: 'Purchase Order' },
  { slug: 'recurring-invoices-new', path: '/accounting/recurring-invoices/new', title: 'Recurring Invoice' },
  { slug: 'supplier-credit-notes', path: '/accounting/supplier-credit-notes', title: 'Supplier Credit Notes' },
  { slug: 'supplier-credit-notes-new', path: '/accounting/supplier-credit-notes/new', title: 'Supplier Credit Note' },
  { slug: 'supplier-invoices-new', path: '/accounting/supplier-invoices/new', title: 'Supplier Invoice' },
  { slug: 'supplier-payments-new', path: '/accounting/supplier-payments/new', title: 'New Supplier Payment' },
] as const;

const evidenceDir = process.env.BANNER_EVIDENCE_DIR;

test.setTimeout(240_000);

/** Is any box from the h1 up to <main> painted with a gradient? */
function titleSitsOnGradient(): boolean {
  for (let el = document.querySelector('main h1'); el && el.tagName !== 'MAIN'; el = el.parentElement) {
    if (getComputedStyle(el).backgroundImage.includes('gradient')) return true;
  }
  return false;
}

async function expectPageReads(page: Page, slug: string, path: string, title: string | RegExp): Promise<void> {
  const results: Record<string, unknown> = {};
  for (const theme of THEMES) {
    await seedTheme(page, theme);
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.waitForSelector(`html[data-theme-applied="${theme}"]`);
    // A list page is measured with its rows (or its empty state) on screen.
    if (!/\/(new|edit\/[^/]+)$/.test(path)) await page.waitForSelector('tbody tr, main :text-matches("^No [a-z ]+", "i")', { timeout: 30_000 });
    await expect(page.locator('main h1'), `${slug} ${theme}: the title`).toHaveText(title);
    expect(await page.evaluate(titleSitsOnGradient), `${slug} ${theme}: the title sits on a gradient, a banner is back`).toBe(false);
    const report = await auditContrast(page);
    results[theme] = report;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      await page.screenshot({ path: join(evidenceDir, `${slug}-${theme}.png`), clip: { x: 0, y: 0, width: 1280, height: 330 } });
      writeFileSync(join(evidenceDir, `title-contrast-${slug}.json`), JSON.stringify(results, null, 1));
    }
    expect(report.total, `${slug} ${theme}: the page rendered text`).toBeGreaterThan(5);
    expect(report.failing, `${slug} ${theme}: text below AA`).toEqual([]);
    await expectNoSeriousA11yViolations(page);
  }
}

for (const { slug, path, title } of PAGES) {
  test(`${slug}: a token header, with every text at AA in light and dark`, async ({ page }) => {
    await expectPageReads(page, slug, path, title);
  });
}

test('customer-invoices-edit: a token header, with every text at AA in light and dark', async ({ page }) => {
  const res = await page.request.get('/api/accounting/customer-invoices-list?status=draft&limit=1');
  expect(res.ok(), 'the draft list loads').toBe(true);
  const { data } = await res.json() as { data: { invoices: { id: string; invoice_number: string }[] } };
  const draft = data.invoices[0];
  test.skip(!draft, 'the company has no draft invoice to open; the source census still covers this page');
  await expectPageReads(page, 'customer-invoices-edit', `/accounting/customer-invoices/edit/${draft!.id}`, draft!.invoice_number);
});

test('a provisional bank line: its badge reads at AA in light and dark', async ({ page }) => {
  await page.route('**/api/accounting/bank-transactions?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { data: { transactions: { status: string }[] } };
    body.data.transactions[0]!.status = 'provisional';
    await route.fulfill({ response, json: body });
  });
  for (const theme of THEMES) {
    await seedTheme(page, theme);
    await page.goto('/accounting/bank-transactions', { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.waitForSelector(`html[data-theme-applied="${theme}"]`);
    await expect(page.getByTitle('Posted by AI — needs evidence'), `${theme}: the badge is on the row`).toBeVisible({ timeout: 30_000 });
    const { failing } = await auditContrast(page);
    expect(failing.filter((f) => f.text.includes('Provisional')), `${theme}: the badge`).toEqual([]);
  }
});

test('font-id keeps the app face, with tabular figures and a zero that really is slashed', async ({ page }) => {
  await page.goto('/accounting/credit-notes', { waitUntil: 'domcontentloaded' });
  await settle(page);
  const seen = await page.evaluate(async () => {
    const main = document.querySelector('main')!;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:#fff;color:#000;font-size:48px;width:400px;';
    box.innerHTML = '<span id="o3-id" class="font-id">0</span> <span id="o3-plain">0</span>';
    main.appendChild(box);
    await document.fonts.ready;
    const style = getComputedStyle(document.getElementById('o3-id')!);
    return { font: style.fontFamily, numeric: style.fontVariantNumeric, app: getComputedStyle(main).fontFamily };
  });
  expect(seen.font).toBe(seen.app);
  expect(seen.font).not.toMatch(/mono/i);
  expect(seen.numeric).toContain('tabular-nums');
  expect(seen.numeric).toContain('slashed-zero');
  // A computed style proves the request, not the glyph: a face without the `zero` feature paints the plain zero.
  const painted = await page.locator('#o3-id').screenshot();
  const plain = await page.locator('#o3-plain').screenshot();
  expect(painted.equals(plain), 'the figures face must carry the slashed zero').toBe(false);
});
