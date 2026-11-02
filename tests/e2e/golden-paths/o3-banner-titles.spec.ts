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
    const first = body.data.transactions[0];
    expect(first, 'the company has no bank transaction to mark provisional; seed one in the dev company').toBeDefined();
    first!.status = 'provisional';
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

test('font-id keeps the app face, with tabular figures', async ({ page }) => {
  await page.goto('/accounting/credit-notes', { waitUntil: 'domcontentloaded' });
  await settle(page);
  const seen = await page.evaluate(() => {
    const main = document.querySelector('main')!;
    const id = document.createElement('span');
    id.className = 'font-id';
    main.appendChild(id);
    const style = getComputedStyle(id);
    return { font: style.fontFamily, numeric: style.fontVariantNumeric, app: getComputedStyle(main).fontFamily };
  });
  expect(seen.font).toBe(seen.app);
  expect(seen.font).not.toMatch(/mono/i);
  expect(seen.numeric).toContain('tabular-nums');
  expect(seen.numeric).toContain('slashed-zero');
});

/**
 * A computed style proves the request, not the glyph: a face cut without the `zero` feature computes slashed-zero and
 * paints the plain zero. So paint the figures face's zero twice in two separate boxes at the same integer coordinates,
 * once with font-id and once without, for each of the three cut weights, and require the pixels to differ. A control
 * paints the plain zero twice and requires the pixels to match, so a difference can only come from the glyph.
 * Fails against the pre-re-cut subset: scripts/fonts/cut-figures.sh --no-zero rebuilds it.
 */
const BOX_LEFT: Record<string, number> = { 'o3-a': 0, 'o3-b': 100, 'o3-c': 200 };
for (const weight of [400, 500, 600]) {
  test(`font-id paints a slashed zero at weight ${weight}`, async ({ page }) => {
    await page.goto('/accounting/credit-notes', { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.evaluate(async (w) => {
      const boxes: [string, string, number][] = [['o3-a', 'font-id', 0], ['o3-b', '', 100], ['o3-c', '', 200]];
      for (const [id, cls, left] of boxes) {
        const box = document.createElement('div');
        box.id = id;
        box.style.cssText = `position:fixed;top:300px;left:${left}px;width:100px;height:100px;z-index:2147483647;background:#fff;color:#000;`
          + `font-size:64px;line-height:100px;text-align:center;font-weight:${w};`;
        box.innerHTML = `<span class="${cls}">0</span>`;
        document.body.appendChild(box);
      }
      await document.fonts.load(`${w} 64px "IsaFlow Figures"`, '0');
      await document.fonts.ready;
    }, weight);
    const shot = (id: string) => page.screenshot({ clip: { x: BOX_LEFT[id]!, y: 300, width: 100, height: 100 } });
    const [withId, plain, plainAgain] = [await shot('o3-a'), await shot('o3-b'), await shot('o3-c')];
    expect(plain.equals(plainAgain), `weight ${weight}: two plain zeros paint the same, so the boxes are comparable`).toBe(true);
    expect(withId.equals(plain), `weight ${weight}: the figures face must carry the slashed zero`).toBe(false);
  });
}
