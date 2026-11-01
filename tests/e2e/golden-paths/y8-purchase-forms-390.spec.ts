/**
 * Golden path Y8 - the purchase order and supplier invoice forms on a phone (wave-2 re-score: both were unusable at
 * 390 px: the summary card sat on the form, which was squeezed to a ~20 px column with date labels printed over each
 * other, and no sideways scroll to show for it). The same stack as the customer invoice (Y1): one column of fields,
 * the summary under the form, the line table scrolling inside its own region. Nothing is saved.
 */
// golden:dev-only
// Dev only: it measures layout, which the post-deploy run has no use for. The post-deploy run skips it by this marker.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const FORMS = [
  { path: '/accounting/purchase-orders/new', title: 'Purchase Order', summary: 'Order Summary', notes: 'Add any notes or delivery instructions…', lines: 'Purchase order lines' },
  { path: '/accounting/supplier-invoices/new', title: 'Supplier Invoice', summary: 'Summary', notes: 'Optional notes…', lines: 'Invoice lines' },
];
type Form = (typeof FORMS)[number];

async function open(page: Page, form: Form): Promise<void> {
  await page.goto(form.path, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: form.title, level: 1 })).toBeVisible({ timeout: 60_000 });
  await settle(page);
}

const cardOf = (el: Locator): Locator => el.locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
const summaryCard = (page: Page, form: Form): Locator => cardOf(page.getByRole('heading', { name: form.summary, exact: true }));

async function box(el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await el.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
}

/** Fields outside the line table narrower than `min`, and pairs of labels / controls / buttons drawn over each other. */
const layoutFaults = (page: Page, min: number) => page.evaluate((minWidth) => {
  const seen = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const narrow = [...document.querySelectorAll('main input:not([type=hidden]):not([type=checkbox]), main select, main textarea')]
    .filter((e) => seen(e) && !e.closest('[role=region]') && e.getBoundingClientRect().width < minWidth)
    .map((e) => (e as HTMLInputElement).name || e.tagName);
  const els = [...document.querySelectorAll('main label, main input:not([type=hidden]), main select, main textarea, main button')].filter(seen);
  const overlaps: string[] = [];
  els.forEach((a, i) => els.slice(i + 1).forEach((b) => {
    if (a.contains(b) || b.contains(a)) return;
    const p = a.getBoundingClientRect(); const q = b.getBoundingClientRect();
    if (Math.min(p.right, q.right) - Math.max(p.left, q.left) > 4 && Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 4) {
      overlaps.push(`${(a.textContent ?? '').trim().slice(0, 20) || a.tagName} x ${(b.textContent ?? '').trim().slice(0, 20) || b.tagName}`);
    }
  }));
  return { narrow, overlaps };
}, min);

for (const form of FORMS) {
  for (const theme of THEMES) {
    test(`${form.title} 390 px (${theme}): fields stack, the summary sits under the form`, async ({ page }) => {
      await seedTheme(page, theme);
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, form);
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scroll, 'the page must not scroll sideways').toBeLessThanOrEqual(390);
      expect(await layoutFaults(page, 200)).toEqual({ narrow: [], overlaps: [] });
      const summary = await box(summaryCard(page, form));
      const notes = await box(page.getByPlaceholder(form.notes));
      expect(summary.y, 'summary starts below the last form card').toBeGreaterThanOrEqual(notes.y + notes.height);
      expect(summary.x + summary.width).toBeLessThanOrEqual(390);
      const add = page.getByRole('button', { name: 'Add Line' });
      const [addBox, lineCard] = [await box(add), await box(cardOf(add))];
      expect(addBox.x + addBox.width, 'Add Line stays inside the Line Items card').toBeLessThanOrEqual(lineCard.x + lineCard.width);
    });
  }

  test(`${form.title} 390 px: the line table scrolls in its own region, down to Remove line`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, form);
    const region = page.getByRole('region', { name: form.lines });
    const remove = region.getByRole('button', { name: 'Remove line 1' });
    await remove.scrollIntoViewIfNeeded();
    const b = await box(remove);
    expect(b.x + b.width, 'Remove line can be brought on screen').toBeLessThanOrEqual(390);
    expect(await remove.evaluate((e) => getComputedStyle(e).opacity), 'a phone has no hover to reveal it').toBe('1');
  });

  test(`${form.title} 1280 px: the table scrolls under the summary and says so, or fits and says nothing`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, form);
    const region = page.getByRole('region', { name: form.lines });
    const overflows = await region.evaluate((e) => e.scrollWidth > e.clientWidth + 1);
    const hint = page.getByText('Scroll sideways to see every column.');
    await expect(hint, 'the hint shows exactly when columns are clipped').toHaveCount(overflows ? 1 : 0);
    if (overflows) {
      const remove = region.getByRole('button', { name: 'Remove line 1' });
      await remove.scrollIntoViewIfNeeded();
      const [r, g] = [await box(region), await box(remove)];
      expect(g.x + g.width, 'Remove line can be scrolled into its region').toBeLessThanOrEqual(r.x + r.width + 1);
    }
  });

  test(`${form.title} 1568 px: the summary sits beside the form`, async ({ page }) => {
    await page.setViewportSize({ width: 1568, height: 900 });
    await open(page, form);
    const summary = await box(summaryCard(page, form));
    const notes = await box(page.getByPlaceholder(form.notes));
    expect(summary.x, 'summary starts right of the form').toBeGreaterThanOrEqual(notes.x + notes.width);
    expect(await layoutFaults(page, 0)).toEqual({ narrow: [], overlaps: [] });
  });
}
