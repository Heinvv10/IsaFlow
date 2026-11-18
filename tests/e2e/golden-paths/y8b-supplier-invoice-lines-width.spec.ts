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
  const form = document.querySelector('main form');
  if (!summary || !lines || !main || !form) throw new Error('summary, line items card or form not found');
  const pad = getComputedStyle(form);
  return {
    // The width the page grid's container queries read: the form's content box.
    formWidth: form.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight),
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
type Point = { width: number; form: number; beside: boolean; mode: string };
async function sweep(page: Page, widths: number[], height = 768): Promise<{ points: Point[]; swaps: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { __swaps: number; __watch?: MutationObserver };
    w.__watch?.disconnect();
    w.__swaps = 0;
    w.__watch = new MutationObserver((records) => {
      for (const r of records) for (const n of [...r.addedNodes, ...r.removedNodes]) if (n.nodeName === 'TABLE') w.__swaps += 1;
    });
    w.__watch.observe(document.querySelector('[role=region][aria-label="Invoice lines"]')!, { childList: true });
  });
  const points: Point[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const g = await geometry(page);
    points.push({ width, form: g.formWidth, beside: g.beside, mode: (await region(page).getByRole('table').count()) === 1 ? 'table' : 'cards' });
  }
  return { points, swaps: await page.evaluate(() => (window as unknown as { __swaps: number }).__swaps) };
}
const changes = (values: unknown[]) => values.filter((v, i) => i > 0 && v !== values[i - 1]).length;
const steps = (from: number, to: number, by: number) =>
  Array.from({ length: Math.floor(Math.abs(to - from) / by) + 1 }, (_, i) => from + Math.sign(to - from) * i * by);
/** Steps where the summary is not where the rule puts it: beside exactly when the form is at least `bound` wide. */
const misplaced = (points: Point[], bound: number) => points.filter((p) => p.beside !== p.form >= bound).map((p) => `${p.width}: form ${p.form}`);

/** Holds `width` for ~1.5 s and samples six times: the summary and the lines must not move while nothing changes. */
async function idle(page: Page, width: number, height: number): Promise<{ sides: boolean[]; swapsWhileIdle: number }> {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const swapsBefore = await page.evaluate(() => (window as unknown as { __swaps: number }).__swaps);
  const sides: boolean[] = [];
  for (let i = 0; i < 6; i++) {
    sides.push((await geometry(page)).beside);
    await page.waitForTimeout(250);
  }
  return { sides, swapsWhileIdle: (await page.evaluate(() => (window as unknown as { __swaps: number }).__swaps)) - swapsBefore };
}

/** Sweeps down and up across the summary breakpoint `bound`, then idles on the widths either side of the flip. */
async function crossSummaryBreakpoint(page: Page, from: number, to: number, bound: number, height = 768): Promise<void> {
  for (const [a, b] of [[from, to], [to, from]] as const) {
    const { points, swaps } = await sweep(page, steps(a, b, 4), height);
    expect(misplaced(points, bound), `summary beside exactly from a ${bound}px form`).toEqual([]);
    expect([points[0]!.beside !== points.at(-1)!.beside, changes(points.map((p) => p.beside))], 'moves once').toEqual([true, 1]);
    expect([points.every((p) => p.mode === 'table'), swaps], 'the lines stay a table throughout').toEqual([true, 0]);
  }
  const { points } = await sweep(page, steps(from, to, 4), height);
  const flip = points.findIndex((p, i) => i > 0 && p.beside !== points[i - 1]!.beside);
  for (const p of [points[flip - 1]!, points[flip]!]) {
    const still = await idle(page, p.width, height);
    expect(still, `${p.width}px held still`).toEqual({ sides: Array(6).fill(p.beside), swapsWhileIdle: 0 });
  }
}

test('crossing the table/cards switch point in 4px steps changes the layout exactly once each way', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 768 });
  await open(page, 'top', false);
  const down = await sweep(page, steps(1000, 900, 4));
  const modesDown = down.points.map((p) => p.mode);
  expect([modesDown[0], modesDown.at(-1), changes(modesDown), down.swaps]).toEqual(['table', 'cards', 1, 1]);
  const up = await sweep(page, steps(900, 1000, 4));
  const modesUp = up.points.map((p) => p.mode);
  expect([modesUp[0], modesUp.at(-1), changes(modesUp), up.swaps]).toEqual(['cards', 'table', 1, 1]);
});

test('Dimensions closed: in 4px steps the summary moves beside the lines exactly at a 1232px form, once each way', async ({ page }) => {
  await page.setViewportSize({ width: 1380, height: 768 });
  await open(page, 'top', false);
  await crossSummaryBreakpoint(page, 1380, 1300, 1232);
});

test('Dimensions open: in 4px steps the summary moves beside the lines exactly at a 1472px form, once each way', async ({ page }) => {
  await page.setViewportSize({ width: 1640, height: 768 });
  await open(page, 'top', true);
  await crossSummaryBreakpoint(page, 1640, 1540, 1472);
});

// Headless Chromium hides scrollbars; drawn, a 15px one could come and go with the summary's position and move the
// breakpoint under it. The page's main area keeps its scrollbar at every height measured (to 2000px), so this guards
// the rule against a page that stops scrolling, not a loop seen today. Its own browser: the launch flag is per browser.
for (const height of [1080, 1400]) {
  test(`${height}px high, scrollbars drawn: the summary moves once each way and holds still at the breakpoint`, async ({ playwright }, info) => {
    const browser = await playwright.chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      const { baseURL, storageState } = info.project.use;
      const page = await (await browser.newContext({ baseURL, storageState, viewport: { width: 1400, height } })).newPage();
      await open(page, 'top', false);
      expect(await page.locator('main').evaluate((m) => (m as HTMLElement).offsetWidth - m.clientWidth), 'a drawn scrollbar').toBeGreaterThan(0);
      await crossSummaryBreakpoint(page, 1400, 1320, 1232, height);
    } finally {
      await browser.close();
    }
  });
}
