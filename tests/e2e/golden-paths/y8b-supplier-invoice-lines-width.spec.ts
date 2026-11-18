/**
 * Golden path Y8b - the supplier invoice lines on a desktop (PR #1614 review). The lines measure their own box and are
 * a table when it can hold the columns (820px, 1060px with Dimensions), stacked cards below that. The 320px summary
 * sits beside the lines only while the lines can still be a table next to it; narrower, it moves under them, so a
 * 1366 px laptop with the sidebar open gets a table instead of cards. Y8 holds the phone checks. Nothing is saved.
 */
// golden:dev-only
// Dev only: it measures layout, which the post-deploy run has no use for. The post-deploy run skips it by this marker.
import { expect, test, type Page } from '@playwright/test';
import { settle } from '../helpers/themeSpec';

const PATH = '/accounting/supplier-invoices/new';

async function open(page: Page, nav: 'top' | 'side', dims: boolean): Promise<void> {
  await page.addInitScript((mode) => {
    localStorage.setItem('accounting-nav-mode', mode);
    localStorage.setItem('accounting-sidebar-collapsed', 'false');
  }, nav);
  await page.goto(PATH, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Supplier Invoice', level: 1 })).toBeVisible({ timeout: 60_000 });
  await settle(page);
  if (dims) await page.getByRole('button', { name: 'Dimensions', exact: true }).click();
  await expect(page.getByRole('button', { name: dims ? 'Hide Dimensions' : 'Dimensions', exact: true })).toBeVisible();
}

const region = (page: Page) => page.getByRole('region', { name: 'Invoice lines' });
const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
};

/** Where the summary card is relative to the line items card, and whether anything scrolls sideways. */
const geometry = (page: Page) => page.evaluate(() => {
  const heading = [...document.querySelectorAll('main h3')].find((h) => h.textContent?.trim() === 'Summary');
  const summary = heading?.closest('.rounded-2xl')?.getBoundingClientRect();
  const lines = document.querySelector('[data-lines-box]')?.closest('.rounded-2xl')?.getBoundingClientRect();
  const main = document.querySelector('main');
  if (!summary || !lines || !main) throw new Error('summary or line items card not found');
  return {
    beside: summary.left >= lines.right,
    below: summary.top >= lines.bottom,
    summaryWidth: summary.width,
    rightEdges: Math.abs(summary.right - lines.right),
    pageScrolls: main.scrollWidth > main.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth,
  };
});

const CASES = [
  // The owner's case: the box was 612px beside the summary, so every line was a card.
  { width: 1366, nav: 'side', dims: false, beside: false },
  // With Dimensions open the table needs 1060px: beside the summary it would be cards, so the summary goes under.
  { width: 1440, nav: 'top', dims: true, beside: false },
  { width: 1920, nav: 'top', dims: false, beside: true },
  { width: 1920, nav: 'side', dims: true, beside: true },
] as const;

for (const c of CASES) {
  test(`${c.width} px, ${c.nav} nav, Dimensions ${c.dims ? 'open' : 'closed'}: the lines are a table, the summary ${c.beside ? 'beside' : 'under'} them`, async ({ page }) => {
    await page.setViewportSize({ width: c.width, height: 768 });
    await open(page, c.nav, c.dims);
    await expect(region(page).getByRole('table'), 'a table, not stacked cards').toHaveCount(1);
    expect(await region(page).evaluate((e) => e.scrollWidth > e.clientWidth + 1), 'no column is clipped').toBe(false);
    await expect(page.getByText('Scroll sideways to see every column.')).toHaveCount(0);
    const g = await geometry(page);
    expect(g.pageScrolls, 'the page does not scroll sideways').toBe(false);
    expect({ beside: g.beside, below: g.below }).toEqual({ beside: c.beside, below: !c.beside });
    if (!c.beside) {
      expect(g.summaryWidth, 'under the lines the summary keeps a card width').toBeLessThanOrEqual(384);
      expect(g.rightEdges, 'and lines up with the right edge of the lines').toBeLessThanOrEqual(1);
      const submit = await box(page, 'main button[type=submit]');
      const notes = await box(page, 'main textarea');
      expect(submit.y, 'Create Invoice follows the form').toBeGreaterThan(notes.y);
    }
  });
}

test('1024 px, side nav: too narrow for the columns even with the summary under them, so the lines are cards', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, 'side', false);
  await expect(region(page).getByRole('table')).toHaveCount(0);
  expect(await region(page).evaluate((e) => e.scrollWidth > e.clientWidth + 1)).toBe(false);
  expect((await geometry(page)).below).toBe(true);
});

/**
 * Steps the viewport across a switch point and back. Every table swapped in or out of the region is counted by a
 * MutationObserver, so a layout that flips back and forth within one step (a loop between the summary's position, a
 * scrollbar and the table/cards rule) is seen even if it happens to settle on the right answer.
 */
async function sweep(page: Page, widths: number[]): Promise<{ modes: string[]; swaps: number; summaryMoves: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { __swaps: number; __watch?: MutationObserver };
    w.__watch?.disconnect();
    w.__swaps = 0;
    w.__watch = new MutationObserver((records) => {
      for (const r of records) for (const n of [...r.addedNodes, ...r.removedNodes]) if (n.nodeName === 'TABLE') w.__swaps += 1;
    });
    w.__watch.observe(document.querySelector('[role=region][aria-label="Invoice lines"]')!, { childList: true });
  });
  const modes: string[] = [];
  const sides: boolean[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 768 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    modes.push((await region(page).getByRole('table').count()) === 1 ? 'table' : 'cards');
    sides.push((await geometry(page)).beside);
  }
  const swaps = await page.evaluate(() => (window as unknown as { __swaps: number }).__swaps);
  return { modes, swaps, summaryMoves: sides.filter((s, i) => i > 0 && s !== sides[i - 1]).length };
}
const changes = (modes: string[]) => modes.filter((m, i) => i > 0 && m !== modes[i - 1]).length;
const steps = (from: number, to: number, by: number) =>
  Array.from({ length: Math.floor(Math.abs(to - from) / by) + 1 }, (_, i) => from + Math.sign(to - from) * i * by);

test('crossing the table/cards switch point in 4px steps changes the layout exactly once each way', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 768 });
  await open(page, 'top', false);
  const down = await sweep(page, steps(1000, 900, 4));
  expect([down.modes[0], down.modes.at(-1), changes(down.modes), down.swaps]).toEqual(['table', 'cards', 1, 1]);
  const up = await sweep(page, steps(900, 1000, 4));
  expect([up.modes[0], up.modes.at(-1), changes(up.modes), up.swaps]).toEqual(['cards', 'table', 1, 1]);
});

test('crossing the summary breakpoint in 4px steps moves the summary once each way and keeps the table', async ({ page }) => {
  await page.setViewportSize({ width: 1380, height: 768 });
  await open(page, 'top', false);
  const down = await sweep(page, steps(1380, 1300, 4));
  expect([down.modes.every((m) => m === 'table'), down.swaps, down.summaryMoves]).toEqual([true, 0, 1]);
  const up = await sweep(page, steps(1300, 1380, 4));
  expect([up.modes.every((m) => m === 'table'), up.swaps, up.summaryMoves]).toEqual([true, 0, 1]);
});
